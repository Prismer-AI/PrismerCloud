// `prismer task (list|get|cancel|create)` — task control.
//
// `create` is a developer-convenience: POSTs to /api/im/tasks and polls
// /api/im/tasks/:id until terminal. Equivalent to mobile creating the task,
// then waiting for SSE; useful for daemon-side e2e and manual smoke tests.

import { Command } from 'commander';
import { setTimeout as sleep } from 'node:timers/promises';
import { CloudClient } from '../../auth.js';
import { loadConfig, resolvePaths } from '../../config.js';
import { exitWithError, printJson, runAction } from '../util.js';
import { getUI } from '../ui.js';

function describeStatus(status: number): string {
  return status === 0 ? 'network error' : `HTTP ${status}`;
}

interface TaskRecord {
  id: string;
  status: string;
  output?: string | null;
  error?: { code?: string; message?: string } | null;
  metrics?: { tokensUsed?: number; durationMs?: number } | null;
}

export function buildTaskCommand(): Command {
  const cmd = new Command('task').description('Manage tasks');

  cmd
    .command('create')
    .description('Create + dispatch a task to the given agent and wait for completion')
    .requiredOption('--agent <imUserId>', 'Assignee agent IMUser.id')
    .requiredOption('--prompt <text>', 'Prompt to send to the adapter')
    .option('--profile <profileId>', 'AgentProfile id (cloud picks first if omitted)')
    .option('--capability <name>', 'Capability tag', 'chat')
    .option('--title <text>', 'Task title (defaults to prompt prefix)')
    .option('--timeout-ms <ms>', 'Per-task timeout', (v) => Number.parseInt(v, 10))
    .option('--no-wait', "Just create + print task id; don't poll")
    .option('--json', 'Output JSON (default)')
    .action(runAction<[{ agent: string; prompt: string; profile?: string; capability: string; title?: string; timeoutMs?: number; wait?: boolean }]>(async (opts) => {
      const cloud = mkCloud();
      const body: Record<string, unknown> = {
        title: opts.title ?? opts.prompt.slice(0, 80),
        assigneeId: opts.agent,
        capability: opts.capability,
        input: { prompt: opts.prompt },
      };
      if (opts.timeoutMs) body.timeoutMs = opts.timeoutMs;
      if (opts.profile) body.metadata = { profileId: opts.profile };

      const create = await cloud.request<{ data?: TaskRecord }>('POST', '/api/im/tasks', { body });
      if (!create.ok) {
        exitWithError(
          `create failed (${describeStatus(create.status)}): ${create.error?.message ?? 'request failed'}`,
          { code: create.error?.code ?? 'task_create_failed' },
        );
      }
      const taskId = taskFrom(create.data)?.id;
      if (!taskId) exitWithError('cloud returned no task id', { code: 'task_create_no_id' });

      if (opts.wait === false) {
        printJson({ taskId });
        return;
      }

      const result = await pollUntilTerminal(cloud, taskId!, opts.timeoutMs);
      printJson(result);
      if (result.status !== 'completed') process.exit(1);
    }, { code: 'task_create_failed' }));

  cmd
    .command('list')
    .description('List board tasks. Default = the WHOLE workspace board (every card, any assignee); use --mine for only your own.')
    .option('--limit <n>', 'Max items', (v) => Number.parseInt(v, 10))
    .option('--runs', 'List execution runs instead of board tasks')
    .option('--all', 'List all task-store records, including legacy mixed rows')
    .option('--mine', 'Only tasks assigned to YOU (resolves self from PRISMER_AGENT_IM_USER_ID)')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[{ limit?: number; runs?: boolean; all?: boolean; mine?: boolean }]>(async (opts) => {
      const cloud = mkCloud();
      const limit = opts.limit ?? 20;
      const query = new URLSearchParams({ limit: String(limit) });
      // Self identity, injected into the agent process by the daemon. Used both
      // for the --mine server-side filter and to annotate each card with `mine`
      // so an agent can tell its own cards from another role's at a glance —
      // the board is shared, so seeing a card does NOT mean it is yours to work.
      const selfImUserId = process.env.PRISMER_AGENT_IM_USER_ID?.trim() || undefined;
      if (opts.all) {
        query.set('view', 'all');
      } else if (opts.runs) {
        query.set('view', 'runs');
        query.set('kind', 'agent_run');
      } else {
        query.set('view', 'board');
        query.set('kind', 'work_item,goal');
      }
      if (opts.mine) {
        if (!selfImUserId) {
          exitWithError(
            '--mine needs your im user id but PRISMER_AGENT_IM_USER_ID is not set; pass --assignee-id <self> explicitly',
            { code: 'task_list_no_self_id' },
          );
        }
        query.set('assigneeId', selfImUserId);
      }
      const data = await cloud.get(`/api/im/tasks?${query.toString()}`);
      printJson(annotateOwnership(data, selfImUserId));
    }, { code: 'task_list_failed' }));

  cmd
    .command('get <taskId>')
    .description('Fetch a single task by id')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[string]>(async (taskId) => {
      const cloud = mkCloud();
      const data = await cloud.get(`/api/im/tasks/${encodeURIComponent(taskId)}`);
      printJson(data);
    }, { code: 'task_get_failed' }));

  cmd
    .command('cancel <taskId>')
    .description('Cancel a running task')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[string]>(async (taskId) => {
      const cloud = mkCloud();
      const res = await cloud.request('PATCH', `/api/im/tasks/${encodeURIComponent(taskId)}`, {
        body: { status: 'cancelled' },
      });
      if (!res.ok) {
        exitWithError(
          `cancel failed (${describeStatus(res.status)}): ${res.error?.message ?? 'request failed'}`,
          { code: res.error?.code ?? 'task_cancel_failed' },
        );
      }
      printJson({ ok: true });
    }, { code: 'task_cancel_failed' }));

  return cmd;
}

/**
 * Tag each board card with `mine: boolean` so the agent reading `cloud task list`
 * can immediately tell its own cards from another role's. The board is shared and
 * informational — a card whose `assigneeId` is someone else is read-only context,
 * NOT yours to claim/start/complete (the permission layer 403s the transition, and
 * poaching another role's task is a collaboration anti-pattern). Without this the
 * raw payload only carries an opaque `assigneeId` cuid the agent can't compare.
 *
 * Non-destructive: leaves the original fields intact and just adds `mine`. Works on
 * a bare array, or an object wrapping `tasks` / `items` / `data`.
 */
function annotateOwnership(payload: unknown, selfImUserId: string | undefined): unknown {
  const tag = (task: unknown): unknown => {
    if (!task || typeof task !== 'object') return task;
    const t = task as Record<string, unknown>;
    if (!('assigneeId' in t)) return task;
    const assigneeId = typeof t.assigneeId === 'string' ? t.assigneeId : null;
    return {
      ...t,
      mine: selfImUserId != null && assigneeId != null && assigneeId === selfImUserId,
    };
  };
  if (Array.isArray(payload)) return payload.map(tag);
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of ['tasks', 'items', 'data'] as const) {
      if (Array.isArray(obj[key])) {
        return { ...obj, [key]: (obj[key] as unknown[]).map(tag) };
      }
    }
  }
  return payload;
}

function mkCloud(): CloudClient {
  const cfg = loadConfig(resolvePaths());
  return new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
}

function unwrap(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'data' in (raw as object)) {
    return (raw as { data?: unknown }).data;
  }
  return raw;
}

async function pollUntilTerminal(cloud: CloudClient, taskId: string, timeoutMs?: number): Promise<TaskRecord> {
  const deadline = Date.now() + (timeoutMs ?? 5 * 60_000);
  while (Date.now() < deadline) {
    await sleep(1_000);
    const res = await cloud.request<{ data?: TaskRecord } | TaskRecord>(
      'GET',
      `/api/im/tasks/${encodeURIComponent(taskId)}`,
    );
    if (!res.ok) {
      // transient — keep polling unless 404 / auth fail
      if (res.status === 404 || res.status === 401 || res.status === 403) {
        throw new Error(`poll failed (${res.status}): ${res.error?.message}`);
      }
      continue;
    }
    const rec = taskFrom(res.data);
    if (!rec) continue;
    if (['completed', 'failed', 'cancelled'].includes(rec.status)) return rec;
  }
  throw new Error(`task ${taskId} did not reach terminal state within timeout`);
}

function taskFrom(raw: unknown): TaskRecord | undefined {
  const unwrapped = unwrap(raw) ?? raw;
  if (!unwrapped || typeof unwrapped !== 'object') return undefined;
  const obj = unwrapped as Record<string, unknown>;
  const task = obj.task && typeof obj.task === 'object' ? obj.task as Record<string, unknown> : obj;
  const result = task.result && typeof task.result === 'object' ? task.result as Record<string, unknown> : undefined;
  const id = typeof task.id === 'string' ? task.id : undefined;
  const status = typeof task.status === 'string' ? task.status : undefined;
  if (!id || !status) return undefined;
  return {
    ...(task as unknown as TaskRecord),
    id,
    status,
    output: typeof task.output === 'string'
      ? task.output
      : typeof result?.output === 'string'
        ? result.output
        : null,
    error: (task.error as TaskRecord['error']) ?? null,
    metrics: (task.metrics as TaskRecord['metrics']) ?? (result?.metrics as TaskRecord['metrics']) ?? null,
  };
}
