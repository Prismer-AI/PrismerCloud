/**
 * pkf209 — the `pkf_reply_inline` native tool (mechanical inline-PKF delivery).
 *
 * 2026-08-20 matrix root cause (6/7, researcher red): weak models complete
 * every correct step — author, mint, validate — then fail the LAST one:
 * pasting the sentinel-wrapped PKF bytes verbatim into the final reply text.
 * Requiring a model to reproduce 4.9 KB byte-for-byte inside magic comments is
 * exactly the capability burden this fix removes (same category as the
 * already-eliminated self-computed hashes).
 *
 * Mechanical path (this module):
 *   1. The agent writes the validated `.pkf` file inside the task
 *      scratch/workdir and calls the tool with its path.
 *   2. `runPkfReplyInlineTool` (loopback `/local/pkf/reply-inline`) resolves
 *      the calling agent's CURRENT dispatch scope (bound by dispatch.ts),
 *      containment-checks the path, validates the PKF with the shared
 *      inline-carrier semantics, and writes a per-task marker
 *      `.pkf-inline-reply.json` into the scratch dir.
 *   3. At dispatch terminal state, `resolvePkfReplyInlineBlocks` re-reads the
 *      marker, RE-READS the file, and RE-VALIDATES everything (the marker is
 *      never trusted: an agent can write files in its own scratch dir) before
 *      constructing the same contentBlock shape the sentinel extraction
 *      produces. Any drift → no block + structured warn, plain text survives.
 *
 * The sentinel wire path (inline-pkf.ts) is untouched legacy compatibility;
 * when both fired, the sentinel carrier stays authoritative.
 */

import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { inlinePkfContentBlockFromSource } from '../inline-pkf.js';
import type { AgentDispatchReplyPkfContentBlock } from '../../wire/dispatch-types.js';

export const PKF_INLINE_REPLY_MARKER_FILENAME = '.pkf-inline-reply.json';

export interface PkfReplyInlineScope {
  taskId: string;
  /** This task's scratch dir — the ONLY place the marker is ever written. */
  scratchDir: string;
  /**
   * Extra READ roots the validated `.pkf` file may live in (persistent repo
   * workdir for coding agents / profile cwd for long-running adapters).
   * Containment-checked like the scratch dir; never written to.
   */
  allowedReadRoots: string[];
}

/**
 * In-flight dispatch scopes keyed by agentImUserId. dispatch.ts binds after
 * scratch provisioning and unbinds in its finally block. Same-agent
 * concurrent dispatches are excluded upstream by the hermes single-flight
 * guard (release203/27 S10), so one scope per agent is the honest model.
 */
const activeScopes = new Map<string, PkfReplyInlineScope>();

export function bindPkfReplyInlineScope(agentImUserId: string, scope: PkfReplyInlineScope): void {
  activeScopes.set(agentImUserId, scope);
}

export function unbindPkfReplyInlineScope(agentImUserId: string, taskId: string): void {
  const current = activeScopes.get(agentImUserId);
  // Never unbind a newer dispatch's scope (defensive; single-flight should
  // make this unreachable).
  if (current?.taskId === taskId) activeScopes.delete(agentImUserId);
}

export function getPkfReplyInlineScope(agentImUserId: string): PkfReplyInlineScope | undefined {
  return activeScopes.get(agentImUserId);
}

export interface PkfReplyInlineMarker {
  taskId: string;
  /** Absolute path as validated at tool-call time. */
  path: string;
  sourceHash: string;
  title?: string;
}

export type PkfReplyInlineToolResult =
  | { ok: true; emitted: true; sourceHash: string; title?: string }
  | { ok: false; error: string; message: string };

function sha256Hex(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

/** Resolve `candidate` against the roots; true only when strictly inside one. */
async function isInsideRoots(resolved: string, roots: string[]): Promise<boolean> {
  let realCandidate = resolved;
  try {
    realCandidate = await fsp.realpath(resolved);
  } catch {
    /* missing file — lexical containment is the pre-check; read fails later */
  }
  for (const root of roots) {
    const realRoot = await fsp.realpath(root).catch(() => root);
    const rel = path.relative(realRoot, realCandidate);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  }
  return false;
}

/**
 * Resolve a RELATIVE tool path against each root in order — the first root
 * where the file exists wins. Absolute paths pass through unchanged.
 *
 * 2026-08-20 run-2 lesson: a hermes agent's `write_file "memo.pkf"` lands in
 * its PROFILE cwd (~/.hermes/profiles/<name>/), not the task scratch dir —
 * the model then passes the same relative path to this tool. Resolving only
 * against scratch made every call fail with file_unreadable and the model
 * fell back to attaching the file (the exact regression this tool exists to
 * kill). Multi-root resolution matches the agent's own path intuition.
 */
async function resolveToolPath(rawPath: string, roots: string[]): Promise<string> {
  if (path.isAbsolute(rawPath)) return rawPath;
  for (const root of roots) {
    const candidate = path.join(root, rawPath);
    try {
      await fsp.access(candidate);
      return candidate;
    } catch {
      /* not under this root — keep looking */
    }
  }
  return path.join(roots[0] ?? '', rawPath);
}

/**
 * Tool-call handler. Reads + validates the file, then writes the marker.
 * Validation failure NEVER writes a marker — the agent gets a structured
 * error and can repair + retry within the same turn.
 */
export async function runPkfReplyInlineTool(input: {
  agentImUserId: string;
  path: string;
}): Promise<PkfReplyInlineToolResult> {
  const scope = getPkfReplyInlineScope(input.agentImUserId);
  if (!scope) {
    return {
      ok: false,
      error: 'pkf_reply_inline_no_active_task',
      message: 'pkf_reply_inline is only callable while your dispatch is running (no active task scope for this agent).',
    };
  }
  const rawPath = typeof input.path === 'string' ? input.path.trim() : '';
  if (!rawPath) {
    return {
      ok: false,
      error: 'pkf_reply_inline_path_required',
      message: 'pkf_reply_inline requires the path of the validated .pkf file.',
    };
  }
  const roots = [scope.scratchDir, ...scope.allowedReadRoots];
  const resolved = await resolveToolPath(rawPath, roots);
  if (!(await isInsideRoots(resolved, roots))) {
    return {
      ok: false,
      error: 'pkf_reply_inline_path_outside',
      message: `The path must resolve inside the task scratch dir (${scope.scratchDir}) or the declared workdir. Write the .pkf there first.`,
    };
  }

  let source: string;
  try {
    const bytes = await fsp.readFile(resolved);
    if (bytes.length > 1024 * 1024) {
      return {
        ok: false,
        error: 'pkf_reply_inline_too_large',
        message: 'The file exceeds the inline carrier budget (32 KiB for the PKF source).',
      };
    }
    source = bytes.toString('utf8');
  } catch {
    return {
      ok: false,
      error: 'pkf_reply_inline_file_unreadable',
      message: `Cannot read ${rawPath} (looked in: ${roots.join(', ')}). Write the .pkf file there first, then call pkf_reply_inline with its path.`,
    };
  }

  const trimmed = source.trim();
  const contentBlocks = inlinePkfContentBlockFromSource(trimmed);
  if (!contentBlocks) {
    if (Buffer.byteLength(trimmed, 'utf8') > 32_768) {
      // product210/03 O2 — actionable over-budget guidance: the agent should
      // not have to bisect (observed live: 5+ wasted probe actions). Point at
      // the deterministic split path.
      const bytes = Buffer.byteLength(trimmed, 'utf8');
      const sections = (trimmed.match(/<section[\s>]/gi) ?? []).length;
      return {
        ok: false,
        error: 'pkf_reply_inline_too_large',
        message:
          `The PKF source is ${bytes} bytes; the inline carrier budget is 32768 (32 KiB). ` +
          (sections > 1
            ? `Split it at top-level <section> boundaries into multiple pkf_reply_inline deliveries (each ≤32768 bytes, each a valid standalone PKF with frontmatter), or deliver it as an Asset attachment and reference it via a prismer://asset pointer.`
            : `Deliver it as an Asset attachment and reference it via a prismer://asset pointer.`),
      };
    }
    return {
      ok: false,
      error: 'pkf_reply_inline_invalid',
      message: 'The file is not a valid inline carrier: PKF v1.1 with structure validation must pass (run pkf_validate and repair every error first).',
    };
  }

  const sourceHash = sha256Hex(trimmed);
  const title = contentBlocks[0]?.title;
  const marker: PkfReplyInlineMarker = {
    taskId: scope.taskId,
    path: resolved,
    sourceHash,
    ...(title ? { title } : {}),
  };
  await fsp.writeFile(
    path.join(scope.scratchDir, PKF_INLINE_REPLY_MARKER_FILENAME),
    JSON.stringify(marker),
    'utf8',
  );
  return { ok: true, emitted: true, sourceHash, ...(title ? { title } : {}) };
}

export type PkfReplyInlineTerminalOutcome =
  | { contentBlocks: AgentDispatchReplyPkfContentBlock[] }
  | { warn: true; reason: string };

/**
 * Dispatch terminal-state resolution. `null` = no marker (plain reply, not an
 * error). A marker that exists but fails re-validation returns `{warn, reason}`
 * — the caller logs it and the reply stays plain text; a bad PKF must NEVER
 * reach the inline carrier.
 */
export async function resolvePkfReplyInlineBlocks(
  scratchDir: string,
  extraReadRoots: string[] = [],
): Promise<PkfReplyInlineTerminalOutcome | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(path.join(scratchDir, PKF_INLINE_REPLY_MARKER_FILENAME), 'utf8');
  } catch {
    return null;
  }

  let marker: Partial<PkfReplyInlineMarker>;
  try {
    marker = JSON.parse(raw) as Partial<PkfReplyInlineMarker>;
  } catch {
    return { warn: true, reason: 'pkf_reply_inline_marker_malformed' };
  }
  if (
    typeof marker.path !== 'string' ||
    !marker.path.trim() ||
    typeof marker.sourceHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(marker.sourceHash)
  ) {
    return { warn: true, reason: 'pkf_reply_inline_marker_malformed' };
  }

  const roots = [scratchDir, ...extraReadRoots];
  if (!(await isInsideRoots(marker.path, roots))) {
    return { warn: true, reason: 'pkf_reply_inline_path_outside' };
  }

  let source: string;
  try {
    source = (await fsp.readFile(marker.path)).toString('utf8');
  } catch {
    return { warn: true, reason: 'pkf_reply_inline_file_unreadable' };
  }
  const trimmed = source.trim();
  if (sha256Hex(trimmed) !== marker.sourceHash) {
    return { warn: true, reason: 'pkf_reply_inline_file_changed' };
  }
  const contentBlocks = inlinePkfContentBlockFromSource(trimmed);
  if (!contentBlocks) {
    return { warn: true, reason: 'pkf_reply_inline_invalid' };
  }
  return { contentBlocks };
}
