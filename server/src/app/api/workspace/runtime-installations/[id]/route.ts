/**
 * Single runtime installation view + teardown.
 *
 * This is the per-row control surface for runtime-installations. The list
 * route already drives the grid; this route exists for the smoke scripts and
 * the delete/cleanup path so lifecycle can close on one installation at a
 * time.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { K8sSandboxError, k8sSandbox, isAlreadyAbsentK8sError } from '@/lib/k8s-sandbox';
import { addForgottenDaemonId } from '@/lib/runtime-binding-metadata';
import { authorizeContainer, type IMContainerRow } from '../../../sandboxes/_helpers';

export const dynamic = 'force-dynamic';

type RuntimeInstallationRow = IMContainerRow & {
  runtimeKind?: string | null;
  // Migration 322 — provisioning progress columns. Optional in the type since
  // a Prisma read with no `select` returns them all but TS infers them as
  // unknown via the cast at the call sites.
  provisioningStep?: string | null;
  provisioningHistory?: unknown;
  /**
   * Migration 323 — §30 §2.6 device capacity model. Per-device agent
   * ceiling. Optional so legacy rows / stale clients stay readable; the
   * DTO collapses missing → 3 (Web base subscription default).
   */
  maxAgents?: number | null;
  /** M448 (doc 20 Gap A) — optional project scope. NULL on legacy rows. */
  projectId?: string | null;
};

type ReadinessProbe = {
  daemonStatus: 'connected' | 'stale' | 'offline';
  daemonAgeMs: number | null;
  declared: number;
  expected: number;
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await authorizeContainer(req, id);
  if (!auth.ok) return auth.response;

  const row = (await prisma.iMContainer.findUnique({ where: { id } })) as RuntimeInstallationRow | null;
  if (!row) {
    return NextResponse.json(
      { ok: false, error: { code: 'not_found', message: 'Runtime installation not found.' } },
      { status: 404 },
    );
  }

  const readiness = await loadReadinessForRows([row], row.workspaceId);
  return NextResponse.json({ ok: true, data: toRuntimeInstallationDTO(row, readiness.get(row.id)) });
}

/**
 * M448 (doc 20 Gap A) — PATCH body. Today the only mutable field is the
 * optional project binding (rebinding / unbinding after creation). Resource
 * shape / image / kind are immutable on this surface — change those by
 * recreating. Pass `projectId: null` to detach; omit to leave unchanged.
 */
const PatchBody = z.object({
  projectId: z.string().trim().min(1).max(30).nullable().optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await authorizeContainer(req, id);
  if (!auth.ok) return auth.response;

  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid_body', details: parsed.error.flatten() }, { status: 400 });
  }
  const body = parsed.data;
  if (body.projectId === undefined) {
    // Nothing to update — return current DTO to keep this endpoint idempotent
    // for clients that PATCH eagerly with empty bodies (mirror task PATCH).
    const row = auth.data.container as RuntimeInstallationRow;
    const readiness = await loadReadinessForRows([row], row.workspaceId);
    return NextResponse.json({ ok: true, data: toRuntimeInstallationDTO(row, readiness.get(row.id)) });
  }

  const current = auth.data.container as RuntimeInstallationRow;

  // Same invariant as POST (route.ts validateProjectScope): non-null
  // projectId must reference an active project in the same workspace.
  if (body.projectId !== null) {
    const project = (await prisma.iMProject.findUnique({
      where: { id: body.projectId },
      select: { id: true, workspaceId: true, status: true },
    })) as { id: string; workspaceId: string; status: string } | null;
    if (!project) {
      return NextResponse.json(
        { ok: false, error: { code: 'PROJECT_NOT_FOUND', message: `Project '${body.projectId}' does not exist.` } },
        { status: 422 },
      );
    }
    if (project.workspaceId !== current.workspaceId) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: 'PROJECT_WORKSPACE_MISMATCH',
            message: `Project '${body.projectId}' belongs to a different workspace.`,
          },
        },
        { status: 422 },
      );
    }
    if (project.status !== 'active') {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: 'PROJECT_NOT_ACTIVE',
            message: `Project '${body.projectId}' is not active (status='${project.status}').`,
          },
        },
        { status: 422 },
      );
    }
  }

  const updated = (await prisma.iMContainer.update({
    where: { id },
    data: { projectId: body.projectId },
  })) as RuntimeInstallationRow;

  const readiness = await loadReadinessForRows([updated], updated.workspaceId);
  logger.info(
    { id, workspaceId: updated.workspaceId, projectId: body.projectId },
    'runtime installation project scope updated',
  );
  return NextResponse.json({ ok: true, data: toRuntimeInstallationDTO(updated, readiness.get(updated.id)) });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await authorizeContainer(req, id);
  if (!auth.ok) return auth.response;

  const { container } = auth.data;
  const row = container as RuntimeInstallationRow;

  try {
    await k8sSandbox.removeContainer(container.podName);
  } catch (err) {
    if (err instanceof K8sSandboxError) {
      if (!isAlreadyAbsentK8sError(err)) {
        logger.error({ err, id, podName: container.podName }, 'runtime installation k8s remove failed');
        return NextResponse.json(
          { ok: false, error: { code: 'controller_error', message: err.body, status: err.status } },
          { status: 502 },
        );
      }
      logger.info({ id, podName: container.podName, status: err.status }, 'runtime already absent in cluster');
    } else {
      logger.error({ err, id, podName: container.podName }, 'runtime installation remove failed');
      return NextResponse.json(
        { ok: false, error: { code: 'internal_error', message: 'Failed to remove runtime installation.' } },
        { status: 500 },
      );
    }
  }

  const updated = (await prisma.iMContainer.update({
    where: { id },
    data: { status: 'stopped', stoppedAt: row.stoppedAt ?? new Date() },
  })) as RuntimeInstallationRow;

  // 2026-05-20 — DELETE means "hide this row from the active device list".
  // F11 design keeps `stopped` visible (for restart), so we mark this row
  // forgotten via workspace metadata; LIST filter honors it.
  //
  // Forget key form: the row-scoped `container-row:<id>` key plus, when
  // available, the derived `container:<agentImUserId>` key. We still never
  // write the raw DB `daemonId` UUID here: UUIDs can be shared across paired
  // rows in the wild, and forgetting by UUID can hide unrelated rows.
  try {
    const ws = (await prisma.iMWorkspace.findUnique({
      where: { id: updated.workspaceId },
      select: { metadata: true },
    })) as { metadata: string | null } | null;
    if (ws) {
      let nextMetadata = addForgottenDaemonId(ws.metadata, runtimeInstallationRowForgetKey(updated.id));
      if (updated.agentImUserId) {
        const containerKey = updated.agentImUserId.startsWith('container:')
          ? updated.agentImUserId
          : `container:${updated.agentImUserId}`;
        nextMetadata = addForgottenDaemonId(nextMetadata, containerKey);
      } else {
        logger.warn(
          { id, podName: container.podName },
          'runtime delete — row has no agentImUserId, recorded row-scoped forget key only',
        );
      }
      if (nextMetadata !== ws.metadata) {
        await prisma.iMWorkspace.update({
          where: { id: updated.workspaceId },
          data: { metadata: nextMetadata },
        });
      }
    }
  } catch (forgetErr) {
    // Best-effort — failure to update workspace metadata doesn't reverse the
    // K8s pod removal. Log and continue. The user can still hit /forget
    // manually via the workspace-runtime endpoint to clean up state.
    logger.warn(
      { err: forgetErr, id, podName: container.podName },
      'runtime delete — forgottenDaemonIds update failed (continuing)',
    );
  }

  const readiness = await loadReadinessForRows([updated], updated.workspaceId);
  logger.info({ id, podName: container.podName }, 'runtime installation removed (forgotten)');
  return NextResponse.json({ ok: true, data: toRuntimeInstallationDTO(updated, readiness.get(updated.id)) });
}

async function loadReadinessForRows(
  rows: RuntimeInstallationRow[],
  workspaceId: string,
): Promise<Map<string, ReadinessProbe>> {
  const out = new Map<string, ReadinessProbe>();
  if (rows.length === 0) return out;

  const declaredByDaemon = await loadDeclaredByDaemon(workspaceId);
  const controllerImUserIds = rows
    .map((row) => row.agentImUserId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const heartbeatById = new Map<string, Date | null>();
  if (controllerImUserIds.length > 0) {
    const cards = (await prisma.iMAgentCard.findMany({
      where: { workspaceId, imUserId: { in: controllerImUserIds } },
      select: { imUserId: true, lastHeartbeat: true },
    })) as Array<{ imUserId: string; lastHeartbeat: Date | null }>;
    for (const card of cards) heartbeatById.set(card.imUserId, card.lastHeartbeat);
  }

  const now = Date.now();
  for (const row of rows) {
    const daemonId = installationDaemonId(row);
    const declared = declaredByDaemon.get(daemonId) ?? 0;
    const heartbeat = row.agentImUserId ? (heartbeatById.get(row.agentImUserId) ?? null) : null;
    const daemonAgeMs = heartbeat ? Math.max(0, now - heartbeat.getTime()) : null;
    out.set(row.id, {
      daemonStatus: daemonAgeMs == null ? 'offline' : daemonAgeMs <= HEARTBEAT_FRESH_MS ? 'connected' : 'stale',
      daemonAgeMs,
      declared,
      expected: declared,
    });
  }
  return out;
}

async function loadDeclaredByDaemon(workspaceId: string): Promise<Map<string, number>> {
  const cards = (await prisma.iMAgentCard.findMany({
    where: { workspaceId },
    select: { metadata: true, imUserId: true, lastHeartbeat: true },
  })) as Array<{ metadata: string | null; imUserId: string; lastHeartbeat: Date | null }>;
  const out = new Map<string, number>();
  const now = Date.now();
  for (const card of cards) {
    let daemonId: string | null = null;
    try {
      const meta = JSON.parse(card.metadata || '{}') as { daemonId?: string };
      daemonId = meta.daemonId ?? null;
    } catch {
      /* skip malformed */
    }
    if (!daemonId) continue;
    const fresh = !card.lastHeartbeat || now - card.lastHeartbeat.getTime() <= HEARTBEAT_FRESH_MS * 4;
    if (!fresh) continue;
    out.set(daemonId, (out.get(daemonId) ?? 0) + 1);
  }
  return out;
}

const HEARTBEAT_FRESH_MS = 90_000;

function runtimeInstallationRowForgetKey(id: string): string {
  return `container-row:${id}`;
}

function installationDaemonId(row: RuntimeInstallationRow): string {
  if (row.daemonId) return row.daemonId;
  const id = row.agentImUserId ?? row.podName;
  return id.startsWith('container:') ? id : `container:${id}`;
}

function toRuntimeInstallationDTO(row: RuntimeInstallationRow, readiness?: ReadinessProbe) {
  const runtimeInstanceId = row.agentImUserId ?? row.podName;
  const daemonId = installationDaemonId(row);
  const createdAtMs = row.createdAt.getTime();
  const startedAtMs = row.startedAt?.getTime() ?? null;
  const phase = phaseFromStatus(row.status);
  const provisionLatencyMs = startedAtMs ? Math.max(0, startedAtMs - createdAtMs) : null;
  const ageMs = Math.max(0, Date.now() - createdAtMs);

  const containerStatus = containerStatusFromRow(row);
  const daemonStatus = readiness?.daemonStatus ?? 'offline';
  const declared = readiness?.declared ?? 0;
  const expected = readiness?.expected ?? declared;
  const hostedAgentSummary = {
    declared,
    expected,
    verified: expected > 0 && declared >= expected,
  };

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    // M448 (doc 20 Gap A) — project scope. `null` = workspace-level.
    projectId: row.projectId ?? null,
    runtimeInstanceId,
    daemonId,
    podName: row.podName,
    namespace: row.namespace,
    runtimeKind: (row.runtimeKind as 'docker' | 'k8s' | undefined) ?? 'docker',
    // Migration 323 — §30 §2.6 device capacity. Falls back to 3 to match
    // the SQL DEFAULT and the server-side enforcement fallback.
    maxAgents: typeof row.maxAgents === 'number' ? row.maxAgents : 3,
    phase,
    desiredState: row.stoppedAt ? 'stopped' : 'running',
    status: row.status,
    containerStatus,
    daemonStatus,
    hostedAgentSummary,
    image: row.image,
    imageTag: row.imageTag,
    resources: {
      cpuRequest: row.cpuRequest,
      cpuLimit: row.cpuLimit,
      memoryRequest: row.memoryRequest,
      memoryLimit: row.memoryLimit,
    },
    gatewayUrl: row.gatewayUrl,
    startedAt: row.startedAt?.toISOString() ?? null,
    stoppedAt: row.stoppedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    metrics: {
      ageMs,
      provisionLatencyMs,
      heartbeatAgeMs: readiness?.daemonAgeMs ?? null,
      hostedAgents: declared,
      onlineHostedAgents: declared,
    },
    observability: {
      statusFreshness: 'database',
      logsPath: `/api/sandboxes/${encodeURIComponent(row.id)}/logs`,
      startPath: `/api/sandboxes/${encodeURIComponent(row.id)}/start`,
      stopPath: `/api/sandboxes/${encodeURIComponent(row.id)}/stop`,
      snapshotPath: `/api/sandboxes/${encodeURIComponent(row.id)}/snapshot`,
    },
    events: buildEvents(row, daemonId, phase),
    provisioning: {
      step: (row as RuntimeInstallationRow & { provisioningStep?: string | null }).provisioningStep ?? null,
      history: normalizeProvisioningHistory(
        (row as RuntimeInstallationRow & { provisioningHistory?: unknown }).provisioningHistory,
      ),
    },
  };
}

function normalizeProvisioningHistory(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function containerStatusFromRow(
  row: RuntimeInstallationRow,
): 'provisioning' | 'running' | 'failing' | 'stopped' | 'unknown' {
  if (row.stoppedAt) return 'stopped';
  switch (row.status) {
    case 'creating':
    case 'pending':
    case 'warming':
    case 'starting':
    case 'provisioning':
      return 'provisioning';
    case 'running':
    case 'bound':
      return 'running';
    case 'stopping':
    case 'stopped':
      return 'stopped';
    case 'errored':
    case 'failed':
      return 'failing';
    default:
      return 'unknown';
  }
}

function phaseFromStatus(status: string): 'provisioning' | 'online' | 'degraded' | 'stopped' | 'failed' {
  switch (status) {
    case 'creating':
    case 'pending':
    case 'warming':
    case 'starting':
    case 'provisioning':
      return 'provisioning';
    case 'running':
    case 'bound':
      return 'online';
    case 'stopped':
    case 'stopping':
      return 'stopped';
    case 'errored':
    case 'failed':
      return 'failed';
    default:
      return 'degraded';
  }
}

function buildEvents(row: RuntimeInstallationRow, daemonId: string, phase: string) {
  const events = [
    {
      at: row.createdAt.toISOString(),
      kind: 'runtime.requested',
      severity: 'info',
      message: `Runtime installation requested for ${daemonId}.`,
    },
  ];
  if (row.startedAt) {
    events.push({
      at: row.startedAt.toISOString(),
      kind: 'container.started',
      severity: 'info',
      message: `Container ${row.podName} entered ${row.status}.`,
    });
  }
  if (phase === 'failed') {
    events.push({
      at: row.updatedAt.toISOString(),
      kind: 'runtime.failed',
      severity: 'error',
      message: 'Runtime is marked failed; open logs before retrying.',
    });
  }
  if (row.stoppedAt) {
    events.push({
      at: row.stoppedAt.toISOString(),
      kind: 'container.stopped',
      severity: 'warn',
      message: `Container ${row.podName} stopped.`,
    });
  }
  return events;
}
