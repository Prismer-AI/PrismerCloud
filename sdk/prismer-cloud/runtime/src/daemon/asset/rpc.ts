// Asset metadata RPC route attacher.
//
// Wires the asset search endpoint onto the existing local HTTP server
// (sdk/prismer-cloud/runtime/src/daemon/local-server.ts) via the optional
// `attachAsset` hook on LocalServerOptions.
//
// Endpoints (bound to 127.0.0.1):
//   POST /local/asset/search    body: { workspaceId, query, limit? }
//
// This is an agent-only endpoint — local-network access only. The host adapter
// (Hermes, Claude Code, etc.) calls this to resolve `#filename` references
// during prompt construction. Returns matching AssetMetadataRow[] from the
// local SQLite index.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { AssetCache } from '../../asset-cache.js';
import { parseUris } from '../../uri-resolver.js';
import type { AssetMetadataIndex, AssetMetadataRow } from './metadata-index.js';

export interface AttachAssetRpcOptions {
  /** Resolver returns the AssetMetadataIndex for a given workspaceId, or undefined if none exists. */
  resolveIndex: (workspaceId: string) => AssetMetadataIndex | undefined;
  /**
   * Optional on-demand sync hook. Called when the local index is absent or
   * misses a just-created asset so `/local/asset/read` can self-heal after a
   * daemon startup or missed WS event.
   */
  ensureIndex?: (workspaceId: string) => Promise<AssetMetadataIndex | undefined>;
  assetCache?: AssetCache;
}

const ASSET_PATH_PREFIX = '/local/asset/';
const MAX_READ_BYTES = 256 * 1024;
const MAX_SEARCH_BYTES = 1024 * 1024;

export function attachAssetRpc(
  opts: AttachAssetRpcOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = req.url ?? '/';
    if (!url.startsWith(ASSET_PATH_PREFIX)) return false;

    const [pathOnly = ''] = url.split('?', 2);
    const subpath = pathOnly.slice(ASSET_PATH_PREFIX.length);
    const method = req.method ?? 'GET';

    try {
      if (method === 'POST' && subpath === 'search') {
        const body = await readJson(req);
        return await handleSearch(opts, body, res);
      }
      if (method === 'POST' && subpath === 'describe') {
        const body = await readJson(req);
        return await handleDescribe(opts, body, res);
      }
      if (method === 'POST' && subpath === 'read') {
        const body = await readJson(req);
        return await handleRead(opts, body, res);
      }

      return false;
    } catch (err) {
      respond(res, 500, {
        error: 'asset_rpc_failed',
        message: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  };
}

async function handleSearch(
  opts: AttachAssetRpcOptions,
  body: unknown,
  res: ServerResponse,
): Promise<boolean> {
  if (!body || typeof body !== 'object') {
    return respond400(res, 'request body must be a JSON object');
  }
  const b = body as { workspaceId?: unknown; query?: unknown; limit?: unknown; uri?: unknown };

  if (typeof b.query !== 'string' || !b.query.trim()) {
    return respond400(res, 'query is required (non-empty string)');
  }
  if (typeof b.uri === 'string' && b.uri.trim()) {
    return searchAssetContent(opts, b.uri.trim(), b.query.trim(), res);
  }

  if (typeof b.workspaceId !== 'string' || !b.workspaceId) {
    return respond400(res, 'workspaceId is required (string)');
  }

  const index = opts.resolveIndex(b.workspaceId) ?? await opts.ensureIndex?.(b.workspaceId);
  if (!index) {
    respond(res, 404, {
      error: 'workspace_index_not_found',
      workspaceId: b.workspaceId,
      message: 'No asset metadata index for this workspace. Ensure the daemon has synced asset metadata.',
    });
    return true;
  }

  const limit = typeof b.limit === 'number' && b.limit > 0 ? b.limit : undefined;
  const items = index.search(b.query.trim(), limit);
  respond(res, 200, { items });
  return true;
}

async function handleDescribe(opts: AttachAssetRpcOptions, body: unknown, res: ServerResponse): Promise<boolean> {
  const resolved = await resolveAssetRef(opts, body);
  if ('error' in resolved) return respond400(res, resolved.error);
  const cached = opts.assetCache?.get(resolved.row.contentHash);
  respond(res, 200, {
    asset: resolved.row,
    uri: `prismer://workspace/${resolved.workspaceId}/asset/${resolved.row.contentHash}`,
    cache: cached
      ? { status: 'hit', localPath: cached.localPath, sizeBytes: cached.sizeBytes, lastUsedAt: cached.lastUsedAt }
      : { status: 'miss' },
    tools: ['asset.describe', 'asset.read', 'asset.search'],
  });
  return true;
}

async function handleRead(opts: AttachAssetRpcOptions, body: unknown, res: ServerResponse): Promise<boolean> {
  const resolved = await resolveAssetRef(opts, body);
  if ('error' in resolved) return respond400(res, resolved.error);
  if (!opts.assetCache) {
    respond(res, 503, { error: 'asset_cache_unavailable' });
    return true;
  }
  const b = body as { offset?: unknown; length?: unknown };
  const offset = typeof b.offset === 'number' && b.offset > 0 ? Math.floor(b.offset) : 0;
  const requested = typeof b.length === 'number' && b.length > 0 ? Math.floor(b.length) : MAX_READ_BYTES;
  const length = Math.min(requested, MAX_READ_BYTES);
  const cached = await opts.assetCache.getOrFetch(resolved.row.contentHash, {
    workspaceIdHint: resolved.workspaceId,
    assetId: resolved.row.assetId,
  });
  const chunk = readFileRange(cached.localPath, offset, length);
  const textLike = isTextLike(resolved.row);
  respond(res, 200, {
    asset: resolved.row,
    locator: { byteOffset: offset, byteLength: chunk.bytesRead },
    truncated: requested > MAX_READ_BYTES || offset + chunk.bytesRead < chunk.sizeBytes,
    encoding: textLike ? 'utf8' : 'base64',
    content: textLike ? chunk.buffer.toString('utf8') : chunk.buffer.toString('base64'),
  });
  return true;
}

async function searchAssetContent(
  opts: AttachAssetRpcOptions,
  uri: string,
  query: string,
  res: ServerResponse,
): Promise<boolean> {
  const resolved = await resolveAssetRef(opts, { uri });
  if ('error' in resolved) return respond400(res, resolved.error);
  if (!opts.assetCache) {
    respond(res, 503, { error: 'asset_cache_unavailable' });
    return true;
  }
  if (!isTextLike(resolved.row)) {
    respond(res, 200, {
      items: [],
      unsupported: true,
      reason: 'content search currently supports text-like assets only',
      asset: resolved.row,
    });
    return true;
  }
  const cached = await opts.assetCache.getOrFetch(resolved.row.contentHash, {
    workspaceIdHint: resolved.workspaceId,
    assetId: resolved.row.assetId,
  });
  const chunk = readFileRange(cached.localPath, 0, MAX_SEARCH_BYTES);
  const text = chunk.buffer.toString('utf8');
  const needle = query.toLowerCase();
  const lines = text.split(/\r?\n/);
  const items: Array<{ line: number; byteOffset: number; preview: string }> = [];
  let byteOffset = 0;
  for (let i = 0; i < lines.length && items.length < 20; i += 1) {
    const line = lines[i] ?? '';
    if (line.toLowerCase().includes(needle)) {
      items.push({ line: i + 1, byteOffset, preview: line.slice(0, 500) });
    }
    byteOffset += Buffer.byteLength(line) + 1;
  }
  respond(res, 200, {
    items,
    asset: resolved.row,
    searched: { byteOffset: 0, byteLength: chunk.bytesRead, truncated: chunk.bytesRead < chunk.sizeBytes },
  });
  return true;
}

async function resolveAssetRef(
  opts: AttachAssetRpcOptions,
  body: unknown,
): Promise<{ workspaceId: string; row: AssetMetadataRow } | { error: string }> {
  if (!body || typeof body !== 'object') return { error: 'request body must be a JSON object' };
  const b = body as { workspaceId?: unknown; assetId?: unknown; contentHash?: unknown; uri?: unknown };
  let workspaceId = typeof b.workspaceId === 'string' ? b.workspaceId : '';
  const assetId = typeof b.assetId === 'string' ? b.assetId : '';
  let contentHash = typeof b.contentHash === 'string' ? b.contentHash : '';
  if (typeof b.uri === 'string' && b.uri.trim()) {
    const [uri] = parseUris(b.uri.trim());
    if (!uri) return { error: 'uri must be prismer://workspace/<workspaceId>/asset/<hash>' };
    if (uri.type !== 'asset') return { error: 'file uri lookup is not available in this RPC yet; pass asset uri or assetId' };
    workspaceId = uri.workspaceId ?? workspaceId;
    contentHash = uri.rest;
  }
  if (!workspaceId) return { error: 'workspaceId is required (string)' };
  let index = opts.resolveIndex(workspaceId);
  if (!index) {
    index = await opts.ensureIndex?.(workspaceId);
  }
  if (!index) return { error: 'workspace asset index is not synced yet' };
  let row = assetId
    ? index.resolveByAssetId(assetId)
    : contentHash
      ? index.resolveByContentHash(contentHash)
      : undefined;
  if (!row && opts.ensureIndex) {
    index = await opts.ensureIndex(workspaceId);
    row = assetId
      ? index?.resolveByAssetId(assetId)
      : contentHash
        ? index?.resolveByContentHash(contentHash)
        : undefined;
  }
  if (!row) return { error: 'asset not found in local metadata index' };
  return { workspaceId, row };
}

function isTextLike(row: AssetMetadataRow): boolean {
  const mime = row.mime ?? '';
  const name = row.filename ?? '';
  return (
    mime.startsWith('text/') ||
    mime.includes('json') ||
    mime.includes('xml') ||
    mime.includes('markdown') ||
    mime.includes('csv') ||
    /\.(md|markdown|txt|json|csv|tsv|ndjson|js|jsx|ts|tsx|py|go|rs|java|kt|swift|rb|php|css|html|htm|xhtml|sql|yaml|yml|toml|log)$/i.test(
      name,
    )
  );
}

function readFileRange(path: string, offset: number, length: number): { buffer: Buffer; bytesRead: number; sizeBytes: number } {
  const sizeBytes = statSync(path).size;
  if (offset >= sizeBytes) return { buffer: Buffer.alloc(0), bytesRead: 0, sizeBytes };
  const fd = openSync(path, 'r');
  try {
    const target = Math.min(length, sizeBytes - offset);
    const buffer = Buffer.alloc(target);
    const bytesRead = readSync(fd, buffer, 0, target, offset);
    return { buffer: buffer.subarray(0, bytesRead), bytesRead, sizeBytes };
  } finally {
    closeSync(fd);
  }
}

// ---- helpers ---------------------------------------------------------------

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function respond400(res: ServerResponse, message: string): boolean {
  respond(res, 400, { error: 'invalid_request', message });
  return true;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  req.setEncoding('utf8');
  for await (const chunk of req) raw += chunk as string;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid_json');
  }
}
