/**
 * hooks-merge.mjs — Pure helpers for merging PARA hooks into ~/.claude/hooks.json
 *
 * Ported from scripts/PARA/exp-13-hooks-migration.ts (verified logic).
 *
 * Exported functions:
 *   mergePara(existing, paraHooks)  — merge PARA entries, remove legacy Prismer entries
 *   removePara(existing)            — rollback: strip only PARA entries
 *   backupAndWrite(path, config)    — backup existing file then write new config
 *
 * Marker-based detection:
 *   PARA entries: contain PARA_HOOK_MARKER (para-emit.mjs)
 *   Legacy entries: contain LEGACY_HOOK_MARKER (evolution-hook.js or session-start.mjs etc.)
 *   User/third-party entries: neither marker → always preserved
 */

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';

// ─── Markers ─────────────────────────────────────────────────────────────────

/** Substring present in every PARA hook command. */
export const PARA_HOOK_MARKER = 'para-emit.mjs';

/**
 * Substrings that identify legacy Prismer Evolution hooks.
 * These are replaced by PARA hooks during migration.
 */
export const LEGACY_HOOK_MARKERS = [
  'evolution-hook.js',
  'session-start.mjs',
  'session-end.mjs',
  'session-stop.mjs',
  'pre-bash-suggest.mjs',
  'pre-web-cache.mjs',
  'post-bash-journal.mjs',
  'post-web-save.mjs',
  'post-tool-failure.mjs',
  'subagent-start.mjs',
];

// ─── Type helpers (JSDoc) ─────────────────────────────────────────────────────

/**
 * @typedef {{ type: 'command'; command: string; timeout?: number }} HookEntry
 * @typedef {{ matcher?: string; hooks: HookEntry[] }} HookRule
 * @typedef {Record<string, HookRule[]>} HooksConfig
 */

// ─── Predicate helpers ────────────────────────────────────────────────────────

/** Returns true if any command in the rule contains the PARA marker. */
function isParaRule(rule) {
  return rule.hooks.some((h) => h.command.includes(PARA_HOOK_MARKER));
}

/** Returns true if any command in the rule is a legacy Prismer Evolution hook. */
function isLegacyRule(rule) {
  const cmd = rule.hooks.map((h) => h.command).join('\n');
  return LEGACY_HOOK_MARKERS.some((m) => cmd.includes(m));
}

// ─── Core merge logic ────────────────────────────────────────────────────────

/**
 * Merge PARA hooks into an existing hooks config.
 *
 * Algorithm (mirrors EXP-13):
 *   1. Copy all existing entries, skipping legacy Prismer Evolution entries.
 *   2. Append PARA entries for each hook type, skipping if already present (idempotent).
 *   3. Remove empty arrays.
 *
 * @param {HooksConfig} existing  The current hooks.json contents (may be {})
 * @param {HooksConfig} paraHooks The PARA hooks to add (from hooks.para.json)
 * @returns {{ result: HooksConfig; actions: string[] }}
 */
export function mergePara(existing, paraHooks) {
  /** @type {HooksConfig} */
  const result = {};
  const actions = [];

  // Step 1: copy existing, stripping legacy Prismer entries
  for (const [event, rules] of Object.entries(existing)) {
    result[event] = [];
    for (const rule of rules) {
      if (isLegacyRule(rule)) {
        actions.push(`REMOVE legacy ${event} hook`);
      } else {
        result[event].push(rule);
        actions.push(`KEEP non-legacy ${event} hook`);
      }
    }
  }

  // Step 2: add PARA entries (idempotent)
  for (const [event, rules] of Object.entries(paraHooks)) {
    if (!result[event]) result[event] = [];
    const hasPara = result[event].some(isParaRule);
    if (!hasPara) {
      result[event].push(...rules);
      actions.push(`ADD PARA ${event} hook`);
    } else {
      actions.push(`SKIP PARA ${event} hook (already present)`);
    }
  }

  // Step 3: clean up empty arrays
  for (const event of Object.keys(result)) {
    if (result[event].length === 0) delete result[event];
  }

  return { result, actions };
}

/**
 * Rollback: remove only PARA entries. User/third-party hooks are preserved.
 * Events whose only entries were PARA are removed entirely.
 *
 * @param {HooksConfig} migrated  The hooks.json after mergePara() was applied
 * @returns {{ result: HooksConfig; actions: string[] }}
 */
export function removePara(migrated) {
  /** @type {HooksConfig} */
  const result = {};
  const actions = [];

  for (const [event, rules] of Object.entries(migrated)) {
    const kept = rules.filter((r) => !isParaRule(r));
    if (kept.length > 0) {
      result[event] = kept;
      actions.push(`KEEP ${kept.length} non-PARA ${event} hooks`);
    } else {
      actions.push(`REMOVE all ${event} hooks (all were PARA)`);
    }
  }

  return { result, actions };
}

// ─── File I/O helpers ────────────────────────────────────────────────────────

/**
 * Read hooks.json from disk. Returns {} if the file doesn't exist or is invalid.
 *
 * @param {string} filePath
 * @returns {HooksConfig}
 */
export function readHooksConfig(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    // Claude Code hooks.json may have a top-level "hooks" key
    return parsed.hooks ?? parsed;
  } catch {
    return {};
  }
}

/**
 * Back up the existing hooks.json (as hooks.json.bak), then atomically write
 * the new config.  Creates parent directories if needed.
 *
 * The written file always uses the `{ "hooks": { ... } }` wrapper format
 * that Claude Code expects.
 *
 * @param {string} filePath  Absolute path to hooks.json
 * @param {HooksConfig} config  The merged config to write
 * @returns {{ backupPath: string | null }}
 */
export function backupAndWrite(filePath, config) {
  mkdirSync(dirname(filePath), { recursive: true });

  let backupPath = null;
  if (existsSync(filePath)) {
    backupPath = filePath + '.bak';
    copyFileSync(filePath, backupPath);
  }

  // Atomic write: write temp then rename. Protects user's hooks.json from
  // corruption if the process is killed mid-write.
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify({ hooks: config }, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, filePath);
  return { backupPath };
}
