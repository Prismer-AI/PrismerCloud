// `prismer memory ...` — local memory store inspection via daemon RPC.
//
// ★ CANONICAL agent-facing memory CLI. The `memory` SKILL.md (`prismer memory
//   write/recall/read/list/curate`) resolves here via @prismer/runtime's `prismer`
//   bin. (NOT the SDK-side legacy `typescript/src/commands/memory.ts` reached by
//   `cloud memory`, retired by memory203/13 decision D.) As of 2822f36f the runtime
//   no longer declares a `cloud` bin — `cloud`=@prismer/sdk (cloud HTTP), `prismer`=
//   @prismer/runtime (this canonical daemon CLI). Local-first: hits the local
//   daemon, not cloud HTTP.
//
// Phase-0 (Line C C1): the daemon exposes `/local/memory/*` routes via the
// memory module wired into LocalServer. The CLI hits those routes first;
// the legacy `/memory/*` + `/api/memory/*` paths remain in the fallback
// list so older daemons (pre-phase-0) still surface the read-only cache
// snapshot from `~/.prismer/local.db` rather than crash.
//
// When the new routes respond, the cache-fallback path is NOT taken — the
// daemon is treated as the source of truth for memory state.

import Database from 'better-sqlite3';
import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { CloudClient } from '../../auth.js';
import { loadConfig, resolvePaths } from '../../config.js';
import { color, printJson } from '../util.js';
import { getUI } from '../ui.js';

type JsonObject = Record<string, unknown>;

interface CacheSnapshot {
  dbPath: string;
  dbExists: boolean;
  dbError?: string;
  tables: {
    cached_assets: { exists: boolean; count: number; sizeBytes: number };
    workspace_files_mirror: { exists: boolean; count: number };
  };
  items: CacheItem[];
}

interface CacheItem {
  kind: 'asset' | 'workspace_file';
  id: string;
  contentHash?: string;
  workspaceId?: string;
  path?: string;
  assetId?: string;
  sizeBytes?: number;
  mime?: string | null;
  localPath?: string;
  fetchedAt?: number;
  lastUsedAt?: number;
  pinned?: boolean;
  version?: number;
  syncedAt?: number | null;
  dirty?: boolean;
}

interface CliResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  checks?: JsonObject;
  fix?: string;
}

// Resolve the daemon's local-server base. The daemon publishes its actual port
// to PRISMER_DAEMON_PORT (local-server.ts) and the agent-rt env passes it through
// to tool subprocesses; honour it so the CLI hits the daemon's REAL port (e.g.
// 7878 in agent-rt pods) rather than the stale 3210 default — the mismatch made
// every `memory` command fail with "gateway unavailable".
const LOCAL_BASE =
  process.env.PRISMER_DAEMON_URL ??
  `http://127.0.0.1:${(process.env.PRISMER_DAEMON_PORT ?? '3210').trim() || '3210'}`;

/** Agent-rt injects the workspace; default to it so the agent can run
 *  `prismer memory search "q"` without repeating --workspace-id. */
const ENV_WS = process.env.PRISMER_WORKSPACE_ID?.trim() || undefined;

// spec16 §8.1 MA-0S — every /local/memory/* call carries the daemon-minted
// per-agent cap from $PRISMER_MEMORY_CAP (prismer-env) as the
// `x-prismer-memory-cap` header. The daemon is fail-closed: no/invalid cap →
// 401 (surfaced below as exit 1), cross-ws cap → 403. The acting identity is
// the cap subject — this CLI no longer claims an actor in the write body.
const CAP_HEADER = 'x-prismer-memory-cap';
const ENV_CAP = process.env.PRISMER_MEMORY_CAP?.trim() || undefined;
const capHeaders = (): Record<string, string> => (ENV_CAP ? { [CAP_HEADER]: ENV_CAP } : {});

export function buildMemoryCommand(): Command {
  const cmd = new Command('memory').description('Inspect local daemon memory/cache state');

  cmd
    .command('stats')
    .description('Show memory/cache stats')
    .option('--workspace-id <id>', 'Scope to a single workspace (default: global aggregate)')
    .option('--json', 'Output JSON (default)')
    .action(async (opts: { workspaceId?: string }) => {
      const wsParam = opts.workspaceId ? `?workspaceId=${encodeURIComponent(opts.workspaceId)}` : '';
      const daemon = await tryDaemon(
        ['GET'],
        [`/local/memory/stats${wsParam}`, '/memory/stats', '/api/memory/stats'],
      );
      if (daemon) {
        printJson(daemon);
        if (!daemon.ok) process.exitCode = 1;
        return;
      }

      const snapshot = readCacheSnapshot(0);
      printJson(unavailable('stats', snapshot, {
        stats: {
          assets: snapshot.tables.cached_assets.count,
          assetBytes: snapshot.tables.cached_assets.sizeBytes,
          workspaceFiles: snapshot.tables.workspace_files_mirror.count,
        },
      }));
      process.exitCode = 1;
    });

  cmd
    .command('list')
    .description('List memory records, or local cache records when gateway is unavailable')
    .option('--workspace-id <id>', 'Workspace to list (default: $PRISMER_WORKSPACE_ID)')
    .option('--page-type <type>', 'Filter by pageType (hub/leaf/decision/glossary/archive)')
    .option('--limit <n>', 'Max items', parsePositiveInt, 20)
    .option('--json', 'Output JSON (default)')
    .action(async (opts: { workspaceId?: string; pageType?: string; limit: number }) => {
      const limit = clampLimit(opts.limit);
      // memory203/18 W4 — fall back to $PRISMER_WORKSPACE_ID like every other
      // subcommand (search/read/recall/write). Without it a bare `prismer
      // memory list` in an agent pod never even TRIED the modern
      // /local/memory/list route (only the legacy 404 paths) and reported
      // memory_gateway_unavailable against a live RPC (W2-gate item 3).
      const ws = opts.workspaceId ?? ENV_WS;
      const daemonPaths: string[] = [];
      if (ws) {
        const params = new URLSearchParams({ workspaceId: ws, limit: String(limit) });
        if (opts.pageType) params.set('pageType', opts.pageType);
        daemonPaths.push(`/local/memory/list?${params.toString()}`);
      }
      // Legacy fallback paths: ignore workspaceId (older daemons didn't scope this way).
      daemonPaths.push(`/memory/list?limit=${limit}`, `/api/memory/list?limit=${limit}`);

      const daemon = await tryDaemon(['GET'], daemonPaths);
      if (daemon) {
        printJson(daemon);
        if (!daemon.ok) process.exitCode = 1;
        return;
      }

      const snapshot = readCacheSnapshot(limit);
      printJson(unavailable('list', snapshot, { items: snapshot.items, limit }));
      process.exitCode = 1;
    });

  cmd
    .command('search')
    .description('Search memory records, or local cache metadata when gateway is unavailable')
    .argument('[query]', 'Search text')
    .option('--query <text>', 'Search text')
    // memory211/01 §6.11 D11-2 (W7 item 3) — the batch recall face. The daemon
    // answers `queries` (JSON array) and ignores `q`; `q` still travels (first
    // query) so an older daemon keeps working, exactly like the TS tool client.
    .option('--queries <json>', 'Batch: a JSON array of up to 8 queries answered in ONE call')
    .option('--workspace-id <id>', 'Workspace to search (required for daemon RPC)')
    .option('--limit <n>', 'Max items', parsePositiveInt, 20)
    .option('--json', 'Output JSON (default)')
    .action(
      async (
        argQuery: string | undefined,
        opts: { query?: string; queries?: string; workspaceId?: string; limit: number },
      ) => {
        const limit = clampLimit(opts.limit);
        const ws = opts.workspaceId ?? ENV_WS;
        const batch = parseCliBatchQueries(opts.queries);
        if (!batch.ok) {
          printJson({ ok: false, error: { code: 'invalid_queries', message: batch.message } });
          process.exitCode = 1;
          return;
        }
        const queries = batch.queries;
        const query = opts.query ?? argQuery ?? queries[0] ?? '';
        const encoded = encodeURIComponent(query);
        const daemonPaths: string[] = [];
        if (ws) {
          const params = new URLSearchParams({
            workspaceId: ws,
            q: encoded,
            topK: String(limit),
          });
          if (queries.length > 0) params.set('queries', JSON.stringify(queries));
          daemonPaths.push(`/local/memory/search?${params.toString()}`);
        }
        daemonPaths.push(
          `/memory/search?q=${encoded}&limit=${limit}`,
          `/api/memory/search?q=${encoded}&limit=${limit}`,
        );

        const daemon = await tryDaemon(['GET'], daemonPaths);
        if (daemon) {
          // W7 item 2 (D11-1) — one recall_pull per CLI recall (via:'cli'), before
          // the exit-code decision so a non-2xx recall still registers intent.
          // Batch parity: a batched call carries N distinct recall intents, so it
          // emits one row PER query — the same chokepoint rule the daemon's own
          // handler applies (rpc.ts emitRecallPull per query).
          if (ws) {
            const data = daemon.data as
              | { results?: unknown[]; resultsByQuery?: Array<{ query: string; results?: unknown[] }> }
              | undefined;
            const groups =
              data?.resultsByQuery && data.resultsByQuery.length > 0
                ? data.resultsByQuery
                : [{ query, results: data?.results }];
            for (const group of groups) {
              await emitCliRecallPull({
                workspaceId: ws,
                query: group.query,
                tool: 'memory_search',
                hitCount: Array.isArray(group.results) ? group.results.length : 0,
                topK: limit,
              });
            }
          }
          printJson(daemon);
          if (!daemon.ok) process.exitCode = 1;
          return;
        }

        const snapshot = readCacheSnapshot(Math.max(limit * 3, limit));
        const q = query.toLowerCase();
        const items = snapshot.items
          .filter((item) => searchableText(item).toLowerCase().includes(q))
          .slice(0, limit);
        printJson(unavailable('search', snapshot, { items, query, limit }));
        process.exitCode = 1;
      },
    );

  // ── load-batch (memory211/01 §6.11 D11-2, W7 item 3) ────────────────────────
  // The CLI face of "顺链接批量读" (SKILL STAGE 3: start point → children →
  // batch read). The daemon has no batch-load RPC — a load is a single-path
  // point read — so this fans out into ≤10 /local/memory/load calls and
  // aggregates them, keeping the per-path verdict so a partial miss is visible
  // instead of collapsing into one error.
  cmd
    .command('load-batch <paths...>')
    .description('Read up to 10 memory pages in one call (per-path verdict, partial misses visible)')
    .option('--workspace-id <id>', 'Workspace (default: $PRISMER_WORKSPACE_ID)')
    .action(async (paths: string[], opts: { workspaceId?: string }) => {
      const ws = opts.workspaceId ?? ENV_WS;
      if (!ws) return failNoWorkspace('load-batch');
      const requested = paths.slice(0, MAX_CLI_LOAD_BATCH);
      const overflow = paths.length - requested.length;
      const results: Array<Record<string, unknown>> = [];
      for (const path of requested) {
        const daemon = await daemonGet(
          `/local/memory/load?workspaceId=${encodeURIComponent(ws)}&path=${encodeURIComponent(path)}`,
        );
        if (daemon && daemon.status === 200) {
          results.push({
            path,
            ok: true,
            page: (daemon.body as { page?: unknown } | null)?.page ?? null,
          });
        } else if (daemon) {
          const err = daemon.body as { error?: string } | null;
          results.push({ path, ok: false, error: err?.error ?? `daemon_http_${daemon.status}` });
        } else {
          results.push({ path, ok: false, error: 'memory_gateway_unavailable' });
        }
      }
      const okCount = results.filter((r) => r.ok).length;
      printJson({
        ok: okCount > 0,
        data: {
          workspaceId: ws,
          loaded: okCount,
          requested: requested.length,
          ...(overflow > 0 ? { dropped: overflow, note: `load-batch is capped at ${MAX_CLI_LOAD_BATCH} paths` } : {}),
          results,
        },
      });
      // A total miss is a failure; a partial miss is reported per path and
      // keeps exit 0 so the agent can still read the pages that DID load.
      if (okCount === 0) process.exitCode = 1;
    });

  cmd
    .command('delete <id>')
    .description('Delete a memory page (soft delete, cloud-adjudicated)')
    // memory211/01 W5 轴 H — the page id alone is ambiguous across workspaces in
    // the daemon's local mirror, and cloud needs the scope for its ACL verdict.
    .option('--workspace-id <id>', 'Workspace (default: $PRISMER_WORKSPACE_ID)')
    .option('--json', 'Output JSON (default)')
    .action(async (id: string, opts: { workspaceId?: string }) => {
      const ws = opts.workspaceId ?? ENV_WS;
      if (!ws) return failNoWorkspace('delete');
      // The daemon's /local/memory/delete forwards to cloud (the deletion
      // authority) and invalidates the local mirror. The legacy paths below
      // stay as the pre-phase-0 fallback only.
      const body = JSON.stringify({ workspaceId: ws, pageId: id });
      const daemon = await daemonPostRaw('/local/memory/delete', body);
      if (daemon) return printJson(daemon);

      const legacy = await tryDaemon(
        ['DELETE'],
        [`/memory/${encodeURIComponent(id)}`, `/api/memory/${encodeURIComponent(id)}`],
      );
      if (legacy) return printJson(legacy);

      const snapshot = readCacheSnapshot(0);
      printJson(unavailable('delete', snapshot, { id }));
      process.exitCode = 1;
    });

  cmd
    .command('sync')
    .description('Flush the daemon memory outbox (sync pending local writes to cloud)')
    .option('--workspace-id <id>', 'Workspace (default: $PRISMER_WORKSPACE_ID)')
    .option('--json', 'Output JSON (default)')
    .action(async (opts: { workspaceId?: string }) => {
      const ws = opts.workspaceId ?? ENV_WS;
      // The daemon exposes POST /local/memory/sync (alias of flush). The legacy
      // paths below are the pre-phase-0 fallback only — no daemon ever exposed
      // them, so probing them first was why `memory sync` always reported the
      // gateway unavailable.
      const body = JSON.stringify(ws ? { workspaceId: ws } : {});
      const daemon = await daemonPostRaw('/local/memory/sync', body);
      if (daemon) return printJson(daemon);

      const legacy = await tryDaemon(['POST'], ['/memory/sync', '/api/memory/sync']);
      if (legacy) return printJson(legacy);

      const snapshot = readCacheSnapshot(0);
      printJson(unavailable('sync', snapshot));
      process.exitCode = 1;
    });

  // ── read / load a page by path (section-level via #anchor) ──────────────────
  cmd
    .command('read <path>')
    .alias('load')
    .description('Read a memory page by path (use path#section for one section)')
    .option('--workspace-id <id>', 'Workspace (default: $PRISMER_WORKSPACE_ID)')
    .option('--json', 'Output JSON (default)')
    .action(async (path: string, opts: { workspaceId?: string }) => {
      const ws = opts.workspaceId ?? ENV_WS;
      if (!ws) return failNoWorkspace('read');
      const daemon = await tryDaemon(
        ['GET'],
        [`/local/memory/load?workspaceId=${encodeURIComponent(ws)}&path=${encodeURIComponent(path)}`],
      );
      if (daemon) {
        printJson(daemon);
        if (!daemon.ok) process.exitCode = 1;
        return;
      }
      printJson(unavailable('read', readCacheSnapshot(0), { path }));
      process.exitCode = 1;
    });

  // ── recall = semantic search returning content (alias the search path) ──────
  cmd
    .command('recall <query>')
    .description('Recall memory by semantic search (returns matching pages + snippets)')
    .option('--workspace-id <id>', 'Workspace (default: $PRISMER_WORKSPACE_ID)')
    .option('--limit <n>', 'Max items', parsePositiveInt, 8)
    .action(async (query: string, opts: { workspaceId?: string; limit: number }) => {
      const ws = opts.workspaceId ?? ENV_WS;
      if (!ws) return failNoWorkspace('recall');
      const limit = clampLimit(opts.limit);
      const daemon = await tryDaemon(
        ['GET'],
        [`/local/memory/search?workspaceId=${encodeURIComponent(ws)}&q=${encodeURIComponent(query)}&topK=${limit}`],
      );
      if (daemon) {
        // W7 item 2 (D11-1) — the CLI face of recall_pull (via:'cli').
        const results = (daemon.data as { results?: unknown[] } | undefined)?.results;
        await emitCliRecallPull({
          workspaceId: ws,
          query,
          tool: 'memory_search',
          hitCount: Array.isArray(results) ? results.length : 0,
          topK: limit,
        });
        printJson(daemon);
        if (!daemon.ok) process.exitCode = 1;
        return;
      }
      printJson(unavailable('recall', readCacheSnapshot(0), { query }));
      process.exitCode = 1;
    });

  // ── write / update a memory page ────────────────────────────────────────────
  cmd
    .command('write')
    .description('Write (create/update) a memory page')
    .requiredOption('--path <path>', 'Page path, e.g. decisions/db-choice.md')
    .option('--content <text>', 'Page body (markdown / PKF)')
    // memory211/01 W5 轴 H — the tool schema's `title` had no CLI face.
    .option('--title <text>', 'Short page title')
    .option('--page-type <type>', 'hub | leaf | decision | glossary | archive', 'leaf')
    .option('--visibility <scope>', 'workspace | agent:<id> | private:<id> | role:<slug> | council:<id> | task:<id>')
    // memory203/18 R6.4 — section-level write passthrough (daemon POST body).
    .option('--op <op>', 'replace | append-section | rewrite-section (default replace)')
    .option('--section <id>', 'Target section heading id (required for section ops)')
    // memory203/18 R6.3 — structural placement (matches the memory_write tool).
    .option('--parent-hub-path <path>', 'Attach the new leaf under this hub (relation child-of)')
    .option('--relation <relation>', 'child-of (default) | related')
    // product210/03 W1-3 — deliverable admission (G9/G10/idempotency gates).
    .option('--deliverable-asset <id>', 'Source asset id this page was distilled from (enables G9/G10 gates)')
    .option('--deliverable-hash <sha256>', 'Source deliverable contentHash (dedupe token)')
    .option('--deliverable-size <n>', 'Source deliverable size in bytes (G10 budget)', parsePositiveInt)
    .option('--workspace-id <id>', 'Workspace (default: $PRISMER_WORKSPACE_ID)')
    .action(
      async (opts: {
        path: string;
        content?: string;
        title?: string;
        pageType: string;
        visibility?: string;
        op?: string;
        section?: string;
        parentHubPath?: string;
        relation?: string;
        deliverableAsset?: string;
        deliverableHash?: string;
        deliverableSize?: number;
        workspaceId?: string;
      }) => {
      const ws = opts.workspaceId ?? ENV_WS;
      if (!ws) return failNoWorkspace('write');
      const content = opts.content ?? (await readStdin());
      const deliverableSource =
        opts.deliverableAsset || opts.deliverableHash || opts.deliverableSize
          ? {
              ...(opts.deliverableAsset ? { assetId: opts.deliverableAsset } : {}),
              ...(opts.deliverableHash ? { contentHash: opts.deliverableHash } : {}),
              ...(opts.deliverableSize ? { sizeBytes: opts.deliverableSize } : {}),
            }
          : undefined;
      const body = {
        workspaceId: ws,
        path: opts.path,
        content,
        pageType: opts.pageType,
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.visibility ? { visibility: opts.visibility } : {}),
        ...(opts.op ? { op: opts.op } : {}),
        ...(opts.section ? { section: opts.section } : {}),
        ...(opts.parentHubPath ? { parentHubPath: opts.parentHubPath } : {}),
        ...(opts.relation ? { relation: opts.relation } : {}),
        ...(deliverableSource ? { deliverableSource } : {}),
      };
      const res = await daemonPost('/local/memory/write', body);
      printJson(res);
      if (!res.ok) process.exitCode = 1;
    });

  // ── trace = write-chain observability (memory203/18 R8.3) ───────────────────
  // Unlike the other subcommands this hits CLOUD (the chain lives in cloud rows:
  // sync events → page/version provenance → links); the daemon only emits the
  // traceId. Read-only; same auth as every other cloud memory read.
  cmd
    .command('trace')
    .description('Trace the memory write chain in cloud (sync events → pages → versions → links)')
    .option('--trace-id <id>', 'R8.1 traceId threaded through the daemon write lane')
    .option('--path <path>', 'Memory page path, e.g. projects/alpha/decisions.pkf')
    .option('--workspace-id <id>', 'Workspace (default: $PRISMER_WORKSPACE_ID)')
    .option('--json', 'Output raw JSON instead of the pretty chain')
    .action(async (opts: { traceId?: string; path?: string; workspaceId?: string; json?: boolean }) => {
      const ws = opts.workspaceId ?? ENV_WS;
      if (!ws) return failNoWorkspace('trace');
      if (!opts.traceId && !opts.path) {
        printJson({ ok: false, error: { code: 'trace_query_required', message: '--trace-id or --path is required' } });
        process.exitCode = 1;
        return;
      }
      const params = new URLSearchParams({ workspaceId: ws });
      if (opts.traceId) params.set('traceId', opts.traceId);
      if (opts.path) params.set('path', opts.path);
      const cfg = loadConfig(resolvePaths());
      const cloud = new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
      const res = await cloud.request<{ ok?: boolean; data?: MemoryTraceData }>(
        'GET',
        `/api/im/memory/trace?${params.toString()}`,
      );
      if (!res.ok || !res.data?.data) {
        printJson({
          ok: false,
          error: {
            code: res.error?.code ?? 'trace_failed',
            message: res.error?.message ?? `HTTP ${res.status}`,
          },
        });
        process.exitCode = 1;
        return;
      }
      const trace = res.data.data;
      if (opts.json) {
        printJson({ ok: true, data: trace });
        return;
      }
      printTrace(trace);
    });

  // ── ingest = the workspace UPLOAD-INGEST operational switch ────────────────
  // memory211/01 §6.9 裁决 5 (掉账 ②): `metadata.ingestDisabled` was readable by
  // the dispatch path but had no operational face. This is a CLOUD setting (the
  // ingest queue is cloud-side), so unlike the other subcommands it hits the
  // cloud /memory/ingest-settings route — owner/admin only, merge-safe (it does
  // NOT wholesale-replace workspace metadata the way PATCH /workspaces does).
  const ingest = cmd.command('ingest').description('Show or toggle workspace upload-ingest (owner/admin)');
  ingest
    .option('--workspace-id <id>', 'Workspace (default: $PRISMER_WORKSPACE_ID)')
    .option('--disable', 'Disable upload ingest for the workspace')
    .option('--enable', 'Enable upload ingest for the workspace')
    .option('--json', 'Output raw JSON (default)')
    .action(async (opts: { workspaceId?: string; disable?: boolean; enable?: boolean; json?: boolean }) => {
      const ws = opts.workspaceId ?? ENV_WS;
      if (!ws) return failNoWorkspace('ingest');
      if (opts.disable && opts.enable) {
        printJson({ ok: false, error: { code: 'ingest_flag_conflict', message: 'use --disable OR --enable, not both' } });
        process.exitCode = 1;
        return;
      }
      const cfg = loadConfig(resolvePaths());
      const cloud = new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
      const body = opts.disable || opts.enable ? { workspaceId: ws, disabled: Boolean(opts.disable) } : { workspaceId: ws, statusOnly: true };
      const res = await cloud.request<{ ok?: boolean; data?: { ingestDisabled?: boolean } }>(
        'POST',
        '/api/im/memory/ingest-settings',
        { body },
      );
      if (!res.ok) {
        printJson({
          ok: false,
          error: {
            code: res.error?.code ?? 'ingest_settings_failed',
            message:
              res.error?.message ??
              `HTTP ${res.status} — ingest is owner/admin-gated; the workspace may not be yours to operate`,
          },
        });
        process.exitCode = 1;
        return;
      }
      printJson({ ok: true, data: { workspaceId: ws, ingestDisabled: res.data?.data?.ingestDisabled ?? false } });
    });

  // ── curate = Dream-maintenance WRITE VERBS (orchestrator-only) ───────────────
  // memory203/13 §0.5: `run-dream` (autonomous cloud-LLM clustering) is retired —
  // Dream is the orchestrator's memory-dream skill calling these write verbs.
  const curate = cmd.command('curate').description('Memory curation (Dream maintenance) — orchestrator only');
  // ── candidates = the Dream CONVERGENCE READ half (memory203/13 §P4) ──────────
  // The orchestrator READS what to converge (orphan leaves / near-duplicate
  // clusters / stale garbage) BEFORE deciding clusters + calling the write verbs.
  // GET passthrough to the daemon's /local/memory/health → cloud /memory/health/*.
  // NOT orchestrator-gated (read-only health scan); every agent can read, but
  // only the orchestrator's verbs can ACT on what it reads.
  curate
    .command('candidates')
    .description('Read Dream candidates: orphan leaves + near-dup clusters + stale pages (the READ half)')
    .option('--kind <kind>', 'orphans | duplicates | stale | all (default all)', 'all')
    .option('--limit <n>', 'Max items per kind', parsePositiveInt)
    .option('--workspace-id <id>', 'Workspace (default: $PRISMER_WORKSPACE_ID)')
    .action(async (opts: { kind?: string; limit?: number; workspaceId?: string }) => {
      const ws = opts.workspaceId ?? ENV_WS;
      if (!ws) return failNoWorkspace('curate candidates');
      const params = new URLSearchParams({ workspaceId: ws });
      if (opts.kind) params.set('kind', opts.kind);
      if (opts.limit !== undefined) params.set('limit', String(clampLimit(opts.limit)));
      const daemon = await tryDaemon(['GET'], [`/local/memory/health?${params.toString()}`]);
      if (daemon) {
        printJson(daemon);
        if (!daemon.ok) process.exitCode = 1;
        return;
      }
      printJson(unavailable('curate candidates', readCacheSnapshot(0), { kind: opts.kind ?? 'all' }));
      process.exitCode = 1;
    });
  curate
    .command('promote-to-hub <pageId>')
    .description('Promote a leaf page to a hub')
    // memory211/01 W5 轴 H — 挂子: attach existing pages under the promoted hub
    // in the same cloud transaction (the tool's `childPaths`, CLI spelling).
    // Without it a promoted hub spanned nothing and the convergence never took.
    .option('--child-paths <paths...>', 'Existing page paths to attach as the hub\'s children')
    .option('--workspace-id <id>')
    .action(async (pageId: string, opts: { childPaths?: string[]; workspaceId?: string }) =>
      runCurate('promote_to_hub', opts.workspaceId, pageId, undefined, opts.childPaths),
    );
  curate
    .command('supersede <pageId>')
    .description('Archive + supersede a page (merge loser / prune garbage)')
    .option('--reason <text>', 'Why')
    .option('--workspace-id <id>')
    .action(async (pageId: string, opts: { workspaceId?: string; reason?: string }) =>
      runCurate('supersede', opts.workspaceId, pageId, opts.reason),
    );
  curate
    .command('rebuild-index')
    .description('Rebuild the top-level INDEX TOC')
    .option('--workspace-id <id>')
    .action(async (opts: { workspaceId?: string }) => runCurate('rebuild_index', opts.workspaceId));
  // ── memory211/01 W5 轴 G — section-level verbs (CLI face of the tool ops) ───
  curate
    .command('section-merge <pageId>')
    .description('Fold a near-duplicate section into another (provenance edges are written for you)')
    .requiredOption('--target-section <slug>', 'Anchor slug of the WINNER section that absorbs the duplicate')
    .requiredOption('--source-page-id <id>', 'Id of the LOSER page whose section is folded away')
    .requiredOption('--source-section <slug>', 'Anchor slug of the LOSER section')
    .option('--merged-content <text>', 'Merged section body (also readable from stdin)')
    .option('--reason <text>', 'Why')
    .option('--workspace-id <id>')
    .action(
      async (
        pageId: string,
        opts: {
          targetSection: string;
          sourcePageId: string;
          sourceSection: string;
          mergedContent?: string;
          reason?: string;
          workspaceId?: string;
        },
      ) => {
        const ws = opts.workspaceId ?? ENV_WS;
        if (!ws) return failNoWorkspace('curate section-merge');
        const mergedContent = opts.mergedContent ?? (await readStdin());
        const res = await daemonPost('/local/memory/curate', {
          workspaceId: ws,
          op: 'section_merge',
          pageId,
          targetSection: opts.targetSection,
          sourcePageId: opts.sourcePageId,
          sourceSection: opts.sourceSection,
          mergedContent,
          ...(opts.reason ? { reason: opts.reason } : {}),
        });
        printJson(res);
        if (!res.ok) process.exitCode = 1;
      },
    );
  curate
    .command('section-supersede <pageId>')
    .description('Retire ONE section in place')
    .requiredOption('--section <slug>', 'Anchor slug of the section to retire')
    .option('--superseded-by-page-id <id>', 'Optional surviving page the retired section points at')
    .option('--superseded-by-section <slug>', 'Anchor slug on the surviving page')
    .option('--reason <text>', 'Why')
    .option('--workspace-id <id>')
    .action(
      async (
        pageId: string,
        opts: {
          section: string;
          supersededByPageId?: string;
          supersededBySection?: string;
          reason?: string;
          workspaceId?: string;
        },
      ) => {
        const ws = opts.workspaceId ?? ENV_WS;
        if (!ws) return failNoWorkspace('curate section-supersede');
        const res = await daemonPost('/local/memory/curate', {
          workspaceId: ws,
          op: 'section_supersede',
          pageId,
          section: opts.section,
          ...(opts.supersededByPageId ? { supersededByPageId: opts.supersededByPageId } : {}),
          ...(opts.supersededBySection ? { supersededBySection: opts.supersededBySection } : {}),
          ...(opts.reason ? { reason: opts.reason } : {}),
        });
        printJson(res);
        if (!res.ok) process.exitCode = 1;
      },
    );
  curate
    .command('rewire <linkId>')
    .description('Re-point a broken or wrong link')
    .option('--to-page-id <id>', 'New target page id (mutually exclusive with --to-path)')
    .option('--to-path <path>', 'New target page path (mutually exclusive with --to-page-id)')
    .option('--to-section <slug>', 'Optional new target section anchor')
    .option('--workspace-id <id>')
    .action(async (linkId: string, opts: { toPageId?: string; toPath?: string; toSection?: string; workspaceId?: string }) => {
      const ws = opts.workspaceId ?? ENV_WS;
      if (!ws) return failNoWorkspace('curate rewire');
      if (!opts.toPageId && !opts.toPath) {
        printJson({ ok: false, error: { code: 'target_required', message: 'rewire needs --to-page-id or --to-path' } });
        process.exitCode = 1;
        return;
      }
      const res = await daemonPost('/local/memory/curate', {
        workspaceId: ws,
        op: 'rewire',
        linkId,
        ...(opts.toPageId ? { toPageId: opts.toPageId } : {}),
        ...(opts.toPath ? { toPath: opts.toPath } : {}),
        ...(opts.toSection ? { toSection: opts.toSection } : {}),
      });
      printJson(res);
      if (!res.ok) process.exitCode = 1;
    });

  return cmd;
}

// ── helpers for the trace subcommand ────────────────────────────────────────

/** Shape of GET /api/im/memory/trace (cloud MemoryTraceResult, R8.3). */
interface MemoryTraceData {
  query: { traceId: string | null; path: string | null };
  events: Array<{ eventId: string; eventType: string; status: string; createdAt: string; traceId: string | null; path: string | null }>;
  pages: Array<{ id: string; path: string; version: number; pageType: string; sourceKind: string | null; createdAt: string; updatedAt: string }>;
  versions: Array<{ pageId: string; version: number; changeSummary: string | null; createdAt: string }>;
  links: Array<{ relation: string; sourcePageId: string; targetPageId: string | null; sourceUri: string; targetUri: string; broken: boolean; createdAt: string }>;
  missingStages: string[];
}

function printTrace(trace: MemoryTraceData): void {
  const q = trace.query.traceId ? `traceId=${trace.query.traceId}` : `path=${trace.query.path}`;
  console.log(color('bold', `memory trace ${q}`));
  console.log(color('cyan', `\n① sync events (${trace.events.length})`));
  for (const e of trace.events) {
    console.log(`  ${e.createdAt}  ${e.eventType}  status=${e.status}${e.path ? `  path=${e.path}` : ''}  eventId=${e.eventId}`);
  }
  console.log(color('cyan', `\n② pages (${trace.pages.length})`));
  for (const p of trace.pages) {
    console.log(`  ${p.updatedAt}  ${p.path}  v${p.version}  type=${p.pageType}${p.sourceKind ? `  source=${p.sourceKind}` : ''}  id=${p.id}`);
  }
  console.log(color('cyan', `\n②b versions (${trace.versions.length})`));
  for (const v of trace.versions) {
    console.log(`  ${v.createdAt}  page=${v.pageId} v${v.version}${v.changeSummary ? `  "${v.changeSummary}"` : ''}`);
  }
  console.log(color('cyan', `\n③ links (${trace.links.length})`));
  for (const l of trace.links) {
    console.log(`  ${l.createdAt}  ${l.relation}${l.broken ? color('red', ' [broken]') : ''}  ${l.sourceUri} → ${l.targetUri}`);
  }
  if (trace.missingStages.length > 0) {
    console.log(color('red', `\n✗ missing stages (${trace.missingStages.length})`));
    for (const m of trace.missingStages) console.log(color('red', `  ✗ ${m}`));
    process.exitCode = 1;
  } else {
    console.log(color('green', '\n✓ chain complete: events → pages → versions → links'));
  }
}

// ── helpers for the write/curate POST paths ────────────────────────────────

// ── CLI recall telemetry (memory211/01 §6.11 D11-1, W7 item 2) ─────────────
// `prismer memory recall/search` used to be the one recall surface with ZERO
// telemetry: the daemon's own handleSearch emission keys on the verified cap
// subject and classifies every row as the tool channel, and CLI runs had no
// actor identity at all — so D11-1 measured a real cavity (grep: this file had
// no recall_pull/metric reference).
//
// Each CLI recall therefore enqueues ONE `recall_pull` into the SAME outbox
// channel the daemon uses, via the existing
// `POST /local/memory/observability/emit` pass-through (the CLI is a separate
// process with no SQLite handle — the endpoint is exactly its outbox). The row
// carries `metadataJson.via = 'cli'` so the frontier clustering and the M1
// adoption aggregate can split the CLI channel from the tool channel; a
// scoped-cap CLI run consequently produces BOTH a daemon row (tool channel)
// and this row (CLI channel) for the same intent — consumers filter on `via`,
// and the report records that caveat.
//
// Actor: decoded from the presented cap's OWN payload claim. This is an
// attribution read only — the signature is NOT checked here (the daemon still
// verifies the cap and its workspace scope on every call, including this emit).
// No cap subject ⇒ NO event (never fabricate an actor, same rule as the
// daemon-side emitter).

/** b64url decode of the cap token's payload segment (no signature check). */
function capSubjectClaim(token: string | undefined): { sub?: string } | undefined {
  if (!token) return undefined;
  const segment = token.split('.')[1];
  if (!segment) return undefined;
  try {
    const json = Buffer.from(
      segment.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');
    const parsed = JSON.parse(json) as { sub?: unknown };
    return typeof parsed.sub === 'string' ? { sub: parsed.sub } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fire-and-forget `recall_pull` for one CLI recall. Never throws and never
 * changes the command's exit code — telemetry must not become a failure mode
 * for the recall it observed (same 旁路 posture as the daemon-side emitter).
 * Search-shaped only: the CLI's read face (`read` / `load-batch`) emits nothing,
 * because the daemon's own /local/memory/load handler already emits the
 * tool-channel row for every load (rpc.ts handleLoad).
 */

// memory211/01 §6.11 D11-2 (W7 item 3) — the CLI load-batch cap. The daemon's
// batch-recall bound is 8 queries (MAX_BATCH_QUERIES in rpc.ts, mirrored by the
// tool schema's `queries[]`); a batch LOAD is a CLI-side fan-out of point reads
// with its own (looser) bound.
export const MAX_CLI_LOAD_BATCH = 10;

/**
 * Parse `--queries '["a","b"]'`. The declared contract is the tool schema's
 * `queries[]` (non-empty strings): an unparseable / non-array / non-string
 * payload is a CLI usage error (exit 1). The ≤8 bound is the DAEMON's
 * (rpc.ts MAX_BATCH_QUERIES) and is enforced THERE — this face passes the list
 * through untouched so an over-limit call comes back with the daemon's own
 * `truncated: true` flag instead of a silently different query set. An empty
 * `--queries ''` (flag present, nothing in it) falls back to the single-query
 * form rather than erroring.
 */
function parseCliBatchQueries(
  raw: string | undefined,
): { ok: true; queries: string[] } | { ok: false; message: string } {
  if (raw === undefined || raw.trim() === '') return { ok: true, queries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, message: '--queries must be a JSON array of strings, e.g. --queries \'["a","b"]\'' };
  }
  if (!Array.isArray(parsed) || parsed.some((s) => typeof s !== 'string')) {
    return { ok: false, message: '--queries must be a JSON array of strings' };
  }
  const cleaned = parsed.map((s) => s.trim()).filter((s) => s.length > 0);
  if (cleaned.length === 0) {
    return { ok: false, message: '--queries must contain at least one non-empty query' };
  }
  return { ok: true, queries: cleaned };
}

/**
 * GET one daemon path and keep the STATUS. Unlike {@link tryDaemon} — whose
 * 404-continue is the right semantics for probing an unknown ROUTE — a memory
 * load 404 (`memory_page_not_found`) is a real per-path verdict that
 * `load-batch` must surface, not a signal to fall back to a legacy path.
 * Returns undefined only on transport failure.
 */
async function daemonGet(path: string): Promise<{ status: number; body: unknown } | undefined> {
  try {
    const res = await fetch(`${LOCAL_BASE}${path}`, {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
      headers: capHeaders(),
    });
    return { status: res.status, body: await readJson(res) };
  } catch {
    return undefined;
  }
}

async function emitCliRecallPull(input: {
  workspaceId: string;
  query: string;
  tool: 'memory_search';
  hitCount: number;
  topK: number | null;
}): Promise<void> {
  const actor = capSubjectClaim(ENV_CAP);
  if (!actor?.sub) return;
  try {
    const eventId = randomUUID();
    const createdAt = new Date().toISOString();
    const res = await fetch(`${LOCAL_BASE}/local/memory/observability/emit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...capHeaders() },
      body: JSON.stringify({
        eventId,
        schemaVersion: 1,
        eventType: 'recall_pull',
        workspaceId: input.workspaceId,
        actorImUserId: actor.sub,
        actorKind: 'agent',
        deviceId: 'cli',
        createdAt,
        idempotencyKey: `obs:recall_pull:${actor.sub}:${createdAt}:${eventId.slice(0, 8)}`,
        query: input.query,
        metadataJson: { tool: input.tool, via: 'cli' },
        metricsJson: {
          hitCount: input.hitCount,
          ...(input.topK !== null ? { topK: input.topK } : {}),
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      process.stderr.write(
        `[memory-cli:recall_pull] emit not accepted (non-blocking): HTTP ${res.status}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `[memory-cli:recall_pull] emit failed (non-blocking): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

function failNoWorkspace(action: string): void {
  printJson({
    ok: false,
    error: {
      code: 'workspace_required',
      message: `memory ${action} needs a workspace — pass --workspace-id or set $PRISMER_WORKSPACE_ID`,
    },
  });
  process.exitCode = 1;
}

async function runCurate(
  op: string,
  workspaceIdOpt: string | undefined,
  pageId?: string,
  reason?: string,
  childPaths?: string[],
): Promise<void> {
  const ws = workspaceIdOpt ?? ENV_WS;
  if (!ws) return failNoWorkspace(`curate ${op}`);
  const res = await daemonPost('/local/memory/curate', {
    workspaceId: ws,
    op,
    ...(pageId ? { pageId } : {}),
    ...(reason ? { reason } : {}),
    ...(childPaths && childPaths.length > 0 ? { childPaths } : {}),
  });
  printJson(res);
  if (!res.ok) process.exitCode = 1;
}

/** POST a pre-encoded body to a daemon local-server path; null when unreachable. */
async function daemonPostRaw(path: string, body: string): Promise<CliResult | undefined> {
  try {
    const res = await fetch(`${LOCAL_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...capHeaders() },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return undefined;
    const parsed = await readJson(res);
    if (parsed && typeof parsed === 'object' && 'ok' in parsed) return parsed as CliResult;
    if (!res.ok) {
      return {
        ok: false,
        error: { code: `daemon_http_${res.status}`, message: messageFromBody(parsed) ?? `HTTP ${res.status}` },
      };
    }
    return { ok: true, data: parsed };
  } catch {
    return undefined;
  }
}

/** POST JSON to a daemon local-server path; returns the parsed CliResult. */
async function daemonPost(path: string, body: unknown): Promise<CliResult> {
  try {
    const res = await fetch(`${LOCAL_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...capHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const parsed = await readJson(res);
    if (parsed && typeof parsed === 'object' && 'ok' in parsed) return parsed as CliResult;
    if (!res.ok) {
      return { ok: false, error: { code: `daemon_http_${res.status}`, message: messageFromBody(parsed) ?? `HTTP ${res.status}` } };
    }
    return { ok: true, data: parsed };
  } catch (err) {
    return {
      ok: false,
      error: { code: 'daemon_unreachable', message: `Cannot reach daemon at ${LOCAL_BASE}: ${err instanceof Error ? err.message : String(err)}` },
    };
  }
}

/** Read stdin to a string (for `memory write` with piped content). */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function tryDaemon(methods: Array<'GET' | 'POST' | 'DELETE'>, paths: string[]): Promise<CliResult | undefined> {
  for (const method of methods) {
    for (const path of paths) {
      try {
        // Cap header attached to every probe (harmless on legacy paths).
        const res = await fetch(`${LOCAL_BASE}${path}`, {
          method,
          signal: AbortSignal.timeout(1_500),
          headers: capHeaders(),
        });
        if (res.status === 404) continue;
        const body = await readJson(res);
        if (!res.ok) {
          return {
            ok: false,
            error: {
              code: `daemon_http_${res.status}`,
              message: messageFromBody(body) ?? `Daemon endpoint ${method} ${path} returned HTTP ${res.status}`,
            },
            checks: { daemon: { url: LOCAL_BASE, endpoint: path, reachable: true } },
          };
        }
        return normalizeDaemonBody(body, { method, path });
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function normalizeDaemonBody(body: unknown, meta: JsonObject): CliResult {
  if (body && typeof body === 'object' && 'ok' in body) {
    return body as CliResult;
  }
  return { ok: true, data: body, checks: { daemon: { ...meta, url: LOCAL_BASE } } };
}

function unavailable(action: string, snapshot: CacheSnapshot, data?: JsonObject): CliResult {
  return {
    ok: false,
    data,
    error: {
      code: 'memory_gateway_unavailable',
      message: `Memory ${action} is unavailable because the local daemon does not expose a Memory Gateway endpoint.`,
    },
    checks: {
      daemon: { url: LOCAL_BASE, memoryEndpoint: false },
      localDb: {
        path: snapshot.dbPath,
        exists: snapshot.dbExists,
        error: snapshot.dbError,
        cacheTables: snapshot.tables,
        presentableItems: snapshot.items.length,
      },
    },
    fix: 'Start or upgrade the Prismer daemon with Memory Gateway support. Until then this command can only show read-only local cache/assets/workspace_files evidence from ~/.prismer/local.db.',
  };
}

function readCacheSnapshot(limit: number): CacheSnapshot {
  const paths = resolvePaths();
  const empty: CacheSnapshot = {
    dbPath: paths.localDb,
    dbExists: existsSync(paths.localDb),
    tables: {
      cached_assets: { exists: false, count: 0, sizeBytes: 0 },
      workspace_files_mirror: { exists: false, count: 0 },
    },
    items: [],
  };
  if (!empty.dbExists) return empty;

  let db: Database.Database | undefined;
  try {
    db = new Database(paths.localDb, { readonly: true, fileMustExist: true });
    const hasAssets = tableExists(db, 'cached_assets');
    const hasFiles = tableExists(db, 'workspace_files_mirror');
    const assets = hasAssets
      ? (db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS sizeBytes FROM cached_assets').get() as {
          count: number;
          sizeBytes: number;
        })
      : { count: 0, sizeBytes: 0 };
    const files = hasFiles
      ? (db.prepare('SELECT COUNT(*) AS count FROM workspace_files_mirror').get() as { count: number })
      : { count: 0 };

    const items: CacheItem[] = [];
    if (limit > 0 && hasAssets) {
      const rows = db
        .prepare(
          `SELECT content_hash, size_bytes, mime, local_path, fetched_at, last_used_at, pin
           FROM cached_assets
           ORDER BY last_used_at DESC
           LIMIT ?`,
        )
        .all(limit) as Array<Record<string, unknown>>;
      for (const row of rows) items.push(assetRow(row));
    }
    if (limit > 0 && hasFiles && items.length < limit) {
      const rows = db
        .prepare(
          `SELECT workspace_id, path, asset_id, content_hash, version, synced_at, dirty
           FROM workspace_files_mirror
           ORDER BY synced_at DESC
           LIMIT ?`,
        )
        .all(limit - items.length) as Array<Record<string, unknown>>;
      for (const row of rows) items.push(fileRow(row));
    }

    return {
      ...empty,
      tables: {
        cached_assets: { exists: hasAssets, count: Number(assets.count), sizeBytes: Number(assets.sizeBytes) },
        workspace_files_mirror: { exists: hasFiles, count: Number(files.count) },
      },
      items,
    };
  } catch (err) {
    return {
      ...empty,
      items: [],
      tables: empty.tables,
      dbExists: true,
      dbError: err instanceof Error ? err.message : String(err),
    };
  } finally {
    db?.close();
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name?: string } | undefined;
  return row?.name === table;
}

function assetRow(row: Record<string, unknown>): CacheItem {
  const hash = String(row.content_hash ?? '');
  return {
    kind: 'asset',
    id: hash,
    contentHash: hash,
    sizeBytes: Number(row.size_bytes ?? 0),
    mime: typeof row.mime === 'string' ? row.mime : null,
    localPath: String(row.local_path ?? ''),
    fetchedAt: Number(row.fetched_at ?? 0),
    lastUsedAt: Number(row.last_used_at ?? 0),
    pinned: Number(row.pin ?? 0) === 1,
  };
}

function fileRow(row: Record<string, unknown>): CacheItem {
  const workspaceId = String(row.workspace_id ?? '');
  const filePath = String(row.path ?? '');
  return {
    kind: 'workspace_file',
    id: `${workspaceId}:${filePath}`,
    workspaceId,
    path: filePath,
    assetId: String(row.asset_id ?? ''),
    contentHash: String(row.content_hash ?? ''),
    version: Number(row.version ?? 0),
    syncedAt: row.synced_at == null ? null : Number(row.synced_at),
    dirty: Number(row.dirty ?? 0) === 1,
  };
}

function searchableText(item: CacheItem): string {
  return [
    item.id,
    item.kind,
    item.contentHash,
    item.workspaceId,
    item.path,
    item.assetId,
    item.mime,
    item.localPath,
  ]
    .filter(Boolean)
    .join(' ');
}

function parsePositiveInt(v: string): number {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

function clampLimit(n: number): number {
  return Math.max(1, Math.min(500, Number.isFinite(n) ? n : 20));
}

function messageFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  if (typeof obj.message === 'string') return obj.message;
  if (typeof obj.error === 'string') return obj.error;
  const err = obj.error;
  if (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
    return (err as Record<string, string>).message;
  }
  return undefined;
}
