import { Command } from 'commander';
import { PrismerClient } from '../index';

type ClientFactory = () => PrismerClient;

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
    .option('--json', 'output raw JSON response')
    .action(async (opts: {
      title: string;
      description?: string;
      capability?: string;
      budget?: number;
      json: boolean;
    }) => {
      const client = getIMClient();
      try {
        const res = await client.im.tasks.create({
          title: opts.title,
          description: opts.description,
          capability: opts.capability,
          budget: opts.budget,
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
    .option('-n, --limit <n>', 'maximum number of tasks to return', '20')
    .option('--json', 'output raw JSON response')
    .action(async (opts: {
      status?: string;
      capability?: string;
      limit: string;
      json: boolean;
    }) => {
      const client = getIMClient();
      try {
        const res = await client.im.tasks.list({
          status: opts.status,
          capability: opts.capability,
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

  // task get <task-id>
  task
    .command('get <task-id>')
    .description('Get task details and logs')
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, opts: { json: boolean }) => {
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

        const t = res.data!;
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

        const logs = t.logs ?? t.taskLogs ?? [];
        if (logs.length > 0) {
          process.stdout.write(`\nLogs (${logs.length}):\n`);
          for (const log of logs) {
            const ts = log.createdAt ?? log.timestamp ?? '';
            const msg = log.message ?? log.content ?? JSON.stringify(log);
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
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, opts: {
      title?: string;
      description?: string;
      status?: string;
      progress?: number;
      statusMessage?: string;
      json: boolean;
    }) => {
      const client = getIMClient();
      try {
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

  // task cancel <task-id>
  task
    .command('cancel <task-id>')
    .description('Cancel a task')
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, opts: { json: boolean }) => {
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
}
