// prismer:// URI resolver — replaces asset/file references in prompts + context
// with local file:// paths so adapters (Hermes / Claude / OpenClaw) can Read them
// using their own tools. Daemon never injects bytes into the prompt itself.
//
// L5 (2026-05-20): also handles `https://` and `http://` URLs found in the
// user-supplied prompt + context surface. Same content-hash dedup + asset-cache
// reuse + pinning, plus SSRF guard. See docs/release200/evidence/
// 16-l5-https-url-resolver-2026-05-20.md.
//
// See docs/refactor/10-asset-network-drive.md §五 (Local cache).

import type { CloudClient } from './auth.js';
import type { AssetCache } from './asset-cache.js';
import type { AssetDispatchObservation } from './types/im-events.js';
import type { LocalDb } from './sync/store.js';

export type PrismerUriType = 'asset' | 'file';

export interface ParsedPrismerUri {
  /** Original full URI string. */
  raw: string;
  /**
   * Owner segment for legacy `prismer://<owner>/...` form (informational,
   * not ACL-checked). For `prismer://workspace/<wid>/...` this is the
   * literal string 'workspace' — prefer `workspaceId` instead.
   */
  owner: string;
  type: PrismerUriType;
  /** For type='asset': the sha256 hash. For legacy file URIs: '<wsId>/<path>'. */
  rest: string;
  /** Convenience parses for type='file' and for workspace-form 'asset'. */
  workspaceId?: string;
  filePath?: string;
}

// Two URI shapes accepted:
//
//   prismer://workspace/<wid>/asset/<hash>           Wave-54 (doc 26)
//   prismer://workspace/<wid>/file/<path...>         Wave-54 (doc 26)
//   prismer://<owner>/asset/<hash>                   legacy 1.9.x
//   prismer://<owner>/file/<wsId>/<path...>          legacy 1.9.x
//
// Workspace form is preferred; legacy form continues to resolve so
// existing prompts / context don't break during the transition.
const URI_REGEX_WORKSPACE = /prismer:\/\/workspace\/([^/\s]+)\/(asset|file)\/([^\s)\]]+)/g;
const URI_REGEX_LEGACY = /prismer:\/\/(?!workspace\/)([^/\s]+)\/(asset|file)\/([^\s)\]]+)/g;

// L5: match bare http(s) URLs in prose. We deliberately avoid the
// `(?:\([^)]*\)|[^…])` "URL inside markdown link" gymnastics; we just stop
// at typical sentence-trailing punctuation and brackets. URLs that end with
// a closing paren / bracket / quote get those characters stripped by the
// trailing-punct cleanup pass below — same convention as the #ref resolver.
const HTTP_URL_REGEX = /https?:\/\/[^\s<>"'`]+/g;
const URL_TRAILING_PUNCT_RE = /[,.;:!?)\]}'"]+$/;

/**
 * Find every recognized `prismer://...` reference in a string.
 * Only `asset` and `file` types are recognized — other types (memory,
 * context, conversation, evolution, task, pair) pass through untouched.
 */
export function parseUris(text: string): ParsedPrismerUri[] {
  if (!text) return [];
  const out: ParsedPrismerUri[] = [];
  const seen = new Set<string>();

  for (const m of text.matchAll(URI_REGEX_WORKSPACE)) {
    const [raw, wsId, typ, rest] = m;
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    const type = typ as PrismerUriType;
    const parsed: ParsedPrismerUri = { raw, owner: 'workspace', type, rest: rest!, workspaceId: wsId };
    if (type === 'file') parsed.filePath = rest;
    out.push(parsed);
  }

  for (const m of text.matchAll(URI_REGEX_LEGACY)) {
    const [raw, owner, typ, rest] = m;
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    const type = typ as PrismerUriType;
    const parsed: ParsedPrismerUri = { raw, owner: owner!, type, rest: rest! };
    if (type === 'file') {
      const slash = rest!.indexOf('/');
      if (slash > 0) {
        parsed.workspaceId = rest!.slice(0, slash);
        parsed.filePath = rest!.slice(slash + 1);
      }
    }
    out.push(parsed);
  }

  return out;
}

interface FileLookupRow {
  asset_id: string;
  content_hash: string;
  version: number;
}

interface RemoteFile {
  assetId: string;
  contentHash: string;
  version: number;
  mime?: string;
  size?: number;
}

export interface UriResolverOptions {
  db: LocalDb;
  cloud: CloudClient;
  assetCache: AssetCache;
}

export class UriResolver {
  private readonly db: LocalDb;
  private readonly cloud: CloudClient;
  private readonly assetCache: AssetCache;

  constructor(opts: UriResolverOptions) {
    this.db = opts.db;
    this.cloud = opts.cloud;
    this.assetCache = opts.assetCache;
  }

  /**
   * Resolve a single URI to a local file path. Throws on auth/4xx;
   * caller decides whether to leave the URI in place (best-effort) or fail.
   */
  async resolveOne(uri: ParsedPrismerUri, opts?: { signal?: AbortSignal }): Promise<string> {
    if (uri.type === 'asset') {
      // Workspace-form URIs (prismer://workspace/<wid>/asset/<hash>) carry
      // wsId, which the cloud-side /assets/by-hash endpoint requires; legacy
      // form (prismer://<owner>/asset/<hash>) does not, and AssetCache will
      // fall through to a wsId-less probe.
      const cached = await this.assetCache.getOrFetch(uri.rest, {
        ...(uri.workspaceId ? { workspaceIdHint: uri.workspaceId } : {}),
        signal: opts?.signal,
      });
      return cached.localPath;
    }
    // type === 'file'
    if (!uri.workspaceId || !uri.filePath) {
      throw new Error(`prismer://file URI must contain wsId/path, got: ${uri.raw}`);
    }
    const file = await this.lookupFile(uri.workspaceId, uri.filePath, opts?.signal);
    const cached = await this.assetCache.getOrFetch(file.content_hash, {
      workspaceIdHint: uri.workspaceId,
      signal: opts?.signal,
    });
    return cached.localPath;
  }

  /**
   * Walk a string, replace every `prismer://(asset|file)/...` and
   * `https://…` / `http://…` URL with `file://<localPath>`.
   *
   * Unrecognized URIs pass through unchanged. Returns rewritten text, the
   * list of pinned hashes, and one observation per http(s) URL the resolver
   * attempted (success + error both surface) so the dispatch can include
   * them in `reply.assetObservability`.
   *
   * `urlCache` lets the caller dedupe URL fetches across multiple rewrite
   * calls within a single dispatch (e.g. prompt + each context entry).
   * Pass the same Map instance to every rewrite() / rewriteAll() call.
   */
  async rewrite(
    text: string,
    opts?: {
      pin?: boolean;
      signal?: AbortSignal;
      /** L5: opt out of http(s) URL fetching for this string (e.g. memory/goal text). */
      fetchUrls?: boolean;
      /** L5: shared per-dispatch dedup map (originalUrl → cached resolution). */
      urlCache?: Map<string, UrlResolution>;
      /** L5: append url observations here (caller-owned array). */
      urlObservations?: AssetDispatchObservation[];
    },
  ): Promise<{ text: string; resolvedHashes: string[] }> {
    const uris = parseUris(text);
    const replacements = new Map<string, string>();
    const resolvedHashes: string[] = [];

    for (const u of uris) {
      try {
        const localPath = await this.resolveOne(u, opts);
        replacements.set(u.raw, `file://${localPath}`);
        // Track resolved hash for pinning. For 'file' we re-look up to get the hash.
        let hash: string | undefined;
        if (u.type === 'asset') hash = u.rest;
        else if (u.workspaceId && u.filePath) {
          const row = this.db
            .prepare(
              'SELECT content_hash FROM workspace_files_mirror WHERE workspace_id = ? AND path = ?',
            )
            .get(u.workspaceId, u.filePath) as { content_hash: string } | undefined;
          hash = row?.content_hash;
        }
        if (hash) {
          resolvedHashes.push(hash);
          if (opts?.pin) this.assetCache.pin(hash);
        }
      } catch (err) {
        // Best-effort: leave the URI in place; prompt remains readable to the agent.
        console.warn(`[uri-resolver] failed to resolve ${u.raw}: ${(err as Error).message}`);
      }
    }

    // L5: http(s) URL fetching. Skipped when the caller opts out (server-
    // composed text like memoryContext / goalContext should not eagerly
    // pull URLs that appear inside them).
    if (opts?.fetchUrls !== false) {
      const urlCache = opts?.urlCache;
      const urls = extractHttpUrls(text);
      for (const original of urls) {
        try {
          let resolution: UrlResolution | undefined = urlCache?.get(original);
          if (!resolution) {
            const { cached, finalUrl, durationMs } = await this.assetCache.getOrFetchUrl(original, {
              signal: opts?.signal,
            });
            resolution = { hash: cached.contentHash, localPath: cached.localPath, sizeBytes: cached.sizeBytes, mime: cached.mime, finalUrl, durationMs };
            urlCache?.set(original, resolution);
            opts?.urlObservations?.push({
              contentHash: cached.contentHash,
              mime: cached.mime,
              sizeBytes: cached.sizeBytes,
              strategy: 'fetched-https',
              originalUrl: original,
              finalUrl,
              durationMs,
            });
          }
          replacements.set(original, `file://${resolution.localPath}`);
          resolvedHashes.push(resolution.hash);
          if (opts?.pin) this.assetCache.pin(resolution.hash);
        } catch (err) {
          const message = (err as Error).message;
          console.warn(`[uri-resolver] failed to fetch ${original}: ${message}`);
          opts?.urlObservations?.push({
            contentHash: '',
            mime: null,
            sizeBytes: null,
            strategy: 'error',
            originalUrl: original,
            error: message,
          });
          // Leave the URL in place — the adapter's own browse tools can
          // try (they have separate trust + retry semantics).
        }
      }
    }

    if (replacements.size === 0) return { text, resolvedHashes };
    let rewritten = text;
    for (const [raw, sub] of replacements) {
      rewritten = rewritten.split(raw).join(sub);
    }
    return { text: rewritten, resolvedHashes };
  }

  /** Bulk-rewrite an array of strings (e.g. context entries' content). */
  async rewriteAll(
    texts: string[],
    opts?: {
      pin?: boolean;
      signal?: AbortSignal;
      fetchUrls?: boolean;
      urlCache?: Map<string, UrlResolution>;
      urlObservations?: AssetDispatchObservation[];
    },
  ): Promise<{ texts: string[]; resolvedHashes: string[] }> {
    const all: string[] = [];
    const allHashes: string[] = [];
    for (const t of texts) {
      const r = await this.rewrite(t, opts);
      all.push(r.text);
      allHashes.push(...r.resolvedHashes);
    }
    return { texts: all, resolvedHashes: dedupe(allHashes) };
  }

  private async lookupFile(
    workspaceId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<FileLookupRow> {
    const local = this.db
      .prepare(
        'SELECT asset_id, content_hash, version FROM workspace_files_mirror WHERE workspace_id = ? AND path = ?',
      )
      .get(workspaceId, path) as FileLookupRow | undefined;
    if (local) return local;

    const remote = await this.cloud.get<RemoteFile>(
      `/api/im/workspaces/${encodeURIComponent(workspaceId)}/files?path=${encodeURIComponent(path)}`,
      { signal },
    );
    this.db
      .prepare(
        `INSERT OR REPLACE INTO workspace_files_mirror
         (workspace_id, path, asset_id, content_hash, version, synced_at, dirty)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(workspaceId, path, remote.assetId, remote.contentHash, remote.version, Date.now());
    return { asset_id: remote.assetId, content_hash: remote.contentHash, version: remote.version };
  }
}

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

/**
 * L5: per-dispatch resolution record for a fetched http(s) URL. The same
 * record is reused across every reference to the URL in this dispatch
 * (prompt + N context entries) so we resolve once even if the URL appears
 * many times.
 */
export interface UrlResolution {
  hash: string;
  localPath: string;
  sizeBytes: number;
  mime: string | null;
  finalUrl: string;
  durationMs: number;
}

/**
 * Extract http(s) URLs from a string. Each match has trailing punctuation
 * stripped so callers can replace the exact match in the source text.
 * Duplicates are de-duped: the first occurrence wins.
 */
export function extractHttpUrls(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(HTTP_URL_REGEX)) {
    let url = m[0]!;
    const punct = URL_TRAILING_PUNCT_RE.exec(url);
    if (punct) url = url.slice(0, -punct[0].length);
    if (!url) continue;
    // Final structural check — bail on anything that doesn't parse.
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}
