/**
 * `cloud environment ...` + `cloud warm-pool ...` — EaaS tenant surface CLI
 * (eaas-gate-a Task 12 / eaas-gate-b Task 15).
 *
 * Commands mirror the TS SDK face (`client.environments.*` /
 * `client.projects.warmPool.*`) 1:1 — same paths, same headers:
 *   cloud environment create   --project <id> --template <t> [--profile 2c4g]
 *                              [--ttl <seconds>] [--metadata k=v ...] [--env k=v ...]
 *                              [--on-warm-miss cold|fail] [--idempotency-key <k>]
 *   cloud environment get      <environmentId>
 *   cloud environment list     [--cursor <c>] [--limit <n>]
 *   cloud environment update   <environmentId> --revision <n> [--expires-at ISO] [--metadata k=v ...]
 *   cloud environment pause|wake|suspend <environmentId> [--idempotency-key <k>]
 *   cloud environment delete   <environmentId> [--idempotency-key <k>]
 *   cloud environment exec     <environmentId> <command...> [--timeout-ms <n>] [--idempotency-key <k>]
 *   cloud environment exec-get <environmentId> <execId> [--cursor <n>]
 *   cloud environment file-get <environmentId> <path> [--out <localFile>]
 *   cloud environment file-put <environmentId> <path> <localFile>
 *   cloud environment snapshot-create <environmentId> [--idempotency-key <k>]
 *   cloud environment snapshot-list   <environmentId>
 *   cloud environment snapshot-restore <environmentId> <snapshotId> [--idempotency-key <k>]
 *   cloud environment services <environmentId>
 *   cloud environment issue-session [--anonymous] [--identity-token <jwt>] [--environment <id>]
 *   cloud environment conversation-list|conversation-ensure|message-list|message-send
 *   cloud environment run-get|run-cancel|run-events, session-list|session-revoke
 *   cloud environment usage|billing <projectId> [--from ISO] [--to ISO] [--cursor c] [--limit n]
 *
 *   cloud publishable-key list|create|revoke <projectId>
 *   cloud warm-pool get        <projectId>
 *   cloud warm-pool patch      <projectId> --revision <n> [--min-ready n] [--max-ready n]
 *                              [--idle-retention-seconds n] [--daily-budget-credits s]
 *                              [--on-miss cold|fail] [--dry-run] [--idempotency-key <k>]
 *
 * Retry contract surfaced to the operator: writes are keyed by an
 * auto-generated `Idempotency-Key`; pass `--idempotency-key` to retry the SAME
 * operation safely (a fresh key is a new operation). A 503
 * `warm_capacity_unavailable` is printed verbatim — this CLI never rewrites
 * `onMiss: fail` into a cold start.
 */

import { Command } from 'commander';
import type {
  PrismerClient,
  EnvironmentStatus,
  EnvironmentCreateSpec,
  EaasLifecycleResult,
  EaasExecView,
  EaasExecReadView,
  EaasBillingPage,
  EaasUsagePage,
  EaasServicesProjection,
  WarmPoolPolicy,
  WarmPoolStatus,
  ProjectPoolManagement,
} from '../index';

type ClientFactory = () => PrismerClient;

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function emit(data: unknown, json: boolean, lines: () => void): void {
  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  lines();
}

/** Repeated `k=v` flags → Record. */
function collectPairs(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function pairsToRecord(raw: string[] | undefined, flag: string): Record<string, string> | undefined {
  if (!raw || raw.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const entry of raw) {
    const idx = entry.indexOf('=');
    if (idx <= 0) fail(`${flag} entries must be k=v form, got "${entry}"`);
    out[entry.slice(0, idx)] = entry.slice(idx + 1);
  }
  return out;
}

function parsePositiveInt(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) fail(`--${flag} must be a non-negative integer`);
  return n;
}

function printStatus(s: EnvironmentStatus, heading = 'Environment'): void {
  process.stdout.write(`${heading}: ${s.environmentId}\n`);
  process.stdout.write(`  state       ${s.state}\n`);
  process.stdout.write(`  revision    ${s.revision}\n`);
  process.stdout.write(`  epoch       ${s.epoch}\n`);
  process.stdout.write(
    `  readiness   sandbox=${s.readiness.sandbox} services=${s.readiness.services} agent=${s.readiness.agent}\n`,
  );
  process.stdout.write(`  startupPath ${s.startupPath ?? '-'}\n`);
  process.stdout.write(`  template    ${s.templateVersion}\n`);
  process.stdout.write(`  expiresAt   ${s.expiresAt}\n`);
  for (const m of s.milestones ?? []) {
    process.stdout.write(`  milestone   ${m.name} @ ${m.at}${m.durationMs !== undefined ? ` (${m.durationMs}ms)` : ''}\n`);
  }
}

function printLifecycle(r: EaasLifecycleResult, verb: string): void {
  process.stdout.write(`Environment ${verb}: ${r.environmentId}\n`);
  process.stdout.write(`  state        ${r.state}\n`);
  process.stdout.write(`  epoch        ${r.epoch}\n`);
  process.stdout.write(`  revision     ${r.revision}\n`);
  if (r.operationId) process.stdout.write(`  operationId  ${r.operationId}\n`);
}

function printExecView(v: EaasExecView): void {
  if (v.status === 'exited') {
    process.stdout.write(`Exec ${v.execId} exited with code ${v.exitCode}\n`);
    if (v.stdout) process.stdout.write(v.stdout + (v.stdout.endsWith('\n') ? '' : '\n'));
    if (v.stderr) process.stderr.write(v.stderr + (v.stderr.endsWith('\n') ? '' : '\n'));
    return;
  }
  process.stdout.write(`Exec ${v.execId} still running (${v.command.join(' ')}, started ${v.startedAt})\n`);
  process.stdout.write(`  read output with: cloud environment exec-get <environmentId> ${v.execId}\n`);
}

function printWarmPool(w: WarmPoolStatus): void {
  process.stdout.write(`Warm pool (revision ${w.revision}, observed ${w.observedRevision})\n`);
  process.stdout.write(`  desired    minReady=${w.desired.minReady} maxReady=${w.desired.maxReady}`);
  process.stdout.write(` idleRetention=${w.desired.idleRetentionSeconds}s`);
  process.stdout.write(` dailyBudget=${w.desired.dailyBudgetCredits} onMiss=${w.desired.onMiss}\n`);
  process.stdout.write(
    `  effective  state=${w.effective.state} ready=${w.effective.ready} provisioning=${w.effective.provisioning} terminating=${w.effective.terminating}${w.effective.reason ? ` reason=${w.effective.reason}` : ''}\n`,
  );
  process.stdout.write(
    `  cost       spentToday=${w.cost.spentTodayCredits} reserved=${w.cost.reservedCredits} remainingToday=${w.cost.remainingTodayCredits} hourlyEst=${w.cost.estimatedHourlyCredits} (rate ${w.cost.rateVersion ?? '-'})\n`,
  );
  process.stdout.write(`  period     ${w.cost.periodStart} → ${w.cost.periodEnd}\n`);
}

function printRows(items: Array<unknown>, empty: string): void {
  if (items.length === 0) {
    process.stdout.write(`${empty}
`);
    return;
  }

  for (const item of items) {
    process.stdout.write(`${JSON.stringify(item)}
`);
  }
}

export function register(parent: Command, getIMClient: ClientFactory, getAPIClient: ClientFactory): void {
  const environment = parent
    .command('environment')
    .description('EaaS environments (eaas-gate-a T12) — lifecycle / exec against a tenant environment');

  environment
    .command('context')
    .description('Discover project-key context and server defaults')
    .option('--json', 'Output JSON')
    .action(async (opts: { json?: boolean }) => {
      const res = await getAPIClient().eaas.context();
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => printRows([res.data], 'No context found.'));
    });

  const accessSession = environment.command('access-session')
    .description('Manage delegated sessions issued by the current project key (sessions:delegate)');

  accessSession.command('issue <environmentId>')
    .description('Issue an environment-bound delegated session')
    .requiredOption('--subject <subject>', 'Authenticated business user id')
    .option('--scope <scope>', 'Principal scope (repeatable)', collectPairs, [] as string[])
    .option('--ttl <seconds>', 'Session lifetime in seconds', Number)
    .option('--idempotency-key <key>', 'Reuse for retries of the same issuance')
    .option('--show-token', 'Explicitly include the sensitive bearer token in output')
    .option('--json', 'Output JSON (token hidden unless --show-token)')
    .action(async (environmentId: string, opts: { subject: string; scope: string[]; ttl?: number; idempotencyKey?: string; showToken?: boolean; json?: boolean }) => {
      if (opts.ttl !== undefined && (!Number.isInteger(opts.ttl) || opts.ttl < 60 || opts.ttl > 604800)) {
        fail('--ttl must be an integer between 60 and 604800');
      }
      const res = await getAPIClient().environments.issueAccessSession(environmentId, {
        subject: opts.subject,
        ...(opts.scope.length ? { scopes: opts.scope } : {}),
        ...(opts.ttl !== undefined ? { ttlSeconds: opts.ttl } : {}),
      }, { idempotencyKey: opts.idempotencyKey });
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      const { token, ...metadata } = res.data;
      if (opts.showToken) process.stderr.write('Sensitive bearer token: do not log or share this output.\n');
      else process.stderr.write('Token hidden; --show-token explicitly enables sensitive output. Retry only with the same explicit idempotency key.\n');
      const data = opts.showToken ? { ...metadata, token } : metadata;
      emit(data, opts.json === true, () => printRows([data], 'No session issued.'));
    });

  accessSession.command('list <environmentId>')
    .description('List this key\'s delegated session metadata')
    .option('--limit <n>', 'Page size (1..100)', Number)
    .option('--cursor <cursor>', 'Opaque cursor from the previous page')
    .option('--json', 'Output JSON')
    .action(async (environmentId: string, opts: { limit?: number; cursor?: string; json?: boolean }) => {
      const res = await getAPIClient().environments.listAccessSessions(environmentId, { limit: opts.limit, cursor: opts.cursor });
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => {
        printRows(res.data.sessions, 'No delegated sessions found.');
        if (res.data.nextCursor) process.stdout.write(`Next cursor: ${res.data.nextCursor}\n`);
      });
    });

  accessSession.command('revoke <environmentId> <sessionId>')
    .description('Revoke a delegated session issued by this project key')
    .option('--json', 'Output JSON')
    .action(async (environmentId: string, sessionId: string, opts: { json?: boolean }) => {
      const res = await getAPIClient().environments.revokeAccessSession(environmentId, sessionId);
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => process.stdout.write(`Session ${res.data.id} revoked at ${res.data.revokedAt}\n`));
    });

  // ── create ─────────────────────────────────────────────────────────────
  environment
    .command('create')
    .description('Create an environment (202 + status projection)')
    .option('--project <id>', 'Project id (optional for project machine keys)')
    .option('--template <t>', 'Official template name or immutable pin (name@sha256:...)')
    .option('--profile <profile>', 'Registry sizing profile (omitted: selected pool default)')
    .option('--pool <id>', 'Advanced: configured EaaS pool id')
    .option('--placement <id>', 'Advanced: configured EaaS placement id')
    .option('--ttl <seconds>', 'Time-to-live in seconds (60..86400; omitted: project default)', (v) => Number(v))
    .option('--metadata <k=v>', 'Metadata entry (repeatable)', collectPairs, [] as string[])
    .option('--env <k=v>', 'Sensitive env entry (repeatable; injected after identity binding)', collectPairs, [] as string[])
    .option('--on-warm-miss <mode>', 'Create-time startup policy tighten: cold|fail')
    .option('--idempotency-key <k>', 'Reuse a key to retry the same create safely')
    .option('--json', 'Output JSON')
    .action(async (opts: {
      project?: string;
      template?: string;
      profile?: string;
      pool?: string;
      placement?: string;
      ttl?: number;
      metadata?: string[];
      env?: string[];
      onWarmMiss?: string;
      idempotencyKey?: string;
      json?: boolean;
    }) => {
      if (opts.profile !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(opts.profile)) {
        fail('--profile must be a valid registry ID');
      }
      if (opts.ttl !== undefined && (!Number.isInteger(opts.ttl) || opts.ttl < 0)) {
        fail('--ttl must be a non-negative integer (seconds)');
      }
      let startup: { onWarmMiss?: 'cold' | 'fail' } | undefined;
      if (opts.onWarmMiss !== undefined) {
        if (opts.onWarmMiss !== 'cold' && opts.onWarmMiss !== 'fail') fail('--on-warm-miss must be cold|fail');
        startup = { onWarmMiss: opts.onWarmMiss };
      }
      const metadata = pairsToRecord(opts.metadata, '--metadata');
      const env = pairsToRecord(opts.env, '--env');
      const spec: EnvironmentCreateSpec = {
        ...(opts.project !== undefined ? { projectId: opts.project } : {}),
        ...(opts.template !== undefined ? { template: opts.template } : {}),
        ...(opts.pool !== undefined ? { poolId: opts.pool } : {}),
        ...(opts.placement !== undefined ? { placementId: opts.placement } : {}),
        ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
        ...(opts.ttl !== undefined ? { ttlSeconds: opts.ttl } : {}),
        ...(metadata ? { metadata } : {}),
        ...(env ? { env } : {}),
        ...(startup ? { startup } : {}),
      };

      const client = getIMClient();
      const res = await client.environments.create(spec, { idempotencyKey: opts.idempotencyKey });
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => printStatus(res.data, 'Environment created'));
    });

  // ── get ────────────────────────────────────────────────────────────────
  environment
    .command('get <environmentId>')
    .description('Show an environment status projection')
    .option('--json', 'Output JSON')
    .action(async (environmentId: string, opts: { json?: boolean }) => {
      const client = getIMClient();
      const res = await client.environments.get(environmentId);
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => printStatus(res.data));
    });

  // ── list ───────────────────────────────────────────────────────────────
  environment
    .command('list')
    .description('List environments of the calling tenant')
    .option('--cursor <cursor>', 'Page cursor from a previous response')
    .option('--limit <n>', 'Page size', (v) => Number(v))
    .option('--json', 'Output JSON')
    .action(async (opts: { cursor?: string; limit?: number; json?: boolean }) => {
      const client = getIMClient();
      const res = await client.environments.list({ cursor: opts.cursor, limit: opts.limit });
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => {
        const page = res.data;
        if (page.environments.length === 0) {
          process.stdout.write('No environments found.\n');
          return;
        }
        process.stdout.write(
          'ID'.padEnd(28) + 'STATE'.padEnd(14) + 'REV'.padEnd(6) + 'READY'.padEnd(16) + 'EXPIRES\n',
        );
        for (const s of page.environments) {
          const ready = `${s.readiness.sandbox ? 's' : '-'}${s.readiness.services ? 'v' : '-'}${s.readiness.agent ? 'a' : '-'}`;
          process.stdout.write(
            `${s.environmentId.padEnd(28)}${s.state.padEnd(14)}${String(s.revision).padEnd(6)}${ready.padEnd(16)}${s.expiresAt}\n`,
          );
        }
        if (page.nextCursor) process.stdout.write(`\nNext cursor: ${page.nextCursor}\n`);
      });
    });

  // ── update (PATCH If-Match revision CAS) ───────────────────────────────
  environment
    .command('update <environmentId>')
    .description('Patch expiresAt/metadata (revision-CAS via If-Match, not idempotency-keyed)')
    .requiredOption('--revision <n>', 'If-Match CAS pin (bare integer from a previous read)', (v) => Number(v))
    .option('--expires-at <iso>', 'New expiry ISO timestamp')
    .option('--metadata <k=v>', 'Metadata entry (repeatable; replaces the whole map)', collectPairs, [] as string[])
    .option('--json', 'Output JSON')
    .action(async (environmentId: string, opts: { revision: number; expiresAt?: string; metadata?: string[]; json?: boolean }) => {
      if (!Number.isInteger(opts.revision) || opts.revision < 0) {
        fail('--revision must be a non-negative integer');
      }
      const metadata = pairsToRecord(opts.metadata, '--metadata');
      if (opts.expiresAt === undefined && metadata === undefined) {
        fail('Nothing to update — pass --expires-at and/or --metadata');
      }
      const client = getIMClient();
      const res = await client.environments.update(
        environmentId,
        {
          ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
          ...(metadata ? { metadata } : {}),
        },
        { revision: opts.revision },
      );
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => printStatus(res.data, 'Environment updated'));
    });

  // ── lifecycle: pause / wake / suspend / delete ─────────────────────────
  for (const [verb, method] of [
    ['pause', 'pause'],
    ['wake', 'wake'],
    ['suspend', 'suspend'],
    ['delete', 'delete'],
  ] as const) {
    environment
      .command(`${verb} <environmentId>`)
      .description(
        verb === 'delete'
          ? 'Delete an environment (idempotent, reconciler executes the stop)'
          : `${verb} an environment (idempotent)`,
      )
      .option('--idempotency-key <k>', 'Reuse a key to retry the same operation safely')
      .option('--json', 'Output JSON')
      .action(async (environmentId: string, opts: { idempotencyKey?: string; json?: boolean }) => {
        const client = getIMClient();
        const res = await client.environments[method](environmentId, {
          idempotencyKey: opts.idempotencyKey,
        });
        if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
        emit(res.data, opts.json === true, () => printLifecycle(res.data, verb === 'delete' ? 'deleted' : `${verb}ed`));
      });
  }

  // ── exec / exec-get ────────────────────────────────────────────────────
  environment
    .command('exec <environmentId> <command...>')
    .description('Run a command (synchronous window, or an A1 handle if the server defers). Put commander options before "--": exec <id> --timeout-ms 5000 -- sh -c \"ls\"')
    .option('--timeout-ms <n>', 'Exec timeout in milliseconds', (v) => Number(v))
    .option('--idempotency-key <k>', 'Reuse a key to retry the same exec safely')
    .option('--json', 'Output JSON')
    .action(async (environmentId: string, command: string[], opts: { timeoutMs?: number; idempotencyKey?: string; json?: boolean }) => {
      if (command.length === 0) fail('command must not be empty');
      const timeoutMs = parsePositiveInt(
        opts.timeoutMs === undefined ? undefined : String(opts.timeoutMs),
        'timeout-ms',
      );
      const client = getIMClient();
      const res = await client.environments.exec(
        environmentId,
        { command, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
        { idempotencyKey: opts.idempotencyKey },
      );
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => printExecView(res.data));
    });

  environment
    .command('exec-get <environmentId> <execId>')
    .description('Read an exec handle (cursor = stdout byte offset for paged reads)')
    .option('--cursor <n>', 'stdout byte offset to resume from', (v) => Number(v))
    .option('--json', 'Output JSON')
    .action(async (environmentId: string, execId: string, opts: { cursor?: number; json?: boolean }) => {
      const client = getIMClient();
      const res = await client.environments.getExec(environmentId, execId, { cursor: opts.cursor });
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => {
        const v: EaasExecReadView = res.data;
        process.stdout.write(`Exec ${v.execId} status=${v.status} exit=${v.exitCode ?? '-'}\n`);
        if (v.stdout) process.stdout.write(v.stdout + (v.stdout.endsWith('\n') ? '' : '\n'));
        if (v.stderr) process.stderr.write(v.stderr + (v.stderr.endsWith('\n') ? '' : '\n'));
        if (v.error) process.stdout.write(`  error      ${v.error}\n`);
        if (v.nextCursor !== null && v.nextCursor !== undefined) {
          process.stdout.write(`  nextCursor ${v.nextCursor}\n`);
        }
      });
    });


  // ── snapshots ──────────────────────────────────────────────────────────
  environment
    .command('snapshot-create <environmentId>')
    .description('Create a snapshot (202 + pending op; the reconciler executes port.snapshot)')
    .option('--idempotency-key <k>', 'Reuse a key to retry the same snapshot safely')
    .option('--json', 'Output JSON')
    .action(async (environmentId: string, opts: { idempotencyKey?: string; json?: boolean }) => {
      const res = await getIMClient().environments.createSnapshot(environmentId, {
        idempotencyKey: opts.idempotencyKey,
      });
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => {
        process.stdout.write(`Snapshot: ${res.data.snapshotId}\n`);
        process.stdout.write(`  state        ${res.data.state}\n`);
        process.stdout.write(`  operationId  ${res.data.operationId}\n`);
      });
    });

  environment
    .command('snapshot-list <environmentId>')
    .description('List succeeded snapshots of an environment (createdAt asc)')
    .option('--json', 'Output JSON')
    .action(async (environmentId: string, opts: { json?: boolean }) => {
      const res = await getIMClient().environments.listSnapshots(environmentId);
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => printRows(res.data.snapshots, 'No snapshots found.'));
    });

  environment
    .command('snapshot-restore <environmentId> <snapshotId>')
    .description('Restore an environment from a snapshot (idempotent, reconciler executes)')
    .option('--idempotency-key <k>', 'Reuse a key to retry the same restore safely')
    .option('--json', 'Output JSON')
    .action(async (environmentId: string, snapshotId: string, opts: { idempotencyKey?: string; json?: boolean }) => {
      const res = await getIMClient().environments.restore(environmentId, snapshotId, {
        idempotencyKey: opts.idempotencyKey,
      });
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => printLifecycle(res.data, 'restored'));
    });

  // ── service readiness projection ──────────────────────────────────────
  environment
    .command('services <environmentId>')
    .description('Show service readiness + the signed scoped gateway URL (never a Pod IP)')
    .option('--json', 'Output JSON')
    .action(async (environmentId: string, opts: { json?: boolean }) => {
      const res = await getIMClient().environments.listServices(environmentId);
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => {
        const v: EaasServicesProjection = res.data;
        process.stdout.write(`Services (${v.environmentId}):\n`);
        for (const s of v.services) {
          process.stdout.write(`  ${s.name.padEnd(24)} ${s.state} (${s.lastCheckedAt ?? 'unchecked'})\n`);
        }
        process.stdout.write(`  gatewayUrl ${v.gatewayUrl}\n`);
      });
    });

  // ── binary file face ───────────────────────────────────────────────────
  environment
    .command('file-get <environmentId> <path>')
    .description('Download a file: raw bytes to stdout (or --out <localFile>); sha256 verified against X-Eaas-File-Sha256')
    .option('--out <localFile>', 'Write the bytes to a local file instead of stdout')
    .option('--json', 'Output JSON metadata (sha256/size) instead of human summary; byte stream unchanged')
    .action(async (environmentId: string, path: string, opts: { out?: string; json?: boolean }) => {
      const res = await getIMClient().environments.getFile(environmentId, path);
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      if (opts.out !== undefined) {
        const fsMod = await import('fs');
        fsMod.writeFileSync(opts.out, res.bytes);
        emit(
          { success: true, sha256: res.sha256, sizeBytes: res.bytes.length, out: opts.out },
          opts.json === true,
          () => process.stdout.write(`Saved ${path} → ${opts.out} (${res.bytes.length} bytes, sha256 ${res.sha256})\n`),
        );
        return;
      }
      // No --out: byte stream IS the output (curl-style); metadata goes to stderr
      // so pipes stay clean in both --json and human mode.
      process.stderr.write(`sha256 ${res.sha256} (${res.bytes.length} bytes)\n`);
      process.stdout.write(Buffer.from(res.bytes.buffer, res.bytes.byteOffset, res.bytes.byteLength));
    });

  environment
    .command('file-put <environmentId> <path> <localFile>')
    .description('Upload a local file as raw octet-stream bytes (<=1MB server cap; returns sha256)')
    .option('--json', 'Output JSON')
    .action(async (environmentId: string, path: string, localFile: string, opts: { json?: boolean }) => {
      const fsMod = await import('fs');
      const bytes = fsMod.readFileSync(localFile);
      const res = await getIMClient().environments.putFile(environmentId, path, new Uint8Array(bytes));
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => {
        process.stdout.write(`Uploaded: ${res.data.path}\n`);
        process.stdout.write(`  size    ${res.data.size}\n`);
        process.stdout.write(`  sha256  ${res.data.sha256}\n`);
      });
    });

  // ── usage / billing (project-scoped operator faces) ────────────────────
  environment
    .command('usage <projectId>')
    .description('Read the project metering ledger (60s grid usage rows)')
    .option('--from <iso>', 'Window start ISO timestamp')
    .option('--to <iso>', 'Window end ISO timestamp')
    .option('--cursor <c>', 'Resume cursor')
    .option('--limit <n>', 'Page size (<=500)', (v) => Number(v))
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { from?: string; to?: string; cursor?: string; limit?: number; json?: boolean }) => {
      const res = await getIMClient().environments.usage(projectId, {
        from: opts.from,
        to: opts.to,
        cursor: opts.cursor,
        limit: opts.limit,
      });
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => {
        const v: EaasUsagePage = res.data;
        process.stdout.write(
          `Usage periodSpent warm=${v.periodSpent.warmCredits} active=${v.periodSpent.activeCredits} (rate ${v.rateVersion ?? '-'})\n`,
        );
        printRows(v.items, 'No usage rows found.');
        if (v.nextCursor) process.stdout.write(`nextCursor ${v.nextCursor}\n`);
      });
    });

  environment
    .command('billing <projectId>')
    .description('Read project billing projection (human/operator billing face)')
    .option('--from <iso>', 'Window start ISO timestamp')
    .option('--to <iso>', 'Window end ISO timestamp')
    .option('--cursor <c>', 'Resume cursor')
    .option('--limit <n>', 'Page size (<=500)', (v) => Number(v))
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { from?: string; to?: string; cursor?: string; limit?: number; json?: boolean }) => {
      const res = await getIMClient().environments.billing(projectId, {
        from: opts.from,
        to: opts.to,
        cursor: opts.cursor,
        limit: opts.limit,
      });
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => {
        const v: EaasBillingPage = res.data;
        process.stdout.write(`Billing total=${v.totals.credits} warm=${v.totals.warmCredits} active=${v.totals.activeCredits} settlement=${v.settlement.status}\n`);
        printRows(v.items, 'No billing rows found.');
        if (v.nextCursor) process.stdout.write(`nextCursor ${v.nextCursor}\n`);
      });
    });

  // ── principal sessions / conversations / runs (Gate B T14 parity) ─────
  environment
    .command('issue-session')
    .description('Exchange the current pk-eaas token for a principal session')
    .option('--anonymous', 'Use anonymous provider')
    .option('--identity-token <jwt>', 'Use a platform identity access token')
    .option('--environment <environmentId>', 'Bind the issued principal session to an environment')
    .option('--ttl <seconds>', 'Session TTL seconds', (v) => Number(v))
    .option('--json', 'Output JSON')
    .action(async (opts: { anonymous?: boolean; identityToken?: string; environment?: string; ttl?: number; json?: boolean }) => {
      const body: Record<string, unknown> = {};
      if (opts.anonymous) body.anonymous = true;
      if (opts.identityToken !== undefined) body.identityToken = opts.identityToken;
      if (opts.environment !== undefined) body.environmentId = opts.environment;
      if (opts.ttl !== undefined) body.ttlSeconds = opts.ttl;
      const res = await getIMClient().environments.issueSession(body);
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => {
        process.stdout.write(`Principal session: ${res.data.principalId}\n`);
        process.stdout.write(`  token      ${res.data.token}\n`);
        process.stdout.write(`  expiresAt  ${res.data.expiresAt}\n`);
        process.stdout.write(`  scopes     ${res.data.effectiveScopes.join(',')}\n`);
      });
    });

  environment
    .command('conversation-list <environmentId>')
    .description('List principal conversations for an environment')
    .option('--json', 'Output JSON')
    .action(async (environmentId: string, opts: { json?: boolean }) => {
      const res = await getIMClient().environments.listConversations(environmentId);
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => printRows(res.data.conversations, 'No conversations found.'));
    });

  environment
    .command('conversation-ensure <environmentId>')
    .description('Return or create the principal↔agent conversation')
    .option('--json', 'Output JSON')
    .action(async (environmentId: string, opts: { json?: boolean }) => {
      const res = await getIMClient().environments.ensureConversation(environmentId);
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => process.stdout.write(`Conversation: ${res.data.conversationId} (${res.data.agentName})\n`));
    });

  environment
    .command('asset-upload <environmentId> <file>')
    .description('Upload an image asset for multimodal messages (content-hash deduped; returns assetId for message-send --image)')
    .option('--media-type <mt>', 'Override content-type (default: derived from extension)')
    .option('--json', 'Output JSON')
    .action(async (environmentId: string, file: string, opts: { mediaType?: string; json?: boolean }) => {
      const fsMod = await import('fs');
      const pathMod = await import('path');
      const extMedia: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
      };
      const mediaType = opts.mediaType ?? extMedia[pathMod.extname(file).toLowerCase()] ?? 'image/png';
      const bytes = fsMod.readFileSync(file);
      const res = await getIMClient().environments.uploadAsset(environmentId, bytes, mediaType);
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => {
        process.stdout.write(`Asset: ${res.data.assetId}\n`);
        process.stdout.write(`  contentHash  ${res.data.contentHash}\n`);
        process.stdout.write(`  sizeBytes    ${res.data.sizeBytes}\n`);
        process.stdout.write(`  mediaType    ${res.data.mediaType}\n`);
        process.stdout.write(`  deduplicated ${res.data.deduplicated}\n`);
      });
    });

  environment
    .command('message-send <environmentId> <conversationId> <content>')
    .description('Send a message to the environment agent (returns durable runId)')
    .option('--idempotency-key <k>', 'Reuse a key to retry the same message safely')
    .option('--image <assetId>', 'Attach an image asset (repeatable, max 4; the server derives the actual mime from the asset row)', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--answer-question <questionId>', 'Treat this message as the answer to a pending agent question')
    .option('--answer-option <optionId>', 'Chosen option id for --answer-question')
    .option('--json', 'Output JSON')
    .action(async (environmentId: string, conversationId: string, content: string, opts: { idempotencyKey?: string; image?: string[]; answerQuestion?: string; answerOption?: string; json?: boolean }) => {
      const contentBlocks = (opts.image ?? []).map((assetId) => ({ kind: 'image' as const, assetId, mediaType: 'image/png' }));
      const answer = opts.answerQuestion !== undefined
        ? (opts.answerOption !== undefined ? { questionId: opts.answerQuestion, optionId: opts.answerOption } : { questionId: opts.answerQuestion })
        : undefined;
      const res = await getIMClient().environments.sendMessage(
        environmentId,
        conversationId,
        {
          content,
          ...(contentBlocks.length > 0 ? { contentBlocks } : {}),
          ...(answer !== undefined ? { answer } : {}),
        },
        { idempotencyKey: opts.idempotencyKey },
      );
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => {
        process.stdout.write(`Message: ${res.data.messageId}\n`);
        process.stdout.write(`  conversationId ${res.data.conversationId}\n`);
        process.stdout.write(`  runId          ${res.data.runId}\n`);
        process.stdout.write(`  deduplicated   ${res.data.deduplicated}\n`);
      });
    });

  environment
    .command('message-list <environmentId> <conversationId>')
    .description('List messages in a principal conversation')
    .option('--limit <n>', 'Page size', (v) => Number(v))
    .option('--json', 'Output JSON')
    .action(async (environmentId: string, conversationId: string, opts: { limit?: number; json?: boolean }) => {
      const res = await getIMClient().environments.listMessages(environmentId, conversationId, { limit: opts.limit });
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => printRows(res.data.messages, 'No messages found.'));
    });

  environment
    .command('run-get <environmentId> <runId>')
    .description('Show the durable run backing an EaaS turn')
    .option('--json', 'Output JSON')
    .action(async (environmentId: string, runId: string, opts: { json?: boolean }) => {
      const res = await getIMClient().environments.getRun(environmentId, runId);
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => {
        process.stdout.write(`Run: ${res.data.runId}\n`);
        process.stdout.write(`  status     ${res.data.status}\n`);
        process.stdout.write(`  recovery   ${res.data.recoveryState}\n`);
      });
    });

  environment
    .command('run-cancel <environmentId> <runId>')
    .description('Cancel a non-terminal EaaS turn')
    .option('--json', 'Output JSON')
    .action(async (environmentId: string, runId: string, opts: { json?: boolean }) => {
      const res = await getIMClient().environments.cancelRun(environmentId, runId);
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => process.stdout.write(`Run ${res.data.runId}: ${res.data.status}\n`));
    });

  environment
    .command('run-events <environmentId> <runId>')
    .description('List task-run events for an EaaS turn')
    .option('--cursor <cursor>', 'Cursor returned by a previous page')
    .option('--limit <n>', 'Page size', (v) => Number(v))
    .option('--json', 'Output JSON')
    .action(async (environmentId: string, runId: string, opts: { cursor?: string; limit?: number; json?: boolean }) => {
      const res = await getIMClient().environments.listRunEvents(environmentId, runId, { cursor: opts.cursor, limit: opts.limit });
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => printRows(res.data.events, 'No run events found.'));
    });

  environment
    .command('session-list <environmentId>')
    .description('List principal sessions bound to an environment')
    .option('--limit <n>', 'Page size', (v) => Number(v))
    .option('--json', 'Output JSON')
    .action(async (environmentId: string, opts: { limit?: number; json?: boolean }) => {
      const res = await getIMClient().environments.listSessions(environmentId, { limit: opts.limit });
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => printRows(res.data.sessions, 'No principal sessions found.'));
    });

  environment
    .command('session-revoke <environmentId> <sessionId>')
    .description('Revoke a principal session')
    .option('--json', 'Output JSON')
    .action(async (environmentId: string, sessionId: string, opts: { json?: boolean }) => {
      const res = await getIMClient().environments.revokeSession(environmentId, sessionId);
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => process.stdout.write(`Session ${res.data.id} revoked at ${res.data.revokedAt}\n`));
    });

  // ── publishable keys ───────────────────────────────────────────────────
  const publishableKey = parent
    .command('publishable-key')
    .description('EaaS publishable key management (project scoped)');

  publishableKey
    .command('list <projectId>')
    .description('List project publishable keys (no plaintext)')
    .option('--limit <n>', 'Page size', (v) => Number(v))
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { limit?: number; json?: boolean }) => {
      const res = await getIMClient().projects.publishableKeys.list(projectId, { limit: opts.limit });
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => printRows(res.data.keys, 'No publishable keys found.'));
    });

  publishableKey
    .command('create <projectId>')
    .description('Create a publishable key (plaintext shown once)')
    .option('--name <name>', 'Operator-facing key name')
    .option('--scope <scope>', 'Principal scope to grant (repeatable)', collectPairs, [] as string[])
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { name?: string; scope?: string[]; json?: boolean }) => {
      const scopes = opts.scope && opts.scope.length > 0 ? opts.scope : undefined;
      const res = await getIMClient().projects.publishableKeys.create(projectId, { name: opts.name, scopes });
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => {
        process.stdout.write(`Publishable key: ${res.data.id}\n`);
        process.stdout.write(`  key        ${res.data.key}\n`);
        process.stdout.write(`  keyPrefix  ${res.data.keyPrefix}\n`);
        process.stdout.write('  note       copy now; plaintext is shown once\n');
      });
    });

  publishableKey
    .command('revoke <projectId> <keyId>')
    .description('Revoke a publishable key')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, keyId: string, opts: { json?: boolean }) => {
      const res = await getIMClient().projects.publishableKeys.revoke(projectId, keyId);
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => process.stdout.write(`Publishable key ${res.data.id} revoked at ${res.data.revokedAt}\n`));
    });

  const poolPolicy = parent.command('pool-policy').description('EaaS project multi-pool policy (operator only)');
  poolPolicy.command('get <projectId>')
    .option('--json', 'Output JSON')
    .action(async (projectId: string) => {
      const res = await getIMClient().projects.poolPolicy.get(projectId);
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
    });
  poolPolicy.command('patch <projectId>')
    .description('Replace the complete policy; no implicit read/merge or offline queue')
    .requiredOption('--policy <json>', 'Complete policy JSON (all pool preferences)')
    .requiredOption('--config-revision <revision>', 'Platform configRevision from policy get')
    .requiredOption('--revision <n>', 'Policy revision from policy get (If-Match)', Number)
    .option('--dry-run', 'Validate without writing or advancing revision')
    .option('--idempotency-key <key>', 'Reuse for retries of the same replacement')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { policy: string; configRevision: string; revision: number; dryRun?: boolean; idempotencyKey?: string }) => {
      if (!Number.isSafeInteger(opts.revision) || opts.revision < 0) fail('--revision must be a non-negative safe integer');
      let policy: ProjectPoolManagement;
      try { policy = JSON.parse(opts.policy); } catch { fail('--policy must be valid JSON'); }
      if (!policy || typeof policy !== 'object' || Array.isArray(policy)) fail('--policy must be an object');
      const res = await getIMClient().projects.poolPolicy.patch(projectId, {
        configRevision: opts.configRevision, policy,
        ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
      }, { revision: opts.revision, idempotencyKey: opts.idempotencyKey });
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
    });
  parent.command('pools').description('EaaS project pool inventory (operator only)')
    .command('list <projectId>')
    .option('--cursor <cursor>', 'Cursor from the preceding page')
    .option('--limit <n>', 'Page size 1..100', Number)
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { cursor?: string; limit?: number }) => {
      if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > 100)) fail('--limit must be an integer 1..100');
      const res = await getIMClient().projects.pools.list(projectId, opts);
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
    });

  // ── warm pool ──────────────────────────────────────────────────────────
  const warmPool = parent
    .command('warm-pool')
    .description('EaaS warm pool policy (eaas-gate-a T12) — desired state on a project');

  warmPool
    .command('get <projectId>')
    .description('Show the warm pool policy + effective state + cost window')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { json?: boolean }) => {
      const client = getIMClient();
      const res = await client.projects.warmPool.get(projectId);
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => printWarmPool(res.data));
    });

  warmPool
    .command('patch <projectId>')
    .description('Patch the desired policy (read-merge-write; --dry-run validates without writing)')
    .option('--revision <n>', 'If-Match CAS pin (bare integer). Default: the revision observed at read time', (v) => Number(v))
    .option('--min-ready <n>', 'Target ready inventory (integer 0..5). Omitted flags keep their current value', (v) => Number(v))
    .option('--max-ready <n>', 'Warm ceiling incl. provisioning (integer minReady..5)', (v) => Number(v))
    .option('--idle-retention-seconds <n>', 'Retention window for unclaimed inventory above minReady (0..1800)', (v) => Number(v))
    .option('--daily-budget-credits <credits>', 'Non-negative decimal fixed-point string, e.g. "10.000"')
    .option('--on-miss <mode>', 'cold | fail (fail → 503 warm_capacity_unavailable when the pool is empty)')
    .option('--dry-run', 'Validate + price without writing')
    .option('--idempotency-key <k>', 'Reuse a key to retry the same patch safely')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: {
      revision?: number;
      minReady?: number;
      maxReady?: number;
      idleRetentionSeconds?: number;
      dailyBudgetCredits?: string;
      onMiss?: string;
      dryRun?: boolean;
      idempotencyKey?: string;
      json?: boolean;
    }) => {
      // Validate the operator input BEFORE the read: a bad invocation must
      // issue zero requests.
      if (opts.revision !== undefined && (!Number.isInteger(opts.revision) || opts.revision < 0)) {
        fail('--revision must be a non-negative integer');
      }
      if (opts.minReady !== undefined && (!Number.isInteger(opts.minReady) || opts.minReady < 0)) {
        fail('--min-ready must be a non-negative integer');
      }
      if (opts.maxReady !== undefined && (!Number.isInteger(opts.maxReady) || opts.maxReady < 0)) {
        fail('--max-ready must be a non-negative integer');
      }
      if (
        opts.idleRetentionSeconds !== undefined &&
        (!Number.isInteger(opts.idleRetentionSeconds) || opts.idleRetentionSeconds < 0)
      ) {
        fail('--idle-retention-seconds must be a non-negative integer');
      }
      if (opts.onMiss !== undefined && opts.onMiss !== 'cold' && opts.onMiss !== 'fail') {
        fail('--on-miss must be cold|fail');
      }
      const overrides: {
        minReady?: number;
        maxReady?: number;
        idleRetentionSeconds?: number;
        dailyBudgetCredits?: string;
        onMiss?: WarmPoolPolicy['onMiss'];
      } = {
        minReady: opts.minReady,
        maxReady: opts.maxReady,
        idleRetentionSeconds: opts.idleRetentionSeconds,
        dailyBudgetCredits: opts.dailyBudgetCredits,
        onMiss: opts.onMiss,
      };
      if (Object.values(overrides).every((v) => v === undefined)) {
        fail('Nothing to patch — pass at least one policy flag');
      }

      const client = getIMClient();
      // C1: the wire is REPLACE-semantics — the server validator defaults every
      // omitted policy field (0 / 'cold'), so sending a partial policy would
      // silently reset the rest of the running policy. Read the current desired
      // policy, overlay the operator's flags, and write the FULL merged policy
      // back, If-Match = the revision observed at read time (--revision pins an
      // explicit CAS for scripts instead). Scripts that want the raw partial
      // write can use the SDK's WarmPoolClient.patch directly.
      const read = await client.projects.warmPool.get(projectId);
      if (!read.success) fail(`${read.error.code}: ${read.error.message}`);
      const policy: Partial<WarmPoolPolicy> = { ...read.data.desired };
      if (overrides.minReady !== undefined) policy.minReady = overrides.minReady;
      if (overrides.maxReady !== undefined) policy.maxReady = overrides.maxReady;
      if (overrides.idleRetentionSeconds !== undefined) {
        policy.idleRetentionSeconds = overrides.idleRetentionSeconds;
      }
      if (overrides.dailyBudgetCredits !== undefined) {
        policy.dailyBudgetCredits = overrides.dailyBudgetCredits;
      }
      if (overrides.onMiss !== undefined) policy.onMiss = overrides.onMiss;

      const res = await client.projects.warmPool.patch(
        projectId,
        { policy: policy as unknown as WarmPoolPolicy, dryRun: opts.dryRun },
        {
          revision: opts.revision !== undefined ? opts.revision : read.data.revision,
          idempotencyKey: opts.idempotencyKey,
        },
      );
      if (!res.success) fail(`${res.error.code}: ${res.error.message}`);
      emit(res.data, opts.json === true, () => {
        if (opts.dryRun) {
          process.stdout.write(
            'Dry run (nothing written). NOTE: the warm-pool API REPLACES the whole policy —\n' +
              'this CLI merged your flags onto the current desired policy, so omitted flags\n' +
              'keep their current value (a partial write through the SDK would reset them).\n',
          );
        }
        printWarmPool(res.data);
      });
    });
}
