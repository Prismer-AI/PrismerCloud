// T16 — prismer migrate command: v1.8.x → v1.9.0 upgrade flow
// Per §15.2 cli-design mockup.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig } from '../config.js';
import { migrateSecrets } from './migrate-secrets.js';
import { AGENT_CATALOG } from '../agents/registry.js';
import { readHookConfig, mergeHooks, installHooks } from '../agents/hooks.js';
import { MemoryDB } from '../memory-db.js';
import type { WriteMemoryFileInput } from '../memory-db.js';
import type { CliContext } from '../cli/context.js';
import { promptConfirm } from '../cli/confirm.js';

// ============================================================
// Public types
// ============================================================

export interface MigrateOptions {
  dryRun?: boolean;
  configPath?: string;
  homeDir?: string;
  yes?: boolean;
  /**
   * Dependency-injection hook for tests — override the TTY confirmation prompt.
   * When provided, replaces the readline-based promptConfirm call entirely.
   */
  confirmer?: () => Promise<boolean>;
}

export interface MigrateResult {
  apiKeyMigrated: boolean;
  hooksBackedUp: string[];      // file paths backed up
  hooksRedirected: string[];    // agent names whose hooks were redirected to daemon
  memoryFilesImported: number;
  networkEndpointsRewritten: Array<{ file: string; rewrites: number; backupPath: string }>;
  errors: Array<{ step: string; error: string }>;
}

// ============================================================
// Internal helpers
// ============================================================

function defaultConfigPath(homeDir?: string): string {
  const base = homeDir ?? os.homedir();
  return path.join(base, '.prismer', 'config.toml');
}

function expandHome(p: string, homeDir?: string): string {
  if (p.startsWith('~')) {
    return (homeDir ?? os.homedir()) + p.slice(1);
  }
  return p;
}

function detectDevDb(homeDir?: string): { exists: boolean; sizeKb: number } {
  const base = homeDir ?? os.homedir();
  const dbPath = path.join(base, '.prismer', 'data', 'dev.db');
  if (!fs.existsSync(dbPath)) return { exists: false, sizeKb: 0 };
  try {
    const stat = fs.statSync(dbPath);
    return { exists: true, sizeKb: Math.round(stat.size / 1024) };
  } catch {
    return { exists: false, sizeKb: 0 };
  }
}

// Matches both camelCase (`apiKey`, legacy dev configs / vitest fixtures) and
// snake_case (`api_key`, what `prismer setup` actually writes today). Anchored
// to line start so it doesn't accidentally match inside a commented URL or a
// multiline string. Values starting with `$KEYRING:` are treated as safe refs
// and do NOT count as plaintext.
export function detectPlaintextApiKey(configText: string): boolean {
  const re = /^\s*(?:api_key|apiKey)\s*=\s*"([^"]*)"/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(configText)) !== null) {
    const val = m[1] ?? '';
    if (!val.startsWith('$KEYRING:')) return true;
  }
  return false;
}

function detectApiKeyInConfig(configPath: string): boolean {
  if (!fs.existsSync(configPath)) return false;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return detectPlaintextApiKey(raw);
  } catch {
    return false;
  }
}

/** Check if a hook config path has v1.8 Prismer command-style hooks. */
async function hasLegacyHooks(hookConfigPath: string): Promise<boolean> {
  if (!fs.existsSync(hookConfigPath)) return false;
  const cfg = await readHookConfig(hookConfigPath);
  if (!cfg) return false;
  const LEGACY_MARKER = 'evolution-hook.js';
  const SESSION_MARKER = 'session-start.mjs';
  for (const entries of Object.values(cfg.hooks)) {
    const arr = Array.isArray(entries) ? entries : [entries];
    for (const entry of arr) {
      const cmd = typeof entry.command === 'string' ? entry.command : '';
      if (cmd.includes(LEGACY_MARKER) || cmd.includes(SESSION_MARKER)) {
        return true;
      }
    }
  }
  return false;
}

// ============================================================
// Memory import helpers
// ============================================================

interface DiscoveredMemoryFile {
  /** Absolute path to the .md file on disk */
  absolutePath: string;
  /** Owner ID derived from the project directory name */
  ownerId: string;
  /** Relative path within the memory directory (used as MemoryDB path) */
  relativePath: string;
}

/** Parse simple YAML frontmatter (between --- delimiters) from a markdown file. */
function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return result;

  const block = match[1];
  for (const line of block.split('\n')) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
    if (kv) {
      result[kv[1].trim()] = kv[2].trim();
    }
  }
  return result;
}

/**
 * Derive an owner ID from the Claude Code project directory name.
 * Example: `/Users/alice/.claude/projects/-Users-alice-workspace-myproject/memory/`
 *          => ownerId = `-Users-alice-workspace-myproject`
 */
function ownerIdFromProjectDir(projectDir: string): string {
  return path.basename(projectDir);
}

/**
 * Scan ~/.claude/projects/{name}/memory/ directories for .md files.
 * Each discovered file becomes a candidate for import into MemoryDB.
 */
function scanClaudeProjectMemory(homeDir?: string): DiscoveredMemoryFile[] {
  const base = homeDir ?? os.homedir();
  const projectsDir = path.join(base, '.claude', 'projects');

  if (!fs.existsSync(projectsDir)) return [];

  const discovered: DiscoveredMemoryFile[] = [];

  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(projectsDir);
  } catch {
    return [];
  }

  for (const projectName of projectDirs) {
    const memoryDir = path.join(projectsDir, projectName, 'memory');
    if (!fs.existsSync(memoryDir)) continue;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(memoryDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    let entries: string[];
    try {
      entries = fs.readdirSync(memoryDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const absPath = path.join(memoryDir, entry);
      try {
        const entryStat = fs.statSync(absPath);
        if (!entryStat.isFile()) continue;
      } catch {
        continue;
      }

      discovered.push({
        absolutePath: absPath,
        ownerId: ownerIdFromProjectDir(projectName),
        relativePath: entry,
      });
    }
  }

  return discovered;
}

/**
 * Import discovered memory files into MemoryDB.
 * Returns the count of successfully imported files.
 */
function importMemoryFiles(
  files: DiscoveredMemoryFile[],
  memoryDb: MemoryDB,
  errors: Array<{ step: string; error: string }>,
): number {
  let imported = 0;

  for (const file of files) {
    try {
      const content = fs.readFileSync(file.absolutePath, 'utf-8');
      const fm = parseFrontmatter(content);

      const input: WriteMemoryFileInput = {
        ownerId: file.ownerId,
        ownerType: 'user',
        scope: 'global',
        path: file.relativePath,
        content,
        memoryType: fm['type'] ?? 'reference',
        description: fm['description'],
      };

      memoryDb.writeMemoryFile(input);
      imported++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({
        step: 'memory-import',
        error: file.absolutePath + ': ' + msg,
      });
    }
  }

  return imported;
}

// ============================================================
// Network endpoint takeover (§11.1 step 4)
// ============================================================

/**
 * Daemon loopback URL used when rewriting cloud endpoints.
 * All cloud HTTP/WS traffic is funneled through the local daemon; daemon
 * either proxies legitimate requests or short-circuits with 404 so legacy
 * plugin network calls stop talking to prismer.cloud behind the user's back.
 */
const DAEMON_HTTP_URL = 'http://localhost:3210';
const DAEMON_WS_URL = 'ws://localhost:3210';

/** Cloud HTTPS origins we always rewrite to the daemon. */
const CLOUD_HTTPS_ORIGINS = [
  'https://prismer.cloud',
  'https://cloud.prismer.dev',
  'https://prismer.app',
];

/** Cloud WebSocket origins we always rewrite to the daemon. */
const CLOUD_WSS_ORIGINS = [
  'wss://prismer.cloud',
  'wss://cloud.prismer.dev',
];

/**
 * Candidate files under homeDir that may embed cloud endpoints. Paths are
 * relative to homeDir (or os.homedir() when unset).
 */
const ENDPOINT_FILE_CANDIDATES = [
  '.claude/plugins/@prismer/claude-code-plugin/settings.json',
  '.claude/plugins/@prismer/claude-code-plugin/.env',
  '.claude/plugins/@prismer/claude-code-plugin/.mcp.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
];

/** Return existing candidate files from the ENDPOINT_FILE_CANDIDATES list. */
function scanEndpointCandidates(homeDir?: string): string[] {
  const base = homeDir ?? os.homedir();
  const found: string[] = [];
  for (const rel of ENDPOINT_FILE_CANDIDATES) {
    const abs = path.join(base, rel);
    if (fs.existsSync(abs)) {
      try {
        const stat = fs.statSync(abs);
        if (stat.isFile()) found.push(abs);
      } catch {
        /* ignore */
      }
    }
  }
  return found;
}

/**
 * Escape a string for safe embedding in a RegExp. Covers all regex
 * metacharacters; pure function, no external state.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Apply cloud→daemon substitutions to a text blob. The match is **anchored at
 * the origin boundary** — after the origin must follow either EOF or a legit
 * URL terminator (`/`, quote, whitespace, newline, comma, `)`, `}`, `]`,
 * backslash). This prevents false positives like
 *  - `https://prismer.app.example.com`
 *  - `https://prismer.cloud-mirror.example.com`
 * from being clobbered into daemon URLs.
 *
 * Returns `[newText, rewriteCount]`. When there are no hits, returns the
 * original string and 0.
 */
function rewriteCloudEndpoints(text: string): [string, number] {
  // Lookahead: any URL-origin terminator OR end-of-string. We deliberately do
  // NOT treat `-`, `.`, letter, or digit as a terminator, so subdomain-style
  // extensions (e.g. `prismer.app.example.com`) don't match.
  const TERMINATOR = '(?=[/"\\s\\\\,)}\\]]|$)';

  let out = text;
  let count = 0;

  for (const origin of CLOUD_HTTPS_ORIGINS) {
    const re = new RegExp(escapeRegex(origin) + TERMINATOR, 'g');
    const matches = out.match(re);
    if (matches && matches.length > 0) {
      out = out.replace(re, DAEMON_HTTP_URL);
      count += matches.length;
    }
  }
  for (const origin of CLOUD_WSS_ORIGINS) {
    const re = new RegExp(escapeRegex(origin) + TERMINATOR, 'g');
    const matches = out.match(re);
    if (matches && matches.length > 0) {
      out = out.replace(re, DAEMON_WS_URL);
      count += matches.length;
    }
  }
  return [out, count];
}

/**
 * Pick a backup path that doesn't collide. Tries `.bak`, `.bak2`, `.bak3`
 * in order. Returns null if all three slots are taken (caller should log
 * and skip rather than clobber).
 */
function pickBackupPath(targetPath: string): string | null {
  const candidates = [targetPath + '.bak', targetPath + '.bak2', targetPath + '.bak3'];
  for (const c of candidates) {
    if (!fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Walk candidate files, rewrite cloud endpoints, back up originals.
 * Mutates `result.networkEndpointsRewritten` and `result.errors`.
 * In dry-run mode, only reports candidates that would be rewritten (no disk writes).
 */
function takeOverNetworkEndpoints(
  homeDir: string | undefined,
  dryRun: boolean,
  result: MigrateResult,
): void {
  const candidates = scanEndpointCandidates(homeDir);

  for (const file of candidates) {
    let original: string;
    try {
      original = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ step: 'network-takeover', error: file + ': ' + msg });
      continue;
    }

    const [rewritten, count] = rewriteCloudEndpoints(original);
    if (count === 0) continue; // leave files alone when no cloud URLs present

    if (dryRun) {
      result.networkEndpointsRewritten.push({
        file,
        rewrites: count,
        backupPath: '', // no backup in dry-run
      });
      continue;
    }

    const backupPath = pickBackupPath(file);
    if (!backupPath) {
      result.errors.push({
        step: 'network-takeover',
        error: file + ': all backup slots (.bak/.bak2/.bak3) taken — skipping',
      });
      continue;
    }

    try {
      fs.writeFileSync(backupPath, original, 'utf-8');
      fs.writeFileSync(file, rewritten, 'utf-8');
      result.networkEndpointsRewritten.push({ file, rewrites: count, backupPath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ step: 'network-takeover', error: file + ': ' + msg });
    }
  }
}

// ============================================================
// migrateCommand
// ============================================================

export async function migrateCommand(
  ctx: CliContext,
  opts?: MigrateOptions,
): Promise<MigrateResult> {
  const dryRun = opts?.dryRun ?? false;
  const configPath = opts?.configPath ?? defaultConfigPath(opts?.homeDir);
  const homeDir = opts?.homeDir;
  const isJsonMode = ctx.ui.mode === 'json';

  const result: MigrateResult = {
    apiKeyMigrated: false,
    hooksBackedUp: [],
    hooksRedirected: [],
    memoryFilesImported: 0,
    networkEndpointsRewritten: [],
    errors: [],
  };

  // ---- 1. Detect existing installation ----

  const configExists = fs.existsSync(configPath);
  const hasPlaintextKey = configExists && detectApiKeyInConfig(configPath);

  // Detect Claude Code hooks (primary agent)
  const claudeEntry = AGENT_CATALOG.find((e) => e.name === 'claude-code');
  const claudeHookPath = claudeEntry
    ? expandHome(claudeEntry.hookConfigPath, homeDir)
    : path.join(os.homedir(), '.claude', 'hooks.json');
  const hooksExist = fs.existsSync(claudeHookPath);
  const hooksHaveLegacy = hooksExist ? await hasLegacyHooks(claudeHookPath) : false;

  const devDb = detectDevDb(homeDir);

  // Pre-scan for Claude project memory files
  const memoryFileCandidates = scanClaudeProjectMemory(homeDir);
  const hasMemoryFiles = memoryFileCandidates.length > 0;

  // Pre-scan for legacy plugin config files that may embed cloud endpoints
  const endpointCandidates = scanEndpointCandidates(homeDir);
  const hasEndpointCandidates = endpointCandidates.length > 0;

  if (!isJsonMode) {
    ctx.ui.line('Detected existing installation:');
    if (configExists) {
      ctx.ui.secondary(
        `${configPath}        (${hasPlaintextKey ? 'API key found' : 'no plaintext key'})`,
      );
    }
    if (hooksExist) {
      ctx.ui.secondary(
        `${claudeHookPath}          (${hooksHaveLegacy ? 'v1.8.x plugin hooks' : 'no legacy hooks'})`,
      );
    }
    if (devDb.exists) {
      ctx.ui.secondary(`~/.prismer/data/dev.db        (${devDb.sizeKb} KB)`);
    }
    if (hasMemoryFiles) {
      ctx.ui.secondary(`~/.claude/projects/           (${memoryFileCandidates.length} memory files)`);
    }
    if (hasEndpointCandidates) {
      ctx.ui.secondary(`plugin configs                (${endpointCandidates.length} candidate files)`);
    }
    ctx.ui.blank();

    if (!configExists && !hooksExist && !devDb.exists && !hasMemoryFiles && !hasEndpointCandidates) {
      ctx.ui.line('Nothing to migrate. Run `prismer setup` to configure a fresh installation.');
      return result;
    }

    ctx.ui.line('Migration plan:');
    ctx.ui.secondary('1. Move API key to system keychain     (reversible)');
    ctx.ui.secondary('2. Redirect hooks to daemon            (backup → hooks.json.bak)');
    ctx.ui.secondary('3. Import memory files to memory.db    (non-destructive)');
    ctx.ui.secondary('4. Redirect plugin network calls       (backup → *.bak)');
    ctx.ui.blank();
  }

  // ---- 2. Prompt (skip in non-TTY / --yes / dry-run) ----

  const isTTY = (process.stdin as NodeJS.ReadStream).isTTY === true;
  // --dry-run: read-only, nothing destructive → no confirmation needed.
  // --yes:     explicit machine/script opt-in → skip prompt.
  // neither:   require TTY confirmation; fail fast in non-TTY / JSON contexts.
  const skipPrompt = (opts?.yes === true) || (dryRun === true);

  if (!skipPrompt) {
    if (isJsonMode) {
      // Machine callers must pass --yes or --dry-run; cannot prompt in JSON mode.
      ctx.ui.json({ ok: false, error: 'CONFIRMATION_REQUIRED', message: 'Pass --yes or --dry-run for non-interactive use' });
      process.exitCode = 1;
      return result;
    }

    // opts.confirmer is used for test injection — it implies a simulated TTY context.
    const hasConfirmer = typeof opts?.confirmer === 'function';

    if (!isTTY && !hasConfirmer) {
      // Non-TTY without --yes and not dry-run → fail fast.
      ctx.ui.error(
        'Migration cancelled',
        'TTY confirmation required for destructive migration; pass --yes for non-interactive use, or --dry-run to preview',
        undefined,
      );
      process.exitCode = 1;
      return result;
    }

    // Interactive TTY (or injected confirmer): ask for confirmation.
    const confirm = opts?.confirmer ?? (() => promptConfirm('Proceed with migration? [y/N]: '));
    const confirmed = await confirm();
    if (!confirmed) {
      ctx.ui.secondary('Cancelled');
      return result;
    }
  }

  if (!isJsonMode && dryRun) {
    ctx.ui.secondary('(dry-run — no changes will be made)');
    ctx.ui.blank();
  }

  // ---- 3. Execute Step 1: API key → keychain ----

  if (configExists) {
    try {
      const msResult = await migrateSecrets({
        configPath,
        keychain: ctx.keychain,
        dryRun,
      });
      if (msResult.migrated.length > 0) {
        result.apiKeyMigrated = true;
      }
    } catch (err) {
      result.errors.push({ step: 'api-key-migration', error: String(err) });
    }
  }

  // ---- 4. Execute Step 2: hooks → daemon (all catalog agents) ----

  for (const agent of AGENT_CATALOG) {
    const hookPath = expandHome(agent.hookConfigPath, homeDir);
    if (!fs.existsSync(hookPath)) continue;

    const legacy = await hasLegacyHooks(hookPath);
    if (!legacy) continue;

    try {
      const existing = await readHookConfig(hookPath);

      if (dryRun) {
        // Dry-run: compute the merge result without writing
        const mergeResult = mergeHooks(existing, { daemonUrl: 'http://localhost:3210', dryRun: true });
        if (mergeResult.replaced.length > 0 || mergeResult.added.length > 0) {
          result.hooksRedirected.push(agent.name);
        }
      } else {
        const installResult = await installHooks(hookPath, existing, {
          daemonUrl: 'http://localhost:3210',
        });
        if (installResult.backupPath) {
          result.hooksBackedUp.push(installResult.backupPath);
        }
        if (installResult.replaced.length > 0 || installResult.added.length > 0) {
          result.hooksRedirected.push(agent.name);
        }
      }
    } catch (err) {
      result.errors.push({ step: `hooks-redirect-${agent.name}`, error: String(err) });
    }
  }

  // ---- 5. Step 3: memory import from ~/.claude/projects/{name}/memory/ ----
  // Uses memoryFileCandidates pre-scanned during detection (step 1).

  if (memoryFileCandidates.length === 0) {
    result.memoryFilesImported = 0;
  } else if (dryRun) {
    // Dry-run: report what would be imported without writing
    result.memoryFilesImported = memoryFileCandidates.length;
  } else {
    try {
      if (!isJsonMode) {
        ctx.ui.pending('Importing ' + memoryFileCandidates.length + ' memory files...');
      }
      const memoryDbPath = path.join(homeDir ?? os.homedir(), '.prismer', 'memory.db');
      const memoryDb = new MemoryDB({ enabled: false }, { filePath: memoryDbPath });
      try {
        result.memoryFilesImported = importMemoryFiles(
          memoryFileCandidates,
          memoryDb,
          result.errors,
        );
      } finally {
        memoryDb.close();
      }
    } catch (err: unknown) {
      result.memoryFilesImported = 0;
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({
        step: 'memory-import',
        error: 'Failed to import memory files: ' + msg,
      });
    }
  }

  // ---- 5b. Step 4: network endpoint takeover (§11.1) ----
  // Legacy plugin configs may still point at prismer.cloud / cloud.prismer.dev /
  // prismer.app. Redirect them to the daemon so all network traffic flows
  // through the local process. Backup originals as .bak (→ .bak2 / .bak3).

  takeOverNetworkEndpoints(homeDir, dryRun, result);

  // ---- 6. Output summary ----

  if (isJsonMode) {
    ctx.ui.json(result);
    return result;
  }

  ctx.ui.blank();

  if (result.apiKeyMigrated) {
    ctx.ui.ok('API key migrated to keychain', dryRun ? 'dry-run' : undefined);
  } else if (configExists && !hasPlaintextKey) {
    ctx.ui.ok('API key already in keychain', 'skipped');
  }

  if (result.hooksRedirected.length > 0) {
    ctx.ui.ok(
      'Hook config backed up and redirected',
      result.hooksRedirected.join(', '),
    );
  } else if (hooksExist && !hooksHaveLegacy) {
    ctx.ui.ok('Hooks already up to date', 'skipped');
  }

  if (result.memoryFilesImported > 0) {
    ctx.ui.ok(
      result.memoryFilesImported + ' memory files imported',
      dryRun ? 'dry-run' : undefined,
    );
  } else {
    ctx.ui.ok('No memory files found to import', 'skipped');
  }

  if (result.networkEndpointsRewritten.length > 0) {
    ctx.ui.ok(
      'Network endpoints redirected to daemon',
      result.networkEndpointsRewritten.length + (dryRun ? ' files (dry-run)' : ' files'),
    );
  } else {
    ctx.ui.ok('No cloud endpoints found to redirect', 'skipped');
  }

  // Surface network-takeover errors (e.g. exhausted backup slots) so users
  // aren't misled by the "redirected N files" summary above. Without this,
  // `.bak/.bak2/.bak3` collisions silently fall through to result.errors
  // and the pretty output never mentions them.
  const takeoverErrors = result.errors.filter((e) => e.step === 'network-takeover');
  if (takeoverErrors.length > 0) {
    ctx.ui.warn(
      takeoverErrors.length + ' file(s) skipped during network takeover',
      'remove old .bak/.bak2/.bak3 files and re-run migrate',
    );
    for (const err of takeoverErrors) {
      ctx.ui.secondary('- ' + err.error);
    }
  }

  if (dryRun) {
    ctx.ui.blank();
    ctx.ui.secondary('(dry-run — no changes were made)');
  }

  return result;
}
