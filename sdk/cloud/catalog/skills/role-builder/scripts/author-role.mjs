#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class RoleAuthoringError extends Error {
  constructor(stage, code, message, exitCode = 1, details = undefined) {
    super(message);
    this.name = 'RoleAuthoringError';
    this.stage = stage;
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

const SECRET_OPTIONS = new Set(['--api-key', '--token', '--jwt', '--secret', '--password']);
const BOOLEAN_OPTIONS = new Set(['--json', '--preflight-only', '--help']);

function optionName(arg) {
  const equalsAt = typeof arg === 'string' ? arg.indexOf('=') : -1;
  return equalsAt === -1 ? arg : arg.slice(0, equalsAt);
}

function enabled(value) {
  return ['1', 'true', 'yes'].includes(String(value ?? '').toLowerCase());
}

function localTarget(hostname) {
  return ['localhost', '127.0.0.1', '::1', 'host.docker.internal'].includes(hostname);
}

function roleRevision(rolePath) {
  const stat = statSync(rolePath);
  const hash = createHash('sha256');
  if (stat.isDirectory()) {
    for (const name of ['role.json', 'SOUL.md']) {
      const file = resolve(rolePath, name);
      if (!existsSync(file)) continue;
      hash.update(name);
      hash.update('\0');
      hash.update(readFileSync(file));
      hash.update('\0');
    }
  } else {
    hash.update(readFileSync(rolePath));
  }
  return hash.digest('hex');
}

export function loadRoleAuthoringConfig(argv, env = process.env) {
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const name = optionName(arg);
    if (SECRET_OPTIONS.has(name)) {
      throw new RoleAuthoringError(
        'local_validation',
        'SECRET_ARGUMENT_FORBIDDEN',
        `${name} is forbidden; credentials must come from the injected environment`,
        2,
      );
    }
    if (!BOOLEAN_OPTIONS.has(arg)) {
      throw new RoleAuthoringError(
        'local_validation',
        'UNKNOWN_ARGUMENT',
        `unknown argument at position ${index + 1}`,
        2,
      );
    }
    flags.add(arg);
  }
  if (flags.has('--help')) return { help: true };

  const rawRolePath = env.PRISMER_ROLE_BUNDLE?.trim();
  if (!rawRolePath) {
    throw new RoleAuthoringError('local_validation', 'CONFIG_MISSING', 'PRISMER_ROLE_BUNDLE is required', 2);
  }
  const rolePath = resolve(rawRolePath);
  if (!existsSync(rolePath)) {
    throw new RoleAuthoringError('local_validation', 'ROLE_BUNDLE_NOT_FOUND', 'PRISMER_ROLE_BUNDLE does not exist', 2);
  }

  let baseUrl;
  try {
    baseUrl = new URL((env.PRISMER_CLOUD_BASE || 'http://127.0.0.1:3000').replace(/\/$/, ''));
  } catch {
    throw new RoleAuthoringError('local_validation', 'INVALID_BASE_URL', 'PRISMER_CLOUD_BASE must be a valid URL', 2);
  }
  if (
    !['http:', 'https:'].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash || baseUrl.pathname !== '/'
  ) {
    throw new RoleAuthoringError(
      'local_validation',
      'UNSAFE_BASE_URL',
      'PRISMER_CLOUD_BASE must be a plain http(s) origin without credentials, query, or hash',
      2,
    );
  }
  const preflightOnly = flags.has('--preflight-only');
  if (!preflightOnly && !localTarget(baseUrl.hostname) && !enabled(env.PRISMER_ALLOW_REMOTE_WRITE)) {
    throw new RoleAuthoringError(
      'local_validation',
      'REMOTE_WRITE_NOT_CONFIRMED',
      'remote mutation is blocked; set PRISMER_ALLOW_REMOTE_WRITE=1 after confirming the target environment',
      2,
    );
  }

  const revision = roleRevision(rolePath);
  return {
    credential: env.PRISMER_API_KEY?.trim() || '',
    rolePath,
    revision,
    cloudBin: env.PRISMER_CLOUD_BIN?.trim() || 'cloud',
    baseUrl: baseUrl.toString().replace(/\/$/, ''),
    ledgerPath: resolve(
      env.PRISMER_ROLE_AUTHORING_LEDGER?.trim() ||
        `.prismer/operations/role-author-${createHash('sha256').update(rolePath).digest('hex').slice(0, 16)}.json`,
    ),
    publish: enabled(env.PRISMER_ROLE_PUBLISH),
    preflightOnly,
    json: flags.has('--json'),
  };
}

function defaultRunCloud(config, args) {
  const result = spawnSync(config.cloudBin, args, {
    encoding: 'utf8',
    env: { ...process.env, PRISMER_CLOUD_BASE: config.baseUrl, PRISMER_API_KEY: config.credential },
    timeout: 120_000,
    shell: false,
  });
  if (result.error) {
    throw new RoleAuthoringError(
      'local_validation',
      'CLOUD_CLI_UNAVAILABLE',
      `could not execute the configured Cloud CLI: ${result.error.message}`,
      2,
    );
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function parseJson(result, stage) {
  const raw = String(result.stdout || '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        // Fall through.
      }
    }
    throw new RoleAuthoringError(stage, 'INVALID_CLI_JSON', 'cloud CLI did not return valid JSON', 5);
  }
}

function cliError(result) {
  return (
    String(result.stderr || '')
      .trim()
      .slice(0, 2_000) || `cloud CLI exited ${String(result.status)}`
  );
}

function writeLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function readLedger(path) {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    throw new RoleAuthoringError(
      'local_validation',
      'INVALID_AUTHORING_LEDGER',
      'the role authoring ledger exists but is not valid JSON',
      2,
    );
  }
}

export async function runRoleAuthoring(config, runCloud = defaultRunCloud) {
  mkdirSync(dirname(config.ledgerPath), { recursive: true });
  const lockPath = `${config.ledgerPath}.lock`;
  const lock = openSync(lockPath, 'wx', 0o600);
  try {
    return await runRoleAuthoringLocked(config, runCloud);
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

async function runRoleAuthoringLocked(config, runCloud) {
  if (!config.credential) throw new RoleAuthoringError('local_validation', 'IDENTITY_REQUIRED', 'PRISMER_API_KEY is required to bind the ledger to the executing credential', 2);
  const targetBinding = createHash('sha256').update(JSON.stringify([config.baseUrl, config.credential])).digest('hex');
  const previous = readLedger(config.ledgerPath);
  if (
    previous &&
    (previous.targetBinding !== targetBinding || previous.rolePath !== config.rolePath ||
      previous.revision !== config.revision ||
      Boolean(previous.publish) !== config.publish)
  ) {
    throw new RoleAuthoringError(
      'local_validation',
      'AUTHORING_LEDGER_CONFLICT',
      'the role authoring ledger belongs to different bundle content or destination',
      2,
    );
  }
  if (['created', 'completed'].includes(previous?.stage) && previous.slug) {
    // The server push completed and its canonical slug was durably recorded;
    // resume from readback instead of pushing again (which intentionally bumps
    // a role version even when its content is identical).
    const shown = await runCloud(config, ['role', 'show', previous.slug, '--json']);
    if (!shown.ok) {
      throw new RoleAuthoringError(
        'readback',
        'ROLE_READBACK_FAILED',
        'a previously-created role could not be read back; refusing an automatic second push',
        5,
      );
    }
    previous.readback = parseJson(shown, 'readback');
    previous.stage = 'completed';
    previous.completedAt = new Date().toISOString();
    previous.updatedAt = previous.completedAt;
    writeLedger(config.ledgerPath, previous);
    return previous;
  }

  const validated = await runCloud(config, ['role', 'validate', config.rolePath, '--json']);
  if (!validated.ok) {
    throw new RoleAuthoringError('validation', 'ROLE_VALIDATION_FAILED', cliError(validated), 2);
  }
  const validation = parseJson(validated, 'validation');
  if (validation.ok === false) {
    throw new RoleAuthoringError('validation', 'ROLE_VALIDATION_FAILED', 'role bundle failed local validation', 2);
  }

  const tested = await runCloud(config, ['role', 'test', config.rolePath, '--json']);
  if (!tested.ok) {
    throw new RoleAuthoringError('preflight', 'ROLE_PREFLIGHT_FAILED', cliError(tested), 5);
  }
  const test = parseJson(tested, 'preflight');
  if (test.ok === false) {
    throw new RoleAuthoringError('preflight', 'ROLE_PREFLIGHT_FAILED', 'required Skill resolution failed', 5);
  }

  const ledger = {
    targetBinding,
    schemaVersion: 1,
    rolePath: config.rolePath,
    revision: config.revision,
    publish: config.publish,
    slug: validation.slug ?? test.slug ?? null,
    stage: 'preflight_complete',
    validation,
    test,
    updatedAt: new Date().toISOString(),
  };
  writeLedger(config.ledgerPath, ledger);
  if (config.preflightOnly) return ledger;

  const createArgs = ['role', 'create', config.rolePath, '--mine', '--json'];
  if (config.publish) createArgs.push('--publish');
  const created = await runCloud(config, createArgs);
  if (!created.ok) {
    throw new RoleAuthoringError('create', 'ROLE_CREATE_FAILED', cliError(created), 5);
  }
  const creation = parseJson(created, 'create');
  if (!creation.slug) {
    throw new RoleAuthoringError('create', 'CANONICAL_SLUG_MISSING', 'create response omitted the role slug', 5);
  }
  ledger.creation = creation;
  ledger.slug = creation.slug;
  ledger.stage = 'created';
  ledger.updatedAt = new Date().toISOString();
  writeLedger(config.ledgerPath, ledger);

  const shown = await runCloud(config, ['role', 'show', creation.slug, '--json']);
  if (!shown.ok) {
    throw new RoleAuthoringError('readback', 'ROLE_READBACK_FAILED', cliError(shown), 5);
  }
  ledger.readback = parseJson(shown, 'readback');
  ledger.stage = 'completed';
  ledger.completedAt = new Date().toISOString();
  ledger.updatedAt = ledger.completedAt;
  writeLedger(config.ledgerPath, ledger);
  return ledger;
}

const HELP = `Usage:
  # PRISMER_ROLE_BUNDLE and cloud authentication are injected in env
  node scripts/author-role.mjs [--preflight-only] [--json]

Optional env: PRISMER_ROLE_PUBLISH=1, PRISMER_ROLE_AUTHORING_LEDGER,
PRISMER_CLOUD_BIN, PRISMER_CLOUD_BASE, PRISMER_ALLOW_REMOTE_WRITE=1.`;

async function main() {
  let config;
  try {
    config = loadRoleAuthoringConfig(process.argv.slice(2));
    if (config.help) {
      process.stdout.write(`${HELP}\n`);
      return;
    }
    const result = await runRoleAuthoring(config);
    if (config.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write(
        `[role-builder] ${result.stage}: role=${result.slug || 'unresolved'} ledger=${config.ledgerPath}\n`,
      );
    }
  } catch (error) {
    const failure =
      error instanceof RoleAuthoringError
        ? error
        : new RoleAuthoringError('internal', 'UNEXPECTED_ERROR', error?.message || String(error), 1);
    process.stderr.write(
      `${JSON.stringify({ ok: false, stage: failure.stage, error: { code: failure.code, message: failure.message, details: failure.details }, ...(config?.ledgerPath ? { ledger: config.ledgerPath } : {}) })}\n`,
    );
    process.exitCode = failure.exitCode;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
