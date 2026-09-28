// Daemon-id helpers. Generated once on first `prismer setup`, then persisted
// in config.toml.
//
// F14 (2026-05-20): IDs are now **stable per (hostname, apiKey)** by default —
// a sha256 hash of the seed produces the 12-hex suffix. Why: the previous
// `randomBytes(6).toString('hex')` form gave a fresh suffix on every fresh
// setup, so the same Mac re-running `prismer setup` (e.g. after config wipe
// or rotating api keys with the same identity) ended up registered as a new
// device on the cloud side. host.declare upserts by `podName='daemon:'+id
// .slice(-30)`, so distinct suffixes meant new rows accumulated per setup.
// Stable hashing makes the same physical machine + same identity always
// yield the same daemonId, so cloud-side upsert dedupes naturally.
//
// `newDaemonId()` (no-arg) keeps the legacy random suffix for callers that
// can't supply an apiKey at mint time (currently none in our codebase but
// preserved for SDK consumers). Prefer `newDaemonId({ apiKey })`.

import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

const PREFIX = 'daemon-';

function sanitizeHostname(): string {
  return (
    hostname()
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'unknown'
  );
}

export interface NewDaemonIdOptions {
  /** API key — when provided, the suffix becomes a deterministic sha256(hostname|apiKey)
   * slice(0,12). Pass this so re-running `prismer setup` yields the same daemonId
   * and cloud-side upsert dedupes the IMContainer row instead of accumulating. */
  apiKey?: string;
  /** Optional explicit hostname (test only). */
  hostnameOverride?: string;
}

export function newDaemonId(opts: NewDaemonIdOptions = {}): string {
  const host = opts.hostnameOverride ?? sanitizeHostname();
  if (opts.apiKey) {
    const suffix = createHash('sha256').update(`${host}|${opts.apiKey}`).digest('hex').slice(0, 12);
    return `${PREFIX}${host}-${suffix}`;
  }
  // Legacy random suffix path — kept for callers without apiKey context.
  return `${PREFIX}${host}-${randomBytes(6).toString('hex')}`;
}

export function isDaemonId(s: string): boolean {
  return s.startsWith(PREFIX) && s.length > PREFIX.length;
}
