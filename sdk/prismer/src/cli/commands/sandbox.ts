// `prismer sandbox (list|create|status|start|stop|snapshot|runCmd|logs)` — daemon-first sandbox smoke.

import { Command } from 'commander';
import { CloudClient } from '../../auth.js';
import { loadConfig, resolvePaths } from '../../config.js';
import { exitWithError, printJson, runAction } from '../util.js';
import { getUI } from '../ui.js';

type ApiEnvelope<T> = {
  ok?: boolean;
  data?: T;
  error?: { code?: string; message?: string } | string;
};

type SandboxContainer = {
  id?: string;
  podName?: string;
  status?: string;
  liveStatus?: string | null;
  workspaceId?: string;
  agentImUserId?: string;
  templateId?: string | null;
  startedAt?: string | null;
  stoppedAt?: string | null;
};

type SandboxSnapshot = {
  id?: string;
  containerId?: string;
  imageTag?: string;
  imageDigest?: string | null;
  sizeBytes?: number | null;
  createdBy?: string;
  createdAt?: string;
};

export function buildSandboxCommand(): Command {
  const cmd = new Command('sandbox').description('Inspect and smoke-test sandbox lifecycle');

  cmd
    .command('list')
    .description('List sandbox containers in a workspace')
    .requiredOption('--workspace-id <id>', 'Workspace id')
    .option('--status <status>', 'Status filter')
    .option('--limit <n>', 'Max rows', parsePositiveInt, 50)
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[{ workspaceId: string; status?: string; limit: number; json?: boolean }]>(async (opts) => {
      const query = new URLSearchParams({ workspaceId: opts.workspaceId, limit: String(opts.limit) });
      if (opts.status) query.set('status', opts.status);
      const body = await cloudRequest('GET', `/api/sandboxes?${query.toString()}`);
      if (opts.json) {
        printJson(body ?? null);
        return;
      }
      printSandboxList(body);
    }, { code: 'sandbox_list_failed' }));

  cmd
    .command('create')
    .description('Create a sandbox container')
    .requiredOption('--workspace-id <id>', 'Workspace id')
    .option('--agent-id <id>', 'Agent IM user id')
    .option('--task-id <id>', 'Task id')
    .option('--image <image>', 'Sandbox image override')
    .option('--cpu-request <value>', 'CPU request')
    .option('--cpu-limit <value>', 'CPU limit')
    .option('--memory-request <value>', 'Memory request')
    .option('--memory-limit <value>', 'Memory limit')
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[{
      workspaceId: string;
      agentId?: string;
      taskId?: string;
      image?: string;
      cpuRequest?: string;
      cpuLimit?: string;
      memoryRequest?: string;
      memoryLimit?: string;
      json?: boolean;
    }]>(async (opts) => {
      const body = await cloudRequest('POST', '/api/sandboxes', {
        workspaceId: opts.workspaceId,
        ...(opts.agentId ? { agentImUserId: opts.agentId } : {}),
        ...(opts.taskId ? { taskId: opts.taskId } : {}),
        ...(opts.image ? { image: opts.image } : {}),
        ...(opts.cpuRequest ? { cpuRequest: opts.cpuRequest } : {}),
        ...(opts.cpuLimit ? { cpuLimit: opts.cpuLimit } : {}),
        ...(opts.memoryRequest ? { memoryRequest: opts.memoryRequest } : {}),
        ...(opts.memoryLimit ? { memoryLimit: opts.memoryLimit } : {}),
      });
      if (opts.json) {
        printJson(body ?? null);
        return;
      }
      printSandboxDetail('(new)', body);
    }, { code: 'sandbox_create_failed' }));

  cmd
    .command('status <id>')
    .description('Fetch sandbox detail + live status')
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[string, { json?: boolean }]>(async (id, opts) => {
      const body = await cloudRequest('GET', `/api/sandboxes/${encodeURIComponent(id)}`);
      if (opts.json) {
        printJson(body ?? null);
        return;
      }
      printSandboxDetail(id, body);
    }, { code: 'sandbox_status_failed' }));

  cmd
    .command('start <id>')
    .description('Start a sandbox container')
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[string, { json?: boolean }]>(async (id, opts) => {
      const body = await cloudRequest('POST', `/api/sandboxes/${encodeURIComponent(id)}/start`);
      if (opts.json) {
        printJson(body ?? null);
        return;
      }
      printSandboxAction('Started sandbox', id, body);
    }, { code: 'sandbox_start_failed' }));

  cmd
    .command('stop <id>')
    .description('Stop a sandbox container')
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[string, { json?: boolean }]>(async (id, opts) => {
      const body = await cloudRequest('POST', `/api/sandboxes/${encodeURIComponent(id)}/stop`);
      if (opts.json) {
        printJson(body ?? null);
        return;
      }
      printSandboxAction('Stopped sandbox', id, body);
    }, { code: 'sandbox_stop_failed' }));

  cmd
    .command('snapshot <id>')
    .description('Create a sandbox snapshot')
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[string, { json?: boolean }]>(async (id, opts) => {
      const body = await cloudRequest('POST', `/api/sandboxes/${encodeURIComponent(id)}/snapshot`);
      if (opts.json) {
        printJson(body ?? null);
        return;
      }
      printSnapshotResult(id, body);
    }, { code: 'sandbox_snapshot_failed' }));

  cmd
    .command('runCmd <id> <command...>')
    .description('Run a command in a sandbox container')
    .option('--timeout-ms <ms>', 'Command timeout', parsePositiveInt, 60_000)
    .option('--json', 'Output machine-readable JSON')
    .allowUnknownOption(true)
    .action(runAction<[string, string[], { timeoutMs: number; json?: boolean }]>(async (id, command, opts) => {
      if (!Array.isArray(command) || command.length === 0) exitWithError('runCmd requires a command after --', { code: 'invalid_argument' });
      const body = await cloudRequest('POST', `/api/sandboxes/${encodeURIComponent(id)}/runCmd`, {
        command,
        timeoutMs: opts.timeoutMs,
      });
      if (opts.json) {
        printJson(body ?? null);
        return;
      }
      printJson(body ?? {});
    }, { code: 'sandbox_runcmd_failed' }));

  cmd
    .command('logs <id>')
    .description('Stream sandbox logs')
    .action(runAction<[string]>(async (id) => {
      const cloud = mkCloud();
      const res = await cloud.fetchRaw(`/api/sandboxes/${encodeURIComponent(id)}/logs`);
      if (!res.ok) {
        const body = await safeParseResponse(res);
        exitWithError(`sandbox logs failed (${res.status}): ${errorMessage(body as ApiEnvelope<unknown>)}`, { code: 'sandbox_logs_failed' });
      }
      if (!res.body) exitWithError('sandbox logs stream unavailable', { code: 'sandbox_logs_failed' });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        process.stdout.write(decoder.decode(value, { stream: true }));
      }
    }, { code: 'sandbox_logs_failed' }));

  return cmd;
}

function mkCloud(): CloudClient {
  const cfg = loadConfig(resolvePaths());
  return new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
}

function isErrorEnvelope(raw: unknown): raw is ApiEnvelope<unknown> {
  return Boolean(raw && typeof raw === 'object' && 'ok' in raw && (raw as { ok?: unknown }).ok === false);
}

function errorMessage(raw: ApiEnvelope<unknown>): string {
  if (typeof raw.error === 'string') return raw.error;
  return raw.error?.message ?? 'request failed';
}

async function cloudRequest(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const cloud = mkCloud();
  const res = await cloud.request<unknown>(method, path, body === undefined ? undefined : { body });
  if (!res.ok) exitWithError(`${method} ${path} failed (${res.status}): ${res.error?.message ?? 'request failed'}`);
  const responseBody = res.data as unknown;
  if (isErrorEnvelope(responseBody)) exitWithError(`${method} ${path} failed (${res.status}): ${errorMessage(responseBody)}`);
  return responseBody;
}

function printSandboxList(raw: unknown): void {
  const payload = extractPayload(raw);
  const containers = payload && typeof payload === 'object' && 'containers' in payload
    ? ((payload as { containers?: SandboxContainer[] }).containers ?? [])
    : [];
  if (containers.length === 0) {
    getUI().line('No sandboxes found.');
    return;
  }
  getUI().line(`Sandboxes (${containers.length})`);
  for (const c of containers) {
    getUI().line(`- ${c.id ?? '(unknown)'}  ${c.status ?? c.liveStatus ?? 'unknown'}  ws=${c.workspaceId ?? ''}`);
  }
}

function printSandboxDetail(id: string, raw: unknown): void {
  const container = extractContainer(raw);
  if (!container) {
    getUI().line(`Sandbox ${id}`);
    return;
  }

  getUI().line(`Sandbox ${container.id ?? id}`);
  writeLine('pod', container.podName);
  writeLine('status', container.liveStatus ?? container.status);
  writeLine('workspace', container.workspaceId);
  writeLine('agent', container.agentImUserId);
  writeLine('template', container.templateId);
  writeLine('startedAt', container.startedAt);
  writeLine('stoppedAt', container.stoppedAt);
}

function printSandboxAction(label: string, id: string, raw: unknown): void {
  getUI().line(`${label} ${id}`);
  const payload = extractPayload(raw);
  writeLine('status', (payload as { status?: unknown } | undefined)?.status);
}

function printSnapshotResult(id: string, raw: unknown): void {
  const snapshot = extractSnapshot(raw);
  if (!snapshot) {
    getUI().line(`Snapshot requested for ${id}`);
    return;
  }

  getUI().line(`Snapshot ${snapshot.id ?? id}`);
  writeLine('container', snapshot.containerId);
  writeLine('imageTag', snapshot.imageTag);
  writeLine('imageDigest', snapshot.imageDigest);
  writeLine('sizeBytes', snapshot.sizeBytes != null ? `${snapshot.sizeBytes} bytes` : undefined);
  writeLine('createdBy', snapshot.createdBy);
  writeLine('createdAt', snapshot.createdAt);
}

function extractPayload(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'data' in raw) {
    return (raw as ApiEnvelope<unknown>).data;
  }
  return raw;
}

function extractContainer(raw: unknown): SandboxContainer | undefined {
  const payload = extractPayload(raw);
  if (!payload || typeof payload !== 'object') return undefined;
  if ('container' in payload) {
    return (payload as { container?: SandboxContainer }).container;
  }
  return payload as SandboxContainer;
}

function extractSnapshot(raw: unknown): SandboxSnapshot | undefined {
  const payload = extractPayload(raw);
  if (!payload || typeof payload !== 'object') return undefined;
  if ('snapshot' in payload) {
    return (payload as { snapshot?: SandboxSnapshot }).snapshot;
  }
  return payload as SandboxSnapshot;
}

function writeLine(label: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  getUI().line(`  ${label}: ${String(value)}`);
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('expected a positive integer');
  }
  return parsed;
}

async function safeParseResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: text };
  }
}
