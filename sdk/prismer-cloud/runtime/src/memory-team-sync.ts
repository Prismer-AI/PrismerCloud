/**
 * memory-team-sync — client-side delta push + server-wins pull for team memory.
 *
 * Walks a local directory (typically `~/.claude/memory/team/<owner>/<repo>/`),
 * diffs content hashes against a persisted `last-sync.json`, pushes only the
 * changed files, and writes any server-side-newer rows back to disk.
 *
 * Design: docs/version190/14e-memory-cc-compat.md §8.5
 *
 * Secret scanning (local): any file whose content matches a blocking pattern
 * is rejected before it leaves the device. The server also scans (defense in
 * depth).
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { hasBlockingSecret, scanForSecrets } from './secret-scan.js';

/** Per-file content size limit (matches server). */
export const MEMORY_TEAM_SYNC_MAX_BYTES = 250 * 1024;

/** Name of the sidecar state file. */
export const LAST_SYNC_FILE = '.prismer-team-sync.json';

/** Directories we always skip when walking rootDir. */
const SKIP_DIRS = new Set<string>([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.next',
  '.cache',
  'dist',
  'build',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
]);

// ═══════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════

export interface SyncTeamMemoryOptions {
  /** Team identifier, e.g. `'acme/widgets'`. */
  team: string;
  /** Root directory to sync (scanned recursively). */
  rootDir: string;
  /** Prismer API key (Bearer). */
  apiKey: string;
  /**
   * Base URL for the IM API — typically the cloud host.
   * e.g. `'https://prismer.cloud/api/im'` or `'http://localhost:3000/api/im'`.
   */
  baseUrl: string;
  /**
   * Optional override of the since timestamp. Normally we read this from the
   * sidecar state file and ignore this param. Exposed mainly for testing.
   */
  since?: string;
  /**
   * Custom fetch (for tests). Defaults to the global fetch.
   */
  fetchImpl?: typeof fetch;
  /**
   * If true, do not write pulled[] rows to disk and do not update sidecar.
   * Useful for dry-run/preflight.
   */
  dryRun?: boolean;
}

export interface SyncTeamMemoryResult {
  pushed: number;
  pulled: number;
  rejected: Array<{ path: string; reason: string; detail?: string }>;
  skippedLocalSecrets: Array<{ path: string; pattern: string; line: number }>;
  serverTime: string;
}

interface LastSyncState {
  /** Per-file sha256 of the last-seen content (plaintext). */
  hashes: Record<string, string>;
  /** Server time (ISO) from the last successful sync — used as next `since`. */
  serverTime: string | null;
  /** Team name this state is for. */
  team: string;
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function readLastSync(rootDir: string): LastSyncState {
  const p = join(rootDir, LAST_SYNC_FILE);
  if (!existsSync(p)) {
    return { hashes: {}, serverTime: null, team: '' };
  }
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LastSyncState>;
    return {
      hashes: parsed.hashes && typeof parsed.hashes === 'object' ? parsed.hashes : {},
      serverTime: typeof parsed.serverTime === 'string' ? parsed.serverTime : null,
      team: typeof parsed.team === 'string' ? parsed.team : '',
    };
  } catch {
    return { hashes: {}, serverTime: null, team: '' };
  }
}

function writeLastSync(rootDir: string, state: LastSyncState): void {
  const p = join(rootDir, LAST_SYNC_FILE);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2), 'utf8');
}

/** Walk rootDir recursively for .md files (only). Returns POSIX-style rel paths. */
export function listMarkdownFiles(rootDir: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      if (entry === LAST_SYNC_FILE) continue;
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && /\.md$/i.test(entry)) out.push(full);
    }
  }
  walk(rootDir);
  return out.map((abs) => relative(rootDir, abs).split(sep).join('/'));
}

/**
 * Write pulled content to disk inside rootDir. Creates parent directories as
 * needed. Refuses to write outside rootDir (path traversal guard).
 */
function writePulledFile(rootDir: string, relPath: string, content: string): void {
  if (relPath.includes('..') || relPath.startsWith('/')) {
    throw new Error(`Refusing to write outside rootDir: ${relPath}`);
  }
  const target = join(rootDir, relPath);
  const root = join(rootDir, '.'); // normalized
  // belt & suspenders: ensure target is under root after join
  if (!target.startsWith(root)) {
    throw new Error(`Refusing to write outside rootDir: ${relPath}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

// ═══════════════════════════════════════════════════════════
// Public entry point
// ═══════════════════════════════════════════════════════════

/**
 * Sync a team-memory directory with the cloud.
 *
 *   1. Walk rootDir for .md files
 *   2. Hash each; diff against last-sync.json → push[] candidates
 *   3. Local secret scan → any hits are skipped (not pushed)
 *   4. POST /memory/team/sync with push[] and since
 *   5. Write pulled[] to disk (server wins)
 *   6. Update last-sync.json
 */
export async function syncTeamMemory(opts: SyncTeamMemoryOptions): Promise<SyncTeamMemoryResult> {
  const { team, rootDir, apiKey, baseUrl, fetchImpl, dryRun } = opts;
  const doFetch = fetchImpl ?? fetch;

  if (!existsSync(rootDir)) {
    mkdirSync(rootDir, { recursive: true });
  }

  const lastSync = readLastSync(rootDir);
  const since = opts.since ?? (lastSync.team === team ? lastSync.serverTime ?? undefined : undefined);

  // ── Gather push candidates ────────────────────────────────
  const files = listMarkdownFiles(rootDir);
  const pushEntries: Array<{ path: string; content: string; contentHash: string }> = [];
  const skippedLocalSecrets: SyncTeamMemoryResult['skippedLocalSecrets'] = [];
  const newHashes: Record<string, string> = {};

  for (const rel of files) {
    const abs = join(rootDir, rel);
    let raw: string;
    try {
      raw = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }

    const byteLen = Buffer.byteLength(raw, 'utf8');
    if (byteLen > MEMORY_TEAM_SYNC_MAX_BYTES) {
      // Skip oversized locally — server would reject anyway.
      continue;
    }

    const hash = sha256Hex(raw);
    newHashes[rel] = hash;

    // Only push when hash changed vs last sync.
    if (lastSync.team === team && lastSync.hashes[rel] === hash) continue;

    if (hasBlockingSecret(raw)) {
      const hit = scanForSecrets(raw).find((h) => !h.warnOnly)!;
      skippedLocalSecrets.push({ path: rel, pattern: hit.pattern, line: hit.line });
      continue;
    }

    pushEntries.push({ path: rel, content: raw, contentHash: hash });
  }

  // ── POST to server ───────────────────────────────────────
  const url = `${baseUrl.replace(/\/$/, '')}/memory/team/sync`;
  const res = await doFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ team, since, push: pushEntries }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`team sync failed: HTTP ${res.status} ${text}`);
  }

  const json = (await res.json()) as {
    ok: boolean;
    data?: {
      pulled: Array<{
        path: string;
        contentHash: string;
        content: string;
        memoryType: string | null;
        description: string | null;
        updatedAt: string;
      }>;
      pushed: { accepted: number; rejected: Array<{ path: string; reason: string; detail?: string }> };
      serverTime: string;
    };
    error?: string;
  };

  if (!json.ok || !json.data) {
    throw new Error(`team sync rejected: ${json.error ?? 'unknown'}`);
  }

  const data = json.data;

  // ── Write pulled back to disk ────────────────────────────
  if (!dryRun) {
    for (const row of data.pulled) {
      try {
        writePulledFile(rootDir, row.path, row.content);
        newHashes[row.path] = row.contentHash;
      } catch (err) {
        // Don't crash the whole sync over one bad path; surface via rejected list.
        data.pushed.rejected.push({
          path: row.path,
          reason: 'write_failed',
          detail: (err as Error).message,
        });
      }
    }
  }

  // Drop any entries whose local file disappeared (filter newHashes to what
  // still exists on disk OR what we just pulled).
  const finalHashes: Record<string, string> = {};
  for (const [p, h] of Object.entries(newHashes)) {
    finalHashes[p] = h;
  }

  if (!dryRun) {
    writeLastSync(rootDir, {
      team,
      hashes: finalHashes,
      serverTime: data.serverTime,
    });
  }

  return {
    pushed: data.pushed.accepted,
    pulled: data.pulled.length,
    rejected: data.pushed.rejected,
    skippedLocalSecrets,
    serverTime: data.serverTime,
  };
}

/**
 * Remove the sidecar state file — forces the next sync to re-push everything.
 * Useful from CLI tooling.
 */
export function resetTeamSyncState(rootDir: string): void {
  const p = join(rootDir, LAST_SYNC_FILE);
  if (existsSync(p)) {
    try {
      unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}
