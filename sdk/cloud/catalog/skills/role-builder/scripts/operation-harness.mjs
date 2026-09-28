#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class HarnessError extends Error {
  constructor(stage, code, message, exitCode = 1, details = undefined) {
    super(message);
    this.name = 'HarnessError';
    this.stage = stage;
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

const VALUE_OPTIONS = new Set([
  '--role',
  '--workspace',
  '--task',
  '--title',
  '--handle',
  '--display-name',
  '--adapter',
  '--target-daemon',
  '--request-id',
  '--timeout-ms',
  '--poll-ms',
  '--ledger',
]);
const BOOLEAN_OPTIONS = new Set(['--json', '--no-wait', '--preflight-only', '--help']);
const SECRET_OPTIONS = new Set(['--api-key', '--token', '--jwt', '--secret', '--password']);

function optionName(arg) {
  if (typeof arg !== 'string') return '';
  const equalsAt = arg.indexOf('=');
  return equalsAt === -1 ? arg : arg.slice(0, equalsAt);
}

export function parseHarnessArgs(argv) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const name = optionName(arg);
    if (SECRET_OPTIONS.has(name)) {
      throw new HarnessError(
        'local_validation',
        'SECRET_ARGUMENT_FORBIDDEN',
        `${name} is forbidden; credentials must come from environment variables`,
        2,
      );
    }
    if (BOOLEAN_OPTIONS.has(arg)) {
      flags.add(arg);
      continue;
    }
    if (!VALUE_OPTIONS.has(arg)) {
      // Never reflect an untrusted argv token. Besides ordinary typos, it may
      // contain a credential in an unrecognised --name=value form.
      throw new HarnessError('local_validation', 'UNKNOWN_ARGUMENT', `unknown argument at position ${index + 1}`, 2);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new HarnessError('local_validation', 'MISSING_ARGUMENT_VALUE', `${arg} requires a value`, 2);
    }
    values[arg] = value;
    index += 1;
  }
  return { values, flags };
}

function envOrArg(parsed, argName, envName, env) {
  return parsed.values[argName] ?? env[envName];
}

function positiveInt(raw, fallback, name) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new HarnessError('local_validation', 'INVALID_NUMBER', `${name} must be a positive integer`, 2);
  }
  return value;
}

function isLocalWriteTarget(hostname) {
  return ['localhost', '127.0.0.1', '::1', 'host.docker.internal'].includes(hostname);
}

export function loadHarnessConfig(argv, env = process.env) {
  const parsed = parseHarnessArgs(argv);
  if (parsed.flags.has('--help')) return { help: true };

  const apiKey = envOrArg(parsed, '__never__', 'PRISMER_API_KEY', env);
  const role = envOrArg(parsed, '--role', 'PRISMER_ROLE_SLUG', env)?.trim();
  const workspaceId = envOrArg(parsed, '--workspace', 'PRISMER_WORKSPACE_ID', env)?.trim();
  const task = envOrArg(parsed, '--task', 'PRISMER_TASK', env)?.trim();
  const preflightOnly = parsed.flags.has('--preflight-only');
  const missing = [
    !apiKey && 'PRISMER_API_KEY',
    !role && 'PRISMER_ROLE_SLUG/--role',
    !workspaceId && 'PRISMER_WORKSPACE_ID/--workspace',
    !task && !preflightOnly && 'PRISMER_TASK/--task',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new HarnessError(
      'local_validation',
      'CONFIG_MISSING',
      `missing required environment/config: ${missing.join(', ')}`,
      2,
    );
  }

  let baseUrl;
  try {
    baseUrl = new URL((env.PRISMER_CLOUD_BASE || 'http://127.0.0.1:3000').replace(/\/$/, ''));
  } catch {
    throw new HarnessError('local_validation', 'INVALID_BASE_URL', 'PRISMER_CLOUD_BASE must be a valid URL', 2);
  }
  if (
    !['http:', 'https:'].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash || baseUrl.pathname !== '/'
  ) {
    throw new HarnessError(
      'local_validation',
      'UNSAFE_BASE_URL',
      'PRISMER_CLOUD_BASE must be a plain http(s) origin without credentials, query, or hash',
      2,
    );
  }
  // Remote mutation authority is deliberately environment-owned. A prompt or
  // copied command must not be able to grant itself authority with a CLI flag.
  const allowRemote = ['1', 'true', 'yes'].includes(String(env.PRISMER_ALLOW_REMOTE_WRITE).toLowerCase());
  if (!preflightOnly && !isLocalWriteTarget(baseUrl.hostname) && !allowRemote) {
    throw new HarnessError(
      'local_validation',
      'REMOTE_WRITE_NOT_CONFIRMED',
      'remote mutation is blocked; set PRISMER_ALLOW_REMOTE_WRITE=1 after confirming the target environment',
      2,
    );
  }

  const adapterName = envOrArg(parsed, '--adapter', 'PRISMER_AGENT_ADAPTER', env)?.trim() || 'hermes';
  if (!['hermes', 'pi-core', 'claude-code'].includes(adapterName)) {
    throw new HarnessError('local_validation', 'INVALID_ADAPTER', 'adapter must be hermes, pi-core, or claude-code', 2);
  }
  const requestId =
    envOrArg(parsed, '--request-id', 'PRISMER_REQUEST_ID', env)?.trim() ||
    `role-run-${randomUUID()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$/.test(requestId)) {
    throw new HarnessError('local_validation', 'INVALID_REQUEST_ID', 'request id must be a safe path component of at most 191 characters', 2);
  }

  const config = {
    apiKey,
    baseUrl: baseUrl.toString().replace(/\/$/, ''),
    role,
    workspaceId,
    task: task || '',
    title:
      envOrArg(parsed, '--title', 'PRISMER_TASK_TITLE', env)?.trim() || (task || `Preflight ${role}`).slice(0, 100),
    handle: envOrArg(parsed, '--handle', 'PRISMER_AGENT_HANDLE', env)?.trim(),
    displayName: envOrArg(parsed, '--display-name', 'PRISMER_AGENT_DISPLAY_NAME', env)?.trim(),
    adapterName,
    targetDaemonId: envOrArg(parsed, '--target-daemon', 'PRISMER_TARGET_DAEMON_ID', env)?.trim(),
    requestId,
    timeoutMs: positiveInt(envOrArg(parsed, '--timeout-ms', 'PRISMER_WORKFLOW_TIMEOUT_MS', env), 600_000, 'timeout'),
    pollMs: positiveInt(envOrArg(parsed, '--poll-ms', 'PRISMER_WORKFLOW_POLL_MS', env), 2_000, 'poll interval'),
    ledgerPath: resolve(
      envOrArg(parsed, '--ledger', 'PRISMER_OPERATION_LEDGER', env) || `.prismer/operations/${requestId}.json`,
    ),
    wait: !parsed.flags.has('--no-wait'),
    preflightOnly,
    json: parsed.flags.has('--json'),
  };
  if (config.handle && !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(config.handle)) {
    throw new HarnessError('local_validation', 'INVALID_HANDLE', 'agent handle has an invalid shape', 2);
  }
  return config;
}

export function writeLedger(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function readLedger(path) {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    throw new HarnessError(
      'local_validation',
      'INVALID_OPERATION_LEDGER',
      'the operation ledger exists but is not valid JSON',
      2,
    );
  }
}

export function invocationHash(config) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        baseUrl: config.baseUrl,
        credentialHash: createHash('sha256').update(config.apiKey).digest('hex'),
        requestId: config.requestId,
        role: config.role,
        workspaceId: config.workspaceId,
        task: config.task,
        title: config.title,
        handle: config.handle ?? null,
        displayName: config.displayName ?? null,
        adapterName: config.adapterName,
        targetDaemonId: config.targetDaemonId ?? null,
      }),
    )
    .digest('hex');
}

export function taskIdempotencyKey(requestId) {
  return `role-task-${createHash('sha256').update(requestId).digest('hex')}`;
}

export async function requestJson(config, method, path, body, stage) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, 120_000));
  let response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
        ...(body?.idempotencyKey ? { 'x-idempotency-key': body.idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'request timed out' : error?.message || String(error);
    throw new HarnessError(stage, 'NETWORK_ERROR', message, 4);
  } finally {
    clearTimeout(timer);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok === false) {
    const serverError = payload?.error;
    throw new HarnessError(
      stage,
      serverError?.code || `HTTP_${response.status}`,
      serverError?.message || serverError || `request failed with HTTP ${response.status}`,
      response.status === 401 || response.status === 403 ? 3 : response.status >= 500 ? 4 : 5,
      { status: response.status, retryable: serverError?.retryable === true },
    );
  }
  return { status: response.status, data: payload?.data ?? payload };
}

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
