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
import { K8sSandboxError, k8sSandbox, podNameForAgent } from '@/lib/k8s-sandbox';
import { getK8sNamespace } from '@/lib/k8s-client';
import { emitterForRow, recordProvisioningStep } from '@/lib/provisioning-progress';
import { authorizeWorkspace } from './_helpers';

const CreateBody = z.object({
  workspaceId: z.string().min(1),
  agentImUserId: z.string().optional(),
  taskId: z.string().optional(),
  image: z.string().optional(),
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
  const sandboxImage = parsed.data.image ?? process.env.SANDBOX_DEFAULT_IMAGE ?? 'prismer-sandbox:dev';

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
      image: sandboxImage,
      cpuRequest: parsed.data.cpuRequest,
      cpuLimit: parsed.data.cpuLimit,
      memoryRequest: parsed.data.memoryRequest,
      memoryLimit: parsed.data.memoryLimit,
      onStep: emitterForRow(row.id),
    };
    const ctlResp = await k8sSandbox.provisionContainer(createArgs);

    const updated = await prisma.iMContainer.update({
      where: { id: row.id },
      data: {
        status: ctlResp.container.status,
        gatewayUrl: ctlResp.container.gatewayUrl ?? null,
        startedAt: new Date(),
        provisioningStep: null,
      },
    });

    // Terminal 'ready' marker — appended after provisioningStep is cleared so
    // the history snapshot reflects the full lifecycle.
    await recordProvisioningStep(row.id, 'ready', 'ok');

    logger.info({ id: updated.id, podName: updated.podName, workspaceId: updated.workspaceId }, 'sandbox created');
    return NextResponse.json({ container: updated }, { status: 201 });
  } catch (err) {
    // Mark pre-created row as errored so the UI can stop polling.
    await prisma.iMContainer
      .update({
        where: { id: row.id },
        data: { status: 'errored', provisioningStep: null },
      })
      .catch(() => {
        /* best-effort */
      });
    if (err instanceof K8sSandboxError) {
      return NextResponse.json({ error: 'controller_error', status: err.status, body: err.body }, { status: 502 });
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
