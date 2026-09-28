/**
 * `cloud metric` — emit + aggregate metric events (release201/11 §6.2).
 *
 *   cloud metric emit  <ns>.<name> [--value N] [--dim k=v]...
 *   cloud metric agg   <ns>.<name> --agg count [--range 7d|--from ISO --to ISO]
 *                                  [--groupBy k1,k2] [--filter workspaceId:abc,...]
 *                                  [--bucket 5m|1h|1d]
 *   cloud metric events <ns>.<name> --filter workspaceId:abc [--range 24h]
 *                                   [--limit N]          (B-P1d provenance read)
 *   cloud metric turns  --scope conversation|task|agent --id <id>
 *                       --filter workspaceId:abc [--range 24h]  (B-P1d)
 *
 * Top-level shortcut `cloud emit <ns>.<name>` is registered in cli.ts; it
 * delegates here so SKILL.md can write the compact form.
 */

import { Command } from 'commander';
import type {
  PrismerClient,
  MetricAgg,
  MetricBucket,
  MetricEmitInput,
  MetricEventRow,
  TurnMetricsSummary,
  TurnScope,
} from '../index';

type ClientFactory = () => PrismerClient;

const AGG_FUNCS: ReadonlyArray<MetricAgg> = ['sum', 'count', 'avg', 'min', 'max', 'p50', 'p95', 'p99'];
const BUCKETS: ReadonlyArray<MetricBucket> = ['5m', '1h', '1d'];

function splitFqName(fqName: string): { namespace: string; name: string } {
  const i = fqName.lastIndexOf('.');
  if (i <= 0 || i === fqName.length - 1) {
    throw new Error(`metric name must be in form "namespace.name" (got "${fqName}")`);
  }
  return { namespace: fqName.slice(0, i), name: fqName.slice(i + 1) };
}

/** Parse a `--filter k1:v1,k2:v2` csv into a dim record (same grammar as agg). */
function parseFilterCsv(raw: string | undefined): Record<string, string> {
  const filter: Record<string, string> = {};
  for (const part of (raw ?? '').split(',').filter(Boolean)) {
    const i = part.indexOf(':');
    if (i <= 0) throw new Error(`--filter "${part}" must be in form key:value`);
    filter[part.slice(0, i)] = part.slice(i + 1);
  }
  return filter;
}

function parseDimFlags(dimArr: string[] | undefined): Record<string, string | number | boolean> {
  const dims: Record<string, string | number | boolean> = {};
  for (const raw of dimArr ?? []) {
    const i = raw.indexOf('=');
    if (i <= 0) throw new Error(`--dim "${raw}" must be in form key=value`);
    const key = raw.slice(0, i);
    const value = raw.slice(i + 1);
    // Coerce numeric / boolean tails so the registry's value-type validation
    // sees the right type. Anything else stays a string.
    if (/^-?\d+(?:\.\d+)?$/.test(value)) dims[key] = Number(value);
    else if (value === 'true' || value === 'false') dims[key] = value === 'true';
    else dims[key] = value;
  }
  return dims;
}

interface EmitOpts {
  value?: string;
  dim?: string[];
  ts?: string;
  json?: boolean;
}

export async function runEmit(
  fqName: string,
  opts: EmitOpts,
  getIMClient: ClientFactory,
): Promise<void> {
  const client = getIMClient();
  const { namespace, name } = splitFqName(fqName);
  const dims = parseDimFlags(opts.dim);
  if (!dims.workspaceId) {
    throw new Error('--dim workspaceId=<id> is required (server rejects emits without it)');
  }

  let value: number | string | undefined;
  if (opts.value !== undefined) {
    value = /^-?\d+(?:\.\d+)?$/.test(opts.value) ? Number(opts.value) : opts.value;
  }

  const input: MetricEmitInput = {
    namespace,
    name,
    ts: opts.ts,
    value,
    dims: dims as MetricEmitInput['dims'],
  };
  const res = await client.im.metrics.emit(input);

  if (opts.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return;
  }
  if (!res.ok) {
    process.stderr.write(`Error: ${res.error?.message ?? 'unknown error'}\n`);
    process.exit(1);
  }
  process.stdout.write(`emitted ${namespace}.${name}\n`);
}

interface AggOpts {
  agg: string;
  range?: string;
  from?: string;
  to?: string;
  groupBy?: string;
  filter?: string;
  bucket?: string;
  json?: boolean;
}

export async function runAgg(
  fqName: string,
  opts: AggOpts,
  getIMClient: ClientFactory,
): Promise<void> {
  const client = getIMClient();
  const { namespace, name } = splitFqName(fqName);
  if (!AGG_FUNCS.includes(opts.agg as MetricAgg)) {
    throw new Error(`--agg must be one of ${AGG_FUNCS.join('|')}`);
  }
  if (opts.bucket && !BUCKETS.includes(opts.bucket as MetricBucket)) {
    throw new Error(`--bucket must be one of ${BUCKETS.join('|')}`);
  }

  const filter: Record<string, string> = {};
  for (const raw of (opts.filter ?? '').split(',').filter(Boolean)) {
    const i = raw.indexOf(':');
    if (i <= 0) throw new Error(`--filter "${raw}" must be in form key:value`);
    filter[raw.slice(0, i)] = raw.slice(i + 1);
  }
  if (!filter.workspaceId) {
    throw new Error('--filter must include workspaceId:<id> (cross-workspace queries are admin-only)');
  }

  const groupBy = opts.groupBy ? opts.groupBy.split(',').filter(Boolean) : undefined;

  const res = await client.im.metrics.aggregate({
    namespace,
    name,
    agg: opts.agg as MetricAgg,
    range: opts.range,
    from: opts.from,
    to: opts.to,
    groupBy,
    filter: filter as { workspaceId: string },
    bucket: opts.bucket as MetricBucket | undefined,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return;
  }
  if (!res.ok) {
    process.stderr.write(`Error: ${res.error?.message ?? 'unknown error'}\n`);
    process.exit(1);
  }
  const data = res.data;
  if (!data) {
    process.stdout.write('(no data)\n');
    return;
  }
  process.stdout.write(
    `${data.namespace}.${data.name} ${data.agg} ` +
      `[${data.range.from} → ${data.range.to}]\n`,
  );
  for (const bucket of data.buckets) {
    const tsLabel = bucket.ts ? `${bucket.ts}` : '(all)';
    for (const g of bucket.groups) {
      const keyLabel = Object.entries(g.groupKey)
        .map(([k, v]) => `${k}=${v ?? '∅'}`)
        .join(' ');
      process.stdout.write(`  ${tsLabel}  ${keyLabel || '(no group)'}  →  ${g.value ?? '∅'}\n`);
    }
  }
}

interface EventsOpts {
  range?: string;
  from?: string;
  to?: string;
  limit?: string;
  filter?: string;
  json?: boolean;
}

export async function runEvents(
  fqName: string,
  opts: EventsOpts,
  getIMClient: ClientFactory,
): Promise<void> {
  const client = getIMClient();
  const { namespace, name } = splitFqName(fqName);
  const filter = parseFilterCsv(opts.filter);
  if (!filter.workspaceId) {
    throw new Error('--filter must include workspaceId:<id> (cross-workspace queries are admin-only)');
  }

  const res = await client.im.metrics.events({
    namespace,
    name,
    filter: filter as { workspaceId: string },
    range: opts.range,
    from: opts.from,
    to: opts.to,
    limit: opts.limit !== undefined ? Number(opts.limit) : undefined,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return;
  }
  if (!res.ok) {
    process.stderr.write(`Error: ${res.error?.message ?? 'unknown error'}\n`);
    process.exit(1);
  }
  const data = res.data;
  if (!data) {
    process.stdout.write('(no data)\n');
    return;
  }
  process.stdout.write(`${data.namespace}.${data.name} [${data.range.from} → ${data.range.to}]\n`);
  if (data.events.length === 0) {
    process.stdout.write('  (no events in window)\n');
    return;
  }
  for (const row of data.events) {
    process.stdout.write(`  ${renderEventRow(row)}\n`);
  }
}

function renderEventRow(row: MetricEventRow): string {
  const value = row.valueNumeric ?? row.valueString ?? '∅';
  const dims = row.dims ? Object.entries(row.dims).map(([k, v]) => `${k}=${String(v)}`).join(' ') : '';
  const source = row.sourceId ? `${row.source}/${row.sourceId}` : row.source;
  return `${row.ts}  ${source}  ${value}${dims ? `  ${dims}` : ''}`;
}

interface TurnsOpts {
  scope: string;
  id: string;
  range?: string;
  filter?: string;
  json?: boolean;
}

const TURN_SCOPES: ReadonlyArray<TurnScope> = ['conversation', 'task', 'agent'];

export async function runTurns(opts: TurnsOpts, getIMClient: ClientFactory): Promise<void> {
  const client = getIMClient();
  if (!TURN_SCOPES.includes(opts.scope as TurnScope)) {
    throw new Error(`--scope must be one of ${TURN_SCOPES.join('|')}`);
  }
  const filter = parseFilterCsv(opts.filter);
  if (!filter.workspaceId) {
    throw new Error('--filter must include workspaceId:<id> (cross-workspace queries are admin-only)');
  }
  const extra = Object.keys(filter).filter((k) => k !== 'workspaceId');
  if (extra.length) {
    throw new Error(
      `--filter only accepts workspaceId here (got ${extra.join(',')}); ` +
        '/turns scopes by --scope/--id, not by dim filter',
    );
  }

  const res = await client.im.metrics.turnSummary({
    scope: opts.scope as TurnScope,
    id: opts.id,
    workspaceId: filter.workspaceId,
    range: opts.range,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return;
  }
  if (!res.ok) {
    process.stderr.write(`Error: ${res.error?.message ?? 'unknown error'}\n`);
    process.exit(1);
  }
  const summary = res.data;
  if (!summary) {
    process.stdout.write('(no data)\n');
    return;
  }
  process.stdout.write(renderTurnSummary(summary, { scope: opts.scope, id: opts.id, range: opts.range }));
}

function renderTurnSummary(
  s: TurnMetricsSummary,
  req: { scope: string; id: string; range?: string },
): string {
  const line = (label: string, value: string): string => `  ${label.padEnd(16)}${value}\n`;
  const models = s.models.length
    ? s.models.map((m) => `${m.model}=${m.turns}`).join(', ')
    : '∅';
  return (
    `turn summary scope=${req.scope} id=${req.id} range=${req.range ?? '(default 24h)'}\n` +
    line('turns', fmtNum(s.turnCount)) +
    line('byStatus', `ok=${fmtNum(s.turnCountByStatus.ok)} error=${fmtNum(s.turnCountByStatus.error)}`) +
    line(
      'tokens/turn',
      `input=${fmtNum(s.avgTokensPerTurn.input)} output=${fmtNum(s.avgTokensPerTurn.output)} ` +
        `cacheRead=${fmtNum(s.avgTokensPerTurn.cacheRead)} cacheWrite=${fmtNum(s.avgTokensPerTurn.cacheWrite)}`,
    ) +
    line('cacheHitRatio', fmtNum(s.cacheHitRatio)) +
    line('p95FirstEventMs', fmtNum(s.p95FirstEventMs)) +
    line('avgDurationMs', fmtNum(s.avgDurationMs)) +
    line('toolCalls/turn', fmtNum(s.toolCallsPerTurn)) +
    line('models', models)
  );
}

/** '∅' for "no rows"; integers verbatim; everything else at 2dp for readability. */
function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined) return '∅';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const metric = parent
    .command('metric')
    .description('Emit metric events and query aggregations (release201/11)');

  metric
    .command('emit <namespace.name>')
    .description('Emit a single metric event')
    .option('--value <value>', 'metric value (number or string)')
    .option('--dim <k=v>', 'dimension (repeatable; workspaceId is required)', (val: string, prev: string[] = []) => {
      prev.push(val);
      return prev;
    })
    .option('--ts <iso>', 'business timestamp in ISO 8601 (defaults to now)')
    .option('--json', 'output raw JSON response')
    .action(async (fqName: string, opts: EmitOpts) => {
      try {
        await runEmit(fqName, opts, getIMClient);
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        process.exit(1);
      }
    });

  metric
    .command('agg <namespace.name>')
    .description('Aggregate metric events (release201/11 §5)')
    .requiredOption('--agg <fn>', `one of ${AGG_FUNCS.join('|')}`)
    .option('--range <Nh|Nd>', 'lookback window (e.g. 24h, 7d)')
    .option('--from <iso>', 'window start (ISO, paired with --to)')
    .option('--to <iso>', 'window end (ISO, paired with --from)')
    .option('--groupBy <k1,k2>', 'csv of dim keys to group by')
    .option('--filter <k1:v1,k2:v2>', 'csv k:v filters (workspaceId is required)')
    .option('--bucket <5m|1h|1d>', 'timeseries bucket size')
    .option('--json', 'output raw JSON response')
    .action(async (fqName: string, opts: AggOpts) => {
      try {
        await runAgg(fqName, opts, getIMClient);
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        process.exit(1);
      }
    });

  metric
    .command('events <namespace.name>')
    .description('Raw event rows behind an aggregate (runtime210/06 provenance read)')
    .requiredOption('--filter <k1:v1,k2:v2>', 'csv k:v filters (workspaceId is required)')
    .option('--range <Nh|Nd>', 'lookback window (e.g. 24h, 7d)')
    .option('--from <iso>', 'window start (ISO, paired with --to)')
    .option('--to <iso>', 'window end (ISO, paired with --from)')
    .option('--limit <n>', 'max rows (server default 50, clamped to 200)')
    .option('--json', 'output raw JSON response')
    .action(async (fqName: string, opts: EventsOpts) => {
      try {
        await runEvents(fqName, opts, getIMClient);
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        process.exit(1);
      }
    });

  metric
    .command('turns')
    .description('Conversation/task/agent turn summary over the turn.* family (B-P1d)')
    .requiredOption('--scope <scope>', `one of ${TURN_SCOPES.join('|')}`)
    .requiredOption('--id <id>', 'conversationId | taskId | agentId (IM user id of the agent)')
    .requiredOption('--filter <k:v>', 'workspaceId:<id> is required')
    .option('--range <Nh|Nd>', 'lookback window (e.g. 24h, 7d; default 24h)')
    .option('--json', 'output raw JSON response')
    .action(async (opts: TurnsOpts) => {
      try {
        await runTurns(opts, getIMClient);
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        process.exit(1);
      }
    });
}
