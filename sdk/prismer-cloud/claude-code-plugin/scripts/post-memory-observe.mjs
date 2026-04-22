#!/usr/bin/env node
/**
 * PostToolUse hook — CC Memory Observer (v1.9.0, §14e.8.3)
 *
 * READ-ONLY observation: when Claude Code writes its own memory file (via
 * Write or Edit tool), this hook reads the resulting file and replicates
 * the content into Prismer's MemoryGateway via POST /api/im/memory/files.
 *
 * We NEVER write back to CC's memory files. CC owns its memory; we merely
 * mirror it. This avoids competition with CC's atomic write path.
 *
 * Fail-open posture:
 *   - Any error is swallowed + logged. The hook always exits 0.
 *   - HTTP POST timeout: 3s.
 *   - Disabled via CLAUDE_CODE_DISABLE_AUTO_MEMORY=1.
 *
 * Stdin JSON shape (PostToolUse):
 *   { tool_name, tool_input: { file_path, ... }, tool_result|tool_response: ... }
 *
 * Path matching (any of):
 *   ~/.claude/projects/<project>/memory/**\/*.md       → scope=project:<project>
 *   ~/.claude/memory/**\/*.md                          → scope=global
 *   ~/.claude/agent-memory/user/**\/*.md               → scope=global
 *   ~/.claude/agent-memory/project/**\/*.md            → scope=project:<cwd-basename>
 *   ~/.claude/agent-memory/local/**\/*.md              → scope=project:<cwd-basename>:local
 *   ~/.claude/memory/team/<owner>/<repo>/**\/*.md      → scope=shared:team:<owner>/<repo>
 *   $CLAUDE_CODE_REMOTE_MEMORY_DIR/**                  → (inherits sub-structure detection)
 *   $CLAUDE_CONFIG_DIR/memory/**                       → replaces ~/.claude
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { basename, dirname, join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { resolveConfig } from './lib/resolve-config.mjs';
import { createLogger } from './lib/logger.mjs';

const log = createLogger('post-memory-observe');

// KAIROS cursor persistence — one JSON doc per plugin data dir.
// Shape: { "<absolute file path>": { "lastLength": <bytes>, "lastMTime": <ms> } }
function getKairosCursorPath() {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  if (!dataDir) return null;
  return join(dataDir, '.kairos-cursors.json');
}

export function readKairosCursors(cursorPath) {
  const p = cursorPath ?? getKairosCursorPath();
  if (!p) return {};
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writeKairosCursors(cursors, cursorPath) {
  const p = cursorPath ?? getKairosCursorPath();
  if (!p) return;
  try {
    mkdirSync(dirname(p), { recursive: true });
  } catch {}
  // Atomic write: write temp + rename.
  const tmp = `${p}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(cursors));
    renameSync(tmp, p);
  } catch (e) {
    log.warn('cursor-write-failed', { error: e?.message });
  }
}

// --- Pure helpers (exported for tests; safe to import without side effects) ---

function getConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || `${homedir()}/.claude`;
}

/**
 * Match the file path against known CC memory layouts and infer scope + relative path.
 *
 * Returns `null` if path is not a CC memory file.
 * Returns `{ scope, relPath, mode }` on match where `mode` is:
 *   - `'kairos'` for append-only daily logs (`.../logs/YYYY/MM/DD.md`)
 *   - `'file'`   for regular whole-file memory
 */
export function detectCCMemoryPath(filePath, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const configDir = opts.configDir || getConfigDir();
  const remoteDir = opts.remoteDir !== undefined
    ? opts.remoteDir
    : (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR || '');

  // Normalize trailing slashes.
  const norm = (p) => String(p || '').replace(/\/+$/, '');
  const cd = norm(configDir);
  const rd = norm(remoteDir);

  // Only .md files qualify.
  if (!/\.md$/i.test(filePath)) return null;

  // Helper: strip a prefix if the path starts with it; return remainder or null.
  function stripPrefix(fp, prefix) {
    if (!prefix) return null;
    if (fp === prefix) return '';
    if (fp.startsWith(prefix + '/')) return fp.slice(prefix.length + 1);
    return null;
  }

  // $CLAUDE_CODE_REMOTE_MEMORY_DIR — treat its content like files under the
  // corresponding ~/.claude/memory layout if we can match it; otherwise fall
  // back to global scope with the remote-relative path.
  if (rd) {
    const rem = stripPrefix(filePath, rd);
    if (rem !== null) {
      const res = matchUnderClaude(filePath, rd, cwd);
      if (res) return withMode(res);
      return withMode({ scope: 'global', relPath: rem });
    }
  }

  const res = matchUnderClaude(filePath, cd, cwd);
  return res ? withMode(res) : null;
}

/**
 * Determine the `mode` ('file' | 'kairos') for a matched memory path.
 * KAIROS = relPath matches `logs/YYYY/MM/DD.md` with strict zero-padding.
 */
function withMode(res) {
  if (!res || !res.relPath) return res;
  if (isKairosRelPath(res.relPath)) {
    return { ...res, mode: 'kairos' };
  }
  return { ...res, mode: 'file' };
}

export function isKairosRelPath(relPath) {
  if (typeof relPath !== 'string') return false;
  return /(^|\/)logs\/\d{4}\/\d{2}\/\d{2}\.md$/.test(relPath);
}

function matchUnderClaude(filePath, claudeRoot, cwd) {
  if (!claudeRoot) return null;

  // 1. ~/.claude/memory/team/<owner>/<repo>/...
  const teamPrefix = `${claudeRoot}/memory/team/`;
  if (filePath.startsWith(teamPrefix)) {
    const rest = filePath.slice(teamPrefix.length);
    const parts = rest.split('/');
    if (parts.length >= 3) {
      const owner = parts[0];
      const repo = parts[1];
      const relPath = parts.slice(2).join('/');
      if (owner && repo && relPath) {
        return { scope: `shared:team:${owner}/${repo}`, relPath };
      }
    }
    return null;
  }

  // 2. ~/.claude/agent-memory/{user,project,local}/...
  const agentMemPrefix = `${claudeRoot}/agent-memory/`;
  if (filePath.startsWith(agentMemPrefix)) {
    const rest = filePath.slice(agentMemPrefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    const subScope = rest.slice(0, slash);
    const relPath = rest.slice(slash + 1);
    if (!relPath) return null;

    if (subScope === 'user') {
      return { scope: 'global', relPath };
    }
    if (subScope === 'project') {
      const projName = basename(cwd) || 'unknown';
      return { scope: `project:${projName}`, relPath };
    }
    if (subScope === 'local') {
      const projName = basename(cwd) || 'unknown';
      return { scope: `project:${projName}:local`, relPath };
    }
    return null;
  }

  // 3. ~/.claude/projects/<project>/memory/...
  const projectsPrefix = `${claudeRoot}/projects/`;
  if (filePath.startsWith(projectsPrefix)) {
    const rest = filePath.slice(projectsPrefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    const projectName = rest.slice(0, slash);
    const afterProj = rest.slice(slash + 1);
    const memPrefix = 'memory/';
    if (!afterProj.startsWith(memPrefix)) return null;
    const relPath = afterProj.slice(memPrefix.length);
    if (!relPath || !projectName) return null;
    return { scope: `project:${projectName}`, relPath };
  }

  // 4. ~/.claude/memory/... (must come AFTER the team check above)
  const memPrefix = `${claudeRoot}/memory/`;
  if (filePath.startsWith(memPrefix)) {
    const relPath = filePath.slice(memPrefix.length);
    if (!relPath) return null;
    return { scope: 'global', relPath };
  }

  return null;
}

/**
 * Closed set of memoryType values accepted by the server. Mirrors the
 * {@link MemoryType} union in `src/im/services/memory/types.ts`. Keeping
 * this list in sync with the server is a soft contract — unknown
 * frontmatter `type` values are dropped at the hook boundary so the server
 * never has to decide.
 */
export const VALID_MEMORY_TYPES = ['user', 'feedback', 'project', 'reference', 'insight'];

/**
 * Parse a YAML-ish frontmatter block. Best effort; only extracts known keys.
 *
 * Normalizes `type` against {@link VALID_MEMORY_TYPES} — unknown values are
 * dropped (`memoryType` is left unset) so the server can apply its default
 * rather than persisting a garbage string.
 *
 * Input: full markdown file text.
 * Output: { memoryType?, description?, body: string }
 */
export function parseFrontmatter(text) {
  if (typeof text !== 'string' || text.length < 3) {
    return { body: text || '' };
  }
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return { body: text };
  }
  const afterOpen = text.indexOf('\n') + 1;
  const closeIdx = text.indexOf('\n---', afterOpen);
  if (closeIdx < 0) {
    return { body: text };
  }
  const fmBlock = text.slice(afterOpen, closeIdx);
  const afterClose = text.indexOf('\n', closeIdx + 1);
  const body = afterClose >= 0 ? text.slice(afterClose + 1) : '';

  const out = { body };
  for (const line of fmBlock.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!val) continue;
    if (key === 'type') {
      // Whitelist-map; unknown values → drop (leave out.memoryType unset).
      if (VALID_MEMORY_TYPES.includes(val)) {
        out.memoryType = val;
      }
    } else if (key === 'description') {
      out.description = val;
    }
  }
  return out;
}

/**
 * Build the POST body shape. ownerId is resolved server-side from API-key auth.
 * Exported for tests.
 *
 * @param {object} args
 * @param {string} args.scope
 * @param {string} args.relPath
 * @param {string} args.content
 * @param {string} [args.memoryType]
 * @param {string} [args.description]
 * @param {'upsert'|'append'} [args.operation]
 *   - 'append' — KAIROS delta growth path (incremental bytes only).
 *   - 'upsert' — KAIROS initial / reset, or non-KAIROS whole-file (full content
 *     replaces any prior row). Emitted on the wire so the server definitively
 *     replaces any stale baseline (e.g. after local log rotation).
 */
export function buildRequestBody({ scope, relPath, content, memoryType, description, operation }) {
  const body = {
    ownerType: 'agent',
    scope,
    path: relPath,
    content,
  };
  if (memoryType) body.memoryType = memoryType;
  if (description) body.description = description;
  if (operation === 'append' || operation === 'upsert') body.operation = operation;
  return body;
}

/**
 * Compute the new-bytes delta for a KAIROS append event given a cursor.
 *
 * Returns one of:
 *   { kind: 'noop' }        — file unchanged, nothing to send.
 *   { kind: 'reset', content } — file shrunk/rotated; send full content, reset cursor.
 *   { kind: 'delta', content } — new bytes only; send delta, advance cursor.
 *   { kind: 'initial', content } — first observation of this file; send full content, set cursor.
 *
 * @param {string} fileText - current file content
 * @param {{lastLength?: number, lastMTime?: number}|undefined} cursor - previous cursor
 */
export function computeKairosDelta(fileText, cursor) {
  const currentLength = fileText.length;
  if (!cursor || typeof cursor.lastLength !== 'number') {
    return { kind: 'initial', content: fileText, newLength: currentLength };
  }
  if (currentLength === cursor.lastLength) {
    return { kind: 'noop', newLength: currentLength };
  }
  if (currentLength < cursor.lastLength) {
    // File shrank / rotated / was rewritten — send full content, reset cursor.
    return { kind: 'reset', content: fileText, newLength: currentLength };
  }
  // Growth — send only the new tail bytes.
  const delta = fileText.slice(cursor.lastLength);
  return { kind: 'delta', content: delta, newLength: currentLength };
}

// --- Main (runs only when executed directly, NOT when imported by tests) ---

async function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }

  if (process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1') {
    log.debug('disabled-via-env');
    return;
  }

  const toolName = input?.tool_name;
  if (toolName !== 'Write' && toolName !== 'Edit') {
    return;
  }

  const filePath = input?.tool_input?.file_path;
  if (!filePath || typeof filePath !== 'string') {
    return;
  }

  const detect = detectCCMemoryPath(filePath);
  if (!detect) {
    log.debug('path-not-cc-memory', { filePath });
    return;
  }

  let fileText = '';
  try {
    if (!existsSync(filePath)) {
      log.debug('file-missing', { filePath });
      return;
    }
    fileText = readFileSync(filePath, 'utf8');
  } catch (e) {
    log.warn('read-failed', { filePath, error: e?.message });
    return;
  }

  if (!fileText || !fileText.trim()) {
    log.debug('file-empty', { filePath });
    return;
  }

  const { memoryType, description } = parseFrontmatter(fileText);

  const kairosDiffEnabled =
    detect.mode === 'kairos' && process.env.PRISMER_CC_KAIROS_DIFF !== '0';

  // KAIROS diff mode: compute delta relative to per-file cursor.
  // If disabled (PRISMER_CC_KAIROS_DIFF=0) or not a KAIROS path, use whole-file upsert.
  let postContent = fileText;
  let operation; // undefined => server defaults to 'upsert'
  let cursors; // read lazily
  let kairosKind; // for logging

  if (kairosDiffEnabled) {
    cursors = readKairosCursors();
    const delta = computeKairosDelta(fileText, cursors[filePath]);
    kairosKind = delta.kind;

    if (delta.kind === 'noop') {
      log.debug('kairos-noop', { filePath, length: fileText.length });
      return;
    }

    postContent = delta.content;
    // Operation selection by delta kind (ship-blocker S3 fix):
    //   - 'initial' → 'upsert': no prior cursor, server may hold a stale row
    //     from a previous process; overwrite idempotently with full content.
    //   - 'delta'   → 'append': normal incremental growth — send tail bytes
    //     and let the server concat onto the existing row.
    //   - 'reset'   → 'upsert': local file shrank (rotation / rewrite), so
    //     server's prior content is definitionally stale. Overwrite, don't
    //     append (appending would corrupt the row and cause permanent desync
    //     once the cursor advances to the shorter length).
    if (delta.kind === 'delta') {
      operation = 'append';
    } else {
      // 'initial' or 'reset' — full content, replace semantics.
      operation = 'upsert';
    }
  }

  const body = buildRequestBody({
    scope: detect.scope,
    relPath: detect.relPath,
    content: postContent,
    memoryType,
    description,
    operation,
  });

  const { apiKey, baseUrl } = resolveConfig();
  if (!apiKey) {
    log.debug('no-api-key');
    return;
  }

  // Test/debug hook: when set, emit URL+body to stdout instead of making a
  // real HTTP call. Lets the test harness verify the request shape offline.
  if (process.env._PRISMER_MEMORY_OBSERVE_DRY_RUN) {
    log.info('dry-run', {
      url: `${baseUrl}/api/im/memory/files`,
      scope: body.scope,
      path: body.path,
      mode: detect.mode,
      kairosKind,
    });
    try {
      process.stdout.write(
        JSON.stringify({
          url: `${baseUrl}/api/im/memory/files`,
          body,
          mode: detect.mode,
          kairosKind,
        }),
      );
    } catch {}
    // Still advance the cursor in dry-run so successive dry-runs see progressive state.
    if (kairosDiffEnabled && kairosKind !== 'noop') {
      cursors[filePath] = { lastLength: fileText.length, lastMTime: Date.now() };
      writeKairosCursors(cursors);
    }
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  timer.unref();
  try {
    const res = await fetch(`${baseUrl}/api/im/memory/files`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) {
      log.info('memory-observed', {
        scope: body.scope,
        path: body.path,
        memoryType,
        size: postContent.length,
        mode: detect.mode,
        kairosKind,
      });
      // Advance cursor ONLY on success.
      if (kairosDiffEnabled && kairosKind && kairosKind !== 'noop') {
        cursors[filePath] = { lastLength: fileText.length, lastMTime: Date.now() };
        writeKairosCursors(cursors);
      }
    } else {
      log.warn('memory-observe-non-ok', {
        status: res.status,
        scope: body.scope,
        path: body.path,
        mode: detect.mode,
      });
      // Do NOT advance cursor on HTTP failure — retry on next event.
    }
  } catch (e) {
    clearTimeout(timer);
    log.warn('memory-observe-failed', {
      error: e?.message,
      timeout: e?.name === 'AbortError',
      scope: body.scope,
      path: body.path,
      mode: detect.mode,
    });
    // Do NOT advance cursor on network failure — retry on next event.
  }
}

// Run main() only when this file is the direct entrypoint (not on import).
const isDirect = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isDirect) {
  try {
    await main();
  } catch (e) {
    try { log.error('unexpected', { error: e?.message, stack: e?.stack }); } catch {}
  }
  process.exit(0);
}
