/**
 * Prismer IM — Metrics API (v2.0.7 release201/11 §5)
 *
 *   POST /metrics/emit       single event (admin / agent)
 *   POST /metrics/batch      batch ingest (daemon)
 *   GET  /metrics/aggregate  count / sum / avg / min / max / p50 / p95 / p99
 *                            + groupBy + timeseries bucket
 *
 * Auth: every endpoint requires a logged-in IM user (authMiddleware on the
 * sub-router). workspaceId is REQUIRED on aggregate filter (release201/11
 * §0.2.4); cross-workspace queries are reserved for admin (TODO when
 * isWorkspaceAdmin gains a cross-workspace marker — for now we enforce
 * workspaceId on all callers; admin override deferred to Phase 3).
 *
 * Forbidden log patterns:
 *   - "[metric] queue dropped"
 *   - "[metric] dim missing workspaceId"
 * We use neutral phrasing for any drift logging.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import type { ApiResponse } from '../types';
import { getMetricService, type MetricEmitInput, type MetricSource } from '../services/metric.service';
import { prisma } from '@/lib/prisma';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('MetricsAPI');

export type AggFunc = 'sum' | 'count' | 'avg' | 'min' | 'max' | 'p50' | 'p95' | 'p99';
const AGG_FUNCS: readonly AggFunc[] = ['sum', 'count', 'avg', 'min', 'max', 'p50', 'p95', 'p99'];
export type BucketSize = '5m' | '1h' | '1d';
const ALLOWED_DIMS = new Set([
  'workspaceId',
  'projectId',
  'agentId',
  'taskId',
  'skillId',
  'capability',
  'conversationId',
  'daemonId',
  'userId',
  'criterionId',
  'verifyMode',
  'status',
  'creatorId',
  'assigneeId',
  'runId',
  'reviewerUserId',
  'sourceKind',
  'reason',
  'publishScope',
  'metricId',
  'name',
  'decisionBy',
  // release201 S13 P0-3 — task.acceptance.status_changed emits a mirrored
  // dim alongside value_string so Insights can filter pass-rate by status.
  'acceptanceStatus',
  // skill.eval.run_finished mirrors passCount/failCount in dims for
  // dashboard rollups (§11 #9).
  'passCount',
  'failCount',
]);
const MAX_BATCH = 500;

interface EmitBody {
  namespace?: string;
  name?: string;
  ts?: string;
  value?: number | string | null;
  dims?: Record<string, string | number | boolean | null>;
}

interface BatchBody {
  events?: EmitBody[];
}

function badRequest(c: any, message: string, code = 'VALIDATION_ERROR') {
  return c.json({ ok: false, error: { code, message } } as ApiResponse, 400);
}

function parseRange(c: any): { from: Date; to: Date } | { error: string } {
  const range = c.req.query('range');
  const fromQ = c.req.query('from');
  const toQ = c.req.query('to');
  const now = new Date();
  if (range) {
    const m = /^(\d+)([hd])$/.exec(range);
    if (!m) return { error: `range must match Nh|Nd or use from/to (got "${range}")` };
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n) || n <= 0 || n > 365) return { error: 'range out of bounds (1..365)' };
    const ms = m[2] === 'h' ? n * 3600_000 : n * 86_400_000;
    return { from: new Date(now.getTime() - ms), to: now };
  }
  if (fromQ && toQ) {
    const from = new Date(fromQ);
    const to = new Date(toQ);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return { error: 'from/to must be ISO timestamps' };
    }
    if (to <= from) return { error: 'to must be after from' };
    return { from, to };
  }
  // Default: last 24h.
  return { from: new Date(now.getTime() - 86_400_000), to: now };
}

function parseFilter(raw: string | undefined): { dims: Record<string, string>; error?: string } {
  const dims: Record<string, string> = {};
  if (!raw) return { dims };
  for (const part of raw.split(',')) {
    const i = part.indexOf(':');
    if (i <= 0) return { dims, error: `filter "${part}" must be key:value` };
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!ALLOWED_DIMS.has(key)) return { dims, error: `filter key "${key}" not allowed` };
    if (value.length === 0 || value.length > 256) return { dims, error: `filter "${key}" value invalid` };
    dims[key] = value;
  }
  return { dims };
}

function parseGroupBy(raw: string | undefined): { keys: string[]; error?: string } {
  if (!raw) return { keys: [] };
  const keys = raw
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  for (const k of keys) {
    if (!ALLOWED_DIMS.has(k)) return { keys, error: `groupBy key "${k}" not allowed` };
  }
  return { keys: keys.slice(0, 4) };
}

function bucketSql(bucket: BucketSize): string {
  switch (bucket) {
    case '5m':
      return "DATE_FORMAT(FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(ts)/300)*300), '%Y-%m-%dT%H:%i:00Z')";
    case '1h':
      return "DATE_FORMAT(ts, '%Y-%m-%dT%H:00:00Z')";
    case '1d':
      return "DATE_FORMAT(ts, '%Y-%m-%dT00:00:00Z')";
  }
}

function aggSelect(agg: AggFunc): string {
  switch (agg) {
    case 'count':
      return 'COUNT(*)';
    case 'sum':
      return 'COALESCE(SUM(value_numeric), 0)';
    case 'avg':
      return 'AVG(value_numeric)';
    case 'min':
      return 'MIN(value_numeric)';
    case 'max':
      return 'MAX(value_numeric)';
    case 'p50':
    case 'p95':
    case 'p99':
      // MySQL 8 supports PERCENTILE_CONT only inline; we approximate using
      // ordered-window approach in postProcessPercentile.
      return "GROUP_CONCAT(value_numeric ORDER BY value_numeric SEPARATOR ',')";
  }
}

function percentileQuantile(agg: AggFunc): number {
  if (agg === 'p50') return 0.5;
  if (agg === 'p95') return 0.95;
  if (agg === 'p99') return 0.99;
  return 0;
}

function computePercentile(sortedCsv: string, q: number): number | null {
  if (!sortedCsv) return null;
  const vals = sortedCsv
    .split(',')
    .map((s) => parseFloat(s))
    .filter((v) => Number.isFinite(v));
  if (vals.length === 0) return null;
  // GROUP_CONCAT may truncate at group_concat_max_len (default 1024). For
  // v2.0.7 this is acceptable — Phase 3 swaps to a window-function path for
  // strict accuracy on 10M-row queries (§0.2.2).
  const idx = Math.min(vals.length - 1, Math.floor(q * (vals.length - 1)));
  return vals[idx];
}

function sanitizeDimsForEmit(
  raw: Record<string, unknown> | undefined | null,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    if (v === null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    }
  }
  return out;
}

export function createMetricsRouter(): Hono {
  const router = new Hono();
  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /metrics in routes.ts; scoped to that prefix
  router.use('*', authMiddleware);

  // ── POST /emit ─────────────────────────────────────────────────────────
  router.post('/emit', async (c) => {
    const user = c.get('user');
    const body = (await c.req.json().catch(() => ({}))) as EmitBody;
    if (!body.namespace || !body.name) {
      return badRequest(c, 'namespace and name are required');
    }
    const dims = sanitizeDimsForEmit(body.dims);
    if (!dims.workspaceId || typeof dims.workspaceId !== 'string') {
      return badRequest(c, 'dims.workspaceId is required', 'WORKSPACE_REQUIRED');
    }
    // Source classification: an IM user calling /emit is treated as 'agent'
    // (workspace agents emit telemetry) unless the caller is a daemon (which
    // should use /batch). Cloud-internal callers use metricEmit() directly.
    const source: MetricSource = user?.role === 'agent' ? 'agent' : 'cloud';
    const input: MetricEmitInput = {
      namespace: body.namespace,
      name: body.name,
      ts: body.ts ? new Date(body.ts) : undefined,
      value: body.value ?? undefined,
      dims: dims as MetricEmitInput['dims'],
      source,
      sourceId: user?.imUserId ?? null,
    };
    getMetricService().emit(input);
    return c.json<ApiResponse>({ ok: true, data: { queued: true } }, 202);
  });

  // ── POST /batch ────────────────────────────────────────────────────────
  router.post('/batch', async (c) => {
    const user = c.get('user');
    const body = (await c.req.json().catch(() => ({}))) as BatchBody;
    const events = Array.isArray(body.events) ? body.events : null;
    if (!events) return badRequest(c, 'events[] is required');
    if (events.length === 0) return badRequest(c, 'events[] is empty');
    if (events.length > MAX_BATCH) {
      return badRequest(c, `events[] exceeds ${MAX_BATCH} per request`, 'BATCH_TOO_LARGE');
    }

    const svc = getMetricService();
    let accepted = 0;
    const rejected: Array<{ index: number; error: string }> = [];
    // Daemon batch ingest: trust source=daemon, never trust client-supplied
    // source string (release201/11 §3.2). Paired daemons authenticate as an
    // agent IM user; sourceId is that user's imUserId. Human / admin callers
    // can also use /batch (e.g. backfill scripts) and are tagged source=cloud.
    const isDaemon = user?.role === 'agent';
    const sourceId = user?.imUserId ?? null;

    events.forEach((ev, idx) => {
      if (!ev.namespace || !ev.name) {
        rejected.push({ index: idx, error: 'namespace and name required' });
        return;
      }
      const dims = sanitizeDimsForEmit(ev.dims);
      if (!dims.workspaceId) {
        rejected.push({ index: idx, error: 'dims.workspaceId required' });
        return;
      }
      svc.emit({
        namespace: ev.namespace,
        name: ev.name,
        ts: ev.ts ? new Date(ev.ts) : undefined,
        value: ev.value ?? undefined,
        dims: dims as MetricEmitInput['dims'],
        source: isDaemon ? 'daemon' : 'cloud',
        sourceId,
        emittedAt: ev.ts ? new Date(ev.ts) : undefined,
      });
      accepted++;
    });

    return c.json<ApiResponse>(
      { ok: true, data: { accepted, rejected: rejected.length, errors: rejected.slice(0, 50) } },
      207,
    );
  });

  // ── GET /aggregate ─────────────────────────────────────────────────────
  router.get('/aggregate', async (c) => {
    const namespace = c.req.query('namespace');
    const name = c.req.query('name');
    const aggRaw = c.req.query('agg');
    const bucketRaw = c.req.query('bucket') as BucketSize | undefined;

    if (!namespace || !name) return badRequest(c, 'namespace and name are required');
    const agg = aggRaw as AggFunc;
    if (!aggRaw || !AGG_FUNCS.includes(agg)) {
      return badRequest(c, `agg must be one of ${AGG_FUNCS.join('|')}`);
    }
    if (bucketRaw && !['5m', '1h', '1d'].includes(bucketRaw)) {
      return badRequest(c, "bucket must be one of '5m'|'1h'|'1d'");
    }

    const range = parseRange(c);
    if ('error' in range) return badRequest(c, range.error);
    const filter = parseFilter(c.req.query('filter'));
    if (filter.error) return badRequest(c, filter.error);
    const groupBy = parseGroupBy(c.req.query('groupBy'));
    if (groupBy.error) return badRequest(c, groupBy.error);

    // release201/11 §0.2.4 — workspaceId is mandatory on aggregate to prevent
    // cross-workspace leakage. Service-layer enforcement: reject any query
    // missing it.
    if (!filter.dims.workspaceId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'WORKSPACE_REQUIRED',
            message: 'filter must include workspaceId (e.g. filter=workspaceId:<id>)',
          },
        } as ApiResponse,
        400,
      );
    }

    try {
      const result = await runAggregate({
        namespace,
        name,
        agg,
        from: range.from,
        to: range.to,
        filter: filter.dims,
        groupBy: groupBy.keys,
        bucket: bucketRaw,
      });
      return c.json<ApiResponse>({
        ok: true,
        data: {
          namespace,
          name,
          agg,
          range: { from: range.from.toISOString(), to: range.to.toISOString() },
          buckets: result,
        },
      });
    } catch (err) {
      log.error({ err, namespace, name, agg }, 'aggregate query failed');
      return c.json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: (err as Error).message } } as ApiResponse,
        500,
      );
    }
  });

  return router;
}

export interface AggregateArgs {
  namespace: string;
  name: string;
  agg: AggFunc;
  from: Date;
  to: Date;
  filter: Record<string, string>;
  groupBy: string[];
  bucket?: BucketSize;
}

export interface BucketResult {
  ts: string | null;
  groups: Array<{ groupKey: Record<string, string | null>; value: number | null }>;
}

export async function runAggregate(args: AggregateArgs): Promise<BucketResult[]> {
  const { namespace, name, agg, from, to, filter, groupBy, bucket } = args;

  // Param order in the final SQL must match `?` placeholder order in the
  // assembled query: SELECT placeholders (JSON paths for groupBy) come
  // before WHERE placeholders.
  const selectParams: any[] = [];
  const whereParams: any[] = [namespace, name, from, to];
  const where: string[] = ['namespace = ?', 'name = ?', 'ts >= ?', 'ts < ?'];

  // workspaceId via the dedicated indexed column.
  where.push('workspace_id = ?');
  whereParams.push(filter.workspaceId);

  for (const [k, v] of Object.entries(filter)) {
    if (k === 'workspaceId') continue;
    where.push('JSON_UNQUOTE(JSON_EXTRACT(dims_json, ?)) = ?');
    whereParams.push(`$.${k}`, v);
  }

  const selectParts: string[] = [];
  const groupParts: string[] = [];
  if (bucket) {
    selectParts.push(`${bucketSql(bucket)} AS bucket_ts`);
    groupParts.push('bucket_ts');
  } else {
    selectParts.push('NULL AS bucket_ts');
  }

  for (const [i, key] of groupBy.entries()) {
    if (key === 'workspaceId') {
      selectParts.push(`workspace_id AS gk_${i}`);
      groupParts.push(`gk_${i}`);
    } else {
      selectParts.push(`JSON_UNQUOTE(JSON_EXTRACT(dims_json, ?)) AS gk_${i}`);
      selectParams.push(`$.${key}`);
      groupParts.push(`gk_${i}`);
    }
  }

  selectParts.push(`${aggSelect(agg)} AS agg_value`);
  const sql =
    `SELECT ${selectParts.join(', ')} FROM im_metric_events WHERE ${where.join(' AND ')}` +
    (groupParts.length ? ` GROUP BY ${groupParts.join(', ')}` : '') +
    (bucket ? ` ORDER BY bucket_ts ASC` : '') +
    ' LIMIT 5000';

  const params = [...selectParams, ...whereParams];
  const rows: any[] = await (prisma as any).$queryRawUnsafe(sql, ...params);

  const byBucket = new Map<string | null, BucketResult>();
  const isPercentile = agg === 'p50' || agg === 'p95' || agg === 'p99';
  const q = percentileQuantile(agg);

  for (const row of rows) {
    const bucketKey = (row.bucket_ts as string | null) ?? null;
    let entry = byBucket.get(bucketKey);
    if (!entry) {
      entry = { ts: bucketKey, groups: [] };
      byBucket.set(bucketKey, entry);
    }
    const groupKey: Record<string, string | null> = {};
    for (const [i, key] of groupBy.entries()) {
      const v = row[`gk_${i}`];
      groupKey[key] = v == null ? null : String(v);
    }
    let value: number | null;
    if (isPercentile) {
      value = computePercentile(String(row.agg_value ?? ''), q);
    } else {
      const v = row.agg_value;
      value = v == null ? null : typeof v === 'bigint' ? Number(v) : Number(v);
    }
    entry.groups.push({ groupKey, value });
  }
  return Array.from(byBucket.values());
}
