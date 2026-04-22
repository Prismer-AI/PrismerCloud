// T13 — Hook config management: merge, upgrade, rollback, idempotency.
// Ported from scripts/PARA/exp-13-hooks-migration.ts (6 scenarios all pass).

import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// Types
// ============================================================

export type HookFormat = 'v1.8' | 'v1.9';

export interface HookEntry {
  command?: string;
  webhook?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface HookConfig {
  hooks: Record<string, HookEntry | HookEntry[]>;
  [key: string]: unknown;
}

export interface MergeResult {
  merged: HookConfig;
  added: string[];
  preserved: string[];
  replaced: string[];
  backupPath?: string;
}

export interface MergeOptions {
  daemonUrl: string;
  dryRun?: boolean;
  /** Absolute path to the installed claude-code-plugin root (contains hooks/para-emit.mjs). */
  pluginRoot?: string;
}

// ============================================================
// EXP-13 constants (updated from exp-13 → PARA hooks.para.json)
// ============================================================

/** Marker present in all v1.8 Prismer-owned hook commands. */
const LEGACY_HOOK_MARKER = 'evolution-hook.js';

/** Known legacy session-start script path (also Prismer-owned in v1.8). */
const LEGACY_SESSION_START_MARKER = 'session-start.mjs';

/** Marker present in v1.9 PARA hooks (para-emit.mjs or para-adapter.js). */
const PARA_EMIT_MARKER = 'para-emit';

/** Legacy marker — kept for backward compat detection of early v1.9 installs. */
const PARA_ADAPTER_MARKER = '/opt/prismer/runtime/para-adapter.js';

/**
 * Full set of v1.9 PARA hook events to inject into Claude Code hooks.json.
 *
 * Uses the Claude Code nested format:
 *   { matcher: ".*", hooks: [{ type: "command", command: "..." }] }
 *
 * The command uses a template variable `{{PLUGIN_ROOT}}` which is replaced
 * by `installHooks()` with the resolved plugin root path.
 *
 * Event list sourced from hooks.para.json (25 events).
 */
const PARA_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'TeammateIdle',
  'Stop',
  'StopFailure',
  'Notification',
  'InstructionsLoaded',
  'ConfigChange',
  'CwdChanged',
  'FileChanged',
  'WorktreeCreate',
  'WorktreeRemove',
  'PreCompact',
  'PostCompact',
  'Elicitation',
  'ElicitationResult',
] as const;

/**
 * Build the PARA_HOOKS record with a resolved plugin root path.
 *
 * Each event maps to a single HookEntry in Claude Code nested format:
 *   { matcher: ".*", hooks: [{ type: "command", command: "node \"<root>/hooks/para-emit.mjs\" <Event>" }] }
 */
function buildParaHooks(pluginRoot: string): Record<string, HookEntry[]> {
  const hooks: Record<string, HookEntry[]> = {};
  for (const event of PARA_HOOK_EVENTS) {
    hooks[event] = [
      {
        matcher: '.*',
        hooks: [
          {
            type: 'command',
            command: `node "${pluginRoot}/hooks/para-emit.mjs" ${event}`,
          },
        ],
      } as unknown as HookEntry,
    ];
  }
  return hooks;
}

/**
 * Resolve the plugin root for @prismer/claude-code-plugin.
 *
 * Resolution order:
 *   1. PRISMER_PLUGIN_ROOT env var (explicit override)
 *   2. Sibling directory (runtime ships alongside claude-code-plugin under sdk/)
 *   3. Global npm prefix: $(npm prefix -g)/lib/node_modules/@prismer/claude-code-plugin
 *   4. Fallback: /opt/prismer/runtime (daemon install path)
 *
 * Callers can override with opts.pluginRoot in MergeOptions.
 */
export function resolvePluginRoot(): string {
  // 1. Env override
  if (process.env['PRISMER_PLUGIN_ROOT']) {
    return process.env['PRISMER_PLUGIN_ROOT'];
  }

  // 2. Relative to this package (runtime ships alongside claude-code-plugin under sdk/)
  //    Compiled output: .../runtime/dist/agents/hooks.js → walk up to sdk/prismer-cloud/claude-code-plugin
  //    Source:          .../runtime/src/agents/hooks.ts  → same relative walk
  const siblingPath = path.resolve(__dirname, '..', '..', '..', 'claude-code-plugin');
  if (fs.existsSync(path.join(siblingPath, 'hooks', 'para-emit.mjs'))) {
    return siblingPath;
  }

  // 3. Global npm install
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf-8' }).trim();
    const globalPath = path.join(prefix, 'lib', 'node_modules', '@prismer', 'claude-code-plugin');
    if (fs.existsSync(path.join(globalPath, 'hooks', 'para-emit.mjs'))) {
      return globalPath;
    }
  } catch {
    // npm not available or failed — continue
  }

  // 4. Fallback
  return '/opt/prismer/runtime';
}

// ============================================================
// Classification helpers
// ============================================================

/**
 * Extract all command strings from an entry, handling both flat and nested CC formats.
 * Flat:   { command: '...' }
 * Nested: { matcher: '...', hooks: [{ type: 'command', command: '...' }] }
 */
function extractCommands(entry: HookEntry): string[] {
  const cmds: string[] = [];
  if (typeof entry.command === 'string') {
    cmds.push(entry.command);
  }
  if (typeof entry.webhook === 'string') {
    cmds.push(entry.webhook);
  }
  // CC nested format: entry.hooks is an array of sub-entries with their own command fields
  const nested = entry['hooks'];
  if (Array.isArray(nested)) {
    for (const sub of nested) {
      if (sub !== null && typeof sub === 'object') {
        const subCmd = (sub as { command?: unknown })['command'];
        if (typeof subCmd === 'string') {
          cmds.push(subCmd);
        }
      }
    }
  }
  return cmds;
}

/** Returns true if the HookEntry is a v1.8 Prismer-owned hook. */
function isLegacyPrismerEntry(entry: HookEntry): boolean {
  const cmds = extractCommands(entry);
  return cmds.some(
    (c) => c.includes(LEGACY_HOOK_MARKER) || c.includes(LEGACY_SESSION_START_MARKER),
  );
}

/** Returns true if the HookEntry is a v1.9 PARA hook (para-emit.mjs or legacy para-adapter.js). */
function isParaEntry(entry: HookEntry): boolean {
  const cmds = extractCommands(entry);
  return cmds.some((c) => c.includes(PARA_EMIT_MARKER) || c.includes(PARA_ADAPTER_MARKER));
}

// ============================================================
// Normalisation helpers
// ============================================================

/**
 * Normalise a hook event value to an array of HookEntry.
 * The stored format is `HookEntry | HookEntry[]` — callers get the array form.
 */
function toEntries(value: HookEntry | HookEntry[]): HookEntry[] {
  return Array.isArray(value) ? value : [value];
}

// ============================================================
// mergeHooks — core idempotent merge function
// ============================================================

export function mergeHooks(existing: HookConfig | null, opts: MergeOptions): MergeResult {
  // Resolve the plugin root for building PARA hook commands
  const pluginRoot = opts.pluginRoot ?? resolvePluginRoot();
  const paraHooks = buildParaHooks(pluginRoot);

  // We work in the flat HookEntry[] format internally.
  const existingHooks: Record<string, HookEntry[]> = {};

  if (existing?.hooks) {
    for (const [event, val] of Object.entries(existing.hooks)) {
      existingHooks[event] = toEntries(val as HookEntry | HookEntry[]);
    }
  }

  const added: string[] = [];
  const preserved: string[] = [];
  const replaced: string[] = [];

  const resultHooks: Record<string, HookEntry[]> = {};

  // Step 1: process existing entries
  for (const [event, entries] of Object.entries(existingHooks)) {
    resultHooks[event] = [];
    for (const entry of entries) {
      if (isLegacyPrismerEntry(entry)) {
        // Remove v1.8 Prismer hook — will be replaced by v1.9 PARA hook
        replaced.push(event);
      } else if (isParaEntry(entry)) {
        // Already a PARA hook — idempotency: keep it, don't re-add
        resultHooks[event].push(entry);
      } else {
        // User/third-party hook — preserve
        resultHooks[event].push(entry);
        preserved.push(event);
      }
    }
  }

  // Step 2: add PARA hooks (idempotent — skip if already present)
  for (const [event, paraEntries] of Object.entries(paraHooks)) {
    if (!resultHooks[event]) resultHooks[event] = [];
    const hasPara = resultHooks[event].some((e) => isParaEntry(e));
    if (!hasPara) {
      resultHooks[event].push(...paraEntries);
      added.push(event);
    }
  }

  // Step 3: clean up empty arrays
  for (const event of Object.keys(resultHooks)) {
    if (resultHooks[event].length === 0) {
      delete resultHooks[event];
    }
  }

  // Build the merged HookConfig, preserving any extra top-level keys
  const merged: HookConfig = {
    ...(existing ?? {}),
    hooks: resultHooks,
  };

  return { merged, added, preserved, replaced };
}

// ============================================================
// readHookConfig
// ============================================================

export async function readHookConfig(filePath: string): Promise<HookConfig | null> {
  if (!fs.existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (!obj['hooks'] || typeof obj['hooks'] !== 'object' || Array.isArray(obj['hooks'])) {
        // Missing or malformed hooks key — treat as empty
        return { hooks: {} };
      }
      return obj as unknown as HookConfig;
    }
    return { hooks: {} };
  } catch {
    // Malformed JSON — treat as empty
    return { hooks: {} };
  }
}

// ============================================================
// writeHookConfig
// ============================================================

export async function writeHookConfig(filePath: string, cfg: HookConfig): Promise<void> {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

// ============================================================
// installHooks — write merged config + create backup
// ============================================================

export async function installHooks(
  configPath: string,
  existing: HookConfig | null,
  opts: MergeOptions,
): Promise<MergeResult> {
  const result = mergeHooks(existing, opts);

  if (opts.dryRun) {
    return result;
  }

  // Backup existing file with monotonic timestamp
  let backupPath: string | undefined;
  if (existing !== null && fs.existsSync(configPath)) {
    backupPath = `${configPath}.prismer-bak-${Date.now()}`;
    fs.copyFileSync(configPath, backupPath);
    result.backupPath = backupPath;
  }

  await writeHookConfig(configPath, result.merged);

  return result;
}

// ============================================================
// rollbackHooks — restore from most recent backup
// ============================================================

export async function rollbackHooks(
  configPath: string,
): Promise<{ restored: boolean; fromBackup: string | null }> {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);

  let backupFiles: string[] = [];
  try {
    const entries = fs.readdirSync(dir);
    backupFiles = entries
      .filter((f) => f.startsWith(base + '.prismer-bak-'))
      .sort(); // lexicographic — monotonic timestamp makes this chronological
  } catch {
    return { restored: false, fromBackup: null };
  }

  if (backupFiles.length === 0) {
    return { restored: false, fromBackup: null };
  }

  // Most recent backup = last in sorted order
  const latestBackup = path.join(dir, backupFiles[backupFiles.length - 1]);

  try {
    fs.copyFileSync(latestBackup, configPath);
    fs.unlinkSync(latestBackup);
    return { restored: true, fromBackup: latestBackup };
  } catch {
    return { restored: false, fromBackup: latestBackup };
  }
}
