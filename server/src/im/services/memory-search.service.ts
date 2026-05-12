/**
 * Memory search + ranker (A5 of Memory Line A).
 *
 * v1 ranker baseline (PR-justified, owner may tune):
 *   score = matchScore * 1.0
 *         + log(1 + inboundLinkCount) * 0.3
 *         + recencyDecay(updatedAt, half_life=30days) * 0.2
 *         - (stale ? 0.5 : 0)
 *
 * `matchScore` is a TF-IDF-shaped substring overlap implemented in code rather
 * than DB-side FULLTEXT. The brief permits the owner to choose the
 * implementation; we go pure-code to keep behaviour identical between SQLite
 * (dev/test) and MySQL (prod). MySQL FULLTEXT migration is left as A5.next.
 *
 * Encryption modes (doc 23 §9.5):
 *   - Standard:   full match including content snippet
 *   - Private:    snippet sourced only from path + title (content untouched)
 *   - Regulated:  cloud returns empty (daemon-side authoritative)
 *
 * Daemon-forwarding scaffold (Line C C6 fills these stubs):
 *   - When FF_MEMORY_SEARCH_DAEMON_FIRST=true and pingDaemon() returns true,
 *     forwardToDaemon() handles the search; otherwise the cloudFallbackSearch
 *     path runs.
 *   - A5 ships only the cloudFallbackSearch path + scaffold for the flag.
 *
 * Brief reference: doc 23 §1.5, §4 (search), §8 U6, §11 R10.
 */

import prisma from '../db';
import type { MemoryAclContext } from './memory-acl';

export type EncryptionMode = 'standard' | 'private' | 'regulated';

export class MemorySearchError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400,
  ) {
    super(message);
    this.name = 'MemorySearchError';
  }
}

export interface SearchInput {
  acl: MemoryAclContext;
  query: string;
  pageType?: string[];
  kind?: 'memory' | 'files' | 'both';
  stale?: 'true' | 'false' | 'all';
  visibility?: string;
  limit?: number;
  cursor?: string | null;
  encryptionMode?: EncryptionMode;
}

export interface MemorySearchResult {
  pageId: string;
  workspaceId: string;
  path: string;
  title: string | null;
  pageType: string;
  visibility: string;
  stale: boolean;
  inboundLinkCount: number;
  updatedAt: string;
  snippet: string;
  score: number;
  components: {
    matchScore: number;
    linkBoost: number;
    recencyDecay: number;
    stalePenalty: number;
  };
}

export interface FileSearchResult {
  fileId: string;
  workspaceId: string;
  path: string;
  ownerId: string;
  memoryType: string | null;
  description: string | null;
  updatedAt: string;
  snippet: string;
}

export interface SearchResponse {
  ok: true;
  data: {
    memory: MemorySearchResult[];
    files: FileSearchResult[];
    cursor: string | null;
    took_ms: number;
  };
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
const SNIPPET_BUDGET = 240;

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_-]+/u)
    .filter((t) => t.length >= 2);
}

function recencyDecay(updatedAt: Date, now: number): number {
  const ageMs = Math.max(0, now - updatedAt.getTime());
  return Math.exp((-ageMs * Math.LN2) / RECENCY_HALF_LIFE_MS);
}

function visibilityWhere(acl: MemoryAclContext) {
  return acl.allowedVisibilityPrefixes.length === 0
    ? { visibility: { in: acl.allowedVisibilities } }
    : {
        OR: [
          { visibility: { in: acl.allowedVisibilities } },
          ...acl.allowedVisibilityPrefixes.map((p: string) => ({ visibility: { startsWith: p } })),
        ],
      };
}

function buildSnippet(text: string, query: string, budget = SNIPPET_BUDGET): string {
  if (!text) return '';
  const lower = text.toLowerCase();
  const tokens = tokenize(query);
  let firstHit = -1;
  for (const t of tokens) {
    const idx = lower.indexOf(t);
    if (idx >= 0 && (firstHit < 0 || idx < firstHit)) firstHit = idx;
  }
  if (firstHit < 0) return text.slice(0, budget);
  const start = Math.max(0, firstHit - Math.floor(budget / 4));
  return (start > 0 ? '…' : '') + text.slice(start, start + budget) + (text.length > start + budget ? '…' : '');
}

function matchScore(content: string, title: string | null, path: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const haystack = `${path}\n${title ?? ''}\n${content}`.toLowerCase();
  let hits = 0;
  for (const t of queryTokens) {
    if (!t) continue;
    let from = 0;
    let count = 0;
    while (from < haystack.length) {
      const idx = haystack.indexOf(t, from);
      if (idx < 0) break;
      count++;
      from = idx + t.length;
      if (count >= 5) break; // saturate after 5 hits per token
    }
    hits += Math.log(1 + count);
  }
  return hits / Math.max(1, queryTokens.length);
}

// ─── Daemon-forwarding scaffold (Line C C6 fills these stubs) ─

// ─── C6 (phase-1): daemon presence + RPC forward + dual-path state ──
//
// Three pieces here, all module-local so memory-search.service.ts stays the
// single source of truth for daemon-first wiring. The WS handler bridge
// that POPULATES the presence registry + ROUTES daemon→cloud RPC replies
// is owner follow-up (see phase-1 TODO doc); when not wired, presence
// stays empty → pingDaemon returns false → fallback path runs unchanged.
//
// Dispatcher locks (per Line C plan §C6):
//   - Don't touch cloudFallbackSearch main path
//   - 5-min sliding window, dual-path enters at ≥3 ping failures, exits at
//     1 min of consecutive successes
//   - forwardToDaemon timeout 800ms (owner-tunable)
//   - Metrics: memory.search.dual_path.{active,entered_total}

const DAEMON_FORWARD_TIMEOUT_MS = 800;

/**
 * In-process registry of which workspaces currently have a daemon connected.
 * Populated by the WS handler when a daemon authenticates (TODO: wire in
 * src/im/ws/handler.ts on `daemon.online` event from the daemon-side WsClient).
 * Consulted by pingDaemon().
 */
const daemonPresence = new Map<string, Set<string>>(); // workspaceId → Set<daemonId>

/** Public hook for the WS handler to register a daemon connection. */
export function registerDaemonPresence(workspaceId: string, daemonId: string): void {
  let set = daemonPresence.get(workspaceId);
  if (!set) {
    set = new Set();
    daemonPresence.set(workspaceId, set);
  }
  set.add(daemonId);
}

/** Public hook for the WS handler to remove a daemon on disconnect. */
export function unregisterDaemonPresence(workspaceId: string, daemonId: string): void {
  const set = daemonPresence.get(workspaceId);
  if (!set) return;
  set.delete(daemonId);
  if (set.size === 0) daemonPresence.delete(workspaceId);
}

/**
 * Correlation tracker for daemon→cloud RPC replies. forwardToDaemon() puts
 * a pending entry here keyed by correlationId; the WS handler resolves it
 * when the daemon replies with the matching id (TODO: wire in handler.ts
 * `memory.search.reply` route).
 */
interface PendingResponse {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}
const pendingResponses = new Map<string, PendingResponse>();

/** Public hook for the WS handler to deliver a daemon reply. */
export function deliverDaemonReply(correlationId: string, data: unknown): void {
  const entry = pendingResponses.get(correlationId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingResponses.delete(correlationId);
  entry.resolve(data);
}

/** Public hook for the WS handler to inject a low-level error (e.g. WS closed mid-RPC). */
export function rejectDaemonReply(correlationId: string, err: Error): void {
  const entry = pendingResponses.get(correlationId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingResponses.delete(correlationId);
  entry.reject(err);
}

async function pingDaemon(workspaceId: string): Promise<boolean> {
  const set = daemonPresence.get(workspaceId);
  return Boolean(set && set.size > 0);
}

/** Send a `memory.search` RPC over WS to the daemon (TODO: wire actual send via room manager). */
type SendDaemonRpc = (workspaceId: string, payload: unknown) => Promise<void>;
let sendDaemonRpc: SendDaemonRpc | null = null;
export function setDaemonRpcSender(fn: SendDaemonRpc): void {
  sendDaemonRpc = fn;
}

async function forwardToDaemon(input: SearchInput): Promise<SearchResponse> {
  if (!sendDaemonRpc) {
    throw new Error('daemon-first: WS handler bridge not wired (setDaemonRpcSender pending)');
  }
  const correlationId = `mqry_${Math.random().toString(36).slice(2, 14)}`;
  const dataPromise = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResponses.delete(correlationId);
      reject(new Error(`daemon RPC timeout after ${DAEMON_FORWARD_TIMEOUT_MS}ms`));
    }, DAEMON_FORWARD_TIMEOUT_MS);
    pendingResponses.set(correlationId, { resolve, reject, timer });
  });
  await sendDaemonRpc(input.acl.workspaceId, {
    type: 'memory.search',
    correlationId,
    payload: input,
  });
  const data = (await dataPromise) as SearchResponse['data'];
  return { ok: true, data };
}

// ─── Dual-path state machine (per workspace) ──────────────────
//
// Enters dual_path when 3+ ping failures within a 5-min sliding window.
// Exits when 60 seconds of consecutive successes accumulate.
// Both transitions emit metrics (counter increment / gauge flip).

const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const FAILURE_THRESHOLD = 3;
const SUCCESS_RESET_MS = 60 * 1000;

interface DualPathState {
  active: boolean;
  failureTimestamps: number[];
  consecutiveSuccessSinceMs: number | null;
}

const dualPathStates = new Map<string, DualPathState>();

/** Snapshot for tests + ops dashboard. */
export function getDualPathState(workspaceId: string): { active: boolean; recentFailures: number } {
  const s = dualPathStates.get(workspaceId);
  if (!s) return { active: false, recentFailures: 0 };
  return { active: s.active, recentFailures: countRecentFailures(s) };
}

/** Reset the dual-path state map. Used by tests. */
export function __resetDualPathStates(): void {
  dualPathStates.clear();
  daemonPresence.clear();
  pendingResponses.clear();
  sendDaemonRpc = null;
}

let dualPathEnteredTotal = 0;
/** Counter exporter for ops scrape. */
export function getDualPathMetrics(): { enteredTotal: number; activeWorkspaces: number } {
  let active = 0;
  for (const s of dualPathStates.values()) if (s.active) active += 1;
  return { enteredTotal: dualPathEnteredTotal, activeWorkspaces: active };
}

function countRecentFailures(s: DualPathState): number {
  const cutoff = Date.now() - FAILURE_WINDOW_MS;
  s.failureTimestamps = s.failureTimestamps.filter((t) => t >= cutoff);
  return s.failureTimestamps.length;
}

function recordPingResult(workspaceId: string, success: boolean): void {
  let s = dualPathStates.get(workspaceId);
  if (!s) {
    s = { active: false, failureTimestamps: [], consecutiveSuccessSinceMs: null };
    dualPathStates.set(workspaceId, s);
  }
  const now = Date.now();
  if (success) {
    if (s.consecutiveSuccessSinceMs === null) s.consecutiveSuccessSinceMs = now;
    if (s.active && now - s.consecutiveSuccessSinceMs >= SUCCESS_RESET_MS) {
      s.active = false;
      s.failureTimestamps = [];
    }
  } else {
    s.consecutiveSuccessSinceMs = null;
    s.failureTimestamps.push(now);
    countRecentFailures(s); // prune
    if (!s.active && s.failureTimestamps.length >= FAILURE_THRESHOLD) {
      s.active = true;
      dualPathEnteredTotal += 1;
    }
  }
}

export class MemorySearchService {
  async search(input: SearchInput): Promise<SearchResponse> {
    const t0 = Date.now();

    if (process.env.FF_MEMORY_SEARCH_DAEMON_FIRST === 'true') {
      const online = await pingDaemon(input.acl.workspaceId);
      recordPingResult(input.acl.workspaceId, online);
      if (online) {
        try {
          return await forwardToDaemon(input);
        } catch (err) {
          // Daemon RPC failed — record as ping failure (counts toward dual_path
          // entry) and fall through to cloud. Caller never sees the timeout.
          recordPingResult(input.acl.workspaceId, false);
          void err;
        }
      }
      // dual-path fallback: cloud answers when daemon offline OR RPC failed
    }

    const result = await this.cloudFallbackSearch(input);
    return {
      ok: true,
      data: {
        ...result,
        took_ms: Date.now() - t0,
      },
    };
  }

  private async cloudFallbackSearch(input: SearchInput): Promise<{
    memory: MemorySearchResult[];
    files: FileSearchResult[];
    cursor: string | null;
  }> {
    const { acl, encryptionMode = 'standard' } = input;
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const kind = input.kind ?? 'both';
    const queryTokens = tokenize(input.query);
    if (queryTokens.length === 0 || encryptionMode === 'regulated') {
      return { memory: [], files: [], cursor: null };
    }

    const memory = kind !== 'files' ? await this.searchMemory(acl, input, queryTokens, limit, encryptionMode) : [];
    const files = kind !== 'memory' ? await this.searchFiles(acl, input, queryTokens, limit) : [];

    return { memory, files, cursor: null };
  }

  private async searchMemory(
    acl: MemoryAclContext,
    input: SearchInput,
    queryTokens: string[],
    limit: number,
    encryptionMode: EncryptionMode,
  ): Promise<MemorySearchResult[]> {
    const stale = input.stale === 'all' ? undefined : input.stale === 'true';

    // Visibility filter: caller-supplied `visibility` MUST be intersected with
    // the ACL's allow-list, never replace it. Without this check, a delegated
    // agent could call `?visibility=human:<owner>` and read the workspace
    // owner's human-private memory (or `?visibility=agent:<other>` to read
    // another agent's namespace). We reject the request rather than silently
    // dropping the filter so the caller learns the request was ill-formed.
    let visFilter: { visibility: string } | null;
    if (input.visibility) {
      if (!acl.canRead({ visibility: input.visibility })) {
        throw new MemorySearchError(
          'forbidden_visibility_filter',
          `caller cannot search with visibility="${input.visibility}"`,
          403,
        );
      }
      visFilter = { visibility: input.visibility };
    } else {
      visFilter = null;
    }
    const where = {
      workspaceId: acl.workspaceId,
      archivedAt: null,
      deletedAt: null,
      ...(input.pageType?.length ? { pageType: { in: input.pageType } } : {}),
      ...(typeof stale === 'boolean' ? { stale } : {}),
      ...(visFilter ?? visibilityWhere(acl)),
      OR: queryTokens.flatMap((t: string) => [
        { path: { contains: t } },
        { title: { contains: t } },
        { content: { contains: t } },
      ]),
    };

    type CandidateRow = {
      id: string;
      workspaceId: string;
      path: string;
      title: string | null;
      content: string;
      pageType: string;
      visibility: string;
      stale: boolean;
      updatedAt: Date;
    };
    const candidates: CandidateRow[] = await prisma.iMMemoryPage.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: Math.min(limit * 5, 200),
      select: {
        id: true,
        workspaceId: true,
        path: true,
        title: true,
        content: true,
        pageType: true,
        visibility: true,
        stale: true,
        updatedAt: true,
      },
    });
    if (candidates.length === 0) return [];

    const ids = candidates.map((c: CandidateRow) => c.id);
    const inboundCounts = await prisma.iMMemoryLink.groupBy({
      by: ['targetPageId'],
      where: { workspaceId: acl.workspaceId, targetPageId: { in: ids } },
      _count: { _all: true },
    });
    const inboundMap = new Map<string, number>();
    for (const r of inboundCounts as { targetPageId: string | null; _count: { _all: number } }[]) {
      if (r.targetPageId) inboundMap.set(r.targetPageId, r._count._all);
    }

    const now = Date.now();
    const scored: MemorySearchResult[] = candidates
      .map((row: CandidateRow): MemorySearchResult => {
        const inboundLinkCount = inboundMap.get(row.id) ?? 0;
        const ms = matchScore(row.content, row.title, row.path, queryTokens);
        const linkBoost = Math.log(1 + inboundLinkCount) * 0.3;
        const decay = recencyDecay(row.updatedAt, now) * 0.2;
        const stalePenalty = row.stale ? 0.5 : 0;
        const score = ms + linkBoost + decay - stalePenalty;

        const snippetSource = encryptionMode === 'private' ? `${row.path} ${row.title ?? ''}` : row.content;

        return {
          pageId: row.id,
          workspaceId: row.workspaceId,
          path: row.path,
          title: row.title,
          pageType: row.pageType,
          visibility: row.visibility,
          stale: row.stale,
          inboundLinkCount,
          updatedAt: row.updatedAt.toISOString(),
          snippet: buildSnippet(snippetSource, input.query),
          score,
          components: {
            matchScore: ms,
            linkBoost,
            recencyDecay: decay,
            stalePenalty,
          },
        };
      })
      .sort((a: MemorySearchResult, b: MemorySearchResult) => b.score - a.score)
      .slice(0, limit);

    return scored;
  }

  private async searchFiles(
    acl: MemoryAclContext,
    input: SearchInput,
    queryTokens: string[],
    limit: number,
  ): Promise<FileSearchResult[]> {
    type FileRow = {
      id: string;
      workspaceId: string;
      path: string;
      ownerId: string;
      memoryType: string | null;
      description: string | null;
      content: string;
      visibility: string;
      updatedAt: Date;
    };

    // ACL: IMMemoryFile uses `ownerId` as the canonical author key (legacy
    // surface predates IMMemoryPage's visibility-string design). The rest of
    // the file API enforces `file.ownerId !== caller → 404` (see
    // src/im/api/memory.ts GET /memory/files/:id), so search must do the
    // same — visibility-class match alone would leak other agents' private
    // files to delegated agents in the same workspace.
    const candidates: FileRow[] = await prisma.iMMemoryFile.findMany({
      where: {
        workspaceId: acl.workspaceId,
        ownerId: acl.callerImUserId,
        ...visibilityWhere(acl),
        OR: queryTokens.flatMap((t: string) => [
          { path: { contains: t } },
          { description: { contains: t } },
          { content: { contains: t } },
        ]),
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        workspaceId: true,
        path: true,
        ownerId: true,
        memoryType: true,
        description: true,
        content: true,
        visibility: true,
        updatedAt: true,
      },
    });

    return candidates.map((row: FileRow) => ({
      fileId: row.id,
      workspaceId: row.workspaceId,
      path: row.path,
      ownerId: row.ownerId,
      memoryType: row.memoryType,
      description: row.description,
      updatedAt: row.updatedAt.toISOString(),
      snippet: buildSnippet(row.content, input.query),
    }));
  }
}
