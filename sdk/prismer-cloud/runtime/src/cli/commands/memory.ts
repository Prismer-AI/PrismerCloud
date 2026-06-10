// `prismer memory ...` — local memory store inspection via daemon RPC.
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
import { existsSync } from 'node:fs';
import { resolvePaths } from '../../config.js';
import { printJson } from '../util.js';
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

const LOCAL_BASE = process.env.PRISMER_DAEMON_URL ?? 'http://127.0.0.1:3210';

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
    .option('--workspace-id <id>', 'Workspace to list (required for daemon RPC)')
    .option('--page-type <type>', 'Filter by pageType (hub/leaf/decision/glossary/archive)')
    .option('--limit <n>', 'Max items', parsePositiveInt, 20)
    .option('--json', 'Output JSON (default)')
    .action(async (opts: { workspaceId?: string; pageType?: string; limit: number }) => {
      const limit = clampLimit(opts.limit);
      const daemonPaths: string[] = [];
      if (opts.workspaceId) {
        const params = new URLSearchParams({ workspaceId: opts.workspaceId, limit: String(limit) });
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
    .option('--workspace-id <id>', 'Workspace to search (required for daemon RPC)')
    .option('--limit <n>', 'Max items', parsePositiveInt, 20)
    .option('--json', 'Output JSON (default)')
    .action(async (argQuery: string | undefined, opts: { query?: string; workspaceId?: string; limit: number }) => {
      const query = opts.query ?? argQuery ?? '';
      const limit = clampLimit(opts.limit);
      const encoded = encodeURIComponent(query);
      const daemonPaths: string[] = [];
      if (opts.workspaceId) {
        daemonPaths.push(
          `/local/memory/search?workspaceId=${encodeURIComponent(opts.workspaceId)}&q=${encoded}&topK=${limit}`,
        );
      }
      daemonPaths.push(
        `/memory/search?q=${encoded}&limit=${limit}`,
        `/api/memory/search?q=${encoded}&limit=${limit}`,
      );

      const daemon = await tryDaemon(['GET'], daemonPaths);
      if (daemon) {
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
    });

  cmd
    .command('delete <id>')
    .description('Delete a memory record via daemon Memory Gateway')
    .option('--json', 'Output JSON (default)')
    .action(async (id: string) => {
      const daemon = await tryDaemon(['DELETE'], [`/memory/${encodeURIComponent(id)}`, `/api/memory/${encodeURIComponent(id)}`]);
      if (daemon) return printJson(daemon);

      const snapshot = readCacheSnapshot(0);
      printJson(unavailable('delete', snapshot, { id }));
      process.exitCode = 1;
    });

  cmd
    .command('sync')
    .description('Trigger daemon Memory Gateway sync')
    .option('--json', 'Output JSON (default)')
    .action(async () => {
      const daemon = await tryDaemon(['POST'], ['/memory/sync', '/api/memory/sync']);
      if (daemon) return printJson(daemon);

      const snapshot = readCacheSnapshot(0);
      printJson(unavailable('sync', snapshot));
      process.exitCode = 1;
    });

  return cmd;
}

async function tryDaemon(methods: Array<'GET' | 'POST' | 'DELETE'>, paths: string[]): Promise<CliResult | undefined> {
  for (const method of methods) {
    for (const path of paths) {
      try {
        const res = await fetch(`${LOCAL_BASE}${path}`, { method, signal: AbortSignal.timeout(1_500) });
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
