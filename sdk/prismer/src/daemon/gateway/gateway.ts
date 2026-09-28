// Phase 6 / M1 — local IM gateway orchestrator
// (docs/desktop202/13-sync-protocol-spec.md §5/§6, 11-local-data-plane.md M1).
//
// CAPABILITY BIT — default OFF. The gateway only activates when explicitly
// enabled (env `PRISMER_LOCAL_GATEWAY=1` or config `local_gateway.enabled`).
// CLI daemon / K8s agent-rt pods leave it OFF → local-server keeps its original
// route set unchanged (healthz/agents/dispatch/...). Desktop assemble injects
// the flag.
//
// Responsibilities:
//   - serve GET /api/im/conversations|messages|tasks from rm_* with SWR (§6):
//       fresh  → return cached (秒回)
//       stale  → return cached + async revalidate (回填)
//       miss   → cloud passthrough + backfill rm_* + return
//   - serve GET /api/im/sync/stream as a local mirror of the cloud SSE,
//     fed by the Materializer/LocalRelay (§5), cursor-compatible (boundarySeq)
//   - enforce Bearer: daemon apiKey directly, OR a user Bearer belonging to
//     the daemon's OWNER (cloud-introspected, digest-cached; desktop205 seam
//     + review hardening — see checkAuthAsync)
//
// Cloud端点零变更：the gateway consumes the existing /api/im/* contract.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { CloudClient } from '../../auth.js';
import type { LocalDb } from '../../sync/store.js';
import type { LocalRelay } from './local-relay.js';
import type { OutboxWriter } from './outbox-writer.js';
import type { OnlineStateTracker } from './online-state.js';
import {
  getTask,
  getWatermark,
  isFresh,
  listConversations,
  listMessages,
  listTasks,
  touchWatermark,
  upsertConversation,
  upsertMessage,
  upsertTask,
  type RmDomain,
} from './read-model.js';

/** SWR TTLs per §6 (synced_at distance). */
export const SWR_TTL_MS = {
  conversations: 30_000, // §6: conversations 列表 30s
  messages: 60_000, // §6: messages（单会话）60s
  tasks: 30_000, // §6: tasks 30s
} as const;

/** Re-pull page size on gap reset (§5: messages N=50/会话). */
export const RESET_REPULL_PAGE = 50;

export interface GatewayConfig {
  /** Master switch — gateway routes only mount when true. */
  enabled: boolean;
  /** Per-domain gray-release set (§10). Phase 6 default: chats only. */
  domains: Set<RmDomain>;
}

/**
 * Resolve the gateway capability flag. Precedence: explicit option >
 * env `PRISMER_LOCAL_GATEWAY` > config flag > OFF.
 *
 * `PRISMER_LOCAL_GATEWAY_DOMAINS=chats,tasks` narrows the gray set; default is
 * `chats` (Phase 6 首发域, §10/§15#3).
 */
export function resolveGatewayConfig(opts?: {
  enabled?: boolean;
  domains?: string[];
  configEnabled?: boolean;
  configDomains?: string[];
}): GatewayConfig {
  const envEnabled = process.env.PRISMER_LOCAL_GATEWAY;
  const enabled =
    opts?.enabled ??
    (envEnabled != null ? envEnabled === '1' || envEnabled === 'true' : undefined) ??
    opts?.configEnabled ??
    false;

  const envDomains = process.env.PRISMER_LOCAL_GATEWAY_DOMAINS?.split(',').map((s) => s.trim());
  const rawDomains = opts?.domains ?? envDomains ?? opts?.configDomains ?? ['chats'];
  const domains = new Set<RmDomain>();
  for (const d of rawDomains) {
    if (d === 'chats' || d === 'tasks') domains.add(d);
  }
  if (domains.size === 0) domains.add('chats');

  return { enabled, domains };
}

export interface GatewayDeps {
  config: GatewayConfig;
  db: LocalDb;
  cloud: CloudClient;
  relay: LocalRelay;
  /** Bearer token the renderer must present — same source as daemon apiKey. */
  authToken: string;
  /** Phase 8a / M2 (§7) — optimistic write path. Present only when the gateway
   *  is enabled with the write capability; when undefined, POST/PATCH writes
   *  fall through to cloud passthrough (M1 behavior unchanged). */
  outbox?: OutboxWriter;
  /** Phase 8b / M3 — cloud-reachability tracker (online-state.ts). When present,
   *  SWR revalidate outcomes feed it, and offline reads (cloud unreachable +
   *  stale cache) serve stale data with `X-Data-Stale: true` instead of 502.
   *  Absent → M1/M2 behavior unchanged (miss + unreachable → 502). */
  online?: OnlineStateTracker;
  /** desktop205 (2026-08-31) — the daemon's currently-declared workspace, so
   *  SWR revalidations scope workspace-scoped cloud reads correctly. Absent →
   *  unscoped fetch (pre-existing behavior; default-workspace list). */
  workspaceId?: () => string | null | undefined;
}

/**
 * Local IM gateway. Returns true from `handle()` when it claimed the request
 * (response written); false to let the standard local-server route table run.
 */
export class LocalGateway {
  constructor(private readonly deps: GatewayDeps) {}

  get enabled(): boolean {
    return this.deps.config.enabled;
  }

  /**
   * First-pass handler for the local-server route chain. Only claims
   * `GET /api/im/*` reads inside enabled domains; everything else falls
   * through (returns false), so cloud-direct passthrough and the existing
   * routes are untouched.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!this.deps.config.enabled) return false;
    const url = req.url ?? '/';
    if (!url.startsWith('/api/im/')) return false;
    const method = req.method ?? 'GET';
    // M1 reads are GET; M2 writes are POST/PATCH. Anything else (DELETE/PUT)
    // falls through to the standard route table / cloud passthrough.
    if (method !== 'GET' && method !== 'POST' && method !== 'PATCH') return false;

    const { pathname, query } = splitUrl(url);

    // Bearer auth (11 §3a) — applies to every gateway route. 401 on failure.
    // desktop205 (2026-08-31): the desktop renderer holds the USER session JWT,
    // not the daemon's api key — the two auth seams never aligned and the whole
    // local data plane was unreachable from the shell. Accept both: the daemon
    // key directly, or a user Bearer verified once against /api/im/me (cached).
    if (!(await this.checkAuthAsync(req))) {
      writeJson(res, 401, { ok: false, error: { code: 'unauthorized', message: 'Bearer required' } });
      return true;
    }

    // ── M2 write path (§7) ──────────────────────────────────────────────────
    // Only when the outbox is wired (write capability). Without it, writes fall
    // through to cloud passthrough (M1 behavior, 回归不变).
    if (method !== 'GET' && this.deps.outbox) {
      const claimed = await this.handleWrite(method, pathname, url, req, res);
      if (claimed) return true;
      // Not a recognized write → cloud passthrough so the renderer sees one base.
      await this.passthroughWrite(method, url, req, res);
      return true;
    }
    if (method !== 'GET') {
      // Write but no outbox → cloud passthrough (M1 / OFF-write behavior).
      await this.passthroughWrite(method, url, req, res);
      return true;
    }

    // Local SSE mirror (§5).
    if (pathname === '/api/im/sync/stream') {
      this.handleStream(res);
      return true;
    }

    // SWR reads. Domain-gated: a disabled domain falls through to cloud-direct.
    if (pathname === '/api/im/conversations' && this.deps.config.domains.has('chats')) {
      await this.handleConversations(res);
      return true;
    }
    if (pathname === '/api/im/messages' && this.deps.config.domains.has('chats')) {
      const conversationId = query.get('conversationId') ?? query.get('conversation_id');
      if (!conversationId) {
        writeJson(res, 400, { ok: false, error: { code: 'missing_conversation_id' } });
        return true;
      }
      await this.handleMessages(conversationId, url, res);
      return true;
    }
    if (pathname === '/api/im/tasks' && this.deps.config.domains.has('tasks')) {
      const workspaceId = query.get('workspaceId') ?? query.get('workspace_id');
      if (!workspaceId) {
        writeJson(res, 400, { ok: false, error: { code: 'missing_workspace_id' } });
        return true;
      }
      await this.handleTasks(workspaceId, url, res);
      return true;
    }

    // Any other /api/im/* read inside an enabled domain isn't locally cached →
    // cloud passthrough (still served by the gateway so the renderer sees a
    // single base URL).
    await this.passthrough(url, res, req);
    return true;
  }

  // ── SWR: conversations ─────────────────────────────────────────────────
  private async handleConversations(res: ServerResponse): Promise<void> {
    const wm = getWatermark(this.deps.db, 'chats', '');
    const rows = listConversations(this.deps.db);

    if (rows.length > 0 && isFresh(wm, SWR_TTL_MS.conversations)) {
      writeJson(res, 200, { ok: true, data: rows.map((r) => JSON.parse(r.payload_json)) });
      return;
    }
    if (rows.length > 0) {
      // stale: serve cached now, revalidate in background (§6). M3: if the
      // gateway is offline, mark the response stale so the renderer can surface
      // the offline indicator (revalidate will fail + not advance synced_at).
      writeStale(res, this.isOffline(), rows.map((r) => JSON.parse(r.payload_json)));
      void this.revalidateConversations();
      return;
    }
    // miss: passthrough + backfill.
    const result = await this.fetchConversations();
    if (!result) {
      // M3 offline read: no local rows + cloud unreachable → explicit
      // offline-unavailable (not a timeout hang). With no online tracker this is
      // the original 502 path.
      this.respondMissUnreachable(res);
      return;
    }
    writeJson(res, 200, { ok: true, data: result });
  }

  private async revalidateConversations(): Promise<void> {
    await this.fetchConversations().catch(() => undefined);
  }

  private async fetchConversations(): Promise<unknown[] | null> {
    // desktop205 (2026-08-31) — /api/im/conversations is workspace-scoped on
    // the cloud; an unscoped daemon-key fetch returns the DEFAULT workspace's
    // list, which the SWR cache would then serve to a user sitting in a
    // different workspace. Scope by the daemon's declared workspace (runner
    // retargets it on switch; single-workspace daemon by design).
    const workspaceId = this.deps.workspaceId?.() ?? undefined;
    const res = await this.deps.cloud.request<{ ok?: boolean; data?: unknown }>(
      'GET',
      workspaceId ? `/api/im/conversations?workspaceId=${encodeURIComponent(workspaceId)}` : '/api/im/conversations',
    );
    if (!res.ok) {
      this.deps.online?.onRevalidateFailure();
      return null;
    }
    this.deps.online?.onRevalidateSuccess();
    const list = extractList(res.data);
    const now = Date.now();
    for (const item of list) {
      const id = asId(item);
      if (!id) continue;
      upsertConversation(this.deps.db, { id, payload: item, updatedAt: updatedAtOf(item, now), syncedAt: now });
    }
    touchWatermark(this.deps.db, 'chats', '', now);
    return list;
  }

  // ── SWR: messages ──────────────────────────────────────────────────────
  private async handleMessages(conversationId: string, url: string, res: ServerResponse): Promise<void> {
    const wm = getWatermark(this.deps.db, 'chats', conversationId);
    const rows = listMessages(this.deps.db, conversationId);

    if (rows.length > 0 && isFresh(wm, SWR_TTL_MS.messages)) {
      writeJson(res, 200, { ok: true, data: rows.map((r) => JSON.parse(r.payload_json)) });
      return;
    }
    if (rows.length > 0) {
      writeStale(res, this.isOffline(), rows.map((r) => JSON.parse(r.payload_json)));
      void this.fetchMessages(conversationId, url).catch(() => undefined);
      return;
    }
    const list = await this.fetchMessages(conversationId, url);
    if (!list) {
      this.respondMissUnreachable(res);
      return;
    }
    writeJson(res, 200, { ok: true, data: list });
  }

  private async fetchMessages(conversationId: string, url: string): Promise<unknown[] | null> {
    // Preserve the renderer's query (pagination/after) by forwarding the URL.
    const res = await this.deps.cloud.request<{ ok?: boolean; data?: unknown }>('GET', url);
    if (!res.ok) {
      this.deps.online?.onRevalidateFailure();
      return null;
    }
    this.deps.online?.onRevalidateSuccess();
    const list = extractList(res.data);
    const now = Date.now();
    for (const item of list) {
      const id = asId(item);
      if (!id) continue;
      const it = item as Record<string, unknown>;
      const boundarySeq =
        typeof it['boundarySeq'] === 'number' ? (it['boundarySeq'] as number) : null;
      upsertMessage(this.deps.db, {
        id,
        conversationId,
        boundarySeq,
        payload: item,
        createdAt: updatedAtOf(item, now),
        syncedAt: now,
      });
    }
    touchWatermark(this.deps.db, 'chats', conversationId, now);
    return list;
  }

  // ── SWR: tasks ─────────────────────────────────────────────────────────
  private async handleTasks(workspaceId: string, url: string, res: ServerResponse): Promise<void> {
    const wm = getWatermark(this.deps.db, 'tasks', '');
    const rows = listTasks(this.deps.db, workspaceId);

    if (rows.length > 0 && isFresh(wm, SWR_TTL_MS.tasks)) {
      writeJson(res, 200, { ok: true, data: rows.map((r) => JSON.parse(r.payload_json)) });
      return;
    }
    if (rows.length > 0) {
      writeStale(res, this.isOffline(), rows.map((r) => JSON.parse(r.payload_json)));
      void this.fetchTasks(workspaceId, url).catch(() => undefined);
      return;
    }
    const list = await this.fetchTasks(workspaceId, url);
    if (!list) {
      this.respondMissUnreachable(res);
      return;
    }
    writeJson(res, 200, { ok: true, data: list });
  }

  private async fetchTasks(workspaceId: string, url: string): Promise<unknown[] | null> {
    const res = await this.deps.cloud.request<{ ok?: boolean; data?: unknown }>('GET', url);
    if (!res.ok) {
      this.deps.online?.onRevalidateFailure();
      return null;
    }
    this.deps.online?.onRevalidateSuccess();
    const list = extractList(res.data);
    const now = Date.now();
    for (const item of list) {
      const id = asId(item);
      if (!id) continue;
      upsertTask(this.deps.db, {
        id,
        workspaceId,
        payload: item,
        updatedAt: updatedAtOf(item, now),
        syncedAt: now,
      });
    }
    touchWatermark(this.deps.db, 'tasks', '', now);
    return list;
  }

  // ── cloud passthrough (uncached /api/im/* reads) ───────────────────────
  private async passthrough(url: string, res: ServerResponse, req?: IncomingMessage): Promise<void> {
    const result = await this.deps.cloud.request('GET', url, {
      headers: req ? forwardedCallerHeaders(req) : undefined,
    });
    if (!result.ok) {
      // status 0 = transport failure (conn refused/timeout) = cloud unreachable.
      if (result.status === 0) this.deps.online?.onRevalidateFailure();
      writeJson(res, result.status >= 400 ? result.status : 502, {
        ok: false,
        error: result.error ?? { code: 'cloud_unreachable' },
      });
      return;
    }
    this.deps.online?.onRevalidateSuccess();
    writeJson(res, 200, result.data ?? { ok: true });
  }

  // ── M3 offline read helpers ────────────────────────────────────────────
  /** Is the gateway's cloud channel currently offline? False when no online
   *  tracker is wired (M1/M2 behavior — never "offline"). */
  private isOffline(): boolean {
    return this.deps.online ? !this.deps.online.cloudReachable : false;
  }

  /**
   * SWR miss + cloud unreachable. With the online tracker (M3): respond with an
   * explicit `offline_unavailable` (503) so the renderer surfaces "离线不可用"
   * rather than the request hanging or looking like a server error. Without it
   * (M1/M2): the original 502 cloud_unreachable.
   */
  private respondMissUnreachable(res: ServerResponse): void {
    if (this.isOffline()) {
      res.setHeader('X-Data-Stale', 'true');
      writeJson(res, 503, {
        ok: false,
        error: { code: 'offline_unavailable', message: 'cloud unreachable and no cached data' },
      });
      return;
    }
    writeJson(res, 502, { ok: false, error: { code: 'cloud_unreachable' } });
  }

  // ── local SSE mirror (§5) ──────────────────────────────────────────────
  private handleStream(res: ServerResponse): void {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.write(': connected\n\n');
    // Mirror the cloud relay's initial control frame so the renderer's
    // caught_up listeners behave identically.
    res.write(`event: caught_up\ndata: ${JSON.stringify({ cursor: 0 })}\n\n`);
    this.deps.relay.subscribe(res);
  }

  // ── M2 write path (§7) ─────────────────────────────────────────────────
  /**
   * Claim a recognized optimistic write. Returns true when handled (response
   * written), false when the path/method isn't a write we own (caller falls
   * back to cloud passthrough).
   */
  private async handleWrite(
    method: 'POST' | 'PATCH',
    pathname: string,
    url: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    // POST /api/im/messages/:conversationId  → optimistic send (chats domain).
    const sendMatch = /^\/api\/im\/messages\/([^/]+)$/.exec(pathname);
    if (method === 'POST' && sendMatch && this.deps.config.domains.has('chats')) {
      const conversationId = decodeURIComponent(sendMatch[1]!);
      const body = await readJsonBody(req);
      const { row } = this.deps.outbox!.enqueueMessageSend({ conversationId, body });
      // 201 + the optimistic message so the renderer renders it instantly,
      // mirroring the cloud POST response envelope shape.
      writeJson(res, 201, { ok: true, data: { message: JSON.parse(row.payload_json) } });
      return true;
    }

    // Task board mutations under /api/im/tasks/:id(/sub) → optimistic + enqueue
    // (tasks domain). PATCH /api/im/tasks/:id carries a predictable field patch;
    // POST subpaths (transition/complete/…) just mark dirty (server-wins回纠 §8③).
    const taskMatch = /^\/api\/im\/tasks\/([^/]+)(\/.*)?$/.exec(pathname);
    if (taskMatch && this.deps.config.domains.has('tasks')) {
      const taskId = decodeURIComponent(taskMatch[1]!);
      const body = await readJsonBody(req);
      const workspaceId =
        (typeof body['workspaceId'] === 'string' ? body['workspaceId'] : undefined) ??
        (typeof body['workspace_id'] === 'string' ? (body['workspace_id'] as string) : undefined) ??
        existingTaskWorkspace(this.deps.db, taskId) ??
        '';
      const isFieldPatch = method === 'PATCH' && !taskMatch[2];
      const { row } = this.deps.outbox!.enqueueTaskMutation({
        taskId,
        workspaceId,
        method,
        path: url,
        body,
        optimisticPatch: isFieldPatch ? body : {},
      });
      writeJson(res, 202, {
        ok: true,
        data: row ? JSON.parse(row.payload_json) : { id: taskId, _optimistic: true },
      });
      return true;
    }

    return false;
  }

  /** Forward an unclaimed write to cloud (so the renderer sees a single base). */
  private async passthroughWrite(
    method: 'POST' | 'PATCH',
    url: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(req);
    const result = await this.deps.cloud.request(method, url, {
      body,
      headers: forwardedCallerHeaders(req),
    });
    if (!result.ok) {
      writeJson(res, result.status >= 400 ? result.status : 502, {
        ok: false,
        error: result.error ?? { code: 'cloud_unreachable' },
      });
      return;
    }
    writeJson(res, result.status || 200, result.data ?? { ok: true });
  }

  // ── Bearer auth (11 §3a + desktop205 user-JWT acceptance) ───────────────
  private checkAuth(req: IncomingMessage): boolean {
    const presented = bearerOf(req);
    if (!presented) return false;
    return safeEqual(presented, this.deps.authToken);
  }

  /**
   * Auth with the desktop seam closed: the daemon key passes directly; any
   * other Bearer must be a session credential of THIS daemon's OWNER (the
   * renderer runs as the user whose key provisioned the daemon). Introspected
   * against the cloud once, then cached keyed by token DIGEST. Review hardening
   * (2026-08-31): originally any VALID cloud account token passed and could
   * read the owner's SWR cache from any same-machine web page via ACAO `*` —
   * the introspected user must now match the daemon key's own /me identity.
   */
  private async checkAuthAsync(req: IncomingMessage): Promise<boolean> {
    if (this.checkAuth(req)) return true;
    const presented = bearerOf(req);
    if (!presented) return false;
    const key = digestKey(presented);
    const now = Date.now();
    const cached = userBearerCache.get(key);
    if (cached && cached.expiresAt > now) return cached.ok;
    let ok = false;
    try {
      const [probe, owner] = await Promise.all([
        this.deps.cloud.request<{ user?: { id?: unknown } }>('GET', '/api/im/me', {
          auth: false,
          headers: { Authorization: `Bearer ${presented}` },
          timeoutMs: 8_000,
        }),
        this.resolveOwnerUserId(),
      ]);
      // CloudClient.data is the FULL response body; /api/im/me answers the IM
      // envelope { ok, data: { user: { id } } }. Read defensively either way.
      const presentedUser = probe.ok
        ? ((probe.data as { data?: { user?: { id?: unknown } } } | undefined)?.data?.user?.id as
            | string
            | undefined) ?? null
        : null;
      ok = probe.ok && presentedUser !== null && owner !== null && presentedUser === owner;
    } catch {
      ok = false;
    }
    userBearerCache.set(key, { ok, expiresAt: now + (ok ? USER_BEARER_TTL_MS : USER_BEARER_FAIL_TTL_MS) });
    if (userBearerCache.size > USER_BEARER_CACHE_MAX) {
      const oldest = userBearerCache.keys().next().value;
      if (oldest !== undefined) userBearerCache.delete(oldest);
    }
    return ok;
  }

  /** The daemon key's own /me user id (cached for the process lifetime).
   *  Null until/unless resolvable — user bearers are refused while unknown
   *  (fail-closed) rather than accepting unbound identities. */
  private ownerUserIdCache: string | null | undefined;

  private async resolveOwnerUserId(): Promise<string | null> {
    if (this.ownerUserIdCache !== undefined) return this.ownerUserIdCache;
    try {
      const me = await this.deps.cloud.request<{ user?: { id?: unknown } }>('GET', '/api/im/me', {
        timeoutMs: 8_000,
      });
      const id =
        me.ok &&
        typeof (me.data as { data?: { user?: { id?: unknown } } } | undefined)?.data?.user?.id === 'string'
          ? ((me.data as { data: { user: { id: string } } }).data.user.id)
          : null;
      this.ownerUserIdCache = id;
    } catch {
      this.ownerUserIdCache = null; // retried on the next auth attempt
    }
    return this.ownerUserIdCache;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || !raw.startsWith('Bearer ')) return null;
  const presented = raw.slice('Bearer '.length).trim();
  return presented || null;
}

/**
 * Introspected user Bearer cache (desktop205 auth-seam fix). Positive entries
 * outlive a refresh token swap by TTL only; negative entries expire quickly so
 * a login retry is not locked out. Bounded, LRU-ish by insertion order.
 * Keys are SHA-256 DIGESTS of the presented token — the raw bearer (a live
 * JWT / sk-prismer key) is never retained in the cache map.
 */
const USER_BEARER_TTL_MS = 10 * 60 * 1000;
const USER_BEARER_FAIL_TTL_MS = 30 * 1000;
const USER_BEARER_CACHE_MAX = 8;
const userBearerCache = new Map<string, { ok: boolean; expiresAt: number }>();

function digestKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Headers the gateway forwards verbatim on cloud passthrough (audit C:
 * X-IM-Workspace loss made multi-workspace members read the default
 * workspace's data through the loopback base). */
function forwardedCallerHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const workspace = req.headers['x-im-workspace'];
  const wsRaw = Array.isArray(workspace) ? workspace[0] : workspace;
  if (wsRaw) out['X-IM-Workspace'] = wsRaw;
  const requestId = req.headers['x-request-id'];
  const ridRaw = Array.isArray(requestId) ? requestId[0] : requestId;
  if (ridRaw) out['X-Request-Id'] = ridRaw;
  return out;
}

function splitUrl(url: string): { pathname: string; query: URLSearchParams } {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return { pathname: url, query: new URLSearchParams() };
  return { pathname: url.slice(0, qIdx), query: new URLSearchParams(url.slice(qIdx + 1)) };
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  // desktop205 (2026-08-31) — the renderer reads X-Data-Stale cross-origin
  // (app://prismer → 127.0.0.1); without Expose-Headers the offline indicator
  // can never light on gateway-served responses.
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, X-Data-Stale');
  res.end(JSON.stringify(body));
}

/**
 * Serve a 200 stale-cache read (M3). When `stale` (gateway offline), set the
 * `X-Data-Stale: true` response header so the renderer can render the offline
 * indicator while still showing the cached rows. Online stale serves identically
 * (the background revalidate refreshes), just without the header.
 */
function writeStale(res: ServerResponse, stale: boolean, data: unknown[]): void {
  if (stale) res.setHeader('X-Data-Stale', 'true');
  writeJson(res, 200, { ok: true, data, ...(stale ? { stale: true } : {}) });
}

/** Unwrap `{ ok, data }` / `{ data }` / bare-array cloud responses to a list. */
function extractList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d['data'])) return d['data'] as unknown[];
    if (d['data'] && typeof d['data'] === 'object') {
      const inner = d['data'] as Record<string, unknown>;
      for (const key of ['conversations', 'messages', 'tasks', 'items']) {
        if (Array.isArray(inner[key])) return inner[key] as unknown[];
      }
    }
    for (const key of ['conversations', 'messages', 'tasks', 'items']) {
      if (Array.isArray(d[key])) return d[key] as unknown[];
    }
  }
  return [];
}

function asId(item: unknown): string | undefined {
  if (item && typeof item === 'object') {
    const v = (item as Record<string, unknown>)['id'];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function updatedAtOf(item: unknown, fallback: number): number {
  if (item && typeof item === 'object') {
    const o = item as Record<string, unknown>;
    for (const key of ['updatedAt', 'createdAt', 'updated_at', 'created_at']) {
      const v = o[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') {
        const ms = Date.parse(v);
        if (Number.isFinite(ms)) return ms;
      }
    }
  }
  return fallback;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Read + JSON-parse a request body (best-effort; empty/invalid → {}). */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const MAX = 4 * 1024 * 1024; // 4MB guard (messages with inline attachments)
    req.on('data', (c: Buffer | string) => {
      const buf = typeof c === 'string' ? Buffer.from(c) : c;
      bytes += buf.length;
      if (bytes <= MAX) chunks.push(buf);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        const v = JSON.parse(text);
        resolve(v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** Resolve a task's workspace from rm_tasks (optimistic write needs it for the
 *  NOT NULL workspace_id column when the body omits it). */
function existingTaskWorkspace(db: LocalDb, taskId: string): string | undefined {
  const row = getTask(db, taskId);
  return row?.workspace_id;
}
