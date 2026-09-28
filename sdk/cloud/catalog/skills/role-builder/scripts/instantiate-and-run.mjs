#!/usr/bin/env node

import { mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  HarnessError,
  invocationHash,
  loadHarnessConfig,
  readLedger,
  requestJson,
  sleep,
  taskIdempotencyKey,
  writeLedger,
} from './operation-harness.mjs';

const HELP = `Usage:
  # with the required PRISMER_* environment already injected:
  node scripts/instantiate-and-run.mjs [--json]

Configuration stays in environment variables. Non-secret flags are available:
  --role --workspace --task --title --handle --display-name --adapter
  --target-daemon --request-id --ledger --timeout-ms --poll-ms
  --preflight-only --no-wait --json

Remote writes require PRISMER_ALLOW_REMOTE_WRITE=1 from the trusted environment.
Set PRISMER_REQUEST_ID once when an interrupted operation must be resumed.

Exit codes: 2 local harness rejection, 3 auth, 4 transient/network, 5 remote contract.`;

function instanceBody(config) {
  return {
    workspaceId: config.workspaceId,
    requestId: config.requestId,
    ...(config.handle ? { handle: config.handle } : {}),
    ...(config.displayName ? { displayName: config.displayName } : {}),
    adapterName: config.adapterName,
    ...(config.targetDaemonId ? { targetDaemonId: config.targetDaemonId } : {}),
  };
}

function emit(config, ledger) {
  if (config.json) process.stdout.write(`${JSON.stringify(ledger)}\n`);
  else {
    process.stdout.write(
      `[role-builder] ${ledger.stage}: role=${config.role} workspace=${config.workspaceId}` +
        `${ledger.agent?.id ? ` agent=${ledger.agent.id}` : ''}${ledger.task?.id ? ` task=${ledger.task.id}` : ''}\n`,
    );
  }
}

async function findExistingInstance(config) {
  try {
    const read = await requestJson(
      config,
      'GET',
      `/api/im/role-templates/${encodeURIComponent(config.role)}/instances/${encodeURIComponent(config.requestId)}`,
      undefined,
      'operation_lookup',
    );
    return read.data;
  } catch (error) {
    if (error instanceof HarnessError && error.details?.status === 404) return null;
    throw error;
  }
}

async function waitForInstance(config, initial, ledger) {
  let instance = initial;
  const started = Date.now();
  let lastResumeAt = started;
  while (Date.now() - started < config.timeoutMs) {
    if (instance.status === 'failed') {
      throw new HarnessError(
        'instance',
        instance.error?.code || 'ROLE_INSTANCE_FAILED',
        instance.error?.message || 'role instance provisioning failed',
        instance.error?.retryable ? 4 : 5,
      );
    }
    if (instance.execution?.state === 'wrong_daemon') {
      throw new HarnessError(
        'instance_wait',
        'ROLE_INSTANCE_WRONG_DAEMON',
        `agent is bound to ${instance.execution.boundDaemonId || 'an unknown daemon'} instead of ${instance.execution.targetDaemonId || 'the requested daemon'}`,
        5,
        {
          targetDaemonId: instance.execution.targetDaemonId ?? null,
          boundDaemonId: instance.execution.boundDaemonId ?? null,
        },
      );
    }
    // A task must never be created for an agent that the runtime has not yet
    // adopted. `--no-wait` skips only the final task-result wait.
    if (instance.status === 'ready' && instance.execution?.state === 'ready') return instance;
    await sleep(config.pollMs);
    const read = await requestJson(
      config,
      'GET',
      `/api/im/role-templates/${encodeURIComponent(config.role)}/instances/${encodeURIComponent(config.requestId)}`,
      undefined,
      'instance_wait',
    );
    instance = read.data;
    ledger.instance = instance;
    ledger.stage = instance.status === 'ready' ? 'waiting_for_runtime' : 'provisioning_agent';
    ledger.updatedAt = new Date().toISOString();
    writeLedger(config.ledgerPath, ledger);

    // A process may die after accepting the operation. Periodically re-POSTing
    // is safe: the server lease decides whether this caller may resume it.
    if (instance.status === 'provisioning' && Date.now() - lastResumeAt >= 35_000) {
      const resumed = await requestJson(
        config,
        'POST',
        `/api/im/role-templates/${encodeURIComponent(config.role)}/instances`,
        instanceBody(config),
        'instance_resume',
      );
      instance = resumed.data;
      lastResumeAt = Date.now();
    }
  }
  throw new HarnessError('instance_wait', 'WORKFLOW_TIMEOUT', 'timed out waiting for agent runtime binding', 4);
}

async function waitForTask(config, task, ledger) {
  const started = Date.now();
  while (Date.now() - started < config.timeoutMs) {
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return task;
    await sleep(config.pollMs);
    const read = await requestJson(
      config,
      'GET',
      `/api/im/tasks/${encodeURIComponent(task.id)}`,
      undefined,
      'task_wait',
    );
    task = read.data;
    ledger.task = task;
    ledger.stage = 'waiting_for_task';
    ledger.updatedAt = new Date().toISOString();
    writeLedger(config.ledgerPath, ledger);
  }
  throw new HarnessError('task_wait', 'WORKFLOW_TIMEOUT', 'timed out waiting for task result', 4);
}

export async function runRoleWorkflow(config) {
  mkdirSync(dirname(config.ledgerPath), { recursive: true });
  const lockPath = `${config.ledgerPath}.lock`;
  const lock = openSync(lockPath, 'wx', 0o600);
  try {
    return await runRoleWorkflowLocked(config);
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

async function runRoleWorkflowLocked(config) {
  const acceptedHash = invocationHash(config);
  const previous = readLedger(config.ledgerPath);
  if (
    previous &&
    (previous.requestId !== config.requestId ||
      previous.role !== config.role ||
      previous.workspaceId !== config.workspaceId ||
      previous.invocationHash !== acceptedHash)
  ) {
    throw new HarnessError(
      'local_validation',
      'OPERATION_LEDGER_CONFLICT',
      'the ledger path belongs to a different role workflow request',
      2,
    );
  }
  const ledger = {
    schemaVersion: 2,
    requestId: config.requestId,
    invocationHash: acceptedHash,
    role: config.role,
    workspaceId: config.workspaceId,
    stage: 'local_validation_complete',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  // Persist the recovery key before the first request. Credentials are never
  // written to the ledger or included in the result.
  writeLedger(config.ledgerPath, ledger);

  const existing = config.preflightOnly ? null : await findExistingInstance(config);
  if (!existing || config.preflightOnly) {
    const preflight = await requestJson(
      config,
      'POST',
      `/api/im/role-templates/${encodeURIComponent(config.role)}/instances/preflight`,
      instanceBody(config),
      'remote_preflight',
    );
    ledger.preflight = preflight.data;
    ledger.stage = 'remote_preflight_complete';
    ledger.updatedAt = new Date().toISOString();
    writeLedger(config.ledgerPath, ledger);
    if (config.preflightOnly) return ledger;
  } else {
    ledger.instance = existing;
    ledger.stage = 'operation_recovered';
    ledger.updatedAt = new Date().toISOString();
    writeLedger(config.ledgerPath, ledger);
  }

  // A ready/provisioning durable operation can be resumed from its read face.
  // A failed operation needs an idempotent POST to re-enter server recovery.
  const provisioned =
    existing && existing.status !== 'failed'
      ? { data: existing }
      : await requestJson(
          config,
          'POST',
          `/api/im/role-templates/${encodeURIComponent(config.role)}/instances`,
          instanceBody(config),
          'instance',
        );
  ledger.instance = provisioned.data;
  ledger.stage = 'provisioning_agent';
  ledger.updatedAt = new Date().toISOString();
  writeLedger(config.ledgerPath, ledger);
  const instance = await waitForInstance(config, provisioned.data, ledger);
  ledger.instance = instance;
  ledger.agent = instance.agent;
  ledger.stage = config.wait ? 'agent_ready' : 'agent_created';
  ledger.updatedAt = new Date().toISOString();
  writeLedger(config.ledgerPath, ledger);

  const taskRequestKey = taskIdempotencyKey(config.requestId);
  const createdTask = await requestJson(
    config,
    'POST',
    '/api/im/tasks',
    {
      title: config.title,
      description: config.task,
      workspaceId: config.workspaceId,
      assigneeId: instance.agent.id,
      runtimeRoute: 'agent',
      dispatchPolicy: 'on-assign',
      idempotencyKey: taskRequestKey,
      metadata: {
        kind: 'agent_run',
        createdVia: 'role-builder-script',
        roleInstanceRequestId: config.requestId,
      },
    },
    'task_create',
  );
  ledger.task = createdTask.data;
  ledger.stage = 'task_created';
  ledger.updatedAt = new Date().toISOString();
  writeLedger(config.ledgerPath, ledger);

  if (config.wait) {
    ledger.task = await waitForTask(config, createdTask.data, ledger);
    if (ledger.task.status !== 'completed') {
      throw new HarnessError(
        'task_wait',
        `TASK_${String(ledger.task.status).toUpperCase()}`,
        ledger.task.error || `task ended as ${ledger.task.status}`,
        5,
      );
    }
  }
  ledger.stage = config.wait ? 'completed' : 'dispatched';
  ledger.completedAt = new Date().toISOString();
  ledger.updatedAt = ledger.completedAt;
  writeLedger(config.ledgerPath, ledger);
  return ledger;
}

async function main() {
  let config;
  try {
    config = loadHarnessConfig(process.argv.slice(2));
    if (config.help) {
      process.stdout.write(`${HELP}\n`);
      return;
    }
    const result = await runRoleWorkflow(config);
    emit(config, result);
  } catch (error) {
    const harnessError =
      error instanceof HarnessError
        ? error
        : new HarnessError('internal', 'UNEXPECTED_ERROR', error?.message || String(error), 1);
    const failure = {
      ok: false,
      stage: harnessError.stage,
      error: { code: harnessError.code, message: harnessError.message, details: harnessError.details },
      ...(config ? { requestId: config.requestId, ledger: config.ledgerPath } : {}),
    };
    process.stderr.write(`${JSON.stringify(failure)}\n`);
    process.exitCode = harnessError.exitCode;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
