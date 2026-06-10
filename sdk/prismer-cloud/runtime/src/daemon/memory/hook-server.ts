// v2.1 §9.5 — daemon-as-hook-intake HTTP routes.
//
// Three local-only routes (127.0.0.1 trust boundary, no Bearer auth):
//
//   POST /v1/hooks/pre_llm_call?profile=&adapter=&session=
//     stdin: Hermes shell-hook JSON (§9.5.6 schema)
//     resolve agent context from query/registry, do ScopedMemoryStore
//     multi-pass recall, return {"context": "...[Relevant memory]..."}
//
//   POST /v1/hooks/post_llm_call?profile=&adapter=&session=
//     stdin: same shape; extra.user_message + extra.assistant_response +
//     extra.conversation_history.
//     heuristic-filter → cloud /memory/extract → mirror to local store
//     synchronously so next turn's recall sees it. Returns 204.
//
//   POST /v1/hooks/on_session_end?profile=&adapter=&session=
//     stdin: minimal payload; flush outbox and drop run-session row.
//     Returns 204.
//
// Error handling: any 5xx surfaces in the response body but Hermes
// continues (30s timeout, then aborts) — never block the LLM main loop.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CloudClient } from '../../auth.js';
import type { MemoryRuntime } from './runtime.js';
import { ScopedMemoryStore } from './scoped-store.js';
import { extractFromTurn, type ExtractInput } from './extract.js';
import { RecallObservationStore, type RecallMode, type RecallObservation } from './recall-observations.js';
import type { RunSessionRegistry } from './run-session-map.js';
import type { MemorySearchResult } from './types.js';

export interface HookResolverContext {
  agentImUserId: string;
  workspaceId: string;
  profileName: string;
  roleTemplateSlug: string | null;
  conversationId: string | null;
  taskId: string | null;
  adapterName: string;
}

export interface ProfileResolver {
  /**
   * Given a profile name from the query string, resolve the daemon-side
   * binding (agentImUserId, workspaceId, roleTemplateSlug). Returns null
   * when the profile isn't installed on this daemon.
   */
  byProfileName(profileName: string): {
    agentImUserId: string;
    workspaceId: string;
    roleTemplateSlug: string | null;
    adapterName: string;
  } | null;
}

export interface AttachHookServerOptions {
  cloud: CloudClient;
  memoryRuntime: MemoryRuntime;
  runSessionRegistry: RunSessionRegistry;
  profileResolver: ProfileResolver;
  deviceId: string;
  /**
   * Optional outbox flush trigger called from `on_session_end`. Defaults
   * to a no-op; the runner wires the actual `worker.flushNow()` here so
   * residual `memory.page.upsert` envelopes leave the daemon before the
   * agent considers the session dead.
   */
  flushOutbox?: () => Promise<void>;
}

const HOOK_PREFIX = '/v1/hooks/';
const LOG = '[hook-server]';

const RECALL_TOP_K = 5;
const RECALL_MAX_BYTES = 3 * 1024;
const RECALL_THRESHOLD = 0.2;

// release201/26 §14.9 (#A2) — eval/throwaway sessions use an ISOLATED scratch
// scope: recall reads ONLY the per-session scratch bucket (never the shared /
// agent-private stores) and extract is SKIPPED, so a throwaway run neither
// reads contaminated shared memory nor writes pollution into it (fixes the
// release201/24 Phase 2 eval pollution). The eval gateway profile + synthetic
// conversationId are keyed `eval-<runId>...`.
function isScratchSession(ctx: HookResolverContext): boolean {
  return ctx.profileName.startsWith('eval-') || Boolean(ctx.conversationId?.startsWith('eval-'));
}
function scratchKey(ctx: HookResolverContext): string {
  return ctx.conversationId || ctx.profileName;
}
// release201/26 §14.5 (#A2) — recall SHADOW mode: still compute + LOG recall,
// but do NOT inject it into the prompt (on the hermes path hermes owns
// injection via builtin MEMORY.md; our recall runs as a measured shadow
// signal). Default off — flip per §14.10 once builtin memory is enabled.
function recallShadowEnabled(): boolean {
  return process.env.FF_MEMORY_RECALL_SHADOW === 'true';
}
// release201/26 §14.5 (#A4) — best-effort double-sign observation write. Never
// throws / blocks the hook; lives in `recall-observations.db` beside memory.db.
function recordObservation(memoryDbPath: string, obs: RecallObservation): void {
  try {
    const dbPath = memoryDbPath.replace(/memory\.db$/, 'recall-observations.db');
    const store = new RecallObservationStore({ dbPath });
    try {
      store.open();
      store.record(obs);
    } finally {
      store.close();
    }
  } catch (err) {
    process.stderr.write(`${LOG} recall-observation write failed: ${(err as Error).message}\n`);
  }
}

export function attachHookServer(
  opts: AttachHookServerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = req.url ?? '/';
    if (!url.startsWith(HOOK_PREFIX)) return false;
    if (req.method !== 'POST') {
      respond(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    const [pathOnly = '', queryRaw = ''] = url.split('?', 2);
    const query = parseQuery(queryRaw);
    const event = pathOnly.slice(HOOK_PREFIX.length);

    let body: HookStdinPayload;
    try {
      body = await readJson(req);
    } catch (err) {
      respond(res, 400, { error: 'invalid_json', message: (err as Error).message });
      return true;
    }

    const ctx = resolveContext(query, body, opts);
    if (!ctx) {
      respond(res, 422, {
        error: 'unresolved_profile',
        message: `Profile '${query.profile ?? '(missing)'}' not bound on this daemon`,
      });
      return true;
    }

    try {
      if (event === 'pre_llm_call') {
        return await handlePreLlmCall(res, body, ctx, opts);
      }
      if (event === 'post_llm_call') {
        return await handlePostLlmCall(res, body, ctx, opts);
      }
      if (event === 'on_session_end') {
        return await handleSessionEnd(res, body, ctx, opts);
      }
      respond(res, 404, { error: 'unknown_hook_event', event });
      return true;
    } catch (err) {
      process.stderr.write(
        `${LOG} ${event} handler threw: ${(err as Error).stack ?? (err as Error).message}\n`,
      );
      respond(res, 500, { error: 'hook_handler_failed', message: (err as Error).message });
      return true;
    }
  };
}

// ---- handlers ------------------------------------------------------------

async function handlePreLlmCall(
  res: ServerResponse,
  body: HookStdinPayload,
  ctx: HookResolverContext,
  opts: AttachHookServerOptions,
): Promise<true> {
  const extra = (body.extra ?? {}) as Record<string, unknown>;
  const userMessage = typeof extra.user_message === 'string' ? extra.user_message : '';
  if (!userMessage.trim()) {
    // Nothing to anchor recall against; return empty context.
    respond(res, 200, { context: '' });
    return true;
  }
  // Build the recall query from the user message. P1 will compose
  // last-N-turns + active task title (§9.11 P1.3) — for MVP the bare
  // user message is enough to demonstrate the loop.
  const slot = opts.memoryRuntime.resolve(ctx.workspaceId);
  // Build search query — keep short to bias FTS5 toward content tokens.
  const query = userMessage.slice(0, 240);
  const scopedRoot = deriveScopedRoot(slot.store.stats().dbPath);
  const scratch = isScratchSession(ctx);

  let merged: MemorySearchResult[] = [];

  if (scratch) {
    // release201/26 §14.9 — isolated recall: search ONLY the per-session
    // scratch bucket; never the shared / agent-private stores. A fresh scratch
    // bucket is empty → no contaminated recall (fixes the Phase 2 pollution).
    try {
      if (scopedRoot) {
        const scoped = new ScopedMemoryStore({
          rootDir: scopedRoot,
          workspaceId: ctx.workspaceId,
          deviceId: opts.deviceId,
        });
        try {
          merged = scoped.search({
            query,
            scope: 'session-scratch',
            sessionKey: scratchKey(ctx),
            options: { topK: RECALL_TOP_K, maxBytes: RECALL_MAX_BYTES, relevanceThreshold: RECALL_THRESHOLD },
          });
        } finally {
          scoped.close();
        }
      }
    } catch (err) {
      process.stderr.write(`${LOG} scratch recall failed: ${(err as Error).message}\n`);
    }
  } else {
    // Workspace-shared pass.
    const sharedResults = slot.search.hybrid(query, {
      topK: RECALL_TOP_K,
      maxBytes: RECALL_MAX_BYTES,
      relevanceThreshold: RECALL_THRESHOLD,
    });
    // Agent-private pass (best-effort; the per-agent bucket lives under
    // ScopedMemoryStore's directory layout, not the MemoryRuntime pool).
    let privateResults: typeof sharedResults = [];
    try {
      if (scopedRoot && ctx.agentImUserId) {
        const scoped = new ScopedMemoryStore({
          rootDir: scopedRoot,
          workspaceId: ctx.workspaceId,
          deviceId: opts.deviceId,
        });
        try {
          privateResults = scoped.search({
            query,
            scope: 'agent-private',
            agentImUserId: ctx.agentImUserId,
            options: { topK: RECALL_TOP_K, maxBytes: RECALL_MAX_BYTES, relevanceThreshold: RECALL_THRESHOLD },
          });
        } finally {
          scoped.close();
        }
      }
    } catch (err) {
      process.stderr.write(`${LOG} agent-private recall failed: ${(err as Error).message}\n`);
    }
    merged = [...sharedResults, ...privateResults].sort((a, b) => b.score - a.score).slice(0, RECALL_TOP_K);
  }

  const shadow = recallShadowEnabled();
  // release201/26 §14.5 (#A4) — double-sign: log what our recall computed + the
  // mode, for offline recall/prompting optimization. Best-effort.
  if (scopedRoot) {
    recordObservation(slot.store.stats().dbPath, {
      workspaceId: ctx.workspaceId,
      agentImUserId: ctx.agentImUserId || null,
      conversationId: ctx.conversationId,
      sessionKey: scratch ? scratchKey(ctx) : null,
      query,
      ourRecall: merged.map((r) => ({ path: r.path, score: r.score, snippet: r.snippet })),
      mode: (shadow ? 'shadow' : 'inject') as RecallMode,
      injected: !shadow && merged.length > 0,
    });
  }

  // release201/26 §14.5 — SHADOW: recall-only, do NOT inject (hermes owns
  // prompting via builtin MEMORY.md). The recall was logged above.
  if (shadow || merged.length === 0) {
    respond(res, 200, { context: '' });
    return true;
  }

  const lines: string[] = ['[Relevant memory from prior sessions]'];
  for (const r of merged) {
    lines.push(`- ${r.path}${r.title ? ` (${r.title})` : ''}: ${r.snippet}`);
  }
  process.stdout.write(
    `${LOG} pre_llm_call recall agent=${ctx.agentImUserId} workspace=${ctx.workspaceId} hits=${merged.length}\n`,
  );
  respond(res, 200, { context: lines.join('\n') });
  return true;
}

async function handlePostLlmCall(
  res: ServerResponse,
  body: HookStdinPayload,
  ctx: HookResolverContext,
  opts: AttachHookServerOptions,
): Promise<true> {
  // release201/26 §14.9 — eval/throwaway sessions do NOT extract: skip the cloud
  // /memory/extract + shared local mirror entirely, so a throwaway run never
  // writes pollution into shared memory (the other half of the Phase 2 fix; the
  // recall half is the scratch-only read in handlePreLlmCall).
  if (isScratchSession(ctx)) {
    respond(res, 204, null);
    return true;
  }

  const extra = (body.extra ?? {}) as Record<string, unknown>;
  const userMessage = typeof extra.user_message === 'string' ? extra.user_message : '';
  const assistantResponse =
    typeof extra.assistant_response === 'string' ? extra.assistant_response : '';
  const conversationHistory = Array.isArray(extra.conversation_history)
    ? (extra.conversation_history as Array<{ role: string; content: string }>)
    : [];
  const model = typeof extra.model === 'string' ? extra.model : 'unknown';
  const platform = typeof extra.platform === 'string' ? extra.platform : 'unknown';
  const runId = body.session_id ?? '';

  const input: ExtractInput = {
    userMessage,
    assistantResponse,
    conversationHistory,
    agentImUserId: ctx.agentImUserId,
    workspaceId: ctx.workspaceId,
    roleSlug: ctx.roleTemplateSlug,
    conversationId: ctx.conversationId,
    runId,
    sessionMetadata: { model, platform },
  };

  // Resolve the per-workspace ScopedMemoryStore for synchronous local mirror.
  const slot = opts.memoryRuntime.resolve(ctx.workspaceId);
  const scopedRoot = deriveScopedRoot(slot.store.stats().dbPath);
  if (!scopedRoot) {
    process.stderr.write(`${LOG} post_llm_call: cannot derive scoped root from db path\n`);
    respond(res, 204, null);
    return true;
  }
  const scoped = new ScopedMemoryStore({
    rootDir: scopedRoot,
    workspaceId: ctx.workspaceId,
    deviceId: opts.deviceId,
  });

  try {
    const pages = await extractFromTurn(input, { cloud: opts.cloud, scopedStore: scoped });
    if (pages.length > 0) {
      process.stdout.write(
        `${LOG} post_llm_call wrote ${pages.length} page(s) run=${runId} agent=${ctx.agentImUserId}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`${LOG} post_llm_call extraction threw: ${(err as Error).message}\n`);
  } finally {
    scoped.close();
  }

  // Fire-and-forget outbox flush so cloud→local invalidate notifications
  // ride out on the next tick. We do NOT enqueue an extra memory.page.upsert
  // here: cloud /memory/extract has already persisted to im_memory_pages,
  // and the daemon outbox is reserved for daemon-originated writes.
  respond(res, 204, null);
  return true;
}

async function handleSessionEnd(
  res: ServerResponse,
  body: HookStdinPayload,
  ctx: HookResolverContext,
  opts: AttachHookServerOptions,
): Promise<true> {
  const runId = body.session_id ?? '';
  if (runId) opts.runSessionRegistry.drop(runId);
  if (opts.flushOutbox) {
    try {
      await opts.flushOutbox();
    } catch (err) {
      process.stderr.write(`${LOG} session_end flush threw: ${(err as Error).message}\n`);
    }
  }
  process.stdout.write(`${LOG} on_session_end run=${runId} agent=${ctx.agentImUserId}\n`);
  respond(res, 204, null);
  return true;
}

// ---- helpers -------------------------------------------------------------

interface HookStdinPayload {
  hook_event_name?: string;
  tool_name?: string | null;
  tool_input?: unknown;
  session_id?: string;
  cwd?: string;
  extra?: Record<string, unknown>;
}

function resolveContext(
  query: Record<string, string>,
  body: HookStdinPayload,
  opts: AttachHookServerOptions,
): HookResolverContext | null {
  const profileName = query.profile;
  if (!profileName) return null;

  // First try run-session registry (set by hermes adapter when it
  // received run_id). This carries the freshest conversationId/taskId.
  const runId = body.session_id ?? '';
  const fromRegistry = runId ? opts.runSessionRegistry.lookup(runId) : null;
  if (fromRegistry) {
    return {
      agentImUserId: fromRegistry.agentImUserId,
      workspaceId: fromRegistry.workspaceId,
      profileName: fromRegistry.profileName,
      roleTemplateSlug: fromRegistry.roleTemplateSlug,
      conversationId: fromRegistry.conversationId,
      taskId: fromRegistry.taskId,
      adapterName: fromRegistry.adapterName,
    };
  }

  // Fallback: profile-only resolution via the daemon's agent_profiles
  // mirror. Loses conversationId/taskId stamping for orphan hooks, but
  // recall still works because workspaceId + agentImUserId are intact.
  const profile = opts.profileResolver.byProfileName(profileName);
  if (!profile) return null;
  return {
    agentImUserId: profile.agentImUserId,
    workspaceId: profile.workspaceId,
    profileName,
    roleTemplateSlug: profile.roleTemplateSlug,
    conversationId: null,
    taskId: null,
    adapterName: profile.adapterName,
  };
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  if (status === 204 || body === null) {
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function parseQuery(raw: string): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split('&')) {
    if (!part) continue;
    const [k = '', v = ''] = part.split('=', 2);
    if (!k) continue;
    out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
  }
  return out;
}

async function readJson(req: IncomingMessage): Promise<HookStdinPayload> {
  let raw = '';
  req.setEncoding('utf8');
  for await (const chunk of req) raw += chunk as string;
  if (!raw) return {};
  return JSON.parse(raw) as HookStdinPayload;
}

/**
 * MemoryRuntime stores per-workspace memory at
 * `<baseDir>/<workspaceSlug>/memory.db`. ScopedMemoryStore stores at
 * `<baseDir>/<workspaceSlug>/_shared.db` and `<baseDir>/<workspaceSlug>/agents/<id>.db`.
 * Both use the same `<baseDir>` root, so given a runtime db path we strip
 * the trailing `<slug>/memory.db` to get the shared baseDir.
 */
function deriveScopedRoot(memoryDbPath: string | null): string | null {
  if (!memoryDbPath || memoryDbPath === ':memory:') return null;
  // .../baseDir/<slug>/memory.db → .../baseDir
  const m = memoryDbPath.match(/^(.+)\/[^/]+\/memory\.db$/);
  return m ? m[1]! : null;
}
