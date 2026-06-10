/**
 * Prismer IM — 3-stage agent transfer protocol (release201/09 §9.7 Phase 3).
 *
 * Endpoints:
 *   POST   /agent-transfer/initiate           body: { agentId, fromDaemonId, toDaemonId }
 *          → 校验 actor (workspace owner / orchestrator / admin / agent owner)
 *          → 校验 binding.boundDaemonId == fromDaemonId
 *          → 校验 toDaemonId 在 workspace 内的 IMContainer 存在 & 未 stopped
 *          → 写入 transferState='initiated' + transferToDaemonId=<toDaemonId>
 *            + transferInitiatedAt=NOW + pausedAt=NOW (quiesce)
 *          → 返 { transferId, agentId, fromDaemonId, toDaemonId, status: 'initiated' }
 *          transferId 用 `${agentId}.${initiatedAt.getTime()}` (无单独表;
 *            agentImUserId 是 1:1 owner of transfer state — 这套设计与现有
 *            agent-bindings/transfer 字段单表方案一致, §16 D12)
 *
 *   POST   /agent-transfer/:transferId/complete  body: { tarballHash }
 *          → 由目标 daemon 调,确认收 tarball + hash
 *          → 校验 transferState='initiated' + transferId 解析对应的 agent
 *          → 把 boundDaemonId 改成 transferToDaemonId, boundBy='transfer',
 *            清 pausedAt / transferState / transferToDaemonId / transferInitiatedAt
 *          → emit sync_events 'agent.transfer.completed'
 *
 *   POST   /agent-transfer/:transferId/abort     body: { reason }
 *          → 任一方调,清 transferState / transferToDaemonId /
 *            transferInitiatedAt + pausedAt,boundDaemonId 不动
 *          → emit sync_events 'agent.transfer.aborted'
 *
 * 与现有 POST /api/im/agent-bindings/transfer 的关系:
 *   - 现有 single-shot transfer endpoint 仍可用 (CLI `prismer agent
 *     export/import` 走它),目标场景:管理员瞬时切 binding (无 quiesce 间隔)。
 *   - 本 3-stage 协议提供 export/import 间隔可观察的 2PC 语义,目标场景:
 *     daemon 互信不充分时分布式 SDK 协调(initiate 由源 device 触发,complete
 *     由目标 device 触发,abort 任一方触发)。两套并存,不互冲突。
 *
 * Auth: workspace owner / active orchestrator / cloud admin / agent owner
 * (agent owner = IMAgentCard.ownerImUserId, 09 §5 三态 + agent owner 兜底)。
 *
 * Idempotency:
 *   - initiate 当 transferState='initiated' && transferToDaemonId 相等时返
 *     原 transferId (idempotent on retry); 不同 toDaemonId 时 409。
 *   - complete / abort 当 transferState='idle' 时 410 'transfer_not_active'。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import prisma from '../db';
import { authMiddleware } from '../auth/middleware';
import type { SyncService } from '../services/sync.service';
import type { ApiResponse } from '../types/index';

interface CreateAgentTransferRouterDeps {
  syncService?: SyncService;
}

// transferId 是 `${agentImUserId}.${initiatedAt.getTime()}` 形式 — 解析时
// 反向拆出 agent + ts，并校验当前 IMAgentBinding 的 transferInitiatedAt
// 与 ts 匹配 (防止历史 transferId 误调老 transfer)。
function parseTransferId(transferId: string): { agentImUserId: string; initiatedAtMs: number } | null {
  const idx = transferId.lastIndexOf('.');
  if (idx <= 0 || idx === transferId.length - 1) return null;
  const agentImUserId = transferId.slice(0, idx);
  const tsStr = transferId.slice(idx + 1);
  const ts = Number(tsStr);
  if (!agentImUserId || !Number.isFinite(ts) || ts <= 0) return null;
  return { agentImUserId, initiatedAtMs: ts };
}

function buildTransferId(agentImUserId: string, initiatedAt: Date): string {
  return `${agentImUserId}.${initiatedAt.getTime()}`;
}

async function resolveAuth(
  c: Context,
  agentImUserId: string,
): Promise<
  { ok: true; workspaceOwnerImUserId: string; workspaceId: string } | { ok: false; status: 403 | 404; error: string }
> {
  const user = c.get('user') as { imUserId: string; role?: string };
  const card = await prisma.iMAgentCard.findFirst({
    where: { imUserId: agentImUserId },
    select: { workspaceId: true, ownerImUserId: true },
  });
  if (!card?.workspaceId) return { ok: false, status: 404, error: 'Agent not found or has no workspace' };
  const ws = await prisma.iMWorkspace.findFirst({
    where: { id: card.workspaceId, deletedAt: null },
    select: { id: true, ownerImUserId: true, orchestratorAgentId: true, orchestratorRevokedAt: true },
  });
  if (!ws) return { ok: false, status: 404, error: 'Workspace not found' };
  const isWsOwner = ws.ownerImUserId === user.imUserId;
  const isActiveOrchestrator = ws.orchestratorAgentId === user.imUserId && ws.orchestratorRevokedAt === null;
  const isAdmin = user.role === 'admin';
  const isAgentOwner = card.ownerImUserId === user.imUserId;
  if (!isWsOwner && !isActiveOrchestrator && !isAdmin && !isAgentOwner) {
    return { ok: false, status: 403, error: 'Forbidden' };
  }
  return { ok: true, workspaceOwnerImUserId: ws.ownerImUserId ?? user.imUserId, workspaceId: ws.id };
}

export function createAgentTransferRouter(deps: CreateAgentTransferRouterDeps = {}) {
  const router = new Hono();
  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /agent-transfer in routes.ts; wildcard scoped to that prefix
  router.use('*', authMiddleware);

  // POST /agent-transfer/initiate
  router.post('/initiate', async (c) => {
    let body: { agentId?: string; fromDaemonId?: string; toDaemonId?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'invalid_json' }, 400);
    }
    const agentId = body.agentId?.trim();
    const fromDaemonId = body.fromDaemonId?.trim();
    const toDaemonId = body.toDaemonId?.trim();
    if (!agentId || !fromDaemonId || !toDaemonId) {
      return c.json<ApiResponse>({ ok: false, error: 'agentId, fromDaemonId, toDaemonId are all required' }, 400);
    }
    if (fromDaemonId === toDaemonId) {
      return c.json<ApiResponse>({ ok: false, error: 'fromDaemonId == toDaemonId; nothing to transfer' }, 400);
    }

    const auth = await resolveAuth(c, agentId);
    if (!auth.ok) return c.json<ApiResponse>({ ok: false, error: auth.error }, auth.status);

    const existing = await prisma.iMAgentBinding.findUnique({ where: { agentImUserId: agentId } });
    if (!existing) {
      return c.json<ApiResponse>(
        { ok: false, error: 'No binding row exists; agent has never been declared by a daemon' },
        404,
      );
    }
    if (existing.boundDaemonId !== fromDaemonId) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `fromDaemonId mismatch: current owner is ${existing.boundDaemonId}, request claims ${fromDaemonId}`,
        },
        409,
      );
    }

    // Idempotency: same agentId + same toDaemonId + state='initiated' → reuse.
    if (existing.transferState === 'initiated') {
      if (existing.transferToDaemonId === toDaemonId && existing.transferInitiatedAt) {
        return c.json<ApiResponse>({
          ok: true,
          data: {
            transferId: buildTransferId(agentId, existing.transferInitiatedAt),
            agentId,
            fromDaemonId,
            toDaemonId,
            status: 'initiated',
            initiatedAt: existing.transferInitiatedAt.toISOString(),
            idempotent: true,
          },
        });
      }
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Another transfer is already in flight for this agent (to=${existing.transferToDaemonId}); abort it first`,
        },
        409,
      );
    }

    // Validate target daemon row exists in workspace.
    const target = await prisma.iMContainer.findFirst({
      where: { workspaceId: auth.workspaceId, daemonId: toDaemonId },
      select: { id: true, status: true, stoppedAt: true },
    });
    if (!target) {
      return c.json<ApiResponse>({ ok: false, error: `target daemon ${toDaemonId} not registered in workspace` }, 400);
    }
    if (target.stoppedAt && target.status === 'stopped') {
      return c.json<ApiResponse>({ ok: false, error: `target daemon ${toDaemonId} is stopped` }, 409);
    }

    const now = new Date();
    await prisma.iMAgentBinding.update({
      where: { agentImUserId: agentId },
      data: {
        transferState: 'initiated',
        transferToDaemonId: toDaemonId,
        transferInitiatedAt: now,
        // Quiesce dispatch — atomic with state set so we never have a window
        // where transfer is in flight but cloud still routes to the source.
        pausedAt: now,
      },
    });

    if (deps.syncService) {
      try {
        await deps.syncService.writeEvent(
          'agent.transfer.initiated',
          {
            agentImUserId: agentId,
            fromDaemonId,
            toDaemonId,
            initiatedAt: now.toISOString(),
            actorImUserId: (c.get('user') as { imUserId: string }).imUserId,
          },
          null,
          auth.workspaceOwnerImUserId,
        );
      } catch (err) {
        console.warn(`[AgentTransfer] initiate sync event failed agent=${agentId}: ${(err as Error).message}`);
      }
    }

    return c.json<ApiResponse>(
      {
        ok: true,
        data: {
          transferId: buildTransferId(agentId, now),
          agentId,
          fromDaemonId,
          toDaemonId,
          status: 'initiated',
          initiatedAt: now.toISOString(),
        },
      },
      201,
    );
  });

  // POST /agent-transfer/:transferId/complete
  router.post('/:transferId/complete', async (c) => {
    const transferId = c.req.param('transferId');
    const parsed = parseTransferId(transferId);
    if (!parsed) {
      return c.json<ApiResponse>({ ok: false, error: 'invalid transferId' }, 400);
    }
    let body: { tarballHash?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'invalid_json' }, 400);
    }
    const tarballHash = body.tarballHash?.trim();
    if (!tarballHash) {
      return c.json<ApiResponse>({ ok: false, error: 'tarballHash is required' }, 400);
    }

    const auth = await resolveAuth(c, parsed.agentImUserId);
    if (!auth.ok) return c.json<ApiResponse>({ ok: false, error: auth.error }, auth.status);

    const existing = await prisma.iMAgentBinding.findUnique({
      where: { agentImUserId: parsed.agentImUserId },
    });
    if (!existing) {
      return c.json<ApiResponse>({ ok: false, error: 'binding not found' }, 404);
    }
    if (existing.transferState !== 'initiated' || !existing.transferToDaemonId) {
      return c.json<ApiResponse>({ ok: false, error: 'transfer_not_active' }, 410);
    }
    if (!existing.transferInitiatedAt || existing.transferInitiatedAt.getTime() !== parsed.initiatedAtMs) {
      return c.json<ApiResponse>(
        { ok: false, error: 'transferId does not match current transfer; possibly stale' },
        409,
      );
    }

    // Target daemon kind / label snapshot (same lookup as single-shot rebind).
    const targetContainer = await prisma.iMContainer.findFirst({
      where: { workspaceId: auth.workspaceId, daemonId: existing.transferToDaemonId },
      select: { deviceType: true, podName: true },
    });
    const targetKind: 'k8s' | 'local' | 'edge' =
      targetContainer?.deviceType === 'k8s' ? 'k8s' : targetContainer?.deviceType === 'edge' ? 'edge' : 'local';
    const targetLabel = targetContainer?.podName ?? existing.transferToDaemonId;

    const now = new Date();
    const previousDaemonId = existing.boundDaemonId;
    const newDaemonId = existing.transferToDaemonId;
    await prisma.iMAgentBinding.update({
      where: { agentImUserId: parsed.agentImUserId },
      data: {
        boundDaemonId: newDaemonId,
        boundDaemonKind: targetKind,
        boundDaemonLabel: targetLabel,
        boundBy: 'transfer',
        boundAt: now,
        lastHostDeclareAt: now,
        contestedSince: null,
        pausedAt: null,
        transferState: 'idle',
        transferToDaemonId: null,
        transferInitiatedAt: null,
      },
    });

    if (deps.syncService) {
      try {
        await deps.syncService.writeEvent(
          'agent.transfer.completed',
          {
            agentImUserId: parsed.agentImUserId,
            previousDaemonId,
            newDaemonId,
            tarballHash,
            completedAt: now.toISOString(),
            actorImUserId: (c.get('user') as { imUserId: string }).imUserId,
          },
          null,
          auth.workspaceOwnerImUserId,
        );
      } catch (err) {
        console.warn(
          `[AgentTransfer] complete sync event failed agent=${parsed.agentImUserId}: ${(err as Error).message}`,
        );
      }
    }

    return c.json<ApiResponse>({
      ok: true,
      data: {
        transferId,
        agentId: parsed.agentImUserId,
        previousDaemonId,
        newDaemonId,
        boundAt: now.toISOString(),
        status: 'completed',
        tarballHash,
      },
    });
  });

  // POST /agent-transfer/:transferId/abort
  router.post('/:transferId/abort', async (c) => {
    const transferId = c.req.param('transferId');
    const parsed = parseTransferId(transferId);
    if (!parsed) {
      return c.json<ApiResponse>({ ok: false, error: 'invalid transferId' }, 400);
    }
    let body: { reason?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      // abort allows empty body — reason is optional.
      body = {};
    }
    const reason = (body.reason ?? '').trim() || 'unspecified';

    const auth = await resolveAuth(c, parsed.agentImUserId);
    if (!auth.ok) return c.json<ApiResponse>({ ok: false, error: auth.error }, auth.status);

    const existing = await prisma.iMAgentBinding.findUnique({
      where: { agentImUserId: parsed.agentImUserId },
    });
    if (!existing) {
      return c.json<ApiResponse>({ ok: false, error: 'binding not found' }, 404);
    }
    if (existing.transferState !== 'initiated') {
      return c.json<ApiResponse>({ ok: false, error: 'transfer_not_active' }, 410);
    }
    if (!existing.transferInitiatedAt || existing.transferInitiatedAt.getTime() !== parsed.initiatedAtMs) {
      return c.json<ApiResponse>(
        { ok: false, error: 'transferId does not match current transfer; possibly stale' },
        409,
      );
    }

    const now = new Date();
    await prisma.iMAgentBinding.update({
      where: { agentImUserId: parsed.agentImUserId },
      data: {
        transferState: 'idle',
        transferToDaemonId: null,
        transferInitiatedAt: null,
        // Clear the pause atomically — agent resumes on the SOURCE device.
        pausedAt: null,
      },
    });

    if (deps.syncService) {
      try {
        await deps.syncService.writeEvent(
          'agent.transfer.aborted',
          {
            agentImUserId: parsed.agentImUserId,
            fromDaemonId: existing.boundDaemonId,
            attemptedToDaemonId: existing.transferToDaemonId,
            abortedAt: now.toISOString(),
            reason,
            actorImUserId: (c.get('user') as { imUserId: string }).imUserId,
          },
          null,
          auth.workspaceOwnerImUserId,
        );
      } catch (err) {
        console.warn(
          `[AgentTransfer] abort sync event failed agent=${parsed.agentImUserId}: ${(err as Error).message}`,
        );
      }
    }

    return c.json<ApiResponse>({
      ok: true,
      data: {
        transferId,
        agentId: parsed.agentImUserId,
        status: 'aborted',
        reason,
        abortedAt: now.toISOString(),
      },
    });
  });

  return router;
}
