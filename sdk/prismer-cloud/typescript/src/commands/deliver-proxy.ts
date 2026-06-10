// release202/09 P2 — in-container explicit file-delivery proxy.
//
// The in-container agent has the agent identity (PRISMER_AGENT_USERNAME) but
// NOT a usable IM credential, so its `cloud file send` / `cloud deliver`
// cannot call the IM API directly. Only the daemon holds a working credential.
// When running inside the daemon-managed container these commands proxy to the
// daemon local-server `POST /local/deliver`, which performs the upload +
// delivery with the daemon's credential.
//
// Detection: the daemon injects PRISMER_DAEMON_PORT into the agent process env
// (and PRISMER_TASK_ID / PRISMER_RUN_ID identify the dispatch). When those are
// present we are in-container and proxy; otherwise the caller falls back to the
// direct IM-API path (e.g. `prismer pair` users on their own machine).
//
// Args-fallback (release202/09 P5#1): spawn adapters (claude-code / codex) call
// applyPrismerScopeEnv() per dispatch, so the env vars above are set. But the
// hermes adapter (current default) spawns its gateway ONCE with a frozen env
// (only PRISMER_AGENT_USERNAME / PRISMER_AGENT_IM_USER_ID + inherited
// PRISMER_DAEMON_PORT); per-dispatch ids reach a hermes agent ONLY inside the
// prompt's <execution_context> XML (<run_id> / <task_id> / <conversation_id>),
// never in the tool-shell env. So env-only detection returns null on hermes and
// the proxy never activates. detectDeliverProxy() therefore accepts explicit
// overrides — a hermes agent copies the ids out of <execution_context> and
// passes them as --run-id / --conversation-id flags, which activate the proxy
// even when the env vars are absent. Explicit flag WINS over env; spawn-adapter
// agents need no flags (their env is already set).

import { resolve } from 'node:path';

export interface DeliverProxyContext {
  /** Resolved daemon local-server base URL, e.g. http://127.0.0.1:3210. */
  daemonUrl: string;
  /** Run/task id (PRISMER_TASK_ID or PRISMER_RUN_ID). */
  taskId: string;
  /** Agent handle (PRISMER_AGENT_USERNAME), forwarded for send-mode stamping. */
  agentUsername?: string;
  /** Conversation id (PRISMER_CONVERSATION_ID) when present. */
  conversationId?: string;
}

/** Explicit overrides from CLI flags (release202/09 P5#1, the hermes path). */
export interface DeliverProxyOverrides {
  /** --run-id <id> (or --task-id alias); maps to PRISMER_RUN_ID / PRISMER_TASK_ID. */
  taskId?: string;
  /** --run-id <id>; alias for taskId, kept for caller clarity. */
  runId?: string;
  /** --conversation-id <id>; maps to PRISMER_CONVERSATION_ID. */
  conversationId?: string;
  /** --daemon-port <port>; maps to PRISMER_DAEMON_PORT. */
  daemonPort?: string;
}

/**
 * Detect the in-container daemon-proxy context. An explicit override (from a
 * CLI flag) WINS over the env var for each field; when neither is present the
 * field falls back to env. Returns null when NO task/run id is resolvable from
 * EITHER flag OR env (the caller then uses its direct IM-API fallback) — so a
 * hermes agent passing --run-id activates the proxy even with no env, while
 * spawn-adapter agents keep working purely off env (no flags needed).
 *
 * The daemon's local-server publishes PRISMER_DAEMON_PORT on listen; the
 * default 3210 matches the runtime DEFAULT_LOCAL_PORT and the checkpoint
 * client in commands/task.ts.
 */
export function detectDeliverProxy(opts?: DeliverProxyOverrides): DeliverProxyContext | null {
  const taskId =
    (opts?.taskId || opts?.runId || '').trim() ||
    process.env.PRISMER_TASK_ID ||
    process.env.PRISMER_RUN_ID ||
    '';
  if (!taskId) return null;
  const port =
    ((opts?.daemonPort || '').trim() || (process.env.PRISMER_DAEMON_PORT ?? '3210').trim()) || '3210';
  const ctx: DeliverProxyContext = {
    daemonUrl: `http://127.0.0.1:${port}`,
    taskId,
  };
  const agentUsername = process.env.PRISMER_AGENT_USERNAME;
  if (agentUsername) ctx.agentUsername = agentUsername;
  const conversationId = (opts?.conversationId || '').trim() || process.env.PRISMER_CONVERSATION_ID;
  if (conversationId) ctx.conversationId = conversationId;
  return ctx;
}

export interface DeliverProxyResult {
  ok: boolean;
  assetId?: string;
  error?: string;
  status: number;
}

/**
 * POST the delivery request to the daemon local-server.
 *
 *   - mode:'attach'         (动作 A) → the file rides the agent's reply.
 *   - mode:'send'           (动作 B) → standalone message into `conversationId`.
 *   - mode:'task-attach'    (动作 ③, P5#2) → task-bound kanban deliverable; the
 *     daemon uploads with `sourceTaskId=ctx.taskId` and the cloud rolls it onto
 *     the task card. No conversationId needed.
 *   - mode:'message-attach' (动作 A2, P5#3) → append the asset to an ALREADY-SENT
 *     message. Requires `conversationId` + `messageId` (the latter returned by a
 *     prior `cloud send` / `cloud file send`). The daemon uploads then calls the
 *     cloud attach route, which re-emits `message.updated`.
 *
 * Resolves the path to absolute (the daemon reads the container FS). Returns a
 * structured result the command formats.
 */
export async function proxyDeliver(
  ctx: DeliverProxyContext,
  filePath: string,
  mode: 'attach' | 'send' | 'task-attach' | 'message-attach',
  conversationId?: string,
  messageId?: string,
): Promise<DeliverProxyResult> {
  const abs = resolve(filePath);
  const body: Record<string, unknown> = {
    taskId: ctx.taskId,
    path: abs,
    mode,
  };
  const conv = conversationId ?? ctx.conversationId;
  if (mode === 'send') {
    if (!conv) {
      return { ok: false, status: 400, error: 'conversationId is required for send mode' };
    }
    body.conversationId = conv;
  }
  if (mode === 'message-attach') {
    if (!conv) {
      return { ok: false, status: 400, error: 'conversationId is required for message-attach mode' };
    }
    if (!messageId) {
      return { ok: false, status: 400, error: 'messageId is required for message-attach mode' };
    }
    body.conversationId = conv;
    body.messageId = messageId;
  }
  if (ctx.agentUsername) body.agentUsername = ctx.agentUsername;

  let res: Response;
  try {
    res = await fetch(`${ctx.daemonUrl}/local/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: `daemon unreachable at ${ctx.daemonUrl}/local/deliver: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let parsed: { ok?: boolean; assetId?: string; error?: string } = {};
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch {
    /* non-JSON body */
  }
  if (res.ok && parsed.ok) {
    const out: DeliverProxyResult = { ok: true, status: res.status };
    if (parsed.assetId) out.assetId = parsed.assetId;
    return out;
  }
  return {
    ok: false,
    status: res.status,
    error: parsed.error ?? `daemon returned ${res.status}`,
  };
}
