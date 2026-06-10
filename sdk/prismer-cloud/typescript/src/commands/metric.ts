/**
 * `cloud metric` — emit + aggregate metric events (release201/11 §6.2).
 *
 *   cloud metric emit <ns>.<name> [--value N] [--dim k=v]...
 *   cloud metric agg  <ns>.<name> --agg count [--range 7d|--from ISO --to ISO]
 *                                 [--groupBy k1,k2] [--filter workspaceId:abc,...]
 *                                 [--bucket 5m|1h|1d]
 *
 * Top-level shortcut `cloud emit <ns>.<name>` is registered in cli.ts; it
 * delegates here so SKILL.md can write the compact form.
 */

import { Command } from 'commander';
import type { PrismerClient, MetricAgg, MetricBucket, MetricEmitInput } from '../index';

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
}
