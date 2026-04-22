// Agent route handlers — extracted from daemon-http.ts (Q1 split).

import type * as http from 'node:http';
import type { AgentSupervisor, AgentStatus } from '../agent-supervisor.js';
import type { EventBus } from '../event-bus.js';
import { sendJson, parseBody, readBody } from './helpers.js';

// ============================================================
// Deps interface
// ============================================================

export interface AgentRoutesDeps {
  supervisor: AgentSupervisor;
  bus: EventBus;
}

// ============================================================
// Body-read helper with 413/400 guard (I5)
// ============================================================

async function readBodyOrFail(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<Buffer | null> {
  try {
    return await readBody(req);
  } catch (err: unknown) {
    if (err instanceof Error && (err as Error & { code?: string }).code === 'E_TOO_LARGE') {
      sendJson(res, 413, { error: 'body-too-large', max: 10 * 1024 * 1024 });
      return null;
    }
    sendJson(res, 400, { error: 'read-error' });
    return null;
  }
}

// ============================================================
// Handlers
// ============================================================

export function handleAgentList(res: http.ServerResponse, deps: AgentRoutesDeps): void {
  sendJson(res, 200, { agents: deps.supervisor.list() });
}

export function handleAgentGet(res: http.ServerResponse, id: string, deps: AgentRoutesDeps): void {
  const status: AgentStatus | undefined = deps.supervisor.get(id);
  if (status === undefined) {
    sendJson(res, 404, { error: 'not-found' });
    return;
  }
  sendJson(res, 200, status);
}

export async function handleAgentRegister(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AgentRoutesDeps,
): Promise<void> {
  const buf = await readBodyOrFail(req, res);
  if (buf === null) return;
  const body = buf.length > 0 ? parseBody(buf) : undefined;
  if (!body || typeof body !== 'object') {
    sendJson(res, 400, { error: 'bad-json' });
    return;
  }

  const input = body as Record<string, unknown>;
  const id = typeof input['id'] === 'string' ? input['id'] : undefined;
  const name = typeof input['name'] === 'string' ? input['name'] : id;
  const command = typeof input['command'] === 'string' ? input['command'] : undefined;
  if (!id || !name || !command) {
    sendJson(res, 400, { error: 'id-name-command-required' });
    return;
  }

  const args = Array.isArray(input['args'])
    ? input['args'].filter((arg): arg is string => typeof arg === 'string')
    : undefined;
  const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : undefined;
  const attachPid = typeof input['attachPid'] === 'number' ? input['attachPid'] : undefined;

  try {
    const existing = deps.supervisor.get(id);
    if (existing !== undefined) {
      sendJson(res, 200, { ok: true, alreadyRegistered: true, agent: existing });
      return;
    }

    deps.supervisor.register({ id, name, command, args, cwd, attachPid });
    sendJson(res, 201, { ok: true, agent: deps.supervisor.get(id) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 409, { ok: false, error: message });
  }
}

export async function handleAgentMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agentId: string,
  deps: AgentRoutesDeps,
): Promise<void> {
  const buf = await readBodyOrFail(req, res);
  if (buf === null) return;
  const body = parseBody(buf);
  if (body === undefined) {
    sendJson(res, 400, { error: 'bad-json' });
    return;
  }
  const { type, payload } = body as { type: string; payload: unknown };
  deps.bus.publish('agent.message.in', { agentId, type, payload }, { source: 'http' });
  sendJson(res, 200, { ok: true });
}

export async function handleAgentStop(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agentId: string,
  deps: AgentRoutesDeps,
): Promise<void> {
  const buf = await readBodyOrFail(req, res);
  if (buf === null) return;

  const body = buf.length > 0 ? parseBody(buf) : {};
  const reason = (body as { reason?: string })?.reason;

  const timeoutHandle = setTimeout(() => {
    if (!res.headersSent) {
      sendJson(res, 202, {
        accepted: true,
        note: 'stop initiated but agent not yet stopped — poll for status',
      });
    }
  }, 1000);

  try {
    await deps.supervisor.stop(agentId, reason);
    clearTimeout(timeoutHandle);
    if (!res.headersSent) {
      sendJson(res, 200, { ok: true });
    }
  } catch (err: unknown) {
    clearTimeout(timeoutHandle);
    if (!res.headersSent) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 404, { error: 'not-found', message: msg });
    }
  }
}

export async function handleAgentApprove(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agentId: string,
  deps: AgentRoutesDeps,
): Promise<void> {
  const buf = await readBodyOrFail(req, res);
  if (buf === null) return;
  const body = parseBody(buf);
  if (body === undefined) {
    sendJson(res, 400, { error: 'bad-json' });
    return;
  }
  const { requestId, decision, scope } = body as {
    requestId: string;
    decision: 'allow' | 'deny';
    scope?: 'once' | 'session' | 'always';
  };
  deps.bus.publish('permission.decided', { agentId, requestId, decision, scope }, { source: 'http' });
  sendJson(res, 200, { ok: true });
}
