// `prismer cookbook run` — CLI-only 54release MVP regression entrypoint.

import { Command } from 'commander';
import { CloudClient, type CloudResponse } from '../../auth.js';
import { loadConfig, resolvePaths } from '../../config.js';
import { color, exitWithError, printJson, runAction } from '../util.js';
import { getUI } from '../ui.js';

type SuiteName = 'status' | 'im' | 'task' | 'group' | 'asset' | 'sandbox' | 'all';
type CheckStatus = 'pass' | 'fail' | 'skip';

interface CookbookOptions {
  suite: string;
  workspaceId?: string;
  agentId?: string;
  groupId?: string;
  sandboxId?: string;
  prompt?: string;
  timeoutMs: number;
  strict?: boolean;
  json?: boolean;
}

interface CheckResult {
  suite: Exclude<SuiteName, 'all'>;
  name: string;
  status: CheckStatus;
  detail?: string;
  endpoint?: string;
  data?: unknown;
}

interface RunSummary {
  ok: boolean;
  totals: Record<CheckStatus, number>;
  checks: CheckResult[];
}

export function buildCookbookCommand(): Command {
  const cmd = new Command('cookbook').description('Run CLI-only 54release MVP regression suites');

  cmd
    .command('run')
    .description('Run one or more cookbook smoke suites using the configured API key')
    .option('--suite <name>', 'status|im|task|group|asset|sandbox|all, comma-separated', 'all')
    .option('--workspace-id <id>', 'Workspace id for workspace-scoped suites')
    .option('--agent-id <id>', 'Agent IM user id for task create smoke')
    .option('--group-id <id>', 'Group/conversation id for group message history smoke')
    .option('--sandbox-id <id>', 'Sandbox id for sandbox status smoke')
    .option('--prompt <text>', 'Prompt for optional task create smoke')
    .option('--timeout-ms <ms>', 'Request/task timeout', parsePositiveInt, 60_000)
    .option('--strict', 'Treat skipped optional checks as failure')
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[CookbookOptions]>(async (opts) => {
      const suites = parseSuites(opts.suite);
      const cloud = mkCloud(opts.timeoutMs);
      const checks: CheckResult[] = [];

      for (const suite of suites) {
        checks.push(...await runSuite(suite, cloud, opts));
      }

      const summary = summarize(checks, Boolean(opts.strict));
      if (opts.json) {
        printJson(summary);
      } else {
        printSummary(summary, Boolean(opts.strict));
      }
      if (!summary.ok) process.exit(1);
    }, { code: 'cookbook_failed' }));

  return cmd;
}

function mkCloud(timeoutMs: number): CloudClient {
  const cfg = loadConfig(resolvePaths());
  return new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key, defaultTimeoutMs: timeoutMs });
}

async function runSuite(
  suite: Exclude<SuiteName, 'all'>,
  cloud: CloudClient,
  opts: CookbookOptions,
): Promise<CheckResult[]> {
  switch (suite) {
    case 'status':
      return runStatusSuite(cloud);
    case 'im':
      return runIMSuite(cloud);
    case 'task':
      return runTaskSuite(cloud, opts);
    case 'group':
      return runGroupSuite(cloud, opts);
    case 'asset':
      return runAssetSuite(cloud, opts);
    case 'sandbox':
      return runSandboxSuite(cloud, opts);
  }
}

async function runStatusSuite(cloud: CloudClient): Promise<CheckResult[]> {
  return [
    await check('status', 'cloud health', 'GET', '/api/health'),
    await check('status', 'current IM identity', 'GET', '/api/im/me', undefined, cloud),
  ];

  async function check(
    suite: Exclude<SuiteName, 'all'>,
    name: string,
    method: 'GET',
    path: string,
    body?: unknown,
    client: CloudClient = cloud,
  ): Promise<CheckResult> {
    return requestCheck(client, suite, name, method, path, body);
  }
}

async function runIMSuite(cloud: CloudClient): Promise<CheckResult[]> {
  return [
    await requestCheck(cloud, 'im', 'workspace list', 'GET', '/api/im/workspaces'),
    await requestCheck(cloud, 'im', 'owned agent list', 'GET', '/api/im/me/agents'),
    await requestCheck(cloud, 'im', 'group list', 'GET', '/api/im/groups'),
  ];
}

async function runTaskSuite(cloud: CloudClient, opts: CookbookOptions): Promise<CheckResult[]> {
  const checks = [
    await requestCheck(cloud, 'task', 'task list', 'GET', '/api/im/tasks?view=board&kind=work_item,goal&limit=5'),
  ];
  if (!opts.agentId || !opts.prompt) {
    checks.push(skip('task', 'task create+poll', 'Pass --agent-id and --prompt to run an end-to-end agent lifecycle smoke.'));
    return checks;
  }

  const created = await requestCheck(cloud, 'task', 'task create', 'POST', '/api/im/tasks', {
    title: opts.prompt.slice(0, 80),
    assigneeId: opts.agentId,
    capability: 'chat',
    input: { prompt: opts.prompt },
    ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    timeoutMs: opts.timeoutMs,
  });
  checks.push(created);
  const taskId = taskIdFrom(created.data);
  if (!taskId) {
    checks.push({
      suite: 'task',
      name: 'task poll',
      status: 'fail',
      detail: 'Task create response did not include a task id.',
      endpoint: '/api/im/tasks/:id',
    });
    return checks;
  }

  checks.push(await pollTask(cloud, taskId, opts.timeoutMs));
  return checks;
}

async function runGroupSuite(cloud: CloudClient, opts: CookbookOptions): Promise<CheckResult[]> {
  const checks = [
    await requestCheck(cloud, 'group', 'group list', 'GET', '/api/im/groups'),
  ];
  if (!opts.groupId) {
    checks.push(skip('group', 'group messages', 'Pass --group-id to verify group history access.'));
    return checks;
  }
  checks.push(await requestCheck(cloud, 'group', 'group messages', 'GET', `/api/im/groups/${encodeURIComponent(opts.groupId)}/messages?limit=5`));
  return checks;
}

async function runAssetSuite(cloud: CloudClient, opts: CookbookOptions): Promise<CheckResult[]> {
  const query = new URLSearchParams();
  if (opts.workspaceId) query.set('workspaceId', opts.workspaceId);
  const suffix = query.toString();
  return [
    await requestCheck(cloud, 'asset', 'asset list', 'GET', `/api/im/assets${suffix ? `?${suffix}` : ''}`),
  ];
}

async function runSandboxSuite(cloud: CloudClient, opts: CookbookOptions): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  if (!opts.workspaceId) {
    checks.push(skip('sandbox', 'sandbox list', 'Pass --workspace-id to verify sandbox ownership-scoped list access.'));
  } else {
    checks.push(await requestCheck(cloud, 'sandbox', 'sandbox list', 'GET', `/api/sandboxes?workspaceId=${encodeURIComponent(opts.workspaceId)}&limit=5`));
  }
  if (!opts.sandboxId) {
    checks.push(skip('sandbox', 'sandbox status', 'Pass --sandbox-id to verify a concrete sandbox container.'));
  } else {
    checks.push(await requestCheck(cloud, 'sandbox', 'sandbox status', 'GET', `/api/sandboxes/${encodeURIComponent(opts.sandboxId)}`));
  }
  return checks;
}

async function requestCheck(
  cloud: CloudClient,
  suite: Exclude<SuiteName, 'all'>,
  name: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<CheckResult> {
  let res: CloudResponse<unknown>;
  try {
    res = await cloud.request(method, path, body === undefined ? undefined : { body });
  } catch (err) {
    return { suite, name, status: 'fail', endpoint: path, detail: sanitize((err as Error).message) };
  }
  if (!res.ok) {
    return {
      suite,
      name,
      status: 'fail',
      endpoint: path,
      detail: sanitize(`${res.status}: ${res.error?.message ?? 'request failed'}`),
    };
  }

  const data = unwrap(res.data);
  if (isApiError(res.data)) {
    return { suite, name, status: 'fail', endpoint: path, detail: sanitize(apiErrorMessage(res.data)), data: res.data };
  }
  return { suite, name, status: 'pass', endpoint: path, detail: summarizeData(data), data };
}

async function pollTask(cloud: CloudClient, taskId: string, timeoutMs: number): Promise<CheckResult> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const check = await requestCheck(cloud, 'task', 'task poll', 'GET', `/api/im/tasks/${encodeURIComponent(taskId)}`);
    if (check.status !== 'pass') return check;
    const task = taskFrom(check.data);
    const status = task?.status;
    if (status && ['completed', 'failed', 'cancelled'].includes(status)) {
      return {
        ...check,
        status: status === 'completed' ? 'pass' : 'fail',
        detail: `terminal status=${status}`,
      };
    }
  }
  return {
    suite: 'task',
    name: 'task poll',
    status: 'fail',
    endpoint: `/api/im/tasks/${taskId}`,
    detail: `Task did not reach terminal state within ${timeoutMs}ms.`,
  };
}

function parseSuites(raw: string): Array<Exclude<SuiteName, 'all'>> {
  const selected = raw
    .split(',')
    .map((s) => s.trim() as SuiteName)
    .filter(Boolean);
  const valid = new Set<SuiteName>(['status', 'im', 'task', 'group', 'asset', 'sandbox', 'all']);
  for (const suite of selected) {
    if (!valid.has(suite)) exitWithError(`unknown cookbook suite: ${suite}`);
  }
  const expanded = selected.includes('all')
    ? ['status', 'im', 'task', 'group', 'asset', 'sandbox']
    : selected;
  return [...new Set(expanded)] as Array<Exclude<SuiteName, 'all'>>;
}

function summarize(checks: CheckResult[], strict: boolean): RunSummary {
  const totals = { pass: 0, fail: 0, skip: 0 };
  for (const check of checks) totals[check.status] += 1;
  return {
    ok: totals.fail === 0 && (!strict || totals.skip === 0),
    totals,
    checks,
  };
}

function printSummary(summary: RunSummary, strict: boolean): void {
  const ui = getUI();
  ui.header('54release CLI cookbook regression');
  ui.blank();
  for (const check of summary.checks) {
    const label = `[${check.suite}] ${check.name}`;
    if (check.status === 'pass') ui.ok(label, check.detail);
    else if (check.status === 'skip') ui.warn(label, check.detail);
    else ui.fail(label, check.detail);
  }
  const skipLabel = strict && summary.totals.skip > 0 ? 'skip-as-fail' : 'skip';
  ui.blank();
  const verdict = summary.ok ? color('green', 'PASS') : color('red', 'FAIL');
  ui.line(`${verdict}  pass=${summary.totals.pass} fail=${summary.totals.fail} ${skipLabel}=${summary.totals.skip}`);
}

function skip(suite: Exclude<SuiteName, 'all'>, name: string, detail: string): CheckResult {
  return { suite, name, status: 'skip', detail };
}

function unwrap(raw: unknown): unknown {
  if (raw && typeof raw === 'object') {
    if ('ok' in raw && (raw as { ok?: boolean }).ok !== false && 'data' in raw) return (raw as { data?: unknown }).data;
    if ('success' in raw && (raw as { success?: boolean }).success !== false && 'data' in raw) return (raw as { data?: unknown }).data;
  }
  return raw;
}

function isApiError(raw: unknown): boolean {
  return Boolean(
    raw &&
      typeof raw === 'object' &&
      (('ok' in raw && (raw as { ok?: boolean }).ok === false) ||
        ('success' in raw && (raw as { success?: boolean }).success === false)),
  );
}

function apiErrorMessage(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return 'API returned an error';
  const error = (raw as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message?: unknown }).message);
  return 'API returned an error';
}

function summarizeData(data: unknown): string | undefined {
  if (Array.isArray(data)) return `${data.length} item${data.length === 1 ? '' : 's'}`;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id : typeof obj.imUserId === 'string' ? obj.imUserId : undefined;
    const status = typeof obj.status === 'string' ? obj.status : undefined;
    return [id ? `id=${id}` : undefined, status ? `status=${status}` : undefined].filter(Boolean).join(' ') || undefined;
  }
  return undefined;
}

function taskIdFrom(data: unknown): string | undefined {
  const task = taskFrom(data);
  return task?.id;
}

function taskFrom(data: unknown): { id?: string; status?: string } | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const obj = data as Record<string, unknown>;
  const task = obj.task && typeof obj.task === 'object' ? obj.task as Record<string, unknown> : obj;
  return {
    id: typeof task.id === 'string' ? task.id : undefined,
    status: typeof task.status === 'string' ? task.status : undefined,
  };
}

function sanitize(message: string): string {
  return message.replace(/sk-prismer-[A-Za-z0-9_-]+/g, 'sk-prismer-***');
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('expected a positive integer');
  }
  return parsed;
}
