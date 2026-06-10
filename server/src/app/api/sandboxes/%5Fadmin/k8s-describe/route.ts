/**
 * GET /api/sandboxes/_admin/k8s-describe — structured `kubectl describe`.
 *
 * Composes the resource read (`readNamespacedPod` or `readNode`) with the
 * recent events that target the object, and returns a flat
 * `{ kind, name, namespace?, spec, status, conditions, events[] }` shape so
 * the CLI can render or diff it without re-implementing YAML parsing.
 *
 * Auth: same `isSandboxAdmin(email)` gate as the other _admin routes.
 *
 * Query params:
 *   kind=Pod|Node              (required)
 *   name=<name>                (required)
 *   namespace=<ns>             (Pod only; default getK8sNamespace())
 *   includeEvents=true|false   (default true)
 *
 * Spec: docs/release201/06-debug-pipeline-design.md §3.4.
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

const SUPPORTED_KINDS = new Set(['Pod', 'Node']);
const EVENT_LIMIT = 20;

interface DescribedEvent {
  type: string | null;
  reason: string | null;
  message: string | null;
  count: number | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  source: { component: string | null; host: string | null };
}

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

interface K8sCondition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string | Date | null;
}

interface ResourceWithStatus {
  metadata?: { name?: string; namespace?: string; creationTimestamp?: string | Date };
  spec?: unknown;
  status?: { conditions?: K8sCondition[]; [k: string]: unknown };
}

function isoOrNull(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? String(v) : new Date(ms).toISOString();
}

function normalizeConditions(conditions: K8sCondition[] | undefined): Array<{
  type: string | null;
  status: string | null;
  reason: string | null;
  message: string | null;
  lastTransitionTime: string | null;
}> {
  if (!Array.isArray(conditions)) return [];
  return conditions.map((c) => ({
    type: c.type ?? null,
    status: c.status ?? null,
    reason: c.reason ?? null,
    message: c.message ?? null,
    lastTransitionTime: isoOrNull(c.lastTransitionTime ?? null),
  }));
}

function isTrueDefaultTrue(value: string | null | undefined): boolean {
  if (value === null || value === undefined || value === '') return true;
  return value === 'true' || value === '1' || value === 'yes';
}

export async function GET(req: NextRequest): Promise<Response> {
  const adminEmail = await resolveAdminEmail(req);
  if (!isSandboxAdmin(adminEmail)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const rl = checkRateLimit(adminEmail);
  if (!rl.allowed) return rateLimitResponse(rl);

  const url = new URL(req.url);
  const kind = url.searchParams.get('kind');
  const name = url.searchParams.get('name');

  if (!kind || !SUPPORTED_KINDS.has(kind)) {
    return NextResponse.json(
      { error: 'invalid_request', message: `kind must be one of: ${[...SUPPORTED_KINDS].join(', ')}` },
      { status: 400 },
    );
  }
  if (!name) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'Missing required query param: name' },
      { status: 400 },
    );
  }

  const namespaceParam = url.searchParams.get('namespace');
  const namespace = kind === 'Pod' ? (namespaceParam ?? getK8sNamespace()) : null;
  const includeEvents = isTrueDefaultTrue(url.searchParams.get('includeEvents'));

  logger.info(
    {
      admin: adminEmail ?? null,
      action: 'k8s-describe',
      filters: { kind, name, namespace, includeEvents },
    },
    '[admin-debug] called',
  );

  let resource: ResourceWithStatus;
  try {
    const api = await getCoreV1Api();
    if (kind === 'Pod') {
      resource = (await api.readNamespacedPod({ name, namespace: namespace as string })) as ResourceWithStatus;
    } else {
      resource = (await api.readNode({ name })) as ResourceWithStatus;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const statusCode = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { statusCode?: number; code?: number })?.code;
    if (statusCode === 404) {
      return NextResponse.json(
        { error: 'not_found', message: `${kind}/${name} not found` },
        { status: 404 },
      );
    }
    logger.warn(
      { err: message, kind, name, namespace, statusCode },
      '[admin/k8s-describe] resource read failed',
    );
    return NextResponse.json(
      { error: 'k8s_unavailable', message },
      { status: 503 },
    );
  }

  const events: DescribedEvent[] = [];
  if (includeEvents) {
    try {
      const api = await getCoreV1Api();
      // Events live in the resource's own namespace (for Pod) or the default
      // namespace for cluster-scoped objects (Node). fieldSelector pins to
      // the target involvedObject; over-fetch then trim to EVENT_LIMIT.
      const eventNamespace = kind === 'Pod' ? (namespace as string) : getK8sNamespace();
      const fieldSelectorParts = [
        `involvedObject.name=${name}`,
        `involvedObject.kind=${kind}`,
      ];
      const res = (await api.listNamespacedEvent({
        namespace: eventNamespace,
        fieldSelector: fieldSelectorParts.join(','),
        limit: Math.max(EVENT_LIMIT * 2, 40),
      })) as { items?: CoreV1Event[] };
      // Sort newest first by lastTimestamp/eventTime, then trim.
      const items = (res.items ?? []).slice().sort((a, b) => {
        const aRef = a.lastTimestamp ?? a.eventTime ?? a.firstTimestamp ?? a.metadata?.creationTimestamp;
        const bRef = b.lastTimestamp ?? b.eventTime ?? b.firstTimestamp ?? b.metadata?.creationTimestamp;
        const aMs = aRef ? (aRef instanceof Date ? aRef.getTime() : Date.parse(String(aRef))) : 0;
        const bMs = bRef ? (bRef instanceof Date ? bRef.getTime() : Date.parse(String(bRef))) : 0;
        return bMs - aMs;
      });
      for (const ev of items.slice(0, EVENT_LIMIT)) {
        events.push({
          type: ev.type ?? null,
          reason: ev.reason ?? null,
          message: ev.message ?? null,
          count: typeof ev.count === 'number' ? ev.count : null,
          firstTimestamp: isoOrNull(ev.firstTimestamp ?? ev.eventTime ?? null),
          lastTimestamp: isoOrNull(ev.lastTimestamp ?? ev.eventTime ?? null),
          source: {
            component: ev.source?.component ?? null,
            host: ev.source?.host ?? null,
          },
        });
      }
    } catch (err) {
      // Event read is best-effort; resource read already succeeded so we
      // still return the describe with an empty events list and a note.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), kind, name },
        '[admin/k8s-describe] event listing failed; returning describe without events',
      );
    }
  }

  return withRateLimitHeaders(
    NextResponse.json({
      kind,
      name,
      namespace: namespace,
      spec: resource.spec ?? null,
      status: resource.status ?? null,
      conditions: normalizeConditions(resource.status?.conditions),
      events,
    }),
    rl,
  );
}
