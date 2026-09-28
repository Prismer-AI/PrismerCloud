// release203/08 WS-E — out-of-band code-agent session control (daemon side).
//
// Pure handler for the agent.session.{set_model,list_commands,rewind} control
// frames. The runner forwards the frame here with a resolver that maps the
// target agent → its live AdapterService (same servicePool the dispatch/cancel
// paths use). We call the optional contract member (setModel / listCommands /
// revert) and return a reply object the runner echoes back over WS with the
// request's `_rpcId` (mirrors webhook.dispatch.reply correlation).
//
// Driver-only by nature: CodeAgentDriver implements these optional members.
// Non-driver adapters (hermes/openclaw) leave them undefined → we return
// ok:false code='unsupported' (no-op), never throw. INTERRUPT is NOT here —
// task.cancel already maps to session.interrupt() (turn-scoped).

import type { AdapterService } from '../adapters/contract.js';

export type AgentSessionControlKind = 'set_model' | 'list_commands' | 'rewind';

export interface AgentSessionControlPayload {
  agentImUserId?: string;
  taskId?: string;
  modelId?: string;
  messageId?: string;
  scope?: 'conversation' | 'files' | 'both';
  _rpcId?: string;
}

export interface AgentSessionControlReply {
  _rpcId?: string;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

/**
 * Resolve the live AdapterService for the target agent. The runner supplies a
 * resolver that iterates the hosted agent's profiles against the ServicePool,
 * preferring one that implements the requested control member.
 */
export type ResolveService = (
  agentImUserId: string,
  kind: AgentSessionControlKind,
) => AdapterService | undefined;

export async function handleAgentSessionControl(
  kind: AgentSessionControlKind,
  payload: AgentSessionControlPayload,
  resolveService: ResolveService,
): Promise<AgentSessionControlReply> {
  const rpcId = payload._rpcId;
  const fail = (code: string, message: string): AgentSessionControlReply => ({
    _rpcId: rpcId,
    ok: false,
    error: { code, message },
  });

  try {
    const agentImUserId = payload.agentImUserId;
    if (!agentImUserId) return fail('bad_request', 'agentImUserId is required');

    const service = resolveService(agentImUserId, kind);
    if (!service) {
      return fail('no_live_session', `no live session for agent ${agentImUserId}`);
    }

    if (kind === 'set_model') {
      if (typeof service.setModel !== 'function') {
        return fail('unsupported', 'adapter does not support set_model');
      }
      if (!payload.modelId) return fail('bad_request', 'modelId is required');
      await service.setModel(payload.modelId);
      return { _rpcId: rpcId, ok: true, data: { ok: true } };
    }

    if (kind === 'list_commands') {
      if (typeof service.listCommands !== 'function') {
        return fail('unsupported', 'adapter does not support list_commands');
      }
      const commands = await service.listCommands();
      return { _rpcId: rpcId, ok: true, data: { commands } };
    }

    // rewind
    if (typeof service.revert !== 'function') {
      return fail('unsupported', 'adapter does not support rewind');
    }
    if (!payload.messageId) return fail('bad_request', 'messageId is required');
    await service.revert({ messageId: payload.messageId, scope: payload.scope });
    return { _rpcId: rpcId, ok: true, data: { ok: true } };
  } catch (err) {
    return fail('control_failed', (err as Error).message);
  }
}
