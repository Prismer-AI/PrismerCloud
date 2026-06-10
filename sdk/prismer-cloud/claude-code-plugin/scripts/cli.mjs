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
} from 'fs';
import { join, dirname } from 'path';
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

  // 2. Install hooks.json (copy with backup)
  if (existsSync(HOOKS_FILE)) {
    const backup = `${HOOKS_FILE}.backup.${timestamp()}`;
    warn(`Existing hooks.json found — backing up to ${backup}`);
    copyFileSync(HOOKS_FILE, backup);
  }
  copyFileSync(HOOKS_TEMPLATE, HOOKS_FILE);
  ok(`hooks.json installed at ${HOOKS_FILE}`);

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
    }
  } catch (e) {
    warn(`Could not inject key into mcp_servers.json: ${e.message}`);
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

// ── help ───────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
Prismer Claude Code Plugin — CLI

Usage:
  npx @prismer/claude-code-plugin <command> [options]

Commands:
  setup     Install hooks.json + MCP config + API key (browser auth)
  status    Check installation state
  --help    Show this help message

Options for setup:
  --force   Re-run browser auth even if API key already exists

Examples:
  npx @prismer/claude-code-plugin setup
  npx @prismer/claude-code-plugin setup --force
  npx @prismer/claude-code-plugin status
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
} else {
  err(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}
