// Local asset cache. Content-addressed by sha256; LRU evicted when pinned bytes
// exceed the configured cap. See docs/refactor/10-asset-network-drive.md §五.

import { createHash } from 'node:crypto';
import { promises as dnsp } from 'node:dns';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isIP, isIPv4, isIPv6 } from 'node:net';
import { dirname, join } from 'node:path';
import { Agent as UndiciAgent } from 'undici';
import type { CloudClient } from './auth.js';
import type { LocalDb } from './sync/store.js';

export interface CachedAsset {
  contentHash: string;
  sizeBytes: number;
  mime: string | null;
  localPath: string;
  fetchedAt: number;
  lastUsedAt: number;
  pin: boolean;
}

interface DbRow {
  content_hash: string;
  size_bytes: number;
  mime: string | null;
  local_path: string;
  fetched_at: number;
  last_used_at: number;
  pin: number;
}

function rowToCached(row: DbRow): CachedAsset {
  return {
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    mime: row.mime,
    localPath: row.local_path,
    fetchedAt: row.fetched_at,
    lastUsedAt: row.last_used_at,
    pin: row.pin === 1,
  };
}

export interface AssetCacheOptions {
  db: LocalDb;
  cloud: CloudClient;
  /** ~/.prismer/cache. */
  cacheDir: string;
  /** LRU cap in bytes. Default 5 GiB. */
  maxBytes?: number;
}

/**
 * Local asset cache.
 *
 * `getOrFetch(hash, opts)` returns the local path; downloads from
 * `GET /api/im/assets/by-hash/:hash?wsId=…` on miss. Pinned rows survive LRU.
 */
export class AssetCache {
  private readonly db: LocalDb;
  private readonly cloud: CloudClient;
  private readonly cacheDir: string;
  private readonly maxBytes: number;

  constructor(opts: AssetCacheOptions) {
    this.db = opts.db;
    this.cloud = opts.cloud;
    this.cacheDir = opts.cacheDir;
    this.maxBytes = opts.maxBytes ?? 5 * 1024 * 1024 * 1024;
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /** Local file path for a content hash. Files split by first 2 chars for fs scaling. */
  pathFor(hash: string): string {
    return join(this.cacheDir, hash.slice(0, 2), hash);
  }

  get(hash: string): CachedAsset | undefined {
    const row = this.db.prepare('SELECT * FROM cached_assets WHERE content_hash = ?').get(hash) as
      | DbRow
      | undefined;
    if (!row) return undefined;
    if (!existsSync(row.local_path)) {
      // Disk gone but row stale — clean up so getOrFetch retries.
      this.db.prepare('DELETE FROM cached_assets WHERE content_hash = ?').run(hash);
      return undefined;
    }
    this.touch(hash);
    return rowToCached({ ...row, last_used_at: Date.now() });
  }

  /** Bump `last_used_at` (call when an asset is consulted). */
  touch(hash: string): void {
    this.db
      .prepare('UPDATE cached_assets SET last_used_at = ? WHERE content_hash = ?')
      .run(Date.now(), hash);
  }

  pin(hash: string): void {
    this.db.prepare('UPDATE cached_assets SET pin = 1 WHERE content_hash = ?').run(hash);
  }

  unpin(hash: string): void {
    this.db.prepare('UPDATE cached_assets SET pin = 0 WHERE content_hash = ?').run(hash);
  }

  /**
   * Get or fetch by hash. On miss, downloads the raw bytes and caches them.
   *
   * Why two endpoints: `GET /api/im/assets/by-hash/:hash` returns the JSON
   * `AssetDTO` (id, contentHash, storageUri, …) — *metadata only*. The raw
   * bytes live at `GET /api/im/assets/:id`. If `opts.assetId` is supplied
   * the caller already has the id from an `AssetRef`, so we go straight to
   * the byte endpoint; otherwise we resolve `hash → id` first (one extra
   * round-trip on the metadata route) before downloading the body.
   *
   * Earlier this method called `by-hash` and treated the JSON body as the
   * asset content — the daemon stored the 500-byte metadata blob on disk
   * and `resolveAssetRefs` inlined that JSON into the prompt. The agent
   * saw `{"id":"…","storageUri":"…"}` instead of the user's file and
   * concluded the upload had failed.
   */
  async getOrFetch(
    hash: string,
    opts?: { workspaceIdHint?: string; signal?: AbortSignal; assetId?: string },
  ): Promise<CachedAsset> {
    const existing = this.get(hash);
    if (existing) return existing;

    const wsParam = opts?.workspaceIdHint ? `?wsId=${encodeURIComponent(opts.workspaceIdHint)}` : '';

    let assetId = opts?.assetId;
    if (!assetId) {
      const metaRes = await this.cloud.fetchRaw(
        `/api/im/assets/by-hash/${encodeURIComponent(hash)}${wsParam}`,
        { signal: opts?.signal },
      );
      if (!metaRes.ok) {
        throw new Error(`Asset metadata fetch failed for ${hash}: HTTP ${metaRes.status}`);
      }
      const metaJson = (await metaRes.json()) as { ok?: boolean; data?: { id?: string } };
      if (!metaJson?.ok || typeof metaJson.data?.id !== 'string') {
        throw new Error(`Asset metadata payload missing id for ${hash}`);
      }
      assetId = metaJson.data.id;
    }

    const res = await this.cloud.fetchRaw(`/api/im/assets/${encodeURIComponent(assetId)}`, {
      signal: opts?.signal,
    });
    if (!res.ok) {
      throw new Error(`Asset bytes fetch failed for ${hash} (id=${assetId}): HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const actualHash = sha256(buf);
    if (actualHash !== hash) {
      throw new Error(`Asset hash mismatch for ${hash}: downloaded ${actualHash}`);
    }

    const localPath = this.pathFor(hash);
    if (!existsSync(dirname(localPath))) {
      mkdirSync(dirname(localPath), { recursive: true });
    }
    const tmpPath = `${localPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, buf);
    renameSync(tmpPath, localPath);
    const mime = res.headers.get('content-type');
    const now = Date.now();

    this.db
      .prepare(
        `INSERT OR REPLACE INTO cached_assets
         (content_hash, size_bytes, mime, local_path, fetched_at, last_used_at, pin)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(hash, buf.length, mime, localPath, now, now);

    this.evictIfOver();

    return {
      contentHash: hash,
      sizeBytes: buf.length,
      mime,
      localPath,
      fetchedAt: now,
      lastUsedAt: now,
      pin: false,
    };
  }

  /**
   * Fetch a public http(s) URL, content-hash dedup, cache locally.
   *
   * Mirrors `getOrFetch` (cache key = sha256 of body bytes), but the input
   * is a URL whose hash we don't know up front. The fetcher applies:
   *
   *   - SSRF guard (resolve hostname, reject loopback / RFC1918 / link-local
   *     / cloud-metadata / IPv6 ULA + link-local). Cross-host redirects
   *     re-validate the new host before each hop.
   *   - manual redirect handling (max 3 hops).
   *   - hard timeout (default 15 s, override via env
   *     `PRISMER_URL_FETCH_TIMEOUT_MS`).
   *   - streaming body read with abort-at-limit (default 5 MiB, override
   *     via env `PRISMER_URL_FETCH_MAX_BYTES`). Truncated bodies are NOT
   *     cached.
   *   - non-2xx → throws (caller should leave the URL in place and emit
   *     an `error` observation).
   *
   * On success returns { cached, finalUrl, durationMs }; the caller can
   * pin / unpin the hash like any other asset.
   */
  async getOrFetchUrl(
    url: string,
    opts?: { signal?: AbortSignal; userAgent?: string; maxBytes?: number; timeoutMs?: number; maxRedirects?: number },
  ): Promise<{ cached: CachedAsset; finalUrl: string; durationMs: number }> {
    const started = Date.now();
    const maxBytes = opts?.maxBytes ?? defaultMaxBytes();
    const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs();
    const maxRedirects = opts?.maxRedirects ?? 3;
    const userAgent = opts?.userAgent ?? 'prismer-daemon';

    const { body, finalUrl, mime } = await fetchUrlWithGuards(url, {
      signal: opts?.signal,
      maxBytes,
      timeoutMs,
      maxRedirects,
      userAgent,
    });

    const hash = sha256(body);

    // Lucky-collision path: a prismer:// asset with the same bytes already
    // exists. Reuse the cache entry verbatim; don't double-store.
    const existing = this.get(hash);
    if (existing) {
      return { cached: existing, finalUrl, durationMs: Date.now() - started };
    }

    const localPath = this.pathFor(hash);
    if (!existsSync(dirname(localPath))) {
      mkdirSync(dirname(localPath), { recursive: true });
    }
    const tmpPath = `${localPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, body);
    renameSync(tmpPath, localPath);

    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO cached_assets
         (content_hash, size_bytes, mime, local_path, fetched_at, last_used_at, pin)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(hash, body.length, mime, localPath, now, now);

    this.evictIfOver();

    return {
      cached: {
        contentHash: hash,
        sizeBytes: body.length,
        mime,
        localPath,
        fetchedAt: now,
        lastUsedAt: now,
        pin: false,
      },
      finalUrl,
      durationMs: now - started,
    };
  }

  /** Insert an already-on-disk asset into the cache (e.g., asset just produced by adapter). */
  registerLocal(hash: string, localPath: string, mime?: string): CachedAsset {
    const actualHash = sha256(readFileBuffer(localPath));
    if (actualHash !== hash) {
      throw new Error(`Asset hash mismatch for ${hash}: local file is ${actualHash}`);
    }
    const size = statSync(localPath).size;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO cached_assets
         (content_hash, size_bytes, mime, local_path, fetched_at, last_used_at, pin)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(hash, size, mime ?? null, localPath, now, now);
    return { contentHash: hash, sizeBytes: size, mime: mime ?? null, localPath, fetchedAt: now, lastUsedAt: now, pin: true };
  }

  /** Total bytes across all rows (incl. pinned). */
  totalBytes(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(size_bytes),0) AS total FROM cached_assets').get() as {
      total: number;
    };
    return row.total;
  }

  /** Run LRU eviction until under cap. Pinned rows are never evicted. */
  evictIfOver(): { removed: number; freed: number } {
    let total = this.totalBytes();
    if (total <= this.maxBytes) return { removed: 0, freed: 0 };

    const candidates = this.db
      .prepare(
        `SELECT content_hash, size_bytes, local_path FROM cached_assets
         WHERE pin = 0
         ORDER BY last_used_at ASC`,
      )
      .all() as Array<{ content_hash: string; size_bytes: number; local_path: string }>;

    let freed = 0;
    let removed = 0;
    for (const row of candidates) {
      if (total <= this.maxBytes) break;
      try {
        if (existsSync(row.local_path)) unlinkSync(row.local_path);
      } catch {
        /* ignore — disk row is gone, db row deleted below */
      }
      this.db.prepare('DELETE FROM cached_assets WHERE content_hash = ?').run(row.content_hash);
      freed += row.size_bytes;
      total -= row.size_bytes;
      removed += 1;
    }
    return { removed, freed };
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function readFileBuffer(path: string): Buffer {
  return readFileSync(path);
}

// ── http(s) URL fetcher with SSRF + size + redirect guards ────────────────

const DEFAULT_URL_FETCH_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
const DEFAULT_URL_FETCH_TIMEOUT_MS = 15_000;

function defaultMaxBytes(): number {
  const v = Number(process.env.PRISMER_URL_FETCH_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_URL_FETCH_MAX_BYTES;
}

function defaultTimeoutMs(): number {
  const v = Number(process.env.PRISMER_URL_FETCH_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_URL_FETCH_TIMEOUT_MS;
}

/**
 * Test seam — swap fetch + DNS for unit tests. Production code uses the
 * Node built-ins.
 */
export interface UrlFetchDeps {
  fetch?: typeof globalThis.fetch;
  resolveHostname?: (hostname: string) => Promise<string[]>;
}

let urlFetchDeps: UrlFetchDeps = {};

/** Test-only hook. Pass `{}` to reset. */
export function __setUrlFetchDeps(deps: UrlFetchDeps): void {
  urlFetchDeps = deps;
}

function activeFetch(): typeof globalThis.fetch {
  return urlFetchDeps.fetch ?? globalThis.fetch;
}

async function activeResolveHostname(host: string): Promise<string[]> {
  if (urlFetchDeps.resolveHostname) return urlFetchDeps.resolveHostname(host);
  // If the hostname is already a literal IP, skip DNS.
  if (isIP(host)) return [host];
  // dns.lookup walks /etc/hosts + nsswitch; dns.resolve only hits DNS.
  // We want lookup semantics for parity with the actual fetch.
  const res = await dnsp.lookup(host, { all: true, verbatim: true });
  return res.map((r) => r.address);
}

/** Reject http(s) URL whose resolved hostname points at a forbidden IP. */
export function isForbiddenIp(ip: string): boolean {
  if (isIPv4(ip)) {
    const parts = ip.split('.').map((n) => Number(n));
    if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
      return true;
    }
    const [a = 0, b = 0] = parts;
    // 127.0.0.0/8 loopback
    if (a === 127) return true;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 link-local + cloud metadata (incl. 169.254.169.254)
    if (a === 169 && b === 254) return true;
    // 0.0.0.0/8 unspecified
    if (a === 0) return true;
    return false;
  }
  if (isIPv6(ip)) {
    const lower = ip.toLowerCase();
    // ::1 loopback
    if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
    // :: unspecified — short and long forms. dns.lookup normally returns
    // the short form, but DNS parsers in the wild emit either.
    if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return true;
    // fe80::/10 link-local
    if (/^fe[89ab][0-9a-f]?:/.test(lower)) return true;
    // fc00::/7 ULA (fc00:: – fdff::)
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — re-check the v4 part.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(lower);
    if (mapped) return isForbiddenIp(mapped[1]!);
    return false;
  }
  // Unknown family — be safe.
  return true;
}

/**
 * Resolve `hostname` and reject if any returned address is in a forbidden
 * range. Returns the first allowed address so the caller can PIN the TCP
 * connection to that IP — defeats DNS rebinding TOCTOU where the OS
 * resolver would otherwise re-query between our policy check and the
 * actual fetch and could get swapped to a private IP.
 */
async function assertHostAllowed(hostname: string): Promise<string> {
  let ips: string[];
  try {
    ips = await activeResolveHostname(hostname);
  } catch (err) {
    throw new Error(`hostname resolution failed for ${hostname}: ${(err as Error).message}`);
  }
  if (ips.length === 0) {
    throw new Error(`no IPs resolved for ${hostname}`);
  }
  for (const ip of ips) {
    if (isForbiddenIp(ip)) {
      throw new Error(`SSRF guard: ${hostname} → ${ip} is in a forbidden range`);
    }
  }
  // All IPs cleared the policy; pin to the first one. (Pinning to ANY
  // allowed IP is safe — we vetted all of them.)
  return ips[0]!;
}

interface UrlFetchOptions {
  signal?: AbortSignal;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  userAgent: string;
}

interface UrlFetchResult {
  body: Buffer;
  finalUrl: string;
  mime: string | null;
}

/**
 * Single-URL fetch with SSRF + redirect + size guards.
 *
 * Throws on any guard violation, non-2xx, network error, or size overflow.
 */
async function fetchUrlWithGuards(rawUrl: string, opts: UrlFetchOptions): Promise<UrlFetchResult> {
  let currentUrl: URL;
  try {
    currentUrl = new URL(rawUrl);
  } catch {
    throw new Error(`invalid URL: ${rawUrl}`);
  }

  for (let hop = 0; hop <= opts.maxRedirects; hop += 1) {
    if (currentUrl.protocol !== 'http:' && currentUrl.protocol !== 'https:') {
      throw new Error(`unsupported scheme: ${currentUrl.protocol}`);
    }
    // Resolve + policy-check + PIN the IP for this hop. The returned
    // address is what we'll force the TCP connect to use; the OS resolver
    // never gets a second chance to swap us onto a private IP between the
    // policy check and the actual socket open (defeats DNS rebinding
    // TOCTOU). Each hop re-resolves so a redirect can't slip past the
    // guard either.
    const pinnedIp = await assertHostAllowed(currentUrl.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), opts.timeoutMs);
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort(opts.signal.reason);
      else opts.signal.addEventListener('abort', () => controller.abort(opts.signal!.reason), { once: true });
    }

    // Per-request undici dispatcher with a `lookup` hook that returns the
    // IP we vetted. Built per-hop so each redirect target gets its own
    // pinned IP (and the agent is closed afterwards to release the socket).
    // Skipped entirely when the test seam replaces `fetch` — fake fetches
    // can't honour `dispatcher` anyway.
    const usingMockedFetch = urlFetchDeps.fetch !== undefined;
    const dispatcher = usingMockedFetch
      ? undefined
      : new UndiciAgent({
          connect: {
            lookup: (
              _hostname: string,
              _options: unknown,
              cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
            ) => {
              cb(null, pinnedIp, isIPv6(pinnedIp) ? 6 : 4);
            },
          },
        });

    // Hop body wrapped in try/finally so the dispatcher is always closed
    // (release the pinned-IP socket) — on redirect, success, OR throw.
    try {
      let res: Response;
      try {
        res = await activeFetch()(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          headers: { 'User-Agent': opts.userAgent, Accept: '*/*' },
          signal: controller.signal,
          // `dispatcher` is undici-specific; Node's built-in fetch (which
          // IS undici under the hood) accepts it via this option.
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit);
      } catch (err) {
        clearTimeout(timer);
        throw new Error(`fetch failed: ${(err as Error).message}`);
      }

      // Manual redirect: 3xx with Location → resolve and loop.
      if (res.status >= 300 && res.status < 400) {
        clearTimeout(timer);
        const loc = res.headers.get('location');
        if (!loc) throw new Error(`redirect ${res.status} with no Location header`);
        try {
          currentUrl = new URL(loc, currentUrl);
        } catch {
          throw new Error(`invalid redirect Location: ${loc}`);
        }
        // Drain body so the socket can be reused.
        try {
          await res.arrayBuffer();
        } catch {
          /* ignore */
        }
        if (hop === opts.maxRedirects) {
          throw new Error(`too many redirects (>${opts.maxRedirects})`);
        }
        continue;
      }

      if (!res.ok) {
        clearTimeout(timer);
        throw new Error(`HTTP ${res.status}`);
      }

      // 2xx — read streaming with size guard. We use the streaming reader
      // explicitly (not res.arrayBuffer) so we can abort mid-flight when
      // body bytes exceed the cap, instead of buffering 100 MB to discover
      // it's too big.
      const contentLength = Number(res.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > opts.maxBytes) {
        clearTimeout(timer);
        controller.abort(new Error('content-length exceeds limit'));
        throw new Error(`body too large: content-length=${contentLength} > ${opts.maxBytes}`);
      }

      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = res.body?.getReader();
      try {
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              total += value.byteLength;
              if (total > opts.maxBytes) {
                controller.abort(new Error('body exceeds limit'));
                try {
                  await reader.cancel();
                } catch {
                  /* ignore */
                }
                throw new Error(`body too large: read ${total} > ${opts.maxBytes}`);
              }
              chunks.push(value);
            }
          }
        } else {
          // No streaming body — fall back to arrayBuffer with a post-check.
          const ab = await res.arrayBuffer();
          if (ab.byteLength > opts.maxBytes) {
            throw new Error(`body too large: ${ab.byteLength} > ${opts.maxBytes}`);
          }
          chunks.push(new Uint8Array(ab));
          total = ab.byteLength;
        }
      } finally {
        clearTimeout(timer);
      }

      const body = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), total);
      return {
        body,
        finalUrl: currentUrl.toString(),
        mime: res.headers.get('content-type'),
      };
    } finally {
      // Close the dispatcher to release the pinned-IP socket. Errors here
      // are non-fatal — the worst case is a momentarily-leaked socket
      // (undici's keep-alive pool eviction will eventually reclaim it).
      await dispatcher?.close().catch(() => undefined);
    }
  }
  // Loop exited without return — exhausted redirects.
  throw new Error(`too many redirects (>${opts.maxRedirects})`);
}
