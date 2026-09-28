#!/usr/bin/env node
// role-builder ingest — material→role template→live, optionally applied, via API key.
//
// Zero runtime dependencies (Node ≥18 built-ins). Reads a SS-02 role.json,
// POSTs it to the real role-template endpoint with an `sk-prismer-*` admin API
// key, and optionally applies it to a live agent.
//
// Accepts EITHER a single role.json OR a role bundle directory (role.json +
// optional SOUL.md). When a dir + SOUL.md is given, SOUL.md's markdown becomes
// operatingPrinciples (Hermes-compatible persona, doc 16 §5.4). Mirrors the
// `cloud role create` CLI logic so the offline path matches.
//
// Usage:
//   PRISMER_API_KEY=sk-prismer-... [PRISMER_CLOUD_BASE=http://127.0.0.1:3000] \
//     node scripts/ingest-role.mjs <role.json|role-dir> [--publish|--admin-catalog] [--apply --agent <imUserId> --workspace-id <wsId>] [--json]
//
// Notes (product204/16 §2.3 — CLI 三入口默认私域):
//   • DEFAULT (no flag) is the caller's PRIVATE Studio `/mine` (ownerAgentId=
//     caller, visibility=private) via POST /api/im/role-templates/mine —
//     editable, then publishable. Any authenticated key works (no admin
//     needed). `--mine` is accepted as an explicit no-op for back-compat.
//   • `--publish` (alias `--admin-catalog`) creates on the admin-only public
//     catalog path (POST /api/im/role-templates, SS-02 §4.1) — the key must
//     map to an admin email, else the server returns 403. Publication is an
//     EXPLICIT act, never the default (16 §2.3).
//   • APPLY is admin OR the target agent's workspace owner.

import { spawnSync } from 'node:child_process';

function die(msg, code = 1) {
  console.error(`[role-builder] ✗ ${msg}`);
  process.exit(code);
}

const args = process.argv.slice(2);
const secretOptions = new Set(['--api-key', '--token', '--jwt', '--secret', '--password']);
let rolePath;
let wantApply = false;
let wantPublish = false;
let asJson = false;
let agentId;
let workspaceId;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  const equalsAt = arg.indexOf('=');
  const option = equalsAt === -1 ? arg : arg.slice(0, equalsAt);
  if (secretOptions.has(option)) {
    die(`${option} is forbidden; credentials must come from environment variables`, 2);
  }
  if (arg === '--apply') {
    wantApply = true;
    continue;
  }
  if (arg === '--publish' || arg === '--admin-catalog') {
    wantPublish = true;
    continue;
  }
  if (arg === '--mine') continue;
  if (arg === '--json') {
    asJson = true;
    continue;
  }
  if (arg === '--agent' || arg === '--workspace-id') {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) die(`${arg} requires a value`, 2);
    if (arg === '--agent') agentId = value;
    else workspaceId = value;
    index += 1;
    continue;
  }
  if (arg.startsWith('--')) die(`unknown argument at position ${index + 1}`, 2);
  if (rolePath) die('only one role path may be supplied', 2);
  rolePath = arg;
}
// product204/16 §2.3 — private `/mine` is the DEFAULT; the public catalog is an
// explicit `--publish` (alias `--admin-catalog`). `--mine` stays accepted as a
// no-op for back-compat with pre-204 invocations.
const wantMine = !wantPublish;

const API_KEY = process.env.PRISMER_API_KEY;
const BASE = (process.env.PRISMER_CLOUD_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');

if (!rolePath) die('usage: node ingest-role.mjs <role.json|role-dir> [--publish|--admin-catalog] [--apply --agent <id> --workspace-id <id>] [--json]');
if (!API_KEY) die('PRISMER_API_KEY env is required (sk-prismer-*; --mine needs any key, the admin catalog path needs an admin email)');
if (wantApply && !agentId) die('--apply requires --agent <imUserId>');
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

// Preserve the legacy CLI surface while delegating parsing/preflight to Cloud.
const command = ['role', 'create', rolePath];
if (wantPublish) command.push('--publish');
if (wantApply) command.push('--apply');
if (agentId) command.push('--agent', agentId);
if (workspaceId) command.push('--workspace-id', workspaceId);
if (asJson) command.push('--json');
const cloud = process.env.PRISMER_CLOUD_BIN || 'cloud';
for (const args of [['role', 'validate', rolePath, '--json'], ['role', 'test', rolePath, '--json'], command]) {
  const result = spawnSync(cloud, args, { stdio: 'inherit', shell: false, timeout: 120_000,
    env: { ...process.env, PRISMER_CLOUD_BASE: BASE } });
  if (result.error || result.status !== 0) {
    die('Cloud CLI failed or timed out; inspect remote state before retrying', result.status || 5);
  }
}
