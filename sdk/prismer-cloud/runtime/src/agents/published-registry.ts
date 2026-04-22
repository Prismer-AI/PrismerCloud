/**
 * Prismer Runtime — Published agents registry (Sprint A2.2, D3 publish flow)
 *
 * Tracks which locally-installed agents have been published to cloud, so
 * the daemon's heartbeat loop knows which `cloudAgentId`s to refresh and
 * `prismer agent unpublish` knows what to delete.
 *
 * On-disk format: TOML at `~/.prismer/published-agents.toml`. Schema is
 * forward-compatible — unknown keys are preserved on round-trip.
 *
 *   schemaVersion = 1
 *   [[agent]]
 *   name = "claude-code"
 *   cloud_agent_id = "cmo0qzzxw011lvm01qplbgs1i"
 *   local_agent_id = "claude-code@MacBook-Pro"
 *   adapter = "claude-code"
 *   published_at = "2026-04-20T10:30:00.000Z"
 *
 * Concurrency: callers serialize via the daemon process. We never assume
 * multi-writer safety — a second `prismer agent publish` racing with the
 * heartbeat loop is acceptable because both eventually converge through
 * read-modify-write of this single file.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import TOML from '@iarna/toml';

export interface PublishedAgent {
  /** Local short name (matches `prismer agent install <name>`). */
  name: string;
  /** Cloud-side IMAgentCard.id returned from POST /api/im/agents/register. */
  cloudAgentId: string;
  /** Daemon-internal id, e.g. "claude-code@hostname". For trace only. */
  localAgentId?: string;
  /** PARA adapter name. */
  adapter?: string;
  /** ISO timestamp when publish succeeded. */
  publishedAt: string;
}

const SCHEMA_VERSION = 1;

function defaultPath(): string {
  return path.join(os.homedir(), '.prismer', 'published-agents.toml');
}

/**
 * Load the registry. Returns an empty list if the file doesn't exist or
 * is malformed (we tolerate corruption — the daemon still functions, the
 * agent simply needs to be republished).
 */
export function loadPublishedRegistry(filePath?: string): PublishedAgent[] {
  const file = filePath ?? defaultPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  let parsed: TOML.JsonMap;
  try {
    parsed = TOML.parse(raw);
  } catch {
    // Don't throw — let publish recover gracefully.
    return [];
  }

  const list = parsed.agent;
  if (!Array.isArray(list)) return [];

  const out: PublishedAgent[] = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.name !== 'string' || typeof r.cloud_agent_id !== 'string') continue;
    out.push({
      name: r.name,
      cloudAgentId: r.cloud_agent_id,
      localAgentId: typeof r.local_agent_id === 'string' ? r.local_agent_id : undefined,
      adapter: typeof r.adapter === 'string' ? r.adapter : undefined,
      publishedAt: typeof r.published_at === 'string' ? r.published_at : new Date(0).toISOString(),
    });
  }
  return out;
}

/**
 * Atomically write the registry. Uses a temp file + rename so a crashed
 * write never leaves the file half-truncated.
 */
export function savePublishedRegistry(entries: PublishedAgent[], filePath?: string): void {
  const file = filePath ?? defaultPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const doc: TOML.JsonMap = {
    schemaVersion: SCHEMA_VERSION,
    agent: entries.map((e) => ({
      name: e.name,
      cloud_agent_id: e.cloudAgentId,
      ...(e.localAgentId ? { local_agent_id: e.localAgentId } : {}),
      ...(e.adapter ? { adapter: e.adapter } : {}),
      published_at: e.publishedAt,
    })),
  };

  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, TOML.stringify(doc), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Add or replace by `name`. Returns the resulting list. */
export function upsertPublished(entry: PublishedAgent, filePath?: string): PublishedAgent[] {
  const all = loadPublishedRegistry(filePath);
  const idx = all.findIndex((a) => a.name === entry.name);
  if (idx >= 0) all[idx] = entry;
  else all.push(entry);
  savePublishedRegistry(all, filePath);
  return all;
}

/** Remove by `name`. Returns the resulting list (no-op if missing). */
export function removePublished(name: string, filePath?: string): PublishedAgent[] {
  const all = loadPublishedRegistry(filePath);
  const filtered = all.filter((a) => a.name !== name);
  if (filtered.length !== all.length) {
    savePublishedRegistry(filtered, filePath);
  }
  return filtered;
}

/** Look up by `name` (returns undefined if not published). */
export function findPublished(name: string, filePath?: string): PublishedAgent | undefined {
  return loadPublishedRegistry(filePath).find((a) => a.name === name);
}
