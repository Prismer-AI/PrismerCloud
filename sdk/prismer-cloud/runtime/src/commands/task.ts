/**
 * Prismer CLI — Task Commands
 *
 * v1.9.0 Task Router CLI: route tasks, list tasks, monitor status.
 *
 * Commands:
 * - prismer task route <taskId> [options] — Route task to optimal agent
 * - prismer task list [options] — List tasks with filters
 */

import type { CliContext } from '../cli/context.js';
import type { UI } from '../cli/ui.js';
import { createCliContext, loadCliConfig } from '../cli/context.js';

// ─── Types ─────────────────────────────────────────────

interface RouteTaskOptions {
  taskId: string;
  priority?: 'high' | 'normal' | 'low';
  preferredAgentId?: string;
  steps?: Array<{ capability: string }>;
  cloudBaseUrl?: string;
  apiToken?: string;
}

interface ListTasksOptions {
  status?: string;
  capability?: string;
  agent?: string;
  limit?: number;
  cloudBaseUrl?: string;
  apiToken?: string;
}

// ─── Route Task Command ─────────────────────────────────

export async function cmdTaskRoute(
  ctx: CliContext,
  ui: UI,
  args: { taskId?: string; priority?: string; agent?: string; steps?: string },
): Promise<void> {
  const { taskId } = args;

  if (!taskId) {
    if (ui.mode === 'json') {
      ui.json({ ok: false, error: 'MISSING_ARGUMENT', message: 'Missing required argument: taskId' });
    } else {
      ui.error('Missing required argument: taskId');
      ui.info('Usage: prismer task route <taskId> [--priority=high|normal|low] [--agent=agentId]');
    }
    process.exit(1);
  }

  const config = await loadCliConfig(ctx);

  const spinner = ui.spinner('Routing task...');

  try {
    const result = await routeTask({
      taskId,
      priority: (args.priority as 'high' | 'normal' | 'low') || 'normal',
      preferredAgentId: args.agent,
      steps: parseRouteSteps(args.steps),
      cloudBaseUrl: config.cloudBaseUrl,
      apiToken: config.apiToken,
    });

    spinner.stop();

    if (ui.mode === 'json') {
      ui.json({ ok: true, ...result });
    } else {
      ui.success('Task routed successfully!');
      ui.table({
        columns: ['Field', 'Value'],
        rows: [
          { Field: 'Task ID', Value: result.taskId },
          { Field: 'Agent', Value: result.agentId },
          { Field: 'Capability', Value: result.capability },
          { Field: 'Step', Value: `${result.stepIdx + 1}/${result.totalSteps}` },
        ],
      });
    }
  } catch (err: unknown) {
    spinner.stop();
    const message = err instanceof Error ? err.message : String(err);
    if (ui.mode === 'json') {
      ui.json({ ok: false, error: 'ROUTE_FAILED', message });
    } else {
      ui.error(`Failed to route task: ${message}`);
    }
    process.exit(1);
  }
}

async function routeTask(options: RouteTaskOptions): Promise<{
  taskId: string;
  agentId: string;
  capability: string;
  stepIdx: number;
  totalSteps: number;
}> {
  const baseUrl = options.cloudBaseUrl || 'https://prismer.cloud/api';
  const url = new URL(`/api/im/tasks/${encodeURIComponent(options.taskId)}/route`, baseUrl);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.apiToken && { Authorization: `Bearer ${options.apiToken}` }),
    },
    body: JSON.stringify({
      priority: options.priority || 'normal',
      preferredAgentId: options.preferredAgentId,
      ...(options.steps && options.steps.length > 0 ? { steps: options.steps } : {}),
    }),
  });

  const responseData = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${responseData}`);
  }

  const json = JSON.parse(responseData);
  if (json.ok && json.data) {
    if (json.data.taskId && json.data.agentId) {
      return json.data;
    }
    if (json.data.id && options.steps && options.steps.length > 0) {
      return {
        taskId: json.data.id,
        agentId: json.data.assigneeId ?? 'pending',
        capability: options.steps[0].capability,
        stepIdx: 0,
        totalSteps: options.steps.length,
      };
    }
    return json.data;
  }
  throw new Error(json.error?.message || json.error || 'Unknown error');
}

function parseRouteSteps(raw: string | undefined): Array<{ capability: string }> | undefined {
  if (!raw) return undefined;
  const capabilities = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (capabilities.length === 0) return undefined;
  return capabilities.map((capability) => ({ capability }));
}

// ─── List Tasks Command ─────────────────────────────────

export async function cmdTaskList(
  ctx: CliContext,
  ui: UI,
  args: { status?: string; capability?: string; agent?: string; limit?: string },
): Promise<void> {
  const config = await loadCliConfig(ctx);

  const spinner = ui.spinner('Fetching tasks...');

  try {
    const tasks = await listTasks({
      status: args.status,
      capability: args.capability,
      agent: args.agent,
      limit: args.limit ? Number.parseInt(args.limit) : undefined,
      cloudBaseUrl: config.cloudBaseUrl,
      apiToken: config.apiToken,
    });

    spinner.stop();

    if (ui.mode === 'json') {
      ui.json({ ok: true, tasks });
      return;
    }

    if (tasks.length === 0) {
      ui.info('No tasks found matching criteria');
      return;
    }

    ui.success(`Found ${tasks.length} task(s)`);
    ui.table({
      columns: ['ID', 'Title', 'Status', 'Agent', 'Capability'],
      rows: tasks.map((task) => ({
        ID: task.id.slice(0, 12) + '...',
        Title: task.title.slice(0, 30) + (task.title.length > 30 ? '...' : ''),
        Status: task.status,
        Agent: task.assigneeId || '-',
        Capability: task.requiresCapability || '-',
      })),
    });
  } catch (err: unknown) {
    spinner.stop();
    const message = err instanceof Error ? err.message : String(err);
    if (ui.mode === 'json') {
      ui.json({ ok: false, error: 'LIST_FAILED', message });
    } else {
      ui.error(`Failed to list tasks: ${message}`);
    }
    process.exit(1);
  }
}

async function listTasks(
  options: ListTasksOptions,
): Promise<
  Array<{
    id: string;
    title: string;
    status: string;
    assigneeId: string | null;
    requiresCapability: string | null;
  }>
> {
  const baseUrl = options.cloudBaseUrl || 'https://prismer.cloud/api';
  const url = new URL('/api/im/tasks', baseUrl);

  // Add query params
  if (options.status) {
    url.searchParams.append('status', options.status);
  }
  if (options.capability) {
    url.searchParams.append('capability', options.capability);
  }
  if (options.agent) {
    url.searchParams.append('assigneeId', options.agent);
  }
  if (options.limit) {
    url.searchParams.append('limit', options.limit.toString());
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      ...(options.apiToken && { Authorization: `Bearer ${options.apiToken}` }),
    },
  });
  const responseData = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${responseData}`);
  }

  const json = JSON.parse(responseData);
  if (json.ok && json.data) {
    return json.data;
  }
  throw new Error(json.error?.message || json.error || 'Unknown error');
}

// ─── Register Commands ─────────────────────────────

export function registerTaskCommands(
  program: any,
  ui: UI,
): void {
  const taskCmd = program.command('task');

  taskCmd
    .command('route')
    .argument('<taskId>', 'Task ID to route')
    .option('--priority <high|normal|low>', 'Task priority (default: normal)')
    .option('--agent <agentId>', 'Preferred agent ID')
    .option('--steps <capabilities>', 'Comma-separated route capabilities, e.g. code.write,code.review')
    .action(async (taskId: string, options: { priority?: string; agent?: string; steps?: string }) => {
      const ctx = await createCliContext({ argv: process.argv, ui });
      await cmdTaskRoute(ctx, ui, { taskId, ...options });
    });

  taskCmd
    .command('list')
    .option('--status <status>', 'Filter by task status')
    .option('--capability <capability>', 'Filter by required capability')
    .option('--agent <agentId>', 'Filter by assigned agent')
    .option('--limit <number>', 'Maximum number of tasks to return')
    .action(async (options: { status?: string; capability?: string; agent?: string; limit?: string }) => {
      const ctx = await createCliContext({ argv: process.argv, ui });
      await cmdTaskList(ctx, ui, options);
    });
}
