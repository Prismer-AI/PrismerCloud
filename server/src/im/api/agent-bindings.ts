/**
 * Prismer IM — Agent Binding API (v2.0 §4.8.2, Wave 2-B2)
 *
 * Endpoints:
 *   GET    /workspaces/:wsId/agent-bindings
 *          → list all agent bindings inside a workspace + contested flag
 *
 *   POST   /agent-bindings/:agentImUserId/rebind
 *          body: { targetDaemonId, targetDaemonKind?, targetDaemonLabel?, reason }
 *          → user explicit rebind; writes audit trail via boundBy='user-explicit'
 *          → in-flight task count returned so UI can surface "N tasks finishing
 *            on the previous owner before traffic switches"
 *
 *   POST   /agent-bindings/transfer  (release201/09 §9.7.2 Phase 3)
 *          body: { agentId, fromDaemonId, toDaemonId, manifestSha256 }
 *          → SDK-driven full agent transfer:
 *            1. Verify current binding.boundDaemonId == fromDaemonId
 *            2. Update binding.boundDaemonId = toDaemonId, boundBy='transfer'
 *            3. Clear pausedAt (resume dispatch on new device)
 *            4. Emit `agent.binding.rebound` sync event with reason='transfer'
 *               (transfer log lives in sync_events, no separate IMAgentBindingTransferLog
 *               table; §16 D12)
 *          v2.0.7 不校验 cloud-side expected manifestSha256 — 信任源 device
 *          签名(daemon api_key HMAC);v2.1+ cloud 维护 expected hash 后再补
 *          严格校验。
 *
 * Auth: only workspace owner OR appointed orchestrator OR cloud admin can call
 * mutations. List is workspace-owner-only (orchestrator can also read).
 */

import { Hono } from 'hono';
import prisma from '../db';
import { authMiddleware } from '../auth/middleware';
import { AgentBindingService, AgentBindingNotFoundError } from '../services/agent-binding.service';
import type { SyncService } from '../services/sync.service';
import type { ApiResponse } from '../types/index';

interface CreateAgentBindingRouterDeps {
  syncService?: SyncService;
}

export function createAgentBindingsRouter(deps: CreateAgentBindingRouterDeps = {}) {
  const router = new Hono();
  // Wave 5 F1: replaced `router.use('*', authMiddleware)` with path-specific
  // wildcards. The previous wildcard leaked through Hono's app.route('/', sub)
  // mount: middleware on the sub-router applied to ALL routes registered on
  // the parent app AFTER the sub mount (verified empirically), which meant
  // daemon-initiated calls to /dispatch/:taskId/{prepare,commit} got rejected
  // by the user-JWT-checking authMiddleware before reaching the dispatch
  // router's own daemon-auth bypass. Scoping the middleware to the two
  // namespaces this router owns avoids the leak.
  router.use('/workspaces/*', authMiddleware);
  router.use('/agent-bindings/*', authMiddleware);

  const service = new AgentBindingService(prisma as any, deps.syncService);

  // GET /workspaces/:wsId/agent-bindings
  router.get('/workspaces/:wsId/agent-bindings', async (c) => {
    const user = c.get('user');
    const wsId = c.req.param('wsId');
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: wsId, deletedAt: null },
      select: { id: true, ownerImUserId: true, orchestratorAgentId: true, orchestratorRevokedAt: true },
    });
    if (!ws) {
      return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    }
    const isOwner = ws.ownerImUserId === user.imUserId;
    const isActiveOrchestrator = ws.orchestratorAgentId === user.imUserId && ws.orchestratorRevokedAt === null;
    if (!isOwner && !isActiveOrchestrator) {
      return c.json<ApiResponse>({ ok: false, error: 'Forbidden' }, 403);
    }

    const rows = await service.listByWorkspace(wsId);
    const data = rows.map((row) => ({
      agentImUserId: row.binding.agentImUserId,
      agentName: row.agentName,
      boundDaemonId: row.binding.boundDaemonId,
      boundDaemonKind: row.binding.boundDaemonKind,
      boundDaemonLabel: row.binding.boundDaemonLabel,
      boundAt: row.binding.boundAt.toISOString(),
      boundBy: row.binding.boundBy,
      lastHostDeclareAt: row.binding.lastHostDeclareAt.toISOString(),
      lastDispatchAt: row.binding.lastDispatchAt ? row.binding.lastDispatchAt.toISOString() : null,
      contested: row.contested,
      contestedSince: row.binding.contestedSince ? row.binding.contestedSince.toISOString() : null,
      contestCount: row.binding.contestCount,
    }));
    c.header('Cache-Control', 'no-store');
    return c.json<ApiResponse<{ bindings: typeof data }>>({ ok: true, data: { bindings: data } });
  });

  // POST /agent-bindings/:agentImUserId/rebind
  router.post('/agent-bindings/:agentImUserId/rebind', async (c) => {
    const user = c.get('user');
    const agentImUserId = c.req.param('agentImUserId');
    let body: {
      targetDaemonId?: string;
      targetDaemonKind?: 'k8s' | 'local' | 'edge';
      targetDaemonLabel?: string;
      reason?: string;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'invalid_json' }, 400);
    }
    const targetDaemonId = body.targetDaemonId?.trim();
    if (!targetDaemonId) {
      return c.json<ApiResponse>({ ok: false, error: 'targetDaemonId is required' }, 400);
    }

    // Auth: actor must own the agent's workspace OR be the active orchestrator
    // OR be a cloud admin. Locate the agent's workspace via IMAgentCard.
    const card = await prisma.iMAgentCard.findFirst({
      where: { imUserId: agentImUserId },
      select: { workspaceId: true },
    });
    if (!card?.workspaceId) {
      return c.json<ApiResponse>({ ok: false, error: 'Agent not found or has no workspace' }, 404);
    }
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: card.workspaceId, deletedAt: null },
      select: { id: true, ownerImUserId: true, orchestratorAgentId: true, orchestratorRevokedAt: true },
    });
    if (!ws) {
      return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    }
    const isOwner = ws.ownerImUserId === user.imUserId;
    const isActiveOrchestrator = ws.orchestratorAgentId === user.imUserId && ws.orchestratorRevokedAt === null;
    const isAdmin = user.role === 'admin';
    if (!isOwner && !isActiveOrchestrator && !isAdmin) {
      return c.json<ApiResponse>({ ok: false, error: 'Forbidden' }, 403);
    }

    // Validate target daemon: must have an im_containers row in this workspace
    // (any kind), to refuse rebind to a fictional daemonId.
    const container = await prisma.iMContainer.findFirst({
      where: { workspaceId: ws.id, daemonId: targetDaemonId },
      select: {
        id: true,
        deviceType: true,
        runtimeKind: true,
        status: true,
        podName: true,
        stoppedAt: true,
      },
    });
    if (!container) {
      return c.json<ApiResponse>(
        { ok: false, error: `target daemon ${targetDaemonId} not registered in workspace` },
        400,
      );
    }
    if (container.stoppedAt && container.status === 'stopped') {
      return c.json<ApiResponse>({ ok: false, error: `target daemon ${targetDaemonId} is stopped` }, 409);
    }
    const inferredKind: 'k8s' | 'local' | 'edge' =
      body.targetDaemonKind ??
      (container.deviceType === 'k8s' ? 'k8s' : container.deviceType === 'edge' ? 'edge' : 'local');
    const inferredLabel = body.targetDaemonLabel ?? container.podName ?? targetDaemonId;

    try {
      const result = await service.rebind({
        agentImUserId,
        targetDaemonId,
        targetDaemonKind: inferredKind,
        targetDaemonLabel: inferredLabel,
        actorImUserId: user.imUserId,
        reason: (body.reason ?? '').trim() || 'unspecified',
      });
      return c.json<
        ApiResponse<{
          binding: {
            agentImUserId: string;
            boundDaemonId: string;
            boundDaemonKind: string;
            boundDaemonLabel: string;
            boundBy: string;
            boundAt: string;
          };
          inFlightTaskCount: number;
          previousDaemonId: string;
        }>
      >({
        ok: true,
        data: {
          binding: {
            agentImUserId: result.binding.agentImUserId,
            boundDaemonId: result.binding.boundDaemonId,
            boundDaemonKind: result.binding.boundDaemonKind,
            boundDaemonLabel: result.binding.boundDaemonLabel,
            boundBy: result.binding.boundBy,
            boundAt: result.binding.boundAt.toISOString(),
          },
          inFlightTaskCount: result.inFlightTaskCount,
          previousDaemonId: result.previousDaemonId,
        },
      });
    } catch (err) {
      if (err instanceof AgentBindingNotFoundError) {
        return c.json<ApiResponse>(
          {
            ok: false,
            error: 'No binding row exists for this agent yet. The daemon must first run host.declare to create one.',
          },
          404,
        );
      }
      return c.json<ApiResponse>({ ok: false, error: `rebind failed: ${(err as Error).message}` }, 500);
    }
  });

  // release201/09 §9.7.2 — POST /agent-bindings/transfer
  router.post('/agent-bindings/transfer', async (c) => {
    const user = c.get('user');
    let body: {
      agentId?: string;
      fromDaemonId?: string;
      toDaemonId?: string;
      manifestSha256?: string;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'invalid_json' }, 400);
    }
    const agentId = body.agentId?.trim();
    const fromDaemonId = body.fromDaemonId?.trim();
    const toDaemonId = body.toDaemonId?.trim();
    const manifestSha256 = body.manifestSha256?.trim();
    if (!agentId || !fromDaemonId || !toDaemonId || !manifestSha256) {
      return c.json<ApiResponse>(
        { ok: false, error: 'agentId, fromDaemonId, toDaemonId, manifestSha256 are all required' },
        400,
      );
    }
    if (fromDaemonId === toDaemonId) {
      return c.json<ApiResponse>({ ok: false, error: 'fromDaemonId == toDaemonId; nothing to transfer' }, 400);
    }

    // Resolve workspace via IMAgentCard; auth is workspace owner OR
    // orchestrator OR admin (same as rebind).
    const card = await prisma.iMAgentCard.findFirst({
      where: { imUserId: agentId },
      select: { workspaceId: true },
    });
    if (!card?.workspaceId) {
      return c.json<ApiResponse>({ ok: false, error: 'Agent not found or has no workspace' }, 404);
    }
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: card.workspaceId, deletedAt: null },
      select: { id: true, ownerImUserId: true, orchestratorAgentId: true, orchestratorRevokedAt: true },
    });
    if (!ws) {
      return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    }
    const isOwner = ws.ownerImUserId === user.imUserId;
    const isActiveOrchestrator = ws.orchestratorAgentId === user.imUserId && ws.orchestratorRevokedAt === null;
    const isAdmin = user.role === 'admin';
    if (!isOwner && !isActiveOrchestrator && !isAdmin) {
      return c.json<ApiResponse>({ ok: false, error: 'Forbidden' }, 403);
    }

    // Verify current binding state.
    const existing = await prisma.iMAgentBinding.findUnique({
      where: { agentImUserId: agentId },
    });
    if (!existing) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'No binding row exists for this agent; export from a device that has hosted it first',
        },
        404,
      );
    }
    if (existing.boundDaemonId !== fromDaemonId) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `fromDaemonId mismatch: current owner is ${existing.boundDaemonId}, request claims ${fromDaemonId}. Re-export from the actual owner.`,
        },
        409,
      );
    }

    // Optional: validate target daemon is registered. Mirror rebind behaviour
    // for symmetry — only fail with 400 when the target has never declared a
    // container row, since transfer must land on a known device.
    const targetContainer = await prisma.iMContainer.findFirst({
      where: { workspaceId: ws.id, daemonId: toDaemonId },
      select: {
        id: true,
        deviceType: true,
        runtimeKind: true,
        status: true,
        podName: true,
        stoppedAt: true,
      },
    });
    if (!targetContainer) {
      return c.json<ApiResponse>({ ok: false, error: `target daemon ${toDaemonId} not registered in workspace` }, 400);
    }
    const targetKind: 'k8s' | 'local' | 'edge' =
      targetContainer.deviceType === 'k8s' ? 'k8s' : targetContainer.deviceType === 'edge' ? 'edge' : 'local';
    const targetLabel = targetContainer.podName ?? toDaemonId;

    const now = new Date();
    const updated = await prisma.iMAgentBinding.update({
      where: { agentImUserId: agentId },
      data: {
        boundDaemonId: toDaemonId,
        boundDaemonKind: targetKind,
        boundDaemonLabel: targetLabel,
        boundBy: 'transfer',
        boundAt: now,
        lastHostDeclareAt: now,
        contestedSince: null,
        // Resume dispatch on the new device — agent was paused by SDK
        // before export; transfer endpoint atomically unpauses on rebind.
        pausedAt: null,
      },
    });

    // Audit trail — reuse `agent.binding.rebound` sync event with
    // reason='transfer' + manifestSha256 metadata. §16 D12 explicitly
    // chose not to create a separate IMAgentBindingTransferLog table.
    if (deps.syncService) {
      try {
        await deps.syncService.writeEvent(
          'agent.binding.rebound',
          {
            agentImUserId: agentId,
            previousDaemonId: existing.boundDaemonId,
            newDaemonId: toDaemonId,
            reason: 'transfer',
            actorImUserId: user.imUserId,
            inFlightTaskCount: 0,
            manifestSha256,
          },
          null,
          ws.ownerImUserId ?? user.imUserId,
        );
      } catch (err) {
        // Sync event failure must not break the transfer reply — the
        // binding row itself is already correct.
        console.warn(`[AgentBindings] transfer sync event failed for agent ${agentId}: ${(err as Error).message}`);
      }
    }

    return c.json<ApiResponse>({
      ok: true,
      data: {
        agentImUserId: updated.agentImUserId,
        previousDaemonId: existing.boundDaemonId,
        boundDaemonId: updated.boundDaemonId,
        boundDaemonKind: updated.boundDaemonKind,
        boundDaemonLabel: updated.boundDaemonLabel,
        boundBy: updated.boundBy,
        boundAt: updated.boundAt.toISOString(),
        manifestSha256,
      },
    });
  });

  return router;
}
