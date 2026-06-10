/**
 * Workspace Runtime Installations control plane.
 *
 * This is the workspace-facing layer above raw sandboxes. A runtime
 * installation represents a long-running daemon host that can later declare
 * hosted IM agents. It deliberately uses a durable runtime credential and a
 * unique controller agent id; task sandboxes keep using short-lived task keys.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { createApiKey } from '@/lib/db-api-keys';
import { hasK8sConfig } from '@/lib/sandbox-config';
import { K8sSandboxError, k8sSandbox, podNameForAgent } from '@/lib/k8s-sandbox';
import { getDaemonImage } from '@/lib/sandbox/image-pin';
import { buildWorkspaceRuntimeEnv } from '@/lib/sandbox/pod-spec';
import { randomUUID } from 'node:crypto';
import { getK8sNamespace } from '@/lib/k8s-client';
import { emitterForRow, recordProvisioningStep } from '@/lib/provisioning-progress';
import { emitRuntimeDegradedNotification } from '@/lib/notification-emitter';
import { loadRuntimeDaemonPresence } from '@/lib/runtime-presence';
import { getForgottenDaemonIds } from '@/lib/runtime-binding-metadata';
import { authorizeWorkspace } from '../../sandboxes/_helpers';

export const dynamic = 'force-dynamic';

const CreateBody = z.object({
  workspaceId: z.string().min(1),
  name: z.string().trim().min(1).max(80).optional(),
  image: z.string().trim().min(1).max(255).optional(),
  cpuRequest: z.string().trim().min(1).max(16).default('250m'),
  cpuLimit: z.string().trim().min(1).max(16).default('2000m'),
  memoryRequest: z.string().trim().min(1).max(16).default('2Gi'),
  memoryLimit: z.string().trim().min(1).max(16).default('4Gi'),
  /**
   * Wave-8 W11 — runtime backing kind. `docker` keeps the existing path
   * (controller call → DB row → return). `k8s` is the wizard-provisioned pod:
   * if the controller round-trip fails we still persist a row with
   * `status='provisioning'` and `runtimeKind='k8s'` and return 202 Accepted so
   * the UI can surface "[K8s] Provisioning…" while the orchestration loop
   * (real EKS pod creation) catches up. Default `docker` keeps every existing
   * caller unchanged.
   */
  kind: z.enum(['docker', 'k8s']).optional().default('docker'),
  /** W11 — only meaningful when `kind='k8s'`; selected template id for audit. */
  template: z.string().trim().min(1).max(80).optional(),
  /** W11 — only meaningful when `kind='k8s'`; non-zero count requests GPU. */
  gpu: z.coerce.number().int().min(0).max(8).optional().default(0),
  /**
   * v2.0.8 doc 20 Gap A (M448) — opt-in project scope. Omitting (or null)
   * persists as workspace-level. When provided, must reference an `active`
   * `IMProject` in the same workspace; otherwise 422 with
   * `PROJECT_WORKSPACE_MISMATCH` / `PROJECT_NOT_ACTIVE`. Daemon dispatch
   * routing is unchanged (per-agent — 09 §9.9); projectId only narrows UI
   * scope filters.
   */
  projectId: z.string().trim().min(1).max(30).optional(),
});

const ListQuery = z.object({
  workspaceId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /**
   * Wave-8 W5 — when 'false' (default) hides rows whose container plane is
   * already in a stopped/failed terminal state from the active list, so
   * stopping a runtime cleanly removes it from the cards grid without
   * losing the row from MySQL. Pass 'true' to include them.
   */
  includeStopped: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
  /**
   * v2.0.8 doc 20 Gap A (M448) — project scope filter (sigils mirror 09 §4.2):
   *   - omitted | 'all'  → no project filter (default; backward-compat)
   *   - '__unscoped'     → projectId IS NULL only (workspace-level rows)
   *   - any other string → exact projectId match
   */
  projectId: z.string().trim().min(1).max(64).optional(),
});

/** W5 — heartbeat freshness window. Mirrors `ONLINE_WINDOW_MS` in runtime-manager.tsx. */
const HEARTBEAT_FRESH_MS = 90_000;

type ContainerRow = {
  id: string;
  workspaceId: string;
  /** M448 — optional project scope. NULL on legacy rows / workspace-level installs. */
  projectId?: string | null;
  tenantId: string;
  agentImUserId: string | null;
  taskId: string | null;
  podName: string;
  namespace: string;
  image: string;
  imageTag: string;
  status: string;
  /** W11 — defaulted at the SQL level; older rows return "docker". */
  runtimeKind?: string | null;
  // Migration 322 — provisioning progress columns.
  provisioningStep?: string | null;
  provisioningHistory?: unknown;
  /**
   * Migration 323 — §30 §2.6 device capacity model. Per-device agent
   * ceiling. Optional in this type so legacy rows (DB without column) and
   * stale cached schemas stay readable; the DTO collapses missing → 3.
   */
  maxAgents?: number | null;
  /** §26 B5 — daemonId column (local daemon self-registration). */
  daemonId?: string | null;
  cpuRequest: string;
  cpuLimit: string;
  memoryRequest: string;
  memoryLimit: string;
  gatewayUrl: string | null;
  startedAt: Date | null;
  stoppedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Per-device agent ceiling for a freshly-provisioned K8S device. Previously the
 * create blocks below DID NOT set `maxAgents`, so the row inherited the
 * `im_containers.maxAgents` COLUMN DEFAULT — which is 3 on any DB where migration
 * 340 (the 3→10 bump) hasn't applied (e.g. test). That is the hard
 * "Device … already hosts 3 agent(s); maximum is 3" wall users hit even in Pro
 * mode. Set it EXPLICITLY + Nacos-tunable (`K8S_AGENT_MAX_AGENTS`) so the ceiling
 * no longer depends on a stale schema default and ops can raise it alongside a
 * larger pod spec. Follow-up: tie the ceiling to the pod's cpu/mem spec + surface
 * a "scale up the container" reminder instead of a flat number.
 */
function maxAgentsForNewDevice(): number {
  const raw = Number(process.env.K8S_AGENT_MAX_AGENTS);
  return Number.isInteger(raw) && raw > 0 ? raw : 10;
}

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const parsed = ListQuery.safeParse({
    workspaceId: url.searchParams.get('workspaceId') ?? '',
    limit: url.searchParams.get('limit') ?? undefined,
    includeStopped: url.searchParams.get('includeStopped') ?? undefined,
    projectId: url.searchParams.get('projectId') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid_query', details: parsed.error.flatten() }, { status: 400 });
  }

  const auth = await authorizeWorkspace(req, parsed.data.workspaceId);
  if (!auth.ok) return auth.response;

  // M448 — project scope filter. Default (omitted / 'all') keeps the legacy
  // behavior of returning every workspace runtime regardless of projectId.
  const projectFilter = parsed.data.projectId;
  const projectWhere =
    !projectFilter || projectFilter === 'all'
      ? {}
      : projectFilter === '__unscoped'
        ? { projectId: null as string | null }
        : { projectId: projectFilter };

  const rows = (await prisma.iMContainer.findMany({
    where: {
      workspaceId: parsed.data.workspaceId,
      taskId: null,
      ...projectWhere,
    },
    orderBy: { createdAt: 'desc' },
    take: parsed.data.limit,
  })) as ContainerRow[];

  // Wave-8 W5 — readiness probes (daemon plane via Redis presence, hosted
  // agents via IMAgentCard metadata.daemonId). Done in one pipelined Redis
  // call + one Prisma findMany so the route stays O(1) per request.
  const readiness = await loadReadinessForRows(rows, parsed.data.workspaceId);

  let dtos = rows.map((row) => toRuntimeInstallationDTO(row, readiness.get(row.id)));

  // Wave-8 W9: when a runtime row enters `failing` (controller reports
  // errored / failed), emit a Bell row so the operator sees the degradation
  // even if they're on another surface. emitRuntimeDegradedNotification
  // dedups internally per-row in a 10-min window so polling won't spam.
  for (const dto of dtos) {
    if (dto.containerStatus === 'failing' || (dto.phase === 'degraded' && dto.containerStatus !== 'stopped')) {
      void emitRuntimeDegradedNotification({
        ownerImUserId: auth.data.workspace.ownerImUserId,
        workspaceId: dto.workspaceId,
        runtimeInstallationId: dto.id,
        daemonId: dto.daemonId,
        podName: dto.podName,
        phase: dto.phase,
        reason: dto.status,
      });
    }
  }

  // Deleted devices are "forgotten" rows, not merely stopped rows. They must
  // stay hidden even when callers request includeStopped=true so Workspace can
  // still show manually stopped devices without resurrecting deleted cards.
  const ws = (await prisma.iMWorkspace.findUnique({
    where: { id: parsed.data.workspaceId },
    select: { metadata: true },
  })) as { metadata: string | null } | null;
  const forgottenSet = new Set(getForgottenDaemonIds(ws?.metadata ?? null));
  const rowsById = new Map(rows.map((r) => [r.id, r] as const));
  dtos = dtos.filter((dto) => {
    const row = rowsById.get(dto.id);
    if (row && isForgottenRuntimeInstallation(row, forgottenSet)) return false;
    if (!parsed.data.includeStopped && isTerminalRuntimeInstallation(dto)) return false;
    return true;
  });

  return NextResponse.json({ ok: true, data: dtos });
}

function runtimeInstallationForgetKeys(row: ContainerRow): string[] {
  const keys = [`container-row:${row.id}`];
  if (row.agentImUserId) {
    keys.push(row.agentImUserId.startsWith('container:') ? row.agentImUserId : `container:${row.agentImUserId}`);
  }
  return keys;
}

function isForgottenRuntimeInstallation(row: ContainerRow, forgottenSet: Set<string>): boolean {
  if (forgottenSet.size === 0) return false;
  return runtimeInstallationForgetKeys(row).some((key) => forgottenSet.has(key));
}

function isTerminalRuntimeInstallation(dto: ReturnType<typeof toRuntimeInstallationDTO>): boolean {
  return dto.containerStatus === 'failing' || dto.status === 'errored' || dto.status === 'failed';
}

interface ReadinessProbe {
  daemonStatus: 'connected' | 'stale' | 'offline';
  daemonAgeMs: number | null;
  declared: number;
  expected: number;
}

/**
 * Compute readiness signals from BOTH IMAgentCard heartbeats (hosted agents)
 * AND Redis presence (daemon's own WS heartbeats via host.declare). The
 * daemon's host.declare handler updates `runtime:device:${wsId}:${daemonId}`
 * in Redis with a 90s TTL every 30s, so checking that key tells us whether
 * the daemon itself is connected even when it hosts zero agents.
 */
async function loadReadinessForRows(rows: ContainerRow[], workspaceId: string): Promise<Map<string, ReadinessProbe>> {
  const out = new Map<string, ReadinessProbe>();
  if (rows.length === 0) return out;

  const declaredByDaemon = await loadDeclaredByDaemon(workspaceId);

  // Agent-card heartbeats — covers hosted-agent plane.
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

  // Redis presence — daemon's own WS heartbeat. Live every ~30s, TTL 90s.
  // Falls back gracefully when Redis is unreachable.
  const redisPresenceByDaemonId = await loadRedisPresence(workspaceId, rows);

  const now = Date.now();
  for (const row of rows) {
    const daemonId = installationDaemonId(row);
    const declared = declaredByDaemon.get(daemonId) ?? 0;
    const heartbeat = row.agentImUserId ? (heartbeatById.get(row.agentImUserId) ?? null) : null;
    const ageFromAgentCard = heartbeat ? Math.max(0, now - heartbeat.getTime()) : null;

    // Redis presence uses the DB daemonId column when available, falling
    // back to the derived daemonId (compat with older rows).
    const redisAgeMs = redisPresenceByDaemonId.get(row.daemonId ?? daemonId) ?? null;

    // Pick the freshest signal, defaulting to offline when both are null.
    const daemonAgeMs = pickFreshest(ageFromAgentCard, redisAgeMs);

    out.set(row.id, {
      daemonStatus: daemonAgeMs == null ? 'offline' : daemonAgeMs <= HEARTBEAT_FRESH_MS ? 'connected' : 'stale',
      daemonAgeMs,
      declared,
      expected: declared,
    });
  }
  return out;
}

/** Pick the freshest (lowest) non-null age, or null if both are null. */
function pickFreshest(...ages: (number | null)[]): number | null {
  let best: number | null = null;
  for (const a of ages) {
    if (a == null) continue;
    if (best == null || a < best) best = a;
  }
  return best;
}

/**
 * Bulk-load Redis presence for every daemon in the given rows. Returns a map
 * of daemonId → age-in-ms (0 = live). Gracefully returns empty map when Redis
 * is unavailable — the agent-card fallback still reports hosted-agent status.
 */
async function loadRedisPresence(workspaceId: string, rows: ContainerRow[]): Promise<Map<string, number>> {
  const daemonIds = new Set<string>();
  for (const row of rows) {
    if (row.daemonId) daemonIds.add(row.daemonId);
    daemonIds.add(installationDaemonId(row));
  }
  return loadRuntimeDaemonPresence(workspaceId, daemonIds);
}

function installationDaemonId(row: ContainerRow): string {
  if (row.daemonId) return row.daemonId;
  const id = row.agentImUserId ?? row.podName;
  return id.startsWith('container:') ? id : `container:${id}`;
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
    // Heartbeat older than 4× window means the agent stopped declaring; skip.
    const fresh = !card.lastHeartbeat || now - card.lastHeartbeat.getTime() <= HEARTBEAT_FRESH_MS * 4;
    if (!fresh) continue;
    out.set(daemonId, (out.get(daemonId) ?? 0) + 1);
  }
  return out;
}

export async function POST(req: NextRequest): Promise<Response> {
  const parsed = CreateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid_body', details: parsed.error.flatten() }, { status: 400 });
  }

  const auth = await authorizeWorkspace(req, parsed.data.workspaceId);
  if (!auth.ok) return auth.response;
  const body = parsed.data;
  const workspaceOwnerImUserId = auth.data.workspace.ownerImUserId;

  // M448 — validate optional project binding before any side effect (API key
  // mint / pod provision). Cheap lookup; aligns with 09 §5 service invariant.
  if (body.projectId) {
    const projectErr = await validateProjectScope(body.workspaceId, body.projectId);
    if (projectErr) return projectErr;
  }

  const cloudUserId = await resolveCloudUserId(auth.user.id, auth.user.numericId);
  if (!cloudUserId) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'owner_cloud_user_missing',
          message: 'Workspace owner is not linked to a cloud user; cannot mint runtime credential.',
        },
      },
      { status: 422 },
    );
  }

  const runtimeInstanceId = makeRuntimeInstanceId();
  // F8 (2026-05-19) — daemonId is now minted route-side as a real UUID and
  // threaded through both `PRISMER_DAEMON_ID` env (via the canonical helper)
  // AND `provisionContainer({ daemonId })`, so the scopedEnv merge inside
  // provisionContainer is byte-idempotent. Pre-F8 this was
  // `\`container:${runtimeInstanceId}\`` which was always overwritten by
  // provisionContainer's randomUUID() — dead value with confusing logs.
  const daemonId = randomUUID();
  const cloudBaseUrl = resolveCloudBaseUrl(req);
  // T8 §08 §5.2 — image resolution priority:
  //   request body > RUNTIME_DAEMON_IMAGE env (legacy) > getDaemonImage()
  //   (which honors CONTAINER_IMAGE env then image-pin.yaml canonical).
  // Removes the dead `daemon-v1.0` hardcoded fallback that pre-T8 left
  // workspace UI device-create failing with ImagePullBackOff in local dev.
  const image = body.image ?? process.env.RUNTIME_DAEMON_IMAGE ?? getDaemonImage();

  let issuedKey: Awaited<ReturnType<typeof createApiKey>>;
  try {
    issuedKey = await createApiKey(
      cloudUserId,
      runtimeKeyLabel({
        workspaceId: body.workspaceId,
        runtimeInstanceId,
        daemonId,
        name: body.name,
      }),
    );
  } catch (err) {
    logger.error({ err, workspaceId: body.workspaceId }, 'runtime credential mint failed');
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'runtime_credential_failed',
          message: err instanceof Error ? err.message : 'Unable to mint runtime credential',
        },
      },
      { status: 502 },
    );
  }

  const requestedKind: 'docker' | 'k8s' = body.kind;

  // W11 — k8s wizard envelope. We pass-through to the same controller for now
  // (controller already runs on EKS in test/prod; the "kind" is a workspace-
  // level UX discriminator + template/gpu hint). When the controller is
  // unreachable (dev / kind sandbox without controller binary) we still
  // persist a synthetic provisioning row so the wizard's caller can render
  // the [K8s] Provisioning… badge — the actual EKS reconcile loop is a
  // follow-up; this is the "row + UX" scope-down explicitly allowed by W11.
  // F8 (2026-05-19) — single source of truth for the workspace-runtime
  // profile env (pre-F8 this was a 25-line inline literal that drifted from
  // both `provisionContainer`'s scopedEnv and `manifest-diff-gen.ts`).
  // Sandbox-scoped daemon shell exec defaults on for k8s pods: pod-level
  // isolation + workspace-bound API key are the real security boundaries
  // (NOT shell-disabled inside an already-sandboxed pod); also satisfies
  // workspace UI's "Shell task" terminal which sends `ls`/`cat` via
  // `runtimeRoute='shell'`.
  const k8sBootstrapEnv = buildWorkspaceRuntimeEnv({
    apiKey: issuedKey.key,
    daemonId,
    cloudApiBase: cloudBaseUrl,
    workspaceId: body.workspaceId,
    tenantId: workspaceOwnerImUserId,
    runtimeInstanceId,
    runtimeKind: requestedKind === 'k8s' ? 'workspace-k8s-pod' : 'workspace-daemon',
    k8sTemplate: requestedKind === 'k8s' ? body.template : undefined,
    gpuRequest: requestedKind === 'k8s' ? body.gpu : undefined,
    shellEnabled: true,
    dispatchDaemonSecret: process.env.DISPATCH_DAEMON_SECRET,
  });

  // §26 B4 — runtime lands via in-process `k8sSandbox.provisionContainer`
  // (the legacy HTTP controller path was removed). We still honour the
  // `K8S_CONTROLLER_AVAILABLE=false` dev escape hatch so a fresh cloud pod
  // without cluster credentials can persist a synthetic `provisioning` row
  // and surface the [K8s] Provisioning… UX in the wizard.
  const k8sCapable = hasK8sConfig();
  const shouldPersistPendingK8s = requestedKind === 'k8s' && process.env.K8S_CONTROLLER_AVAILABLE === 'false';

  async function persistPendingK8s(reason: { controllerError: string }): Promise<Response> {
    const podName = `pending-${runtimeInstanceId}`;
    const pendingRow = (await prisma.iMContainer.create({
      data: {
        workspaceId: body.workspaceId,
        // M448 — opt-in project scope; NULL = workspace-level (default).
        projectId: body.projectId ?? null,
        tenantId: workspaceOwnerImUserId,
        agentImUserId: runtimeInstanceId,
        taskId: null,
        podName,
        namespace: getK8sNamespace(),
        image,
        imageTag: image.split(':').pop() ?? 'latest',
        status: 'provisioning',
        runtimeKind: 'k8s',
        // Explicit ceiling — don't inherit the stale DB default (3) on test.
        maxAgents: maxAgentsForNewDevice(),
        // 2026-05-20 — populate daemonId AT CREATE TIME. Pre-fix the column
        // was only stamped after provisionContainer returned (line ~549), so
        // host.declare arriving in the race window saw `daemonId IS NULL` on
        // the K8s row and fell through to create a duplicate `daemon:<short>`
        // local docker row sharing the same UUID. The route already mints
        // daemonId via randomUUID() above; persisting it here closes the race.
        daemonId,
        cpuRequest: body.cpuRequest,
        cpuLimit: body.cpuLimit,
        memoryRequest: body.memoryRequest,
        memoryLimit: body.memoryLimit,
        gatewayUrl: null,
        startedAt: null,
      },
    })) as ContainerRow;
    logger.info(
      {
        runtimeInstallationId: pendingRow.id,
        runtimeInstanceId,
        controllerError: reason.controllerError,
      },
      'k8s device runtime persisted in provisioning state (k8s unavailable; reconcile pending)',
    );
    return NextResponse.json({ ok: true, data: toRuntimeInstallationDTO(pendingRow) }, { status: 202 });
  }

  try {
    if (shouldPersistPendingK8s) {
      return await persistPendingK8s({
        controllerError: 'K8S_CONTROLLER_AVAILABLE=false',
      });
    }
    if (requestedKind === 'k8s' && !k8sCapable && process.env.K8S_CONTROLLER_AVAILABLE !== 'true') {
      logger.warn(
        { workspaceId: body.workspaceId, runtimeInstanceId },
        'k8s device runtime create blocked because cloud has no K8s cluster credentials',
      );
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: 'controller_unconfigured',
            message:
              'Cloud is missing K8s cluster credentials (KUBERNETES_SERVICE_HOST or K8S_CLUSTER_URL + K8S_SERVICE_ACCOUNT_TOKEN); cannot provision a K8s device.',
          },
        },
        { status: 503 },
      );
    }

    // Pre-create row so workspace UI can poll progress while provisionContainer
    // blocks 2-3s on pod reach-Running. podName is deterministic from agent id.
    const podName = podNameForAgent(runtimeInstanceId);
    const row = (await prisma.iMContainer.create({
      data: {
        workspaceId: body.workspaceId,
        // M448 — opt-in project scope; NULL = workspace-level (default).
        projectId: body.projectId ?? null,
        tenantId: workspaceOwnerImUserId,
        agentImUserId: runtimeInstanceId,
        taskId: null,
        podName,
        namespace: getK8sNamespace(),
        image,
        imageTag: image.split(':').pop() ?? 'latest',
        status: 'provisioning',
        runtimeKind: requestedKind,
        // Explicit ceiling — don't inherit the stale DB default (3) on test.
        maxAgents: maxAgentsForNewDevice(),
        // 2026-05-20 — populate daemonId AT CREATE TIME (race fix). Without
        // this, the K8s row has daemonId=NULL during the entire pod-boot
        // window (~30-90s). The pod's daemon process boots, WS-connects, and
        // emits `agent.host.declare` with daemonId=<UUID injected via env>.
        // handler.ts host.declare looks up the K8s row by daemonId — but the
        // row's column is still NULL → no match → fallthrough creates a
        // legacy `deviceType=local` row with the same UUID → the UI now shows
        // TWO device cards for one daemon. The downstream update at the end
        // of provisionContainer still runs (idempotent: ctlResp.container
        // .daemonId === the UUID we mint here), so the lifecycle is unchanged
        // except the race window now closes immediately.
        daemonId,
        cpuRequest: body.cpuRequest,
        cpuLimit: body.cpuLimit,
        memoryRequest: body.memoryRequest,
        memoryLimit: body.memoryLimit,
        gatewayUrl: null,
        startedAt: null,
        provisioningStep: 'container_create',
        provisioningHistory: [],
      },
    })) as ContainerRow;

    const createArgs = {
      workspaceId: body.workspaceId,
      tenantId: workspaceOwnerImUserId,
      controllerAgentId: runtimeInstanceId,
      agentImUserId: runtimeInstanceId,
      // F8 — pass the route-minted daemonId through so provisionContainer's
      // scopedEnv merge sees the same UUID and the resulting env is
      // byte-identical to what buildWorkspaceRuntimeEnv emitted.
      daemonId,
      image,
      cpuRequest: body.cpuRequest,
      cpuLimit: body.cpuLimit,
      memoryRequest: body.memoryRequest,
      memoryLimit: body.memoryLimit,
      environment: k8sBootstrapEnv,
      onStep: emitterForRow(row.id),
    };

    let ctlResp;
    try {
      ctlResp = await k8sSandbox.provisionContainer(createArgs);
    } catch (provisionErr) {
      // 2026-05-24 — low-friction cleanup. Pre-fix this just stamped
      // status='errored' + stoppedAt, leaving the row + pod for the user to
      // manually clean (Devices panel showed permanent "daemon offline"
      // cards; orphan K8s pods sat Pending consuming scheduling slots
      // forever). Per the directive: "如果遇到资源不够的问题应该如实回报
      // 停止创建。然后把已经走完的流程的数据也删除掉" — hard-delete the
      // K8s pod + im_containers row so the workspace stays clean and the
      // wizard's failure step displays the K8s diagnostic (now carried in
      // the thrown error message thanks to k8s-sandbox.ts #16 enhancements).
      try {
        await k8sSandbox.removeContainer(podName, true);
      } catch {
        /* best-effort — pod may never have been submitted (createContainer
         * threw before the K8s API accepted the spec), or was already deleted
         * by an out-of-band sweep. removeContainer's isMissingPod check
         * already swallows 404s; this catch covers any other transient
         * delete-time errors so cleanup proceeds. */
      }
      await prisma.iMContainer.delete({ where: { id: row.id } }).catch(() => {
        /* best-effort — concurrent delete / row already gone */
      });
      throw provisionErr;
    }

    const updated = (await prisma.iMContainer.update({
      where: { id: row.id },
      data: {
        status: ctlResp.container.status,
        gatewayUrl: ctlResp.container.gatewayUrl ?? null,
        startedAt: new Date(),
        provisioningStep: null,
        // S4 §08 §5.4 D-7 close — persist the cloud-minted daemonId returned by
        // provisionContainer (it was injected into the pod via PRISMER_DAEMON_ID
        // env, and the daemon echoes it back on /healthz). Mirrors the
        // equivalent SET in `/api/sandboxes/route.ts`. Without this, /healthz
        // mismatch detection (warn-only per T11) and subsequent ack/dispatch
        // routes can't correlate daemon traffic to the container row.
        daemonId: ctlResp.container.daemonId,
      },
    })) as ContainerRow;

    await recordProvisioningStep(row.id, 'ready', 'ok');

    logger.info(
      {
        runtimeInstallationId: updated.id,
        runtimeInstanceId,
        daemonId,
        podName: updated.podName,
        workspaceId: updated.workspaceId,
        runtimeKind: requestedKind,
      },
      'workspace runtime installation created',
    );

    return NextResponse.json({ ok: true, data: toRuntimeInstallationDTO(updated) }, { status: 201 });
  } catch (err) {
    if (err instanceof K8sSandboxError) {
      // W14 — production/test should surface real K8s provisioning failures
      // as 502. The dev fallback path is handled before the create call when
      // K8S_CONTROLLER_AVAILABLE is explicitly 'false' or cluster creds are
      // missing (k8sCapable=false above).
      logger.warn(
        { errBody: err.body, status: err.status, workspaceId: body.workspaceId, runtimeInstanceId },
        'runtime installation k8s create failed',
      );
      return NextResponse.json(
        { ok: false, error: { code: 'controller_error', message: err.body, status: err.status } },
        { status: 502 },
      );
    }
    logger.error({ err, workspaceId: body.workspaceId, runtimeInstanceId }, 'runtime installation create failed');
    return NextResponse.json(
      { ok: false, error: { code: 'internal_error', message: err instanceof Error ? err.message : 'Internal error' } },
      { status: 500 },
    );
  }
}

async function resolveCloudUserId(ownerImUserId: string, numericId: number): Promise<number | null> {
  if (Number.isFinite(numericId) && numericId > 0) return numericId;
  const owner = (await prisma.iMUser.findUnique({
    where: { id: ownerImUserId },
    select: { userId: true, numericId: true },
  })) as { userId: string | null; numericId: bigint | number | null } | null;
  const fromNumeric =
    owner?.numericId == null ? 0 : typeof owner.numericId === 'bigint' ? Number(owner.numericId) : owner.numericId;
  if (Number.isFinite(fromNumeric) && fromNumeric > 0) return fromNumeric;
  const fromUserId = Number(owner?.userId);
  return Number.isFinite(fromUserId) && fromUserId > 0 ? fromUserId : null;
}

function resolveCloudBaseUrl(req: NextRequest): string {
  return (
    process.env.PRISMER_HOST_URL ??
    process.env.NEXTAUTH_URL ??
    process.env.PRISMER_BASE_URL ??
    process.env.CLOUD_URL ??
    req.nextUrl.origin
  ).replace(/\/$/, '');
}

function makeRuntimeInstanceId(): string {
  const time = Date.now().toString(36).slice(-7);
  const rand = Math.random().toString(36).slice(2, 10);
  return `rt-${time}-${rand}`.slice(0, 24);
}

/**
 * M448 (doc 20 Gap A) — validate that a project id given by the caller
 * actually belongs to the same workspace AND is in `active` status.
 * Returns null on success, or a ready-to-return 422 NextResponse otherwise.
 *
 * Style mirrors 09 §5 service invariant (project.service.ts) but kept inline
 * here to avoid a route → service round-trip for a single FK-style check.
 * No FK is declared on `im_containers.project_id` (see M448 + 09 §3.3) —
 * route layer is the integrity boundary.
 */
async function validateProjectScope(workspaceId: string, projectId: string): Promise<Response | null> {
  const project = (await prisma.iMProject.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true, status: true },
  })) as { id: string; workspaceId: string; status: string } | null;
  if (!project) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: `Project '${projectId}' does not exist.`,
        },
      },
      { status: 422 },
    );
  }
  if (project.workspaceId !== workspaceId) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'PROJECT_WORKSPACE_MISMATCH',
          message: `Project '${projectId}' belongs to a different workspace.`,
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
          message: `Project '${projectId}' is not active (status='${project.status}').`,
        },
      },
      { status: 422 },
    );
  }
  return null;
}

function runtimeKeyLabel(input: {
  workspaceId: string;
  runtimeInstanceId: string;
  daemonId: string;
  name?: string;
}): string {
  const suffix = (input.name ?? input.runtimeInstanceId ?? input.daemonId).trim();
  return `Workspace Runtime${suffix ? `: ${suffix}` : ''}`.slice(0, 255);
}

function toRuntimeInstallationDTO(row: ContainerRow, readiness?: ReadinessProbe) {
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
    // M448 (doc 20 Gap A) — project scope. `null` = workspace-level (default
    // for legacy rows pre-migration and explicit "Workspace-level" picks).
    projectId: row.projectId ?? null,
    runtimeInstanceId,
    daemonId,
    podName: row.podName,
    namespace: row.namespace,
    // Wave-8 W11 — defaulted to "docker" so legacy rows / older controller
    // payloads stay backwards-compatible. The DB column has a SQL DEFAULT
    // 'docker' but the field is optional in the read DTO; collapse to the
    // explicit literal here so consumers don't see undefined.
    runtimeKind: (row.runtimeKind as 'docker' | 'k8s' | undefined) ?? 'docker',
    // Migration 323 — §30 §2.6 device capacity. Legacy rows / pre-migration
    // schemas default to 3 (Web base subscription tier) to match the SQL
    // DEFAULT and the server-side enforcement fallback in register.ts.
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
      // Migration 322 — provisioning progress signal (workspace UI polls
      // this during device creation to render the multi-step panel).
      // step:    current in-flight step, NULL when terminal
      // history: append-only array of {step, status, startedAt, durationMs?, error?}
      step: (row as ContainerRow & { provisioningStep?: string | null }).provisioningStep ?? null,
      history: normalizeProvisioningHistory(
        (row as ContainerRow & { provisioningHistory?: unknown }).provisioningHistory,
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

/**
 * W5 — collapse the messy controller `status` enum into a 5-state container
 * readiness signal. `stoppedAt` always wins over status (DB row is the SoT
 * for lifecycle): once we set stoppedAt the controller may still report
 * `running` for a few seconds before the pod evicts.
 */
function containerStatusFromRow(row: ContainerRow): 'provisioning' | 'running' | 'failing' | 'stopped' | 'unknown' {
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

function buildEvents(row: ContainerRow, daemonId: string, phase: string) {
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
