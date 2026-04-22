#!/usr/bin/env node
/**
 * Prismer Claude Code Plugin — CLI entry point
 *
 * Usage:
 *   npx @prismer/claude-code-plugin setup    # Install hooks + MCP + API key
 *   npx @prismer/claude-code-plugin status   # Check installation state
 *   npx @prismer/claude-code-plugin --help   # Show help
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  chmodSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { fork } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CLAUDE_DIR   = join(homedir(), '.claude');
const PRISMER_DIR  = join(homedir(), '.prismer');
const CONFIG_FILE  = join(PRISMER_DIR, 'config.toml');
const HOOKS_FILE   = join(CLAUDE_DIR, 'hooks.json');
const MCP_FILE     = join(CLAUDE_DIR, 'mcp_servers.json');

const TEMPLATE_DIR   = join(__dirname, '..', 'templates');
const HOOKS_TEMPLATE = join(TEMPLATE_DIR, 'hooks.json');
const MCP_TEMPLATE   = join(TEMPLATE_DIR, 'mcp_servers.json');
const SETUP_MJS      = join(__dirname, 'setup.mjs');

// ── Helpers ────────────────────────────────────────────────────────────────

function log(msg)  { console.log(`[prismer] ${msg}`); }
function ok(msg)   { console.log(`[prismer] ✓ ${msg}`); }
function warn(msg) { console.log(`[prismer] ! ${msg}`); }
function err(msg)  { console.error(`[prismer] ✗ ${msg}`); }

function timestamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
}

// Substrings that identify a Prismer-owned hook entry. Over-matching is safe
// (we re-inject our own hooks anyway); under-matching would double-register.
const PRISMER_HOOK_MARKERS = [
  '@prismer/claude-code-plugin',
  'prismer/claude-code-plugin',
  '${CLAUDE_PLUGIN_ROOT}',
  'session-start.mjs',
  'session-stop.mjs',
  'session-end.mjs',
  'subagent-start.mjs',
  'pre-bash-suggest.mjs',
  'pre-web-cache.mjs',
  'post-bash-journal.mjs',
  'post-tool-failure.mjs',
  'post-web-save.mjs',
  'para-emit.mjs',
];

/** Return true if any hook entry in the rule looks like a Prismer-owned hook. */
export function isPrismerHookRule(rule) {
  if (!rule || !Array.isArray(rule.hooks)) return false;
  return rule.hooks.some((h) => {
    const cmd = typeof h?.command === 'string' ? h.command : '';
    return PRISMER_HOOK_MARKERS.some((m) => cmd.includes(m));
  });
}

/**
 * Cap old timestamped backups at `keep` most recent. Uses filename sort (our
 * timestamps are YYYYMMDDHHMMSS, lexicographic-sortable).
 */
function pruneBackups(filePath, keep = 3) {
  try {
    const dir = dirname(filePath);
    const base = basename(filePath);
    const prefix = `${base}.backup.`;
    const entries = readdirSync(dir)
      .filter((n) => n.startsWith(prefix))
      .sort(); // ascending: oldest first
    const toDelete = entries.slice(0, Math.max(0, entries.length - keep));
    for (const name of toDelete) {
      try { unlinkSync(join(dir, name)); } catch {}
    }
  } catch {}
}

/**
 * Deep-merge template hooks.json into an existing ~/.claude/hooks.json so we
 * don't destroy hooks registered by other plugins (gstack, superpowers, etc.).
 *
 * Behavior:
 *   - If existing file is missing → copy template as-is.
 *   - If existing file is valid JSON → for each event in template.hooks,
 *     strip prior Prismer rules (detected via PRISMER_HOOK_MARKERS), then
 *     append the template rules. Other events/rules are preserved verbatim.
 *   - If existing file is NOT valid JSON → timestamped backup, then write
 *     template as-is.
 *   - Timestamped backups are capped to 3 most recent.
 *
 * @param {string} existingPath  Absolute path to hooks.json (may not exist)
 * @param {string} templatePath  Absolute path to template hooks.json
 * @returns {'copied'|'merged'|'backup-and-replaced'}
 */
export function mergeHooksFile(existingPath, templatePath) {
  const templateRaw = readFileSync(templatePath, 'utf-8');
  const template = JSON.parse(templateRaw);

  // Case 1: nothing there — copy template
  if (!existsSync(existingPath)) {
    writeFileSync(existingPath, templateRaw);
    return 'copied';
  }

  // Try to parse existing
  let existing;
  try {
    existing = JSON.parse(readFileSync(existingPath, 'utf-8'));
  } catch {
    // Case 3: corrupt JSON — backup and replace
    const backup = `${existingPath}.backup.${timestamp()}`;
    warn(`Existing hooks.json is not valid JSON — backing up to ${backup}`);
    copyFileSync(existingPath, backup);
    pruneBackups(existingPath, 3);
    writeFileSync(existingPath, templateRaw);
    return 'backup-and-replaced';
  }

  // Case 2: valid JSON — deep merge per event
  if (!existing.hooks || typeof existing.hooks !== 'object') {
    existing.hooks = {};
  }

  const templateEvents = template.hooks ?? {};
  for (const event of Object.keys(templateEvents)) {
    const templateRules = Array.isArray(templateEvents[event]) ? templateEvents[event] : [];
    const existingRules = Array.isArray(existing.hooks[event]) ? existing.hooks[event] : [];
    // Strip any prior Prismer entries so re-running setup doesn't duplicate.
    const preserved = existingRules.filter((r) => !isPrismerHookRule(r));
    existing.hooks[event] = preserved.concat(templateRules);
  }

  writeFileSync(existingPath, JSON.stringify(existing, null, 2) + '\n');
  return 'merged';
}

function readExistingKey() {
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    const m = raw.match(/^api_key\s*=\s*['"]([^'"]+)['"]/m);
    return m?.[1] || '';
  } catch { return ''; }
}

// ── setup subcommand ───────────────────────────────────────────────────────

async function runSetup(args) {
  const force = args.includes('--force');

  log('Starting Prismer plugin setup...');

  // 1. Ensure directories
  mkdirSync(CLAUDE_DIR,  { recursive: true });
  mkdirSync(PRISMER_DIR, { recursive: true });

  // 2. Install hooks.json (deep-merge to preserve other plugins' hooks)
  const hooksAction = mergeHooksFile(HOOKS_FILE, HOOKS_TEMPLATE);
  if (hooksAction === 'copied') {
    ok(`hooks.json installed at ${HOOKS_FILE}`);
  } else if (hooksAction === 'merged') {
    ok(`hooks.json merged at ${HOOKS_FILE} (preserved other plugins' hooks)`);
  } else {
    ok(`hooks.json replaced at ${HOOKS_FILE} (prior file was invalid JSON)`);
  }

  // 3. Merge mcp_servers.json (pure JS, no Python dependency)
  let mcpConfig = {};
  if (existsSync(MCP_FILE)) {
    const backup = `${MCP_FILE}.backup.${timestamp()}`;
    warn(`Existing mcp_servers.json found — backing up to ${backup}`);
    copyFileSync(MCP_FILE, backup);
    try {
      mcpConfig = JSON.parse(readFileSync(MCP_FILE, 'utf-8'));
    } catch {
      warn('Could not parse existing mcp_servers.json — overwriting');
    }
  }

  const prismerTemplate = JSON.parse(readFileSync(MCP_TEMPLATE, 'utf-8'));
  // Deep merge: preserve user's existing env vars in prismer entry
  if (mcpConfig.prismer?.env && prismerTemplate.prismer?.env) {
    prismerTemplate.prismer.env = { ...mcpConfig.prismer.env, ...prismerTemplate.prismer.env };
  }
  Object.assign(mcpConfig, prismerTemplate);
  writeFileSync(MCP_FILE, JSON.stringify(mcpConfig, null, 2) + '\n');
  chmodMcp(MCP_FILE);
  ok(`mcp_servers.json configured at ${MCP_FILE}`);

  // 4. Check for existing API key
  const existingKey = readExistingKey();
  const hasKey = existingKey.startsWith('sk-prismer-');

  if (hasKey && !force) {
    ok(`API key already configured: ${existingKey.slice(0, 12)}...${existingKey.slice(-4)}`);
    injectKeyIntoMcp(existingKey);
    printSuccess();
    return;
  }

  if (force && hasKey) {
    warn('--force: re-running browser auth to replace existing key');
  }

  // 5. Fork setup.mjs to do browser auth (it writes config.toml)
  log('Launching browser auth to obtain API key...');
  const apiKey = await runBrowserAuth(force);

  if (apiKey) {
    injectKeyIntoMcp(apiKey);
    ok('API key injected into mcp_servers.json');
  } else {
    warn('API key not obtained. Manually set PRISMER_API_KEY in ~/.claude/mcp_servers.json');
  }

  printSuccess();
}

function injectKeyIntoMcp(apiKey) {
  try {
    const raw = readFileSync(MCP_FILE, 'utf-8');
    const config = JSON.parse(raw);
    if (config.prismer?.env) {
      config.prismer.env.PRISMER_API_KEY = apiKey;
      writeFileSync(MCP_FILE, JSON.stringify(config, null, 2) + '\n');
      chmodMcp(MCP_FILE);
    }
  } catch (e) {
    warn(`Could not inject key into mcp_servers.json: ${e.message}`);
  }
}

/**
 * chmod 600 on mcp_servers.json — it contains the API key and should not be
 * world-readable on shared POSIX systems. Silently skip on non-POSIX (Windows).
 */
function chmodMcp(filePath) {
  try {
    chmodSync(filePath, 0o600);
  } catch (e) {
    warn(`Could not chmod 600 ${filePath}: ${e.message} (non-POSIX filesystem?)`);
  }
}

function runBrowserAuth(force) {
  return new Promise((resolve) => {
    const setupArgs = force ? ['--force'] : [];
    const child = fork(SETUP_MJS, setupArgs, { stdio: 'inherit' });

    child.on('exit', (code) => {
      if (code === 0) {
        // setup.mjs wrote config.toml — read the key from there
        const key = readExistingKey();
        resolve(key.startsWith('sk-prismer-') ? key : null);
      } else {
        warn(`setup.mjs exited with code ${code}`);
        resolve(null);
      }
    });

    child.on('error', (e) => {
      err(`Failed to launch setup.mjs: ${e.message}`);
      resolve(null);
    });
  });
}

function printSuccess() {
  console.log('');
  ok('Setup complete! Next steps:');
  console.log('');
  console.log('  1. Restart Claude Code to pick up the new configuration');
  console.log('');
  console.log('  2. (Optional) Add evolution guidance to your project CLAUDE.md:');
  console.log(`     cat ${join(TEMPLATE_DIR, 'CLAUDE.md.template')} >> your-project/CLAUDE.md`);
  console.log('');
  console.log('  Learn more: https://prismer.cloud/docs/claude-code-plugin');
  console.log('');
}

// ── status subcommand ──────────────────────────────────────────────────────

function runStatus() {
  console.log('');
  console.log('Prismer Claude Code Plugin — Status');
  console.log('────────────────────────────────────');

  // hooks.json
  if (existsSync(HOOKS_FILE)) {
    ok(`hooks.json          ${HOOKS_FILE}`);
  } else {
    err(`hooks.json          NOT FOUND (${HOOKS_FILE})`);
  }

  // mcp_servers.json + prismer entry
  let mcpHasPrismer = false;
  if (existsSync(MCP_FILE)) {
    try {
      const config = JSON.parse(readFileSync(MCP_FILE, 'utf-8'));
      mcpHasPrismer = !!config.prismer;
    } catch {}
    if (mcpHasPrismer) {
      ok(`mcp_servers.json    ${MCP_FILE} (prismer entry present)`);
    } else {
      warn(`mcp_servers.json    ${MCP_FILE} (prismer entry MISSING)`);
    }
  } else {
    err(`mcp_servers.json    NOT FOUND (${MCP_FILE})`);
  }

  // API key in mcp_servers.json
  let mcpKeySet = false;
  if (mcpHasPrismer && existsSync(MCP_FILE)) {
    try {
      const config = JSON.parse(readFileSync(MCP_FILE, 'utf-8'));
      const key = config.prismer?.env?.PRISMER_API_KEY || '';
      mcpKeySet = key.startsWith('sk-prismer-') && key !== 'sk-prismer-...';
      if (mcpKeySet) {
        ok(`MCP API key         ${key.slice(0, 12)}...${key.slice(-4)}`);
      } else {
        warn('MCP API key         NOT SET (placeholder value)');
      }
    } catch {}
  }

  // config.toml API key
  const key = readExistingKey();
  if (key.startsWith('sk-prismer-')) {
    ok(`config.toml key     ${key.slice(0, 12)}...${key.slice(-4)} (${CONFIG_FILE})`);
  } else {
    warn(`config.toml key     NOT FOUND (${CONFIG_FILE})`);
  }

  console.log('');

  const allGood = existsSync(HOOKS_FILE) && mcpHasPrismer && mcpKeySet;
  if (allGood) {
    ok('All checks passed. Plugin is ready.');
  } else {
    warn('Setup incomplete. Run: npx @prismer/claude-code-plugin setup');
  }
  console.log('');
}

// ── doctor subcommand ───────────────────────────────────────────────────────

export async function runDoctor() {
  console.log('');
  console.log('Prismer Claude Code Plugin — Diagnostic Report');
  console.log('───────────────────────────────────────────────');
  console.log('');

  const checks = {
    version: { name: 'Plugin Version Match', status: 'unknown', details: '' },
    apiKey: { name: 'API Key Validity', status: 'unknown', details: '' },
    hooks: { name: 'Hooks Registration', status: 'unknown', details: '' },
    cache: { name: 'Cache Directory', status: 'unknown', details: '' },
    mcp: { name: 'MCP Server Config', status: 'unknown', details: '' },
    pluginRoot: { name: 'Plugin Root Path', status: 'unknown', details: '' },
  };

  // 1. Version check: package.json vs installed_plugins.json
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const pluginVersion = pkg.version;

    const registryPath = join(CLAUDE_DIR, 'plugins', 'installed_plugins.json');
    let registryVersion = null;

    if (existsSync(registryPath)) {
      try {
        const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
        // Registry shape varies across CC versions
        const candidates = [];
        if (Array.isArray(registry?.plugins)) candidates.push(...registry.plugins);
        if (registry && typeof registry === 'object') {
          for (const v of Object.values(registry)) {
            if (Array.isArray(v)) candidates.push(...v);
            else if (v && typeof v === 'object') candidates.push(v);
          }
        }
        const entry = candidates.find((p) => {
          if (!p || typeof p !== 'object') return false;
          const name = p.name || p.id || p.plugin || '';
          return /prismer/.test(String(name));
        });

        if (entry) {
          registryVersion = entry.version || entry.installedVersion;
        }
      } catch {
        // Registry parse failed
      }
    }

    if (registryVersion) {
      if (registryVersion === pluginVersion) {
        checks.version.status = 'pass';
        checks.version.details = `v${pluginVersion} (matched)`;
      } else {
        checks.version.status = 'warn';
        checks.version.details = `Running v${pluginVersion}, registry v${registryVersion} (stale)`;
      }
    } else {
      checks.version.status = 'warn';
      checks.version.details = `v${pluginVersion} (no registry entry)`;
    }
  } catch (e) {
    checks.version.status = 'fail';
    checks.version.details = `Error: ${e.message}`;
  }

  // 2. API key validity (HTTP ping)
  try {
    const key = readExistingKey();
    if (!key.startsWith('sk-prismer-')) {
      checks.apiKey.status = 'fail';
      checks.apiKey.details = 'No valid API key in config.toml';
    } else {
      const baseUrl = process.env.PRISMER_BASE_URL || 'https://prismer.cloud';
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`${baseUrl}/api/health`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (res.ok) {
          checks.apiKey.status = 'pass';
          checks.apiKey.details = `${key.slice(0, 12)}...${key.slice(-4)} (reachable)`;
        } else {
          checks.apiKey.status = 'fail';
          checks.apiKey.details = `${key.slice(0, 12)}...${key.slice(-4)} (HTTP ${res.status})`;
        }
      } catch (netErr) {
        checks.apiKey.status = 'warn';
        checks.apiKey.details = `${key.slice(0, 12)}...${key.slice(-4)} (network error: ${netErr.message})`;
      }
    }
  } catch (e) {
    checks.apiKey.status = 'fail';
    checks.apiKey.details = `Error: ${e.message}`;
  }

  // 3. Hooks registration
  try {
    if (!existsSync(HOOKS_FILE)) {
      checks.hooks.status = 'fail';
      checks.hooks.details = 'hooks.json not found';
    } else {
      try {
        const config = JSON.parse(readFileSync(HOOKS_FILE, 'utf-8'));
        const hooks = config.hooks || config;
        const events = Object.keys(hooks);
        const prismerEvents = events.filter((e) => {
          const rules = Array.isArray(hooks[e]) ? hooks[e] : [];
          return rules.some(isPrismerHookRule);
        });

        if (prismerEvents.length > 0) {
          checks.hooks.status = 'pass';
          checks.hooks.details = `${prismerEvents.length} events registered (${prismerEvents.slice(0, 3).join(', ')}${prismerEvents.length > 3 ? '...' : ''})`;
        } else {
          checks.hooks.status = 'fail';
          checks.hooks.details = 'No Prismer hooks registered';
        }
      } catch {
        checks.hooks.status = 'fail';
        checks.hooks.details = 'hooks.json is invalid JSON';
      }
    }
  } catch (e) {
    checks.hooks.status = 'fail';
    checks.hooks.details = `Error: ${e.message}`;
  }

  // 4. Cache directory
  try {
    const cacheDir = process.env.CLAUDE_PLUGIN_DATA || join(__dirname, '..', '.cache');
    if (existsSync(cacheDir)) {
      // Try to read/write a test file
      const testFile = join(cacheDir, `.doctor-test-${Date.now()}`);
      try {
        writeFileSync(testFile, 'test');
        const content = readFileSync(testFile, 'utf-8');
        if (content === 'test') {
          checks.cache.status = 'pass';
          checks.cache.details = `${cacheDir} (readable + writable)`;
        } else {
          checks.cache.status = 'fail';
          checks.cache.details = `${cacheDir} (write/read mismatch)`;
        }
        try { unlinkSync(testFile); } catch {}
      } catch (fsErr) {
        checks.cache.status = 'fail';
        checks.cache.details = `${cacheDir} (not writable: ${fsErr.message})`;
      }
    } else {
      checks.cache.status = 'warn';
      checks.cache.details = `${cacheDir} (not found, will be created on first use)`;
    }
  } catch (e) {
    checks.cache.status = 'fail';
    checks.cache.details = `Error: ${e.message}`;
  }

  // 5. MCP server config
  try {
    if (!existsSync(MCP_FILE)) {
      checks.mcp.status = 'fail';
      checks.mcp.details = 'mcp_servers.json not found';
    } else {
      try {
        const config = JSON.parse(readFileSync(MCP_FILE, 'utf-8'));
        const prismerConfig = config.prismer;

        if (!prismerConfig) {
          checks.mcp.status = 'fail';
          checks.mcp.details = 'No prismer entry in mcp_servers.json';
        } else {
          const hasCmd = typeof prismerConfig.command === 'string' && prismerConfig.command;
          const hasEnv = typeof prismerConfig.env === 'object' && prismerConfig.env;
          const hasKey = hasEnv && typeof prismerConfig.env.PRISMER_API_KEY === 'string' &&
                         prismerConfig.env.PRISMER_API_KEY.startsWith('sk-prismer-') &&
                         prismerConfig.env.PRISMER_API_KEY !== 'sk-prismer-...';

          if (hasCmd && hasEnv && hasKey) {
            checks.mcp.status = 'pass';
            checks.mcp.details = `Command: ${prismerConfig.command.split('/').pop()} + API key set`;
          } else {
            const issues = [];
            if (!hasCmd) issues.push('missing command');
            if (!hasEnv) issues.push('missing env');
            if (!hasKey) issues.push('missing/invalid API key');
            checks.mcp.status = 'warn';
            checks.mcp.details = `Incomplete config: ${issues.join(', ')}`;
          }
        }
      } catch {
        checks.mcp.status = 'fail';
        checks.mcp.details = 'mcp_servers.json is invalid JSON';
      }
    }
  } catch (e) {
    checks.mcp.status = 'fail';
    checks.mcp.details = `Error: ${e.message}`;
  }

  // 6. CLAUDE_PLUGIN_ROOT sanity check
  try {
    const pluginRoot = join(__dirname, '..');
    const pkgPath = join(pluginRoot, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === '@prismer/claude-code-plugin') {
          checks.pluginRoot.status = 'pass';
          checks.pluginRoot.details = pluginRoot;
        } else {
          checks.pluginRoot.status = 'warn';
          checks.pluginRoot.details = `${pluginRoot} (package.name is "${pkg.name}", not "@prismer/claude-code-plugin")`;
        }
      } catch {
        checks.pluginRoot.status = 'fail';
        checks.pluginRoot.details = `${pluginRoot} (package.json invalid)`;
      }
    } else {
      checks.pluginRoot.status = 'fail';
      checks.pluginRoot.details = `${pluginRoot} (package.json not found)`;
    }
  } catch (e) {
    checks.pluginRoot.status = 'fail';
    checks.pluginRoot.details = `Error: ${e.message}`;
  }

  // Print report
  for (const [key, check] of Object.entries(checks)) {
    const icon = check.status === 'pass' ? '✅' : check.status === 'warn' ? '⚠️' : '❌';
    console.log(`${icon} ${check.name}`);
    console.log(`   ${check.details}`);
    console.log('');
  }

  // Summary
  const passCount = Object.values(checks).filter(c => c.status === 'pass').length;
  const warnCount = Object.values(checks).filter(c => c.status === 'warn').length;
  const failCount = Object.values(checks).filter(c => c.status === 'fail').length;

  console.log('───────────────────────────────────────────────');
  console.log(`Summary: ${passCount} passed, ${warnCount} warnings, ${failCount} failed`);

  if (failCount === 0 && warnCount === 0) {
    ok('All checks passed. Plugin is healthy.');
  } else if (failCount === 0) {
    warn('Plugin is functional but has warnings. Review above.');
  } else {
    err('Plugin has issues. Run: npx @prismer/claude-code-plugin setup');
  }
  console.log('');
}

// ── help ───────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
Prismer Claude Code Plugin — CLI

Usage:
  npx @prismer/claude-code-plugin <command> [options]

Commands:
  setup     Install hooks.json + MCP config + API key (browser auth)
  status    Check installation state
  doctor    Run diagnostic checks (version, API key, hooks, cache, MCP, paths)
  --help    Show this help message

Options for setup:
  --force   Re-run browser auth even if API key already exists

Examples:
  npx @prismer/claude-code-plugin setup
  npx @prismer/claude-code-plugin setup --force
  npx @prismer/claude-code-plugin status
  npx @prismer/claude-code-plugin doctor
`);
}

// ── Entry ──────────────────────────────────────────────────────────────────

const [,, cmd, ...rest] = process.argv;

if (!cmd || cmd === '--help' || cmd === '-h') {
  printHelp();
} else if (cmd === 'setup') {
  runSetup(rest).catch((e) => {
    err(`Setup failed: ${e.message}`);
    process.exit(1);
  });
} else if (cmd === 'status') {
  runStatus();
} else if (cmd === 'doctor') {
  runDoctor().catch((e) => {
    err(`Doctor failed: ${e.message}`);
    process.exit(1);
  });
} else {
  err(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}
