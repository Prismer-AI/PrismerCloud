/**
 * sink.ts — Default PARA event sink for @prismer/openclaw-channel
 *
 * Writes PARA events to ~/.prismer/para/events.jsonl (shared file with
 * @prismer/claude-code-plugin — both adapters share the same pipe so the
 * Prismer daemon reads a single unified event stream).
 *
 * If env PRISMER_PARA_STDOUT=1, also writes each event line to stdout.
 *
 * Append-safety: appendFileSync with a single JSON line is safe on POSIX
 * for small writes (< PIPE_BUF ≈ 4096 bytes). For larger events we rely
 * on sequential calls — the IM event model ensures no concurrent writes
 * from OpenClaw hooks (all run on the same Node.js event loop thread).
 *
 * docs/version190/03-para-spec.md §4.4 — adapter writes to the JSONL sink;
 * PARA daemon reads and routes.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { createHash } from 'node:crypto';
import type { AgentDescriptor } from '@prismer/wire';
import type { DispatchSink } from '@prismer/adapters-core';
import type { ParaEvent } from '@prismer/wire';

// ─── Paths ────────────────────────────────────────────────────────────────────

export const PARA_DIR = join(homedir(), '.prismer', 'para');
const EVENTS_FILE = join(PARA_DIR, 'events.jsonl');

// ─── Stable adapter ID ────────────────────────────────────────────────────────

/**
 * Generate a stable adapter ID per PARA spec §4.3 AgentDescriptor example
 * ("claude-code@MacBook-Pro"). Format: `<adapter>-<16-hex hash>`.
 * Two adapters on the same workspace produce different ids (CC != OpenClaw)
 * because the adapter name is part of the hash input.
 */
export function stableAdapterId(workspace: string, adapter = 'openclaw'): string {
  const hash = createHash('sha256')
    .update(`${adapter}:${workspace}:${hostname()}`)
    .digest('hex')
    .slice(0, 16);
  return `${adapter}-${hash}`;
}

// ─── Agent descriptor ─────────────────────────────────────────────────────────

/**
 * Build an AgentDescriptor for the OpenClaw adapter.
 *
 * Tier support:
 *   L1 Discovery (1), L2 Message I/O (2), L3 Tool Call Observation (3) — wired.
 *   L7 FS Delegation (7) — NOT supported (OpenClaw does not expose FS hooks yet).
 *
 * @param openclawVersion — peer openclaw version string read from node_modules,
 *   or 'unknown' if the file is not readable.
 */
export function buildAgentDescriptor(openclawVersion?: string): AgentDescriptor {
  const workspace = process.cwd();
  const version = openclawVersion ?? resolveOpenClawVersion();
  return {
    id: stableAdapterId(workspace),
    adapter: 'openclaw',
    version,
    // L1 (Discovery) + L2 (Message I/O). L3 (Tool observation) intentionally
    // NOT claimed — OpenClaw plugin SDK §4.6.1 does not expose tool hooks
    // (pre/post_tool_call). Downgrade to match spec.
    tiersSupported: [1, 2],
    capabilityTags: ['code', 'message', 'channel'],
    workspace,
  };
}

/**
 * Attempt to read the installed openclaw version from node_modules.
 * Returns 'unknown' on any error.
 */
function resolveOpenClawVersion(): string {
  try {
    // Prefer resolving relative to this module file (correct for monorepo /
    // global install / nested node_modules), then fall back to cwd.
    const here = fileURLToPath(new URL('.', import.meta.url)); // src/para/
    const candidates = [
      join(here, '..', '..', 'node_modules', 'openclaw', 'package.json'),
      join(process.cwd(), 'node_modules', 'openclaw', 'package.json'),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, 'utf-8')) as { version?: string };
        if (pkg.version) return pkg.version;
      }
    }
  } catch {
    // non-fatal
  }
  return 'unknown';
}

// ─── Agent descriptor file cache ──────────────────────────────────────────────

const AGENT_DESC_FILE = join(PARA_DIR, 'openclaw-agent-descriptor.json');

/** Load cached descriptor, or null if not yet written. */
export function loadCachedDescriptor(): AgentDescriptor | null {
  try {
    if (!existsSync(AGENT_DESC_FILE)) return null;
    return JSON.parse(readFileSync(AGENT_DESC_FILE, 'utf-8')) as AgentDescriptor;
  } catch {
    return null;
  }
}

/** Build, cache, and return a fresh descriptor. */
export function buildAndCacheDescriptor(): AgentDescriptor {
  const descriptor = buildAgentDescriptor();
  try {
    mkdirSync(PARA_DIR, { recursive: true, mode: 0o700 });
    // Atomic write: temp + rename prevents partial reads under concurrent starts.
    const tmp = AGENT_DESC_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(descriptor, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, AGENT_DESC_FILE);
  } catch {
    // Non-fatal — in-memory descriptor is still usable.
  }
  return descriptor;
}

// ─── Default JSONL sink ───────────────────────────────────────────────────────

/**
 * defaultJsonlSink — append each PARA event as a single JSON line to the
 * shared events file.  Shared with the CC adapter so Prismer daemon sees a
 * unified stream.
 *
 * Sink receives already-validated ParaEvent objects from EventDispatcher
 * and does NOT call zod. Wire bundles zod ^3 as a direct dep (nested in
 * @prismer/wire/node_modules/) so wire's ParaEventSchema.parse() always
 * runs against v3 regardless of which zod version the consumer ships.
 */
// 50 MB cap — rotate to events.jsonl.1 when exceeded. Single rollover is
// enough for this version; Track 2 daemon will own more sophisticated rotation.
const MAX_EVENTS_FILE_SIZE = 50 * 1024 * 1024;

function rotateIfNeeded(): void {
  try {
    if (existsSync(EVENTS_FILE) && statSync(EVENTS_FILE).size >= MAX_EVENTS_FILE_SIZE) {
      renameSync(EVENTS_FILE, EVENTS_FILE + '.1');
    }
  } catch {
    // non-fatal
  }
}

export const defaultJsonlSink: DispatchSink = (evt: ParaEvent): void => {
  const line = JSON.stringify({ ...evt, _ts: Date.now() }) + '\n';
  try {
    mkdirSync(PARA_DIR, { recursive: true, mode: 0o700 });
    rotateIfNeeded();
    appendFileSync(EVENTS_FILE, line, { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    // Non-fatal — PARA is observation-only; log to stderr but don't throw.
    process.stderr.write(
      `[openclaw-para] write error (${EVENTS_FILE}): ${(err as Error).message}\n`,
    );
  }
  if (process.env.PRISMER_PARA_STDOUT === '1') {
    process.stdout.write(line);
  }
};
