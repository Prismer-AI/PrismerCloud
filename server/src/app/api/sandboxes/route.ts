/**
 * POST /api/sandboxes — create a sandbox container in the caller's workspace.
 * GET  /api/sandboxes?workspaceId=...&status=...&limit=... — list workspace containers.
 *
 * POST does:
 *   1. Validate body (zod)
 *   2. Require auth + verify workspace ownership (`authorizeWorkspace`)
 *   3. Provision via in-process K8s SDK (`k8sSandbox.provisionContainer`)
 *   4. Persist `IMContainer` row in Prisma
 *   5. Return 201 with the row
 *
 * GET does:
 *   1. Validate query (zod)
 *   2. Require auth + verify workspace ownership
 *   3. List from Prisma (no K8s round-trip — the DB is the source of truth
 *      for "what containers exist in this workspace"; the K8s API is only
 *      authoritative for live pod state, which is fetched per-id).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { podNameForAgent } from '@/lib/k8s-sandbox';
import { getK8sNamespace } from '@/lib/k8s-client';
import { emitterForRow, recordProvisioningStep } from '@/lib/provisioning-progress';
import { resolvePersistent } from '@/lib/sandbox/registry';
import { getDaemonImage } from '@/lib/sandbox/image-pin';
import { ProviderError, httpStatusForProviderError } from '@/lib/execution/errors';
import { stampAgentCardDaemonBinding } from '@/lib/sandbox/agent-card-daemon-binding';
import { authorizeWorkspace } from './_helpers';

const CreateBody = z.object({
  workspaceId: z.string().min(1),
  agentImUserId: z.string().optional(),
  taskId: z.string().optional(),
  apiKeyTtlSeconds: z.coerce.number().int().min(60).max(7200).optional(),
  image: z.string().optional(),
  // Persistent agent-runtime daemon pods (no taskId/apiKeyTtlSeconds → no
  // scoped-key mint) need a long-lived PRISMER_API_KEY injected so the daemon
  // can authenticate to cloud. Passed through to provisionContainer as
  // `environment.PRISMER_API_KEY`; the env merge keeps it because scopedEnv
  // only sets PRISMER_API_KEY on the minting path. Admin/owner-gated via
  // authorizeWorkspace above. (release202/05 — local k8s codex e2e.)
  apiKey: z.string().regex(/^sk-prismer-/).optional(),
  cpuRequest: z.string().default('250m'),
  cpuLimit: z.string().default('2000m'),
  memoryRequest: z.string().default('2Gi'),
  memoryLimit: z.string().default('4Gi'),
});

const ListQuery = z.object({
  workspaceId: z.string().min(1),
  status: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
});

export async function POST(req: NextRequest): Promise<Response> {
  const body = await req.json().catch(() => null);
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', details: parsed.error.flatten() }, { status: 400 });
  }

  const auth = await authorizeWorkspace(req, parsed.data.workspaceId);
  if (!auth.ok) return auth.response;

  // tenantId is the workspace owner — Phase 1 mapping. Multi-tenant org
  // billing (one tenant, many workspaces) is a Phase 2 concern.
  const tenantId = auth.data.workspace.ownerImUserId;
  // T8 (08 §5.2) — canonical image via image-pin.yaml. provisionContainer
  // also resolves the same fallback chain; we resolve here so the pre-row
  // image column reflects what the pod will actually pull. CONTAINER_IMAGE
  // env override is honored by getDaemonImage().
  const sandboxImage = parsed.data.image ?? getDaemonImage();

  // Pre-create the row so the workspace UI can poll progress while
  // `provisionContainer` is still mid-flight (it blocks 2-3s waiting on the
  // pod to reach Running). podName is derived deterministically from the
  // same agent-id resolution `provisionContainer` uses.
  const agentId = parsed.data.agentImUserId ?? tenantId;
  const podName = podNameForAgent(agentId);

  let row;
  try {
    row = await prisma.iMContainer.create({
      data: {
        workspaceId: parsed.data.workspaceId,
        tenantId,
        agentImUserId: parsed.data.agentImUserId ?? null,
        taskId: parsed.data.taskId ?? null,
        podName,
        namespace: getK8sNamespace(),
        image: sandboxImage,
        imageTag: sandboxImage.split(':').pop() ?? 'dev',
        status: 'provisioning',
        cpuRequest: parsed.data.cpuRequest,
        cpuLimit: parsed.data.cpuLimit,
        memoryRequest: parsed.data.memoryRequest,
        memoryLimit: parsed.data.memoryLimit,
        startedAt: null,
        provisioningStep: 'container_create',
        provisioningHistory: [],
      },
    });
  } catch (err) {
    logger.error({ err }, 'sandbox create: pre-row write failed');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  try {
    const createArgs = {
      workspaceId: parsed.data.workspaceId,
      tenantId,
      agentImUserId: parsed.data.agentImUserId,
      taskId: parsed.data.taskId,
      apiKeyTtlSeconds: parsed.data.apiKeyTtlSeconds,
      image: sandboxImage,
      ...(parsed.data.apiKey ? { environment: { PRISMER_API_KEY: parsed.data.apiKey } } : {}),
      cpuRequest: parsed.data.cpuRequest,
      cpuLimit: parsed.data.cpuLimit,
      memoryRequest: parsed.data.memoryRequest,
      memoryLimit: parsed.data.memoryLimit,
      onStep: emitterForRow(row.id),
    };
    // v200 §08 §4.5 — provider-agnostic call via registry. Create path
    // hardcodes 'k8s' because request schema doesn't yet expose providerKind;
    // the IMContainer row inherits DB DEFAULT 'k8s' (migration 336). When
    // POST schema adds providerKind, switch to parsed.data.providerKind.
    const provider = resolvePersistent('k8s');
    const ctlResp = await provider.provisionContainer(createArgs);

    const updated = await prisma.iMContainer.update({
      where: { id: row.id },
      data: {
        status: ctlResp.container.status,
        gatewayUrl: ctlResp.container.gatewayUrl ?? null,
        startedAt: new Date(),
        provisioningStep: null,
        // Release 200 §5.4 — persist cloud-minted daemonId. provisionContainer
        // generates a UUID and threads it through pod env (PRISMER_DAEMON_ID);
        // routes round-trip the value here so subsequent /healthz responses
        // can be validated against the row.
        daemonId: ctlResp.container.daemonId,
      },
    });

    if (parsed.data.agentImUserId) {
      await stampAgentCardDaemonBinding({
        prisma,
        logger,
        workspaceId: parsed.data.workspaceId,
        agentImUserId: parsed.data.agentImUserId,
        daemonId: ctlResp.container.daemonId,
      });
    }

    // Terminal 'ready' marker — appended after provisioningStep is cleared so
    // the history snapshot reflects the full lifecycle.
    await recordProvisioningStep(row.id, 'ready', 'ok');

    logger.info({ id: updated.id, podName: updated.podName, workspaceId: updated.workspaceId }, 'sandbox created');
    return NextResponse.json({ container: updated }, { status: 201 });
  } catch (err) {
    // Mark pre-created row as errored so the UI can stop polling.
    // F6 (2026-05-19) — errored is terminal; stamp stoppedAt so the UI device
    // filter (`runtime-installations` GET excludes stopped/failing/errored)
    // treats the row as dead instead of leaving it active in the device list.
    await prisma.iMContainer
      .update({
        where: { id: row.id },
        data: { status: 'errored', provisioningStep: null, stoppedAt: new Date() },
      })
      .catch(() => {
        /* best-effort */
      });
    if (err instanceof ProviderError) {
      return NextResponse.json(
        { error: err.code, message: err.message, retriable: err.retriable, providerRef: err.providerRef },
        { status: httpStatusForProviderError(err) },
      );
    }
    logger.error({ err }, 'sandbox create failed');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const parsed = ListQuery.safeParse({
    workspaceId: url.searchParams.get('workspaceId') ?? '',
    status: url.searchParams.get('status') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_query', details: parsed.error.flatten() }, { status: 400 });
  }

  const auth = await authorizeWorkspace(req, parsed.data.workspaceId);
  if (!auth.ok) return auth.response;

  const rows = await prisma.iMContainer.findMany({
    where: {
      workspaceId: parsed.data.workspaceId,
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: parsed.data.limit,
  });

  return NextResponse.json({ containers: rows });
}
