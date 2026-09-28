import { Command } from 'commander';
import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PrismerClient } from '../index';
import type { TaskStatus } from '../types';
import { detectDeliverProxy, proxyDeliver } from './deliver-proxy';
// Cloud owns its task-wait command builder. Runtime keeps a compatibility copy;
// command-contract tests prevent behavior drift without a source dependency.
import { buildTaskWaitCommand, type TaskWaitAdapter } from './shared/task-wait-builder';

type ClientFactory = () => PrismerClient;
// runtime210/06 W1b 评审修复 — 九态镜像的运行时校验面（此前漏改，--to blocked 类型合法运行时被拒）。
const TASK_STATUSES = new Set<TaskStatus>([
  'pending',
  'assigned',
  'running',
  'review',
  'blocked',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
]);
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

/** Read all of stdin as a UTF-8 string; '' when stdin is a TTY (nothing piped). */
async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `POST /tasks/:id/event` (task.ts:2510-2514) 403s with `TASK_ACCESS_DENIED`
 * when the caller is not the task's assignee. Same shape as `skill.ts`'s
 * private `isNotAssigneeError` — duplicated locally rather than shared across
 * command modules for one route-specific check.
 */
function isNotTaskAssigneeError(err: { code?: string; message?: string } | undefined): boolean {
  if (!err) return false;
  return err.code === 'TASK_ACCESS_DENIED' || /only the task assignee/i.test(err.message ?? '');
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

// ── apc P0-2 — `cloud task meta set` assignment parsing ────────────────────

interface MetaAssignment {
  /** Dotted key split into a path; length > 1 means a nested write. */
  path: string[];
  value: unknown;
}

/**
 * `key=value` / `a.b.c=value`. Only the FIRST `=` splits, so values may contain
 * `=`.
 *
 * With `json: true` (the `--set` surface) the value is parsed as JSON when it
 * parses and kept as a raw string when it doesn't. That inference is NOT safe
 * for identifiers that merely happen to look numeric: a 7-char git sha is
 * all-digits ~3.7% of the time ((10/16)^7), so `--set sha=1234567` silently
 * stores the NUMBER 1234567, and a 40-char all-digit sha becomes
 * 1.2345678901234568e+39 — the provenance value is destroyed, not just
 * retyped. `--set-string` (`json: false`) is the surface for those: every value
 * stays a string, whatever it looks like.
 */
export function parseMetaAssignments(raw: string[], opts: { json?: boolean } = {}): MetaAssignment[] {
  const optionName = opts.json === false ? '--set-string' : '--set';
  return raw.map((entry) => {
    const eq = entry.indexOf('=');
    if (eq <= 0) throw new Error(`invalid ${optionName} "${entry}" — expected key=value`);
    const key = entry.slice(0, eq).trim();
    const rawValue = entry.slice(eq + 1);
    const path = key.split('.').map((seg) => seg.trim());
    if (path.some((seg) => seg.length === 0)) {
      throw new Error(`invalid ${optionName} key "${key}" — empty path segment`);
    }
    if (opts.json === false) return { path, value: rawValue };
    let value: unknown = rawValue;
    try {
      value = JSON.parse(rawValue);
    } catch {
      /* not JSON — keep the raw string */
    }
    return { path, value };
  });
}

/**
 * Write one assignment into `patch` (the object that will be PATCHed).
 *
 * Top-level (`a=1`) writes straight into `patch`. Nested (`a.b=1`) seeds
 * `patch[a]` from the task's CURRENT metadata first, because the server merges
 * only at the top level — without the seed the PATCH would replace `a` wholesale
 * and drop its other keys (e.g. `assets.aggregatedAssetIds`).
 */
export function applyMetaAssignment(
  patch: Record<string, unknown>,
  current: Record<string, unknown>,
  assignment: MetaAssignment,
): void {
  const [head, ...rest] = assignment.path;
  if (rest.length === 0) {
    patch[head] = assignment.value;
    return;
  }
  if (!(head in patch)) {
    const seed = current[head];
    patch[head] = seed && typeof seed === 'object' && !Array.isArray(seed)
      ? { ...(seed as Record<string, unknown>) }
      : {};
  }
  let cursor = patch[head];
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
    cursor = {};
    patch[head] = cursor;
  }
  let node = cursor as Record<string, unknown>;
  for (let i = 0; i < rest.length - 1; i++) {
    const seg = rest[i];
    const child = node[seg];
    const next = child && typeof child === 'object' && !Array.isArray(child)
      ? { ...(child as Record<string, unknown>) }
      : {};
    node[seg] = next;
    node = next;
  }
  node[rest[rest.length - 1]] = assignment.value;
}

// ── apc/05 §1 C2 — `cloud task test-feedback` TierResult → cockpit mapping ──
//
// Consumer (the reason this exists): `src/im/services/insights-cockpit.service.ts`
// (`getAcceptanceFeedback`) reads `im_task_logs` rows with
// `action='test_result_feedback'` and expects `metadata.status` to be exactly
// one of `'passed' | 'failed' | 'env_blocked'`, `metadata.tiers` to be an
// array whose items each carry a string `.tier`, and `metadata.failureCount`
// to be a number. That reader has existed with NO writer anywhere in the repo
// (docs/apc/05-devchain-gaps-and-skills.md §1 C2's other half — the
// per-criterion rollup already had a writer via `verify-criterion`; the
// whole-run rollup to cockpit did not).
//
// Producer shape (input): the top-level JSON `apc test --json` /
// `scripts/test203/run.ts`'s `jsonReport()` writes to stdout —
// `{ schema, timestamp, doctor, envStatus, tiers: TierResult[], regressions,
// fixed, exitCode }`. This module only reads the fields it needs; it does not
// import `scripts/test203/run.ts` (that script lives outside this package's
// build graph and is not a workspace dependency).
export interface ApcTestTierInput {
  tier: string;
  passed?: number;
  failed?: number;
  skipped?: number;
  total?: number;
  [key: string]: unknown;
}

export interface ApcTestRunReport {
  /** `'ok' | 'env_blocked'` at the top level (env doctor / test203 run.ts). */
  envStatus?: string;
  /** `0` = green, `1` = SUT red (or new regressions under `--diff`), `78` = env_blocked. */
  exitCode: number;
  tiers?: ApcTestTierInput[];
  /** New reds vs baseline under `--diff` (top-level, union across tiers). */
  regressions?: string[];
  [key: string]: unknown;
}

/** Exactly the tier fields the cockpit / this mapping cares about — a subset of TierResult. */
export interface TestFeedbackTierSummary {
  tier: string;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

export interface TestResultFeedbackPayload {
  status: 'passed' | 'failed' | 'env_blocked';
  failureCount: number;
  tiers: TestFeedbackTierSummary[];
  exitCode: number;
  regressions: string[];
}

/** `apc test`'s reserved env-doctor-blocked exit code (apc/06 §3.2, `scripts/test203/run.ts` `ENV_BLOCKED_EXIT`). */
const APC_ENV_BLOCKED_EXIT_CODE = 78;

/**
 * Map one `apc test --json` run report to the payload `cloud task
 * test-feedback` posts as a task event (which the server then stores verbatim
 * as `metadata`, see `POST /api/im/tasks/:id/event`).
 *
 * Pure function — no I/O — so the mapping rule can be unit-tested without a
 * live task/cloud round-trip. The one rule this MUST get right (apc/05 C2 /
 * doc12's承重 requirement on this skill): **`env_blocked` must never be
 * reported as `failed`** — an environment that never ran the suite is a
 * distinct fault domain from a red suite, and conflating them would make the
 * cockpit count infra flakiness as product regressions.
 */
export function mapTestRunReportToFeedback(report: ApcTestRunReport): TestResultFeedbackPayload {
  const envBlocked = report.envStatus === 'env_blocked' || report.exitCode === APC_ENV_BLOCKED_EXIT_CODE;
  const status: TestResultFeedbackPayload['status'] = envBlocked
    ? 'env_blocked'
    : report.exitCode === 0
      ? 'passed'
      : 'failed';

  const tiers: TestFeedbackTierSummary[] = Array.isArray(report.tiers)
    ? report.tiers.map((t) => ({
        tier: String(t.tier),
        passed: Number(t.passed) || 0,
        failed: Number(t.failed) || 0,
        skipped: Number(t.skipped) || 0,
        total: Number(t.total) || 0,
      }))
    : [];

  const failureCount = tiers.reduce((sum, t) => sum + t.failed, 0);

  return {
    status,
    failureCount,
    tiers,
    exitCode: report.exitCode,
    regressions: Array.isArray(report.regressions) ? report.regressions.map((r) => String(r)) : [],
  };
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
 * `resolveAssigneeId` in `sdk/cloud/mcp/src/tools/create-task.ts` —
 * exact match first (id / username / AgentCard name), fuzzy substring match as
 * fallback. Returns `''` when no match.
 */
async function resolveAssigneeId(
  client: PrismerClient,
  name: string,
  workspaceId: string,
): Promise<string> {
  const needle = name.trim().toLowerCase();
  const normalized = needle.replace(/^@/, '');
  if (!needle) return '';

  const res = await client.im.agents.discover({ workspaceId });
  if (!res.ok || !Array.isArray(res.data)) return '';
  const agents = res.data as unknown as Array<Record<string, unknown>>;

  const exact = agents.find((agent) => {
    const values = [agent.userId, agent.username, agent.name].map((v) =>
      typeof v === 'string' ? v.trim().toLowerCase() : '',
    );
    return values.includes(needle) || values.includes(normalized);
  });
  if (exact && typeof exact.userId === 'string') return exact.userId;

  const fuzzy = agents.find((agent) => {
    const labels = [agent.username, agent.name]
      .map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : ''))
      .filter(Boolean);
    return labels.some((label) => label.includes(normalized) || normalized.includes(label));
  });
  return fuzzy && typeof fuzzy.userId === 'string' ? fuzzy.userId : '';
}

/**
 * `cloud`-side adapter for the shared `buildTaskWaitCommand`. Bridges the
 * transport/output-agnostic builder to PrismerClient.im (im_token auth) + the
 * `cloud` text output convention (ID/Status/Result lines; --json dumps the full
 * task detail). `getTask` returns null on a transient (non-ok) response so the
 * builder keeps polling; the run-id guard fires on first poll before any work.
 */
/** `cloud`-side settled-task record: flat settle fields + the full `{ task, logs }` detail for --json. */
interface CloudWaitRecord {
  status: string;
  id: string;
  result?: unknown;
  detail: unknown;
}

function mkTaskWaitAdapter(getIMClient: ClientFactory): TaskWaitAdapter<CloudWaitRecord> {
  return {
    async getTask(id) {
      // Resolve credentials only when `task wait` actually runs. Creating the
      // command tree must remain side-effect free so `cloud --help` and shell
      // completion work before login.
      const client = getIMClient();
      assertNotRunId(id); // run ids have no task card; exits before polling
      const res = await client.im.tasks.get(id);
      if (!res.ok || !res.data) return null; // transient — keep polling
      const t = res.data.task;
      // Carry the flat settle fields the builder reads, plus `detail` so JSON
      // mode can render the original `{ task, logs }` payload unchanged.
      return { status: t.status, result: t.result, id: t.id, detail: res.data };
    },
    emit(payload, opts) {
      if (opts.json) {
        process.stdout.write(JSON.stringify(payload.detail, null, 2) + '\n');
        return;
      }
      process.stdout.write(`ID:     ${payload.id}\nStatus: ${payload.status}\n`);
      if (payload.result) process.stdout.write(`Result: ${String(payload.result)}\n`);
    },
    fail(msg) {
      process.stderr.write(`Error: ${msg}\n`);
      process.exit(1);
    },
  };
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
    .option('--assignee-name <name>', 'assign by @username / AgentCard name (resolved via discover)')
    .option('--workspace-id <id>', 'workspace scope (defaults to PRISMER_WORKSPACE_ID env)')
    .option('--conversation-id <id>', 'pin task to a conversation/session')
    .option('--project <id>', 'scope task to project id; use __unscoped/none for workspace-level')
    .option('--kind <kind>', 'board projection kind: work_item (default) | goal', 'work_item')
    .option('--schedule-at <iso>', 'one-shot ISO 8601 scheduled time (sets scheduleType=once)')
    .option('--schedule-cron <expr>', 'cron expression (sets scheduleType=cron)')
    .option('--kr <keyResultId>', 'link the task to an OKR Key Result (same workspace; acceptance progress feeds KR recompute)')
    .option('--objective <objectiveId>', 'consistency check: must be the objective the --kr belongs to')
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
      workspaceId?: string;
      conversationId?: string;
      project?: string;
      kind?: string;
      scheduleAt?: string;
      scheduleCron?: string;
      kr?: string;
      objective?: string;
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
        const workspaceId = opts.workspaceId || process.env.PRISMER_WORKSPACE_ID || '';
        let assigneeId = opts.assigneeId;
        if (!assigneeId && opts.assigneeName) {
          if (!workspaceId) {
            throw new Error('workspace id is required for agent discovery');
          }
          assigneeId = await resolveAssigneeId(client, opts.assigneeName, workspaceId);
          if (!assigneeId) {
            throw new Error(
              `--assignee-name "${opts.assigneeName}" did not resolve to an agent. Use a visible agent username/name or pass --assignee-id explicitly.`,
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
        if (workspaceId) createOpts.workspaceId = workspaceId;
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
        // runtime210/06 W2 — scope link. --objective is a consistency hint
        // only (server rejects a mismatch); --kr is the actual link column.
        if (opts.kr) {
          if (!workspaceId) {
            throw new Error('workspace id (--workspace-id or PRISMER_WORKSPACE_ID) is required when linking a KR');
          }
          createOpts.keyResultId = opts.kr;
        }
        if (opts.objective) createOpts.objectiveId = opts.objective;

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

  // task wait <task-id> — release203/15 WS-E4 §7.3 "B" (CLI parity with
  // `prismer task wait`). Block until a task you've ALREADY delegated settles,
  // then print it: the orchestrator's "delegate → wait → act on the result"
  // primitive (the tasks/agent-coordination skills point agents here). Settles
  // on review/completed/failed/cancelled by default — `review` is included
  // because for a delegated task it means "assignee finished, awaiting YOUR
  // approval"; blocking until `completed` would deadlock the orchestrator that
  // must approve. --terminal-only opts into strict terminal; exits non-zero on
  // failed/cancelled.
  //
  // The poll/settle logic is the SHARED `buildTaskWaitCommand` (one source,
  // also used by `prismer task wait`); only the adapter below is `cloud`-
  // specific (PrismerClient.im transport + text output convention).
  task.addCommand(buildTaskWaitCommand(mkTaskWaitAdapter(getIMClient)));

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
        if (result.queued || result.status === 202) {
          process.stdout.write(`Queued for task ${targetTaskId}; cloud upload is pending reconnection.\n`);
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
    .option('--command <command>', 'executable verifier command')
    .option('--cwd <path>', 'absolute verifier working directory')
    .option('--workdir-id <id>', 'bound workdir id')
    .option('--review-kind <kind>', 'code-review | design-review')
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, opts: {
      mode: string;
      expectation: string;
      verifierAgent?: string;
      weight?: number;
      optional?: boolean;
      command?: string;
      cwd?: string;
      workdirId?: string;
      reviewKind?: string;
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
          ...(opts.command || opts.cwd || opts.workdirId
            ? { execution: { command: opts.command ?? '', cwd: opts.cwd ?? '', workdirId: opts.workdirId ?? '' } }
            : {}),
          ...(opts.reviewKind ? { reviewKind: opts.reviewKind as 'code-review' | 'design-review' } : {}),
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
    .option('--run', 'execute criterion.execution locally, then report its exit status')
    .option('--waive-reason <reason>', 'required when --outcome waived')
    .option('--review-artifact <path>', 'structured S5/S6 review artifact JSON file')
    .option('--json', 'output raw JSON response')
    .action(async (
      taskId: string,
      criterionId: string,
      opts: { outcome: string; note?: string; evidence?: string[]; waiveReason?: string; run?: boolean; reviewArtifact?: string; json: boolean },
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
        let runNote = '';
        let runOutcome: 'passed' | 'failed' | undefined;
        if (opts.run) {
          const view = await client.im.tasks.getAcceptance(taskId);
          const criterion = (view.data as any)?.criteria?.find((c: any) => c.id === criterionId);
          const execution = criterion?.execution;
          if (!execution || typeof execution.command !== 'string' || !execution.cwd?.startsWith('/') || !execution.workdirId) {
            throw new Error('criterion has no safe execution {command,cwd,workdirId}');
          }
          const child = spawnSync('/bin/sh', ['-lc', execution.command], {
            cwd: execution.cwd,
            encoding: 'utf8',
            timeout: 10 * 60 * 1000,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          const code = typeof child.status === 'number' ? child.status : 1;
          runOutcome = code === 0 ? 'passed' : 'failed';
          runNote = `command: ${execution.command}\ncwd: ${execution.cwd}\nworkdirId: ${execution.workdirId}\nexit: ${code}\nstdout:\n${child.stdout ?? ''}\nstderr:\n${child.stderr ?? ''}`;
        }
        const effectiveOutcome = runOutcome ?? (opts.outcome as 'passed' | 'failed' | 'n/a' | 'waived');
        const reviewArtifact = opts.reviewArtifact
          ? JSON.parse(await fs.readFile(opts.reviewArtifact, 'utf8'))
          : undefined;
        const res = await client.im.tasks.criteria.verify(taskId, criterionId, {
          outcome: effectiveOutcome,
          note: [opts.note, runNote].filter(Boolean).join('\n\n'),
          evidenceRefs: opts.evidence,
          reviewArtifact,
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
        process.stdout.write(`Criterion ${criterionId} → ${effectiveOutcome}\n`);
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ── apc/05 §1 C2 — `cloud task test-feedback` (whole-run rollup to cockpit) ─
  //
  // Thin wrapper over `POST /api/im/tasks/:id/event` (same endpoint as
  // `cloud skill ack`; see `client.im.tasks.postEvent`, src/index.ts:920),
  // posting `code: 'TEST_RESULT_FEEDBACK'`. The server lowercases that to
  // `action='test_result_feedback'` and stores `{code, ...payload}` verbatim
  // as `metadata` — exactly the shape
  // `src/im/services/insights-cockpit.service.ts::getAcceptanceFeedback` reads.
  //
  // This is the whole-RUN counterpart to `verify-criterion` above (which
  // reports ONE criterion). Neither replaces the other — `verify-criterion`
  // drives the task's acceptance-view; this drives the cockpit's
  // acceptanceFeedback panel.
  //
  // Same server-side limits as `cloud skill ack` (task.ts:2510-2514): only the
  // task ASSIGNEE may post; a `run_…` chat-dispatch id has no task row.
  // Exit codes: 0 landed · 1 failed · 4 rejected (not assignee).
  task
    .command('test-feedback <task-id> [report-path]')
    .description(
      'Roll an `apc test --json` TierResult run up into the cockpit test-result-feedback event (apc/05 §1 C2). ' +
        'Reads report-path if given, else stdin.',
    )
    .option('--note <text>', 'optional human-readable note stored on the log row')
    .option('--json', 'output raw JSON response')
    .action(async (taskId: string, reportPath: string | undefined, opts: { note?: string; json?: boolean }) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      let exitCode = 0;
      try {
        const raw = reportPath ? await fs.readFile(reportPath, 'utf8') : await readStdinText();
        if (!raw.trim()) {
          throw new Error(
            reportPath
              ? `${reportPath} is empty`
              : 'no report-path given and stdin is empty — pipe `apc test --json` output or pass a file path',
          );
        }
        let report: ApcTestRunReport;
        try {
          report = JSON.parse(raw) as ApcTestRunReport;
        } catch {
          throw new Error(`could not parse TierResult JSON from ${reportPath ?? 'stdin'}`);
        }
        if (typeof report.exitCode !== 'number') {
          throw new Error('TierResult JSON is missing a numeric top-level "exitCode"');
        }
        const payload = mapTestRunReportToFeedback(report);
        const res = await client.im.tasks.postEvent(taskId, {
          code: 'TEST_RESULT_FEEDBACK',
          message:
            opts.note ??
            `apc test rollup: ${payload.status} (${payload.tiers.length} tier(s), ${payload.failureCount} failed)`,
          payload: payload as unknown as Record<string, unknown>,
        });
        if (!res.ok) exitCode = isNotTaskAssigneeError(res.error) ? 4 : 1;
        if (opts.json) {
          process.stdout.write(JSON.stringify({ ...res, payload }, null, 2) + '\n');
        } else if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          if (exitCode === 4) {
            process.stderr.write('Hint: only the task ASSIGNEE may post a test-result-feedback event.\n');
          }
        } else {
          process.stdout.write(
            `Recorded test_result_feedback on ${taskId}: ${payload.status} — ` +
              `${payload.tiers.map((t) => `${t.tier}:${t.passed}/${t.total}`).join(' ')} ` +
              `(${payload.failureCount} failed, ${payload.regressions.length} regressions)\n`,
          );
        }
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        exitCode = 1;
      }
      if (exitCode !== 0) process.exit(exitCode);
    });

  // ── apc P0-2 — `cloud task meta set` (task metadata writer) ──────────────
  //
  // Thin wrapper over the EXISTING `PATCH /api/im/tasks/:id` (tasks.ts:1784),
  // whose `metadata` field the server already shallow-merges at the TOP level
  // (`task.service.ts:2661-2662`: `{...existing, ...updates.metadata}`). No new
  // server capability. `cloud task update` (above) deliberately does NOT carry
  // metadata — it is the title/status/progress verb — so this is an additive
  // surface, not a duplicate one.
  //
  // ⚠️ LOAD-BEARING PERMISSION LIMIT — metadata is gated as `edit-content`
  // (Gate #5, `task.service.ts:2653-2660`), whose resolver DENIES executor
  // agents outright ("executor agents cannot edit content or reassign tasks",
  // `task-permission.ts:817-822`). The assignee is NOT allowed. Provenance
  // writes (spec-intake linking assets, git-ops stamping branch/sha) must run
  // as the ORCHESTRATOR / CREATOR, i.e. the main agent — a coding agent writing
  // to its own task will get 403.
  //
  // MERGE SEMANTICS (two different ones — pick deliberately):
  //   --set a=1            top-level key → server shallow-merge, one PATCH.
  //   --set a.b=1          nested path   → the CLI first GETs the task, deep-sets
  //                        the path into the CURRENT metadata, and PATCHes the
  //                        whole top-level key. This is required for correctness:
  //                        the server merge is top-level ONLY, so PATCHing
  //                        {assets:{linkedAssetIds:[…]}} blind would DELETE the
  //                        sibling `assets.aggregatedAssetIds` that dispatch
  //                        reads (`task.service.ts:7618-7620`). Read-modify-write
  //                        is NOT atomic — last writer wins on a concurrent edit.
  //   --json '{"a":…}'     raw escape hatch: passed straight through, so each
  //                        top-level key it contains REPLACES that key wholesale.
  const meta = task.command('meta').description('Read/write task metadata (apc P0-2)');
  meta
    .command('set <task-id>')
    .description('Write task metadata keys (PATCH /tasks/:id → server shallow-merge)')
    .option(
      '--set <key=value...>',
      'metadata assignment; dotted key = nested path; value parsed as JSON, else kept as a string ' +
        '(use --set-string for shas / ids — an all-digit sha would become a number)',
    )
    .option(
      '--set-string <key=value...>',
      'metadata assignment whose value is ALWAYS stored as a string (shas, branch names, ids)',
    )
    .option('--json-value <json>', 'raw metadata object merged at the TOP level (replaces each key it names)')
    .option('--json', 'output raw JSON response')
    .addHelpText(
      'after',
      [
        '',
        'Who may run this (apc/11 P0-2):',
        '  metadata is gated as edit-content → creator / orchestrator / admin / owner.',
        '  The task ASSIGNEE is NOT included: an executor agent PATCHing its own task',
        '  gets 403. Run provenance writes as the MAIN agent (orchestrator/creator).',
        '',
        'Value typing (git-ops provenance depends on this):',
        '  --set        infers JSON — `sha=1234567` becomes the NUMBER 1234567 and a',
        '               40-digit sha becomes 1.2345678901234568e+39 (destroyed, not',
        '               just retyped). ~3.7% of 7-char shas are all digits.',
        '  --set-string never infers — the value is stored verbatim as a string.',
        '               Use it for every sha / branch / id.',
        '',
        'Merge semantics:',
        '  --set a=1        → PATCH {metadata:{a:1}}; server merges at top level.',
        '  --set a.b=1      → GET task, deep-set a.b in the CURRENT metadata, PATCH the',
        '                     whole `a` object (server merge is top-level only, so a blind',
        '                     nested PATCH would drop sibling keys). Read-modify-write is',
        '                     not atomic.',
        '  --json-value ... → passed through unchanged; each top-level key it names is',
        '                     REPLACED, not deep-merged.',
        '',
        'Examples:',
        '  cloud task meta set <id> --set-string git.sha=$(git rev-parse HEAD) \\',
        '                           --set-string git.branch=feat/x',
        '  cloud task meta set <id> --set retries=2 --set blocked=false',
        '  cloud task meta set <id> --set assets.linkedAssetIds=\'["ast_1","ast_2"]\'',
        '  cloud task meta set <id> --json-value \'{"git":{"branch":"feat/x","sha":"deadbeef"}}\'',
      ].join('\n'),
    )
    .action(async (taskId: string, opts: { set?: string[]; setString?: string[]; jsonValue?: string; json: boolean }) => {
      assertNotRunId(taskId);
      const client = getIMClient();
      // Exit code computed here, applied after the try/catch — see the same
      // note on `cloud skill ack`: an exit raised inside the try would be
      // swallowed by this handler's own catch and degrade 4 → 1.
      let exitCode = 0;
      try {
        // `--set-string` is applied AFTER `--set`, so on the same key the
        // string form wins (commander loses the relative order of two options).
        const assignments = [
          ...parseMetaAssignments(opts.set ?? []),
          ...parseMetaAssignments(opts.setString ?? [], { json: false }),
        ];
        let patch: Record<string, unknown> = {};
        if (opts.jsonValue) {
          const parsed = JSON.parse(opts.jsonValue);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('--json-value must be a JSON object');
          }
          patch = { ...(parsed as Record<string, unknown>) };
        }
        if (assignments.length === 0 && !opts.jsonValue) {
          throw new Error(
            'nothing to write: pass at least one --set / --set-string key=value, or --json-value <json>',
          );
        }

        // Only pay for the extra GET when a dotted path forces a read-modify-write.
        const needsCurrent = assignments.some((a) => a.path.length > 1);
        let current: Record<string, unknown> = {};
        if (needsCurrent) {
          const got = await client.im.tasks.get(taskId);
          if (!got.ok) {
            throw new Error(
              `cannot read current metadata for a nested --set (${got.error?.code ?? 'unknown'}: ${got.error?.message ?? 'request failed'})`,
            );
          }
          const existing = (got.data as { task?: { metadata?: unknown } } | undefined)?.task?.metadata;
          if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
            current = existing as Record<string, unknown>;
          }
        }
        for (const a of assignments) {
          applyMetaAssignment(patch, current, a);
        }

        const res = await client.im.tasks.update(taskId, { metadata: patch });
        if (!res.ok) exitCode = res.error?.code === 'TASK_ACCESS_DENIED' ? 4 : 1;
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
        } else if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          if (exitCode === 4) {
            process.stderr.write(
              'Hint: task metadata is creator/orchestrator/admin/owner only — the assignee cannot write it. ' +
                'Run this as the main agent (apc/11 P0-2).\n',
            );
          }
        } else {
          process.stdout.write(`Metadata updated on ${taskId}: ${Object.keys(patch).sort().join(', ')}\n`);
        }
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        exitCode = 1;
      }
      if (exitCode !== 0) process.exit(exitCode);
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
