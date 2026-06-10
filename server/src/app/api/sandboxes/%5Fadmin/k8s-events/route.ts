/**
 * GET /api/sandboxes/_admin/k8s-events — cluster events feed with filters.
 *
 * Wraps `listNamespacedEvent`. fieldSelector is built for the safe filters
 * (`involvedObject.name` / `involvedObject.kind`); `type` and `reason` are
 * applied JS-side because fieldSelector support for those varies between
 * apiserver versions (and fails closed on EKS for `reason`). All filtering
 * is best-effort — when in doubt, post-process in JS.
 *
 * Auth: same `isSandboxAdmin(email)` gate as the other _admin routes.
 *
 * Query params:
 *   involvedObjectName=<name>
 *   involvedObjectKind=Pod|Node|Deployment|...
 *   namespace=<ns>            (default getK8sNamespace())
 *   type=Warning|Normal
 *   reason=FailedScheduling|BackOff|ImagePullBackOff|...
 *   since=<iso>
 *   limit=100                  (max 500)
 *
 * Spec: docs/release201/06-debug-pipeline-design.md §3.3.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { resolveAdminEmail } from '@/lib/admin/resolve-admin-email';
import { isSandboxAdmin } from '@/lib/admin-rbac';
import { logger } from '@/lib/logger';
import { getCoreV1Api, getK8sNamespace } from '@/lib/k8s-client';
import {
  checkRateLimit,
  rateLimitResponse,
  withRateLimitHeaders,
} from '@/lib/admin/debug-rate-limit';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

interface CoreV1Event {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  firstTimestamp?: string | Date | null;
  lastTimestamp?: string | Date | null;
  eventTime?: string | Date | null;
  involvedObject?: { kind?: string; name?: string; namespace?: string };
  source?: { component?: string; host?: string };
  metadata?: { creationTimestamp?: string | Date };
}

interface EventOut {
  type: string | null;
  reason: string | null;
  message: string | null;
  count: number | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  involvedObject: { kind: string | null; name: string | null; namespace: string | null };
  source: { component: string | null; host: string | null };
}

function isoOrNull(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  // Trust ISO strings; otherwise try to parse + reformat.
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? String(v) : new Date(ms).toISOString();
}

export async function GET(req: NextRequest): Promise<Response> {
  const adminEmail = await resolveAdminEmail(req);
  if (!isSandboxAdmin(adminEmail)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const rl = checkRateLimit(adminEmail);
  if (!rl.allowed) return rateLimitResponse(rl);

  const url = new URL(req.url);
  const involvedObjectName = url.searchParams.get('involvedObjectName');
  const involvedObjectKind = url.searchParams.get('involvedObjectKind');
  const namespace = url.searchParams.get('namespace') ?? getK8sNamespace();
  const typeFilter = url.searchParams.get('type');
  const reasonFilter = url.searchParams.get('reason');
  const sinceParam = url.searchParams.get('since');
  const limitRaw = Number(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT));
  const limit = Math.min(
    Math.max(Number.isFinite(limitRaw) ? Math.floor(limitRaw) : DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );

  let sinceMs: number | null = null;
  if (sinceParam) {
    const ms = Date.parse(sinceParam);
    if (Number.isNaN(ms)) {
      return NextResponse.json(
        { error: 'invalid_request', message: `Invalid ISO timestamp in since=${sinceParam}` },
        { status: 400 },
      );
    }
    sinceMs = ms;
  }

  const fieldSelectorParts: string[] = [];
  if (involvedObjectName) fieldSelectorParts.push(`involvedObject.name=${involvedObjectName}`);
  if (involvedObjectKind) fieldSelectorParts.push(`involvedObject.kind=${involvedObjectKind}`);
  const fieldSelector = fieldSelectorParts.length > 0 ? fieldSelectorParts.join(',') : undefined;

  logger.info(
    {
      admin: adminEmail ?? null,
      action: 'k8s-events',
      filters: {
        involvedObjectName,
        involvedObjectKind,
        namespace,
        type: typeFilter,
        reason: reasonFilter,
        since: sinceParam,
        limit,
      },
    },
    '[admin-debug] called',
  );

  let items: CoreV1Event[] = [];
  try {
    const api = await getCoreV1Api();
    const res = (await api.listNamespacedEvent({
      namespace,
      fieldSelector,
      limit: Math.min(limit * 2, 1000), // over-fetch since we filter type/reason in JS
    })) as { items?: CoreV1Event[] };
    items = res.items ?? [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err: message, namespace },
      '[admin/k8s-events] listNamespacedEvent failed',
    );
    return NextResponse.json(
      { error: 'k8s_unavailable', message, events: [] },
      { status: 503 },
    );
  }

  const events: EventOut[] = [];
  for (const ev of items) {
    if (typeFilter && ev.type !== typeFilter) continue;
    if (reasonFilter && ev.reason !== reasonFilter) continue;
    if (sinceMs !== null) {
      const refDate = ev.lastTimestamp ?? ev.firstTimestamp ?? ev.eventTime ?? ev.metadata?.creationTimestamp;
      const refMs = refDate
        ? (refDate instanceof Date ? refDate.getTime() : Date.parse(String(refDate)))
        : NaN;
      if (Number.isFinite(refMs) && refMs < sinceMs) continue;
    }
    events.push({
      type: ev.type ?? null,
      reason: ev.reason ?? null,
      message: ev.message ?? null,
      count: typeof ev.count === 'number' ? ev.count : null,
      firstTimestamp: isoOrNull(ev.firstTimestamp ?? ev.eventTime ?? null),
      lastTimestamp: isoOrNull(ev.lastTimestamp ?? ev.eventTime ?? null),
      involvedObject: {
        kind: ev.involvedObject?.kind ?? null,
        name: ev.involvedObject?.name ?? null,
        namespace: ev.involvedObject?.namespace ?? null,
      },
      source: {
        component: ev.source?.component ?? null,
        host: ev.source?.host ?? null,
      },
    });
    if (events.length >= limit) break;
  }

  return withRateLimitHeaders(NextResponse.json({ events }), rl);
}
