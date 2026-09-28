#!/usr/bin/env node
// skill-builder ingest — material→bundle→live catalog, via SDK + API key.
//
// Zero runtime dependencies (Node ≥18 built-ins only). Reads a SS-01 skill
// bundle directory, parses SKILL.md frontmatter, builds an SS-01 contentManifest
// with a server-matching merkle revision, and POSTs it to the real catalog
// endpoint authenticated with an `sk-prismer-*` API key.
//
// Usage:
//   PRISMER_API_KEY=sk-prismer-... [PRISMER_CLOUD_BASE=http://127.0.0.1:3000] \
//     node scripts/ingest.mjs <bundle-dir> [--install] [--agent <imUserId>] [--json]
//
// Env:
//   PRISMER_API_KEY   (required) Bearer token; admin not required for skill create.
//   PRISMER_CLOUD_BASE (default http://127.0.0.1:3000) cloud base URL.

import { spawnSync } from 'node:child_process';

function die(msg, code = 1) {
  console.error(`[skill-builder] ✗ ${msg}`);
  process.exit(code);
}

const args = process.argv.slice(2);
const secretOptions = new Set(['--api-key', '--token', '--jwt', '--secret', '--password']);
let bundleDir;
let wantInstall = false;
let asJson = false;
let agentId;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  const equalsAt = arg.indexOf('=');
  const option = equalsAt === -1 ? arg : arg.slice(0, equalsAt);
  if (secretOptions.has(option)) {
    die(`${option} is forbidden; credentials must come from environment variables`, 2);
  }
  if (arg === '--install') {
    wantInstall = true;
    continue;
  }
  if (arg === '--json') {
    asJson = true;
    continue;
  }
  if (arg === '--agent') {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) die('--agent requires an imUserId', 2);
    agentId = value;
    index += 1;
    continue;
  }
  if (arg.startsWith('--')) die(`unknown argument at position ${index + 1}`, 2);
  if (bundleDir) die('only one bundle directory may be supplied', 2);
  bundleDir = arg;
}

const API_KEY = process.env.PRISMER_API_KEY;
const BASE = (process.env.PRISMER_CLOUD_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');

if (!bundleDir) die('usage: node ingest.mjs <bundle-dir> [--install] [--agent <imUserId>] [--json]');
if (!API_KEY) die('PRISMER_API_KEY env is required (sk-prismer-*)');
let target;
try {
  target = new URL(BASE);
} catch {
  die('PRISMER_CLOUD_BASE must be a valid URL', 2);
}
if (
  !['http:', 'https:'].includes(target.protocol) ||
  target.username ||
  target.password ||
  target.search ||
  target.hash || target.pathname !== '/'
) {
  die('PRISMER_CLOUD_BASE must be a plain http(s) origin without credentials, query, or hash', 2);
}
const isLocalTarget = ['localhost', '127.0.0.1', '::1', 'host.docker.internal'].includes(target.hostname);
const allowRemote = ['1', 'true', 'yes'].includes(String(process.env.PRISMER_ALLOW_REMOTE_WRITE).toLowerCase());
if (!isLocalTarget && !allowRemote) {
  die('remote mutation is blocked; set PRISMER_ALLOW_REMOTE_WRITE=1 after confirming the target environment', 2);
}

// Keep the legacy entrypoint, but use the canonical structured parser and CLI.
const command = ['skill', 'create', bundleDir];
if (wantInstall) command.push('--install');
if (agentId) command.push('--agent', agentId);
if (asJson) command.push('--json');
const result = spawnSync(process.env.PRISMER_CLOUD_BIN || 'cloud', command, {
  stdio: 'inherit', shell: false, timeout: 120_000,
  env: { ...process.env, PRISMER_CLOUD_BASE: BASE },
});
if (result.error) die('Cloud CLI failed or timed out; inspect remote state before retrying', 5);
process.exitCode = result.status ?? 5;
