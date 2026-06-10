import { Command } from 'commander';
import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { PrismerClient } from '../index';
import type { TaskStatus } from '../types';
import { detectDeliverProxy, proxyDeliver } from './deliver-proxy';

type ClientFactory = () => PrismerClient;
const TASK_STATUSES = new Set<TaskStatus>(['pending', 'assigned', 'running', 'review', 'completed', 'failed', 'cancelled']);
const TASK_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);
const TASK_KINDS = new Set(['work_item', 'goal']);

/**
 * release202/09 §3.2 — fail fast when a chat-dispatch RUN id (`run_…`) is
 * passed to a `cloud task <op>` subcommand. A chat reply closes its own turn —
 * the platform completes the run from the agent's reply, so there is no
 * `cloud task` op to run. Passing a run id to a task route used to 404
 * (`TASK_NOT_FOUND`) because run / task / conversation ids were all
 * indistinguishable cuids; the `run_` prefix makes it a clear, early error.
 *
 * Bare-cuid ids (legacy runs + all tasks) are untouched and stay valid.
 */
function assertNotRunId(id: string | undefined): void {
  if (typeof id === 'string' && id.startsWith('run_')) {
    process.stderr.write(
      `Error: '${id}' is a run id (run_…); a chat reply doesn't need 'cloud task' ops — ` +
        `the platform closes the turn from your reply.\n`,
    );
    process.exit(1);
  }
}

function parseTaskStatus(raw: string | undefined): TaskStatus | undefined {
  if (!raw) return undefined;
  if (TASK_STATUSES.has(raw as TaskStatus)) return raw as TaskStatus;
  throw new Error(`Invalid task status "${raw}".`);
}

function normalizeProjectForCreate(raw: string | undefined): string | null | undefined {
  const value = raw ?? process.env.PRISMER_ACTIVE_PROJECT_ID;
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'all') return undefined;
  if (trimmed === '__unscoped' || trimmed === '_unscoped' || trimmed === 'none' || trimmed === 'null') return null;
  return trimmed;
}

function normalizeProjectForList(raw: string | undefined): string | undefined {
  const value = raw ?? process.env.PRISMER_ACTIVE_PROJECT_ID;
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === '_unscoped' || trimmed === 'none' || trimmed === 'null') return '__unscoped';
  return trimmed;
}

/**
 * Result shape from the local daemon's `/v1/checkpoints/pre_status_change`
 * endpoint. Mirrors `checkpoint-server.ts` so we don't need a shared types
 * package between runtime + SDK.
 */
interface CheckpointResult {
  ok: boolean;
  /** Set when daemon couldn't reach cloud or local fs scan failed. */
  indeterminate?: boolean;
  message?: string;
  pendingFiles?: Array<{ path: string; sha256: string; sizeBytes: number }>;
}

/**
 * Call the daemon's checkpoint hook before sending a `status=review` task
 * update to cloud. Returns `{ ok: true }` for both "no result files" and
 * "all files attached" outcomes. Returns `{ ok: false, pendingFiles: [...] }`
 * when the daemon detected unattached files; the caller (cloud task update)
 * formats them onto stderr.
 *
 * 503 / network error → indeterminate=true; caller asks user to retry with
 * --skip-checkpoint. Default daemon port is 3210; PRISMER_DAEMON_PORT env
 * (set by local-server when listening) overrides.
 */
async function runReviewCheckpoint(taskId: string, toStatus: string): Promise<CheckpointResult> {
  const port = process.env.PRISMER_DAEMON_PORT ?? '3210';
  const url = `http://127.0.0.1:${port}/v1/checkpoints/pre_status_change`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, toStatus }),
    });
  } catch (err) {
    return {
      ok: false,
      indeterminate: true,
      message: `daemon unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let body: { ok?: boolean; pendingFiles?: unknown; error?: { code?: string; message?: string } };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    body = {};
  }
  if (response.status === 200 && body.ok === true) {
    return { ok: true };
  }
  if (response.status === 409 && Array.isArray(body.pendingFiles)) {
    return {
      ok: false,
      pendingFiles: body.pendingFiles as Array<{ path: string; sha256: string; sizeBytes: number }>,
      message: body.error?.message ?? 'pending_attach',
    };
  }
  if (response.status === 503) {
    return {
      ok: false,
      indeterminate: true,
      message: body.error?.message ?? `daemon returned 503`,
    };
  }
  return {
    ok: false,
    message: body.error?.message ?? `daemon returned ${response.status}`,
  };
}

/**
 * Resolve an agent display name / username / slug to its imUserId. Mirrors
 * `resolveAssigneeId` in `sdk/prismer-cloud/mcp/src/tools/create-task.ts` —
 * exact match first (id / username / displayName), fuzzy substring match as
 * fallback. Returns `''` when no match.
 */
async function resolveAssigneeId(
  client: PrismerClient,
  name: string,
): Promise<string> {
  const needle = name.trim().toLowerCase();
  const normalized = needle.replace(/^@/, '');
  if (!needle) return '';

  const res = await client.im.contacts.discover();
  if (!res.ok || !Array.isArray(res.data)) return '';
  const agents = res.data as unknown as Array<Record<string, unknown>>;

  const exact = agents.find((agent) => {
    const values = [agent.userId, agent.username, agent.displayName].map((v) =>
      typeof v === 'string' ? v.trim().toLowerCase() : '',
    );
    return values.includes(needle) || values.includes(normalized);
  });
  if (exact && typeof exact.userId === 'string') return exact.userId;

  const fuzzy = agents.find((agent) => {
    const labels = [agent.username, agent.displayName]
      .map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : ''))
      .filter(Boolean);
    return labels.some((label) => label.includes(normalized) || normalized.includes(label));
  });
  return fuzzy && typeof fuzzy.userId === 'string' ? fuzzy.userId : '';
}

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const task = parent
    .command('task')
    .description('Manage tasks in the task marketplace');

  // task create
  task
    .command('create')
    .description('Create a new task')
    .requiredOption('--title <title>', 'task title')
    .option('--description <description>', 'task description')
    .option('--capability <capability>', 'required agent capability')
    .option('--budget <budget>', 'budget in credits', parseFloat)
    .option('--reward <reward>', 'alias for --budget (credits offered for completion)', parseFloat)
    .option('--priority <priority>', 'task priority: low | medium | high | urgent')
    .option('--assignee-id <imUserId>', 'directly assign to a specific agent by IM user id')
    .option('--assignee-name <name>', 'assign by @username / display name (resolved via discover)')
    .option('--conversation-id <id>', 'pin task to a conversation/session')
    .option('--project <id>', 'scope task to project id; use __unscoped/none for workspace-level')
    .option('--kind <kind>', 'board projection kind: work_item (default) | goal', 'work_item')
    .option('--schedule-at <iso>', 'one-shot ISO 8601 scheduled time (sets scheduleType=once)')
    .option('--schedule-cron <expr>', 'cron expression (sets scheduleType=cron)')
    .option('--json', 'output raw JSON response')
    .action(async (opts: {
      title: string;
      description?: string;
      capability?: string;
      budget?: number;
      reward?: number;
      priority?: string;
      assigneeId?: string;
      assigneeName?: string;
      conversationId?: string;
      project?: string;
      kind?: string;
      scheduleAt?: string;
      scheduleCron?: string;
      json: boolean;
    }) => {
      const client = getIMClient();
      try {
        // Validate enums
        if (opts.priority && !TASK_PRIORITIES.has(opts.priority)) {
          throw new Error(`Invalid --priority "${opts.priority}". Use one of: low, medium, high, urgent.`);
        }
        const kind = opts.kind ?? 'work_item';
        if (!TASK_KINDS.has(kind)) {
          throw new Error(`Invalid --kind "${kind}". Use one of: work_item, goal.`);
        }

        // Resolve assignee
        let assigneeId = opts.assigneeId;
        if (!assigneeId && opts.assigneeName) {
          assigneeId = await resolveAssigneeId(client, opts.assigneeName);
          if (!assigneeId) {
            throw new Error(
              `--assignee-name "${opts.assigneeName}" did not resolve to an agent. Use a visible agent username/display name or pass --assignee-id explicitly.`,
            );
          }
        }

        // budget vs reward (reward is alias)
        const budget = opts.budget ?? opts.reward;

        // metadata (kind + priority + goal payload when kind=goal)
        const metadata: Record<string, unknown> = { kind };
        if (opts.priority) metadata.priority = opts.priority;
        if (opts.conversationId) {
          metadata.context = { linkedConversationId: opts.conversationId };
        }
        if (kind === 'goal') {
          metadata.intent = 'standing_objective';
          metadata.goal = {
            status: 'active',
            priority: opts.priority === 'urgent' ? 'high' : (opts.priority ?? 'medium'),
            linkedConversationIds: opts.conversationId ? [opts.conversationId] : [],
            linkedTaskIds: [],
            lastActivityAt: new Date().toISOString(),
          };
        }

        // Derive scheduleType from schedule-at / schedule-cron
        const createOpts: Record<string, unknown> = {
          title: opts.title,
          description: opts.description,
          capability: opts.capability,
          budget,
          metadata,
        };
        if (assigneeId) createOpts.assigneeId = assigneeId;
        if (opts.conversationId) createOpts.conversationId = opts.conversationId;
        const projectId = normalizeProjectForCreate(opts.project);
        if (projectId !== undefined) createOpts.projectId = projectId;
        if (opts.scheduleAt) {
          createOpts.scheduleType = 'once';
          createOpts.scheduleAt = opts.scheduleAt;
        }
        if (opts.scheduleCron) {
          createOpts.scheduleType = 'cron';
          createOpts.scheduleCron = opts.scheduleCron;
        }

        const res = await client.im.tasks.create(createOpts as any);

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }

        const t = res.data!;
        process.stdout.write(`Task created successfully\n\n`);
        process.stdout.write(`ID:          ${t.id}\n`);
        process.stdout.write(`Title:       ${t.title}\n`);
        process.stdout.write(`Status:      ${t.status}\n`);
        if (t.description) process.stdout.write(`Description: ${t.description}\n`);
        if (t.capability) process.stdout.write(`Capability:  ${t.capability}\n`);
        if (t.budget !== undefined) process.stdout.write(`Budget:      ${t.budget}\n`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // task list
  task
    .command('list')
    .description('List tasks')
    .option('--status <status>', 'filter by status')
    .option('--capability <capability>', 'filter by required capability')
    .option('--project <id>', 'filter by project id; use all or __unscoped')
    .option('-n, --limit <n>', 'maximum number of tasks to return', '20')
    .option('--json', 'output raw JSON response')
    .action(async (opts: {
      status?: string;
      capability?: string;
      project?: string;
      limit: string;
      json: boolean;
    }) => {
      const client = getIMClient();
      try {
        const res = await client.im.tasks.list({
          status: parseTaskStatus(opts.status),
          capability: opts.capability,
          projectId: normalizeProjectForList(opts.project),
          limit: parseInt(opts.limit, 10),
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }

        const tasks = res.data;
        if (!tasks || tasks.length === 0) {
          process.stdout.write('No tasks found.\n');
          return;
        }

        // Table header
        const idW = 24;
        const statusW = 12;
        const titleW = 40;
        const header =
          'ID'.padEnd(idW) +
          'STATUS'.padEnd(statusW) +
          'TITLE';
        const sep = '-'.repeat(idW + statusW + titleW);

        process.stdout.write(header + '\n');
        process.stdout.write(sep + '\n');

        for (const t of tasks) {
          const title = t.title.length > titleW ? t.title.slice(0, titleW - 3) + '...' : t.title;
          process.stdout.write(
            String(t.id).padEnd(idW) +
            String(t.status).padEnd(statusW) +
            title + '\n'
          );
        }

        process.stdout.write(`\n${tasks.length} task(s) listed.\n`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // task move-project <task-id> [project-id]
  task
    .command('move-project <task-id> [project-id]')
    .description('Move a task to a project, or use --unscoped to return it to workspace-level')
    .option('--unscoped', 'set projectId to null', false)
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, projectId: string | undefined, opts: { unscoped?: boolean; json?: boolean }) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      try {
        if (!opts.unscoped && !projectId) {
          throw new Error('Provide <project-id> or pass --unscoped.');
        }
        const targetProjectId = opts.unscoped ? null : projectId!.trim();
        const res = await client.im.tasks.moveProject(taskId, targetProjectId);
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }
        process.stdout.write(`Task ${taskId} project: ${targetProjectId ?? '(workspace-level)'}\n`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // task get <task-id>
  task
    .command('get <task-id>')
    .description('Get task details and logs')
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, opts: { json: boolean }) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      try {
        const res = await client.im.tasks.get(taskId);

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }

        const detail = res.data!;
        const t = detail.task;
        process.stdout.write(`ID:           ${t.id}\n`);
        process.stdout.write(`Title:        ${t.title}\n`);
        process.stdout.write(`Status:       ${t.status}\n`);
        if (t.description) process.stdout.write(`Description:  ${t.description}\n`);
        if (t.capability) process.stdout.write(`Capability:   ${t.capability}\n`);
        if (t.budget !== undefined) process.stdout.write(`Budget:       ${t.budget}\n`);
        if (t.progress != null) process.stdout.write(`Progress:     ${t.progress}\n`);
        if (t.statusMessage) process.stdout.write(`Status Msg:   ${t.statusMessage}\n`);
        if (t.creatorId) process.stdout.write(`Creator:      ${t.creatorId}\n`);
        if (t.assigneeId) process.stdout.write(`Assignee:     ${t.assigneeId}\n`);
        if (t.createdAt) process.stdout.write(`Created:      ${t.createdAt}\n`);
        if (t.updatedAt) process.stdout.write(`Updated:      ${t.updatedAt}\n`);
        if (t.completedAt) process.stdout.write(`Completed:    ${t.completedAt}\n`);
        if (t.result) process.stdout.write(`Result:       ${t.result}\n`);
        if (t.error) process.stdout.write(`Error:        ${t.error}\n`);

        const logs = detail.logs ?? [];
        if (logs.length > 0) {
          process.stdout.write(`\nLogs (${logs.length}):\n`);
          for (const log of logs) {
            const ts = log.createdAt ?? '';
            const msg = log.message ?? JSON.stringify(log);
            process.stdout.write(`  [${ts}] ${msg}\n`);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // task claim <task-id>
  task
    .command('claim <task-id>')
    .description('Claim a pending task')
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, opts: { json: boolean }) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      try {
        const res = await client.im.tasks.claim(taskId);

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }

        const t = res.data!;
        process.stdout.write(`Task claimed successfully\n\n`);
        process.stdout.write(`ID:       ${t.id}\n`);
        process.stdout.write(`Title:    ${t.title}\n`);
        process.stdout.write(`Status:   ${t.status}\n`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // task update <task-id>
  task
    .command('update <task-id>')
    .description('Update a task')
    .option('--title <title>', 'new title')
    .option('--description <description>', 'new description')
    .option('--status <status>', 'new status')
    .option('--progress <progress>', 'progress (0.0 to 1.0)', parseFloat)
    .option('--status-message <statusMessage>', 'status message')
    .option('--skip-checkpoint', 'bypass local daemon checkpoint when transitioning to review (release201/09 §9.4a.7)', false)
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, opts: {
      title?: string;
      description?: string;
      status?: string;
      progress?: number;
      statusMessage?: string;
      skipCheckpoint?: boolean;
      json: boolean;
    }) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      try {
        // release201/09 §9.4a.7 — when transitioning a task into the `review`
        // status, ask the local daemon whether `artifacts/` has any files not
        // yet attached as IMAssets. Daemon checkpoint will 409 with a
        // pendingFiles list when the agent dropped a file but forgot to
        // `cloud task attach` it. The list is formatted to stderr so the
        // hermes/openclaw adapter's stderr → agent context loop surfaces
        // it; we exit 12 so the agent's wrapper knows to retry.
        if (opts.status === 'review' && !opts.skipCheckpoint) {
          const checkpoint = await runReviewCheckpoint(taskId, opts.status);
          if (!checkpoint.ok) {
            if (checkpoint.pendingFiles && checkpoint.pendingFiles.length > 0) {
              process.stderr.write(
                `[checkpoint] artifacts/ 含 ${checkpoint.pendingFiles.length} 个未 attach 文件:\n`,
              );
              for (const f of checkpoint.pendingFiles) {
                const sizeKb = (f.sizeBytes / 1024).toFixed(1);
                process.stderr.write(`  - ${f.path} (sha256=${f.sha256.slice(0, 12)}…, ${sizeKb}KB)\n`);
              }
              process.stderr.write(
                '请 attach 它们再 retry status change, 或加 --skip-checkpoint 显式忽略\n',
              );
            } else if (checkpoint.indeterminate) {
              process.stderr.write(
                `[checkpoint] daemon unreachable or cloud lookup failed (${checkpoint.message}); pass --skip-checkpoint to bypass\n`,
              );
            } else {
              process.stderr.write(`[checkpoint] failed: ${checkpoint.message ?? 'unknown'}\n`);
            }
            process.exit(12);
          }
        }
        const res = await client.im.tasks.update(taskId, {
          title: opts.title,
          description: opts.description,
          status: opts.status as any,
          progress: opts.progress,
          statusMessage: opts.statusMessage,
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }

        const t = res.data!;
        process.stdout.write(`Task updated successfully\n\n`);
        process.stdout.write(`ID:       ${t.id}\n`);
        process.stdout.write(`Title:    ${t.title}\n`);
        process.stdout.write(`Status:   ${t.status}\n`);
        if (t.progress != null) process.stdout.write(`Progress: ${t.progress}\n`);
        if (t.statusMessage) process.stdout.write(`Message:  ${t.statusMessage}\n`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // task complete <task-id>
  task
    .command('complete <task-id>')
    .description('Mark a task as complete')
    .option('--result <result>', 'result or output of the task')
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, opts: { result?: string; json: boolean }) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      try {
        const res = await client.im.tasks.complete(taskId, {
          result: opts.result,
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }

        const t = res.data!;
        process.stdout.write(`Task completed successfully\n\n`);
        process.stdout.write(`ID:     ${t.id}\n`);
        process.stdout.write(`Title:  ${t.title}\n`);
        process.stdout.write(`Status: ${t.status}\n`);
        if (t.result) process.stdout.write(`Result: ${t.result}\n`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // task fail <task-id>
  task
    .command('fail <task-id>')
    .description('Mark a task as failed')
    .requiredOption('--error <error>', 'error message describing why the task failed')
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, opts: { error: string; json: boolean }) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      try {
        const res = await client.im.tasks.fail(taskId, opts.error);

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }

        const t = res.data!;
        process.stdout.write(`Task marked as failed\n\n`);
        process.stdout.write(`ID:     ${t.id}\n`);
        process.stdout.write(`Title:  ${t.title}\n`);
        process.stdout.write(`Status: ${t.status}\n`);
        if (t.error) process.stdout.write(`Error:  ${t.error}\n`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // task approve <task-id>
  task
    .command('approve <task-id>')
    .description('Approve a completed task')
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, opts: { json: boolean }) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      try {
        const res = await client.im.tasks.approve(taskId);

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }

        const t = res.data!;
        process.stdout.write(`Task approved successfully\n\n`);
        process.stdout.write(`ID:     ${t.id}\n`);
        process.stdout.write(`Title:  ${t.title}\n`);
        process.stdout.write(`Status: ${t.status}\n`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // task reject <task-id>
  task
    .command('reject <task-id>')
    .description('Reject a task')
    .requiredOption('--reason <reason>', 'reason for rejection')
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, opts: { reason: string; json: boolean }) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      try {
        const res = await client.im.tasks.reject(taskId, opts.reason);

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }

        const t = res.data!;
        process.stdout.write(`Task rejected\n\n`);
        process.stdout.write(`ID:     ${t.id}\n`);
        process.stdout.write(`Title:  ${t.title}\n`);
        process.stdout.write(`Status: ${t.status}\n`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // task attach <path>
  //
  // release201/09 §9.4a.5 — declare-first唯一通道 for task user-deliverables.
  // No silent dir auto-upload; agent must call this CLI after writing files
  // to `${PRISMER_ARTIFACTS_DIR}` (release202/04 §3.1; legacy
  // `${PRISMER_OUTBOX_DIR}` alias still honored).
  //
  // --task may be omitted; falls back to PRISMER_TASK_ID env (release201/09 §9.9).
  // --name overrides the display filename; defaults to basename(path).
  // Service-side dedup uses (workspaceId, sourceTaskId, contentHash); same hash
  // re-attach returns dedupHit=true without creating a new IMAsset row.
  task
    .command('attach <path>')
    .description('Attach a file to a task as a user-deliverable (release201/09 §9.4a.5)')
    .option('--task <taskId>', 'target task id; defaults to PRISMER_TASK_ID env')
    .option('--name <displayName>', 'override the display filename; defaults to basename(path)')
    // release202/09 P5#2 — hermes has no per-dispatch env; the agent copies the
    // task id out of <execution_context> and passes it as --task / --run-id so
    // the daemon proxy activates. Spawn adapters (claude-code / codex) set
    // PRISMER_TASK_ID + PRISMER_DAEMON_PORT and need no flags.
    .option('--run-id <id>', 'dispatch task id (alias for --task; from <execution_context>; env fallback PRISMER_TASK_ID)')
    .option('--daemon-port <port>', 'daemon local-server port (env fallback PRISMER_DAEMON_PORT, default 3210)')
    .option('--json', 'output raw JSON response')
    .action(async (
      filePath: string,
      opts: { task?: string; name?: string; json: boolean; runId?: string; daemonPort?: string },
    ) => {
      const targetTaskId = opts.task ?? opts.runId ?? process.env.PRISMER_TASK_ID;
      if (!targetTaskId) {
        process.stderr.write('Error: --task is required (or set PRISMER_TASK_ID env)\n');
        process.exit(1);
      }
      // release202/09 §3.2 — `attach` writes a task-bound deliverable; a run
      // id has no kanban card to attach to. Chat-dispatch agents deliver via
      // `cloud send --file` (the reply), not `cloud task attach`. Guard BEFORE
      // any proxy/direct dispatch so a run id is rejected identically on both
      // paths.
      assertNotRunId(targetTaskId);

      // release202/09 P5#2 — when running in-container under a daemon dispatch,
      // proxy to the daemon local-server (动作 ③ / mode:'task-attach'). The
      // in-container agent has no usable IM credential; only the daemon can
      // upload + bind the asset to the task. `task-attach` uploads with
      // `sourceTaskId` set so the cloud rolls it onto the kanban card + asset
      // library (no separate cloud call). Falls through to the direct-cloud
      // path below for non-container callers (`prismer pair` on the user's own
      // machine) — back-compat unchanged.
      const proxy = detectDeliverProxy({
        taskId: targetTaskId,
        daemonPort: opts.daemonPort,
      });
      if (proxy) {
        const result = await proxyDeliver(proxy, filePath, 'task-attach');
        if (!result.ok) {
          process.stderr.write(`Error: ${result.error ?? 'task attach failed'}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Attached to task ${targetTaskId} (assetId: ${result.assetId ?? '-'})\n`);
        return;
      }

      const client = getIMClient();
      try {
        // Lookup workspaceId via the target task. We always send workspaceId
        // explicitly so the service routes the upload to the right tenant
        // even when the daemon is hosting agents from multiple workspaces.
        const getRes = await client.im.tasks.get(targetTaskId);
        if (!getRes.ok || !getRes.data) {
          process.stderr.write(`Error: task ${targetTaskId} not found: ${getRes.error?.message ?? 'unknown'}\n`);
          process.exit(1);
        }
        const wsId = getRes.data.task?.workspaceId;
        if (!wsId) {
          process.stderr.write(`Error: task ${targetTaskId} has no workspaceId; cannot upload\n`);
          process.exit(1);
        }

        let bytes: Buffer;
        try {
          bytes = await fs.readFile(filePath);
        } catch (err) {
          process.stderr.write(`Error: cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(1);
        }
        const contentHash = createHash('sha256').update(bytes).digest('hex');
        const displayName = opts.name ?? basename(filePath);

        // Upload via SDK. The cloud-side POST /assets handler:
        //   - finds an existing IMAsset by (workspaceId, contentHash) →
        //     returns dedup=true with the original row;
        //   - otherwise creates a new row with sourceTaskId + boundKind set;
        // service-layer extension (release201/09) makes the dedup respect
        // sourceTaskId so a hash from another task still creates a new
        // attach row in this task scope (see src/im/api/assets.ts).
        const uploadRes = await client.im.assets.upload(bytes, {
          workspaceId: wsId,
          sourceTaskId: targetTaskId,
          kind: 'agent-output',
          fileName: displayName,
          metadata: {
            // boundKind stamped via metadata so service-side cloud code can
            // mirror onto the column. Service POST handler reads this and
            // populates IMAsset.boundKind='task-bound'.
            boundKind: 'task-bound',
            filename: displayName,
            attachedBy: 'cloud-task-attach',
          },
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify(uploadRes, null, 2) + '\n');
          return;
        }
        if (!uploadRes.ok || !uploadRes.data) {
          process.stderr.write(`Error: attach failed: ${uploadRes.error?.message ?? 'unknown'}\n`);
          process.exit(1);
        }
        const dedupHit = Boolean((uploadRes as { meta?: { dedup?: boolean } }).meta?.dedup);
        const asset = uploadRes.data;
        process.stdout.write(`Attached ${displayName}\n\n`);
        process.stdout.write(`AssetId:      ${asset.id}\n`);
        process.stdout.write(`Task:         ${targetTaskId}\n`);
        process.stdout.write(`ContentHash:  ${contentHash}\n`);
        process.stdout.write(`SizeBytes:    ${bytes.length}\n`);
        process.stdout.write(`Dedup:        ${dedupHit ? 'true (existing IMAsset row)' : 'false (created)'}\n`);
        if (asset.cdnUrl) process.stdout.write(`CDN URL:      ${asset.cdnUrl}\n`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // task cancel <task-id>
  task
    .command('cancel <task-id>')
    .description('Cancel a task')
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, opts: { json: boolean }) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      try {
        const res = await client.im.tasks.cancel(taskId);

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }

        const t = res.data!;
        process.stdout.write(`Task cancelled\n\n`);
        process.stdout.write(`ID:     ${t.id}\n`);
        process.stdout.write(`Title:  ${t.title}\n`);
        process.stdout.write(`Status: ${t.status}\n`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // ── release201/10 rev 2 — SPEC / TODO / acceptance sub-commands ─────────

  // SPEC
  task
    .command('spec-set <task-id>')
    .description('Owner writes / updates SPEC.md for a task')
    .option('-f, --file <path>', 'read SPEC.md content from a file')
    .option('-m, --markdown <markdown>', 'inline SPEC.md content')
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, opts: { file?: string; markdown?: string; json: boolean }) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      try {
        let md = '';
        if (opts.file) {
          md = await fs.readFile(opts.file, 'utf-8');
        } else if (opts.markdown) {
          md = opts.markdown;
        } else {
          throw new Error('one of --file or --markdown is required');
        }
        const res = await client.im.tasks.spec.set(taskId, { markdown: md });
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }
        const v = res.data as { revision: number };
        process.stdout.write(`SPEC.md saved (revision ${v.revision})\n`);
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  task
    .command('spec-show <task-id>')
    .description('Print SPEC.md content for a task')
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, opts: { json: boolean }) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      try {
        const res = await client.im.tasks.spec.get(taskId);
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }
        const v = res.data as { markdown: string; revision: number };
        process.stdout.write(v.markdown);
        if (!v.markdown.endsWith('\n')) process.stdout.write('\n');
        process.stdout.write(`# revision ${v.revision}\n`);
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // TODO
  task
    .command('todo-add <task-id> <text...>')
    .description('Append an item to the task TODO.md (assignee)')
    .option('--depth <n>', 'nesting depth (0..3)', (v) => parseInt(v, 10), 0)
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, text: string[], opts: { depth: number; json: boolean }) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      try {
        const res = await client.im.tasks.todo.add(taskId, {
          text: text.join(' '),
          depth: opts.depth,
        });
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }
        const v = res.data as { doneCount: number; totalCount: number; revision: number };
        process.stdout.write(`TODO item added — ${v.doneCount}/${v.totalCount} (rev ${v.revision})\n`);
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  task
    .command('todo-done <task-id> <index>')
    .description('Mark a TODO item as done')
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, indexRaw: string, opts: { json: boolean }) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      try {
        const idx = parseInt(indexRaw, 10);
        if (!Number.isFinite(idx) || idx < 0) throw new Error('index must be a non-negative integer');
        const res = await client.im.tasks.todo.toggle(taskId, idx, true);
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }
        const v = res.data as { doneCount: number; totalCount: number; progressPct: number };
        process.stdout.write(
          `TODO[${idx}] → done. progress ${v.doneCount}/${v.totalCount} (${Math.round(v.progressPct * 100)}%)\n`,
        );
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  task
    .command('todo-uncheck <task-id> <index>')
    .description('Un-tick a TODO item')
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, indexRaw: string, opts: { json: boolean }) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      try {
        const idx = parseInt(indexRaw, 10);
        if (!Number.isFinite(idx) || idx < 0) throw new Error('index must be a non-negative integer');
        const res = await client.im.tasks.todo.toggle(taskId, idx, false);
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }
        const v = res.data as { doneCount: number; totalCount: number };
        process.stdout.write(`TODO[${idx}] → pending. progress ${v.doneCount}/${v.totalCount}\n`);
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  task
    .command('todo-show <task-id>')
    .description('Render TODO.md checklist + progress for a task')
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, opts: { json: boolean }) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      try {
        const res = await client.im.tasks.todo.list(taskId);
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }
        const v = res.data as {
          items: Array<{ index: number; depth: number; status: string; text: string }>;
          doneCount: number;
          totalCount: number;
          progressPct: number;
          revision: number;
        };
        process.stdout.write(
          `TODO progress: ${v.doneCount}/${v.totalCount} (${Math.round(v.progressPct * 100)}%) · rev ${v.revision}\n`,
        );
        for (const it of v.items) {
          const tick = it.status === 'done' ? '☑' : '☐';
          const indent = '  '.repeat(it.depth);
          process.stdout.write(`  ${indent}${tick} [${it.index}] ${it.text}\n`);
        }
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // Acceptance
  task
    .command('acceptance <task-id>')
    .description('Show acceptance criteria + rolled-up status for a task')
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, opts: { json: boolean }) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      try {
        const res = await client.im.tasks.getAcceptance(taskId);
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }
        const v = res.data as {
          overall: string;
          criteria: Array<{
            id: string;
            status: string;
            expectation: string;
            verifyMode: string;
            verifierAgentId: string | null;
            required?: boolean;
          }>;
          completedCount: number;
          totalCount: number;
        };
        process.stdout.write(`Acceptance for ${taskId}: ${v.overall} (${v.completedCount}/${v.totalCount})\n`);
        for (const c of v.criteria) {
          const mark = c.status === 'passed' ? '✓' : c.status === 'failed' ? '✗' : c.status === 'n/a' ? '·' : '◯';
          const req = c.required === false ? ' [optional]' : '';
          const ver = c.verifierAgentId ? ` @${c.verifierAgentId}` : '';
          process.stdout.write(`  ${mark} [${c.verifyMode}${ver}] ${c.expectation}${req} (${c.status}) — ${c.id}\n`);
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  task
    .command('add-criterion <task-id>')
    .description('Add an acceptance criterion to a task (rev 2 — verifyMode + expectation)')
    .requiredOption(
      '--mode <mode>',
      'verifyMode: qualitative | quantitative | agent-self-check | manual',
    )
    .requiredOption('--expectation <markdown>', 'markdown describing what done looks like')
    .option('--verifier-agent <agentId>', 'verifier agent id (default = creator)')
    .option('--weight <n>', 'weight (numeric, default 1)', parseFloat)
    .option('--optional', 'mark this criterion optional (default required)')
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, opts: {
      mode: string;
      expectation: string;
      verifierAgent?: string;
      weight?: number;
      optional?: boolean;
      json: boolean;
    }) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      try {
        const VALID = ['qualitative', 'quantitative', 'agent-self-check', 'manual'];
        if (!VALID.includes(opts.mode)) {
          throw new Error(`--mode must be one of ${VALID.join(' | ')}`);
        }
        const res = await client.im.tasks.criteria.add(taskId, {
          verifyMode: opts.mode as 'qualitative' | 'quantitative' | 'agent-self-check' | 'manual',
          expectation: opts.expectation,
          verifierAgentId: opts.verifierAgent ?? null,
          weight: opts.weight ?? 1,
          required: !opts.optional,
        });
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }
        const { criterion } = res.data as { criterion: { id: string } };
        process.stdout.write(`Added criterion ${criterion.id} to task ${taskId}\n`);
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  task
    .command('verify <task-id>')
    .description(
      'Assignee self-check: list all agent-self-check criteria + mark them passed (run before status=review)',
    )
    .option('--note <note>', 'note to attach to each self-check', 'agent self-check via `cloud task verify`')
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, opts: { note: string; json: boolean }) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      try {
        const view = await client.im.tasks.getAcceptance(taskId);
        if (!view.ok) {
          process.stderr.write(`Error: ${view.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }
        const v = view.data as {
          criteria: Array<{ id: string; expectation: string; verifyMode: string; status: string }>;
        };
        const targets = v.criteria.filter(
          (c) => c.verifyMode === 'agent-self-check' && c.status === 'pending',
        );
        if (targets.length === 0) {
          process.stdout.write('No pending agent-self-check criteria.\n');
          return;
        }
        const results: Array<{ id: string; outcome: string }> = [];
        let anyFailed = false;
        for (const c of targets) {
          const r = await client.im.tasks.criteria.verify(taskId, c.id, {
            outcome: 'passed',
            note: opts.note,
          });
          results.push({ id: c.id, outcome: r.ok ? 'passed' : 'error' });
          if (!r.ok) anyFailed = true;
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify({ ok: !anyFailed, results }, null, 2) + '\n');
          return;
        }
        for (const r of results) {
          process.stdout.write(`  ${r.outcome === 'passed' ? '✓' : '✗'} ${r.id}\n`);
        }
        if (anyFailed) process.exit(1);
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  task
    .command('verify-criterion <task-id> <criterion-id>')
    .description(
      'Report verify outcome for one criterion. Used by reviewers (manual), verifier agents, and assignees (self-check).',
    )
    .requiredOption('--outcome <outcome>', 'passed | failed | n/a | waived')
    .option('--note <note>', 'free-form markdown: method + result + repro steps')
    .option('--evidence <ref...>', 'evidence refs (repeatable; e.g. asset:<id>, url:..., taskRun:<id>)')
    .option('--waive-reason <reason>', 'required when --outcome waived')
    .option('--json', 'output raw JSON response')
    .action(async (
      taskId: string,
      criterionId: string,
      opts: { outcome: string; note?: string; evidence?: string[]; waiveReason?: string; json: boolean },
    ) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      try {
        const VALID = ['passed', 'failed', 'n/a', 'waived'];
        if (!VALID.includes(opts.outcome)) {
          throw new Error(`--outcome must be one of ${VALID.join(' | ')}`);
        }
        if (opts.outcome === 'waived' && !opts.waiveReason) {
          throw new Error('--waive-reason is required when --outcome waived');
        }
        const outcome = opts.outcome as 'passed' | 'failed' | 'n/a' | 'waived';
        const res = await client.im.tasks.criteria.verify(taskId, criterionId, {
          outcome,
          note: opts.note,
          evidenceRefs: opts.evidence,
          waiveReason: opts.waiveReason,
        });
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }
        process.stdout.write(`Criterion ${criterionId} → ${opts.outcome}\n`);
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  task
    .command('apply-template <task-id>')
    .description('Apply an acceptance criteria template to a task')
    .requiredOption('--template <templateId>', 'template id to apply')
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, opts: { template: string; json: boolean }) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      try {
        const res = await client.im.tasks.applyTemplate(taskId, opts.template);
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }
        const v = res.data as { totalCount: number };
        process.stdout.write(`Applied template ${opts.template} (${v.totalCount} criteria total)\n`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });
}
