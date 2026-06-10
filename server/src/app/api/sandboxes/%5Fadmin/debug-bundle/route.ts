/**
 * GET /api/sandboxes/_admin/debug-bundle — composed cross-layer debug snapshot.
 *
 * Phase C of the v2.1 unified debug pipeline (docs/release201/06-debug-pipeline-design.md §3.8).
 *
 * Fans out HTTP loopback fetches to the sibling `_admin/*` endpoints (db-snapshot,
 * system-logs, k8s-describe, k8s-events, k8s-pod-logs, daemon-state) and
 * composes the results into a single JSON envelope. Partial failure of one
 * section does NOT abort the bundle — it surfaces as
 * `sections.<name>: { error, message }` while other sections still succeed.
 *
 * Auth: same `isSandboxAdmin(email)` gate as the other `_admin` routes. The
 * caller's Authorization header is forwarded verbatim on the inner loopback
 * fetches so each sub-endpoint re-validates RBAC.
 *
 * Query params:
 *   entity=workspace|task|pod    (required)
 *   id=<id>                      (required — workspace id, task id, or pod name)
 *   since=<iso>                  (default: now - 30min)
 *   sections=<csv>               (default: all — db,system,k8s,daemon)
 */

import { NextResponse, type NextRequest } from 'next/server';
import { resolveAdminEmail } from '@/lib/admin/resolve-admin-email';
import { isSandboxAdmin } from '@/lib/admin-rbac';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import {
  checkRateLimit,
  rateLimitResponse,
  withRateLimitHeaders,
} from '@/lib/admin/debug-rate-limit';

const DEFAULT_SINCE_MS = 30 * 60 * 1000; // 30min
const SUPPORTED_ENTITIES = new Set(['workspace', 'task', 'pod']);
const ALL_SECTIONS = ['db', 'system', 'k8s', 'daemon'] as const;
type Section = (typeof ALL_SECTIONS)[number];

type SectionResult = Record<string, unknown>;

function loopbackBase(req: NextRequest): string {
  // Same-host same-port loopback. Prefer 127.0.0.1 to avoid any DNS hop.
  const url = new URL(req.url);
  return `http://127.0.0.1:${url.port || '3000'}`;
}

function forwardAuthHeader(req: NextRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  const authz = req.headers.get('authorization');
  if (authz) headers.authorization = authz;
  // Forward NextAuth cookies so session-based callers keep working.
  const cookie = req.headers.get('cookie');
  if (cookie) headers.cookie = cookie;
  // Dev mode short-circuit header.
  const devUserId = req.headers.get('x-dev-user-id');
  if (devUserId) headers['x-dev-user-id'] = devUserId;
  return headers;
}

async function loopbackJson(
  base: string,
  path: string,
  headers: Record<string, string>,
): Promise<SectionResult> {
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        error: `loopback_${res.status}`,
        message: text.slice(0, 512),
        path,
      };
    }
    try {
      return JSON.parse(text) as SectionResult;
    } catch (err) {
      return {
        error: 'invalid_json',
        message: err instanceof Error ? err.message : String(err),
        path,
        snippet: text.slice(0, 256),
      };
    }
  } catch (err) {
    return {
      error: 'fetch_failed',
      message: err instanceof Error ? err.message : String(err),
      path,
    };
  }
}

async function loopbackText(
  base: string,
  path: string,
  headers: Record<string, string>,
): Promise<SectionResult> {
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      return { error: `loopback_${res.status}`, message: text.slice(0, 512), path };
    }
    return { content: text, path };
  } catch (err) {
    return {
      error: 'fetch_failed',
      message: err instanceof Error ? err.message : String(err),
      path,
    };
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const adminEmail = await resolveAdminEmail(req);
  if (!isSandboxAdmin(adminEmail)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const rl = checkRateLimit(adminEmail);
  if (!rl.allowed) return rateLimitResponse(rl);

  const url = new URL(req.url);
  const entity = url.searchParams.get('entity');
  const id = url.searchParams.get('id');
  const sinceParam = url.searchParams.get('since');
  const sectionsParam = url.searchParams.get('sections');

  logger.info(
    {
      admin: adminEmail ?? null,
      action: 'debug-bundle',
      filters: { entity, id, since: sinceParam, sections: sectionsParam },
    },
    '[admin-debug] called',
  );

  if (!entity || !id) {
    return NextResponse.json(
      { error: 'bad_request', message: 'entity and id query params required' },
      { status: 400 },
    );
  }
  if (!SUPPORTED_ENTITIES.has(entity)) {
    return NextResponse.json(
      {
        error: 'bad_request',
        message: `unknown entity '${entity}' — expected one of: workspace, task, pod`,
      },
      { status: 400 },
    );
  }

  const since = sinceParam ?? new Date(Date.now() - DEFAULT_SINCE_MS).toISOString();

  const requestedSections: Set<Section> = sectionsParam
    ? new Set(
        sectionsParam
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter((s): s is Section =>
            (ALL_SECTIONS as readonly string[]).includes(s),
          ),
      )
    : new Set(ALL_SECTIONS);

  const base = loopbackBase(req);
  const headers = forwardAuthHeader(req);
  const sections: Record<string, SectionResult> = {};

  if (entity === 'workspace') {
    if (requestedSections.has('db')) {
      sections.db = await loopbackJson(
        base,
        `/api/sandboxes/_admin/db-snapshot?entity=workspace&id=${encodeURIComponent(id)}`,
        headers,
      );
    }
    if (requestedSections.has('system')) {
      sections.system = await loopbackJson(
        base,
        `/api/sandboxes/_admin/system-logs?contains=${encodeURIComponent(id)}&since=${encodeURIComponent(since)}&limit=500`,
        headers,
      );
    }
    if (requestedSections.has('k8s')) {
      // For each k8s pod referenced by the workspace's containers: describe + recent events + pod-logs tail.
      try {
        const containers = (await prisma.iMContainer.findMany({
          where: { workspaceId: id, runtimeKind: 'k8s' },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { podName: true, namespace: true },
        })) as Array<{ podName: string; namespace: string }>;

        const podBundles: Array<Record<string, unknown>> = [];
        for (const c of containers) {
          const describe = await loopbackJson(
            base,
            `/api/sandboxes/_admin/k8s-describe?kind=Pod&name=${encodeURIComponent(c.podName)}&namespace=${encodeURIComponent(c.namespace)}`,
            headers,
          );
          const events = await loopbackJson(
            base,
            `/api/sandboxes/_admin/k8s-events?involvedObjectName=${encodeURIComponent(c.podName)}&involvedObjectKind=Pod&namespace=${encodeURIComponent(c.namespace)}&since=${encodeURIComponent(since)}`,
            headers,
          );
          const podLogs = await loopbackText(
            base,
            `/api/sandboxes/_admin/k8s-pod-logs?pod=${encodeURIComponent(c.podName)}&namespace=${encodeURIComponent(c.namespace)}&tailLines=200`,
            headers,
          );
          podBundles.push({ pod: c.podName, namespace: c.namespace, describe, events, podLogs });
        }
        sections.k8s = { pods: podBundles, podCount: podBundles.length };
      } catch (err) {
        sections.k8s = {
          error: 'k8s_compose_failed',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }
    // No daemon section for workspace — workspace can have N daemons; surface per-pod under k8s.
  } else if (entity === 'task') {
    if (requestedSections.has('db')) {
      sections.db = await loopbackJson(
        base,
        `/api/sandboxes/_admin/db-snapshot?entity=task&id=${encodeURIComponent(id)}`,
        headers,
      );
    }
    if (requestedSections.has('system')) {
      sections.system = await loopbackJson(
        base,
        `/api/sandboxes/_admin/system-logs?contains=${encodeURIComponent(id)}&since=${encodeURIComponent(since)}&limit=500`,
        headers,
      );
    }
    // For tasks dispatched to a daemon, include daemon-state + k8s-describe.
    if (requestedSections.has('daemon') || requestedSections.has('k8s')) {
      try {
        const task = (await prisma.iMTask.findUnique({
          where: { id },
          select: { containerId: true },
        })) as { containerId: string | null } | null;

        let podName: string | null = null;
        let namespace: string | null = null;
        if (task?.containerId) {
          const container = (await prisma.iMContainer.findUnique({
            where: { id: task.containerId },
            select: { podName: true, namespace: true },
          })) as { podName: string; namespace: string } | null;
          if (container) {
            podName = container.podName;
            namespace = container.namespace;
          }
        }

        if (requestedSections.has('daemon')) {
          if (podName) {
            sections.daemon = await loopbackJson(
              base,
              `/api/sandboxes/_admin/daemon-state?pod=${encodeURIComponent(podName)}`,
              headers,
            );
          } else {
            sections.daemon = {
              error: 'no_dispatch',
              message: 'task is not dispatched to a daemon (containerId is null or container missing)',
            };
          }
        }
        if (requestedSections.has('k8s')) {
          if (podName && namespace) {
            const describe = await loopbackJson(
              base,
              `/api/sandboxes/_admin/k8s-describe?kind=Pod&name=${encodeURIComponent(podName)}&namespace=${encodeURIComponent(namespace)}`,
              headers,
            );
            sections.k8s = { pod: podName, namespace, describe };
          } else {
            sections.k8s = {
              error: 'no_pod',
              message: 'task is not associated with a k8s pod',
            };
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (requestedSections.has('daemon') && !sections.daemon) {
          sections.daemon = { error: 'daemon_compose_failed', message: msg };
        }
        if (requestedSections.has('k8s') && !sections.k8s) {
          sections.k8s = { error: 'k8s_compose_failed', message: msg };
        }
      }
    }
  } else {
    // entity === 'pod'
    // For pod, resolve container by podName, then bundle db (container) + k8s-describe + k8s-pod-logs + k8s-events + daemon-state.
    let containerId: string | null = null;
    let namespace = '';
    try {
      const container = (await prisma.iMContainer.findUnique({
        where: { podName: id },
        select: { id: true, namespace: true },
      })) as { id: string; namespace: string } | null;
      if (container) {
        containerId = container.id;
        namespace = container.namespace;
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), pod: id },
        '[admin/debug-bundle] container lookup by pod failed',
      );
    }

    if (requestedSections.has('db')) {
      if (containerId) {
        sections.db = await loopbackJson(
          base,
          `/api/sandboxes/_admin/db-snapshot?entity=container&id=${encodeURIComponent(containerId)}`,
          headers,
        );
      } else {
        sections.db = {
          error: 'container_not_found',
          message: `no im_containers row for podName=${id}`,
        };
      }
    }
    if (requestedSections.has('system')) {
      sections.system = await loopbackJson(
        base,
        `/api/sandboxes/_admin/system-logs?contains=${encodeURIComponent(id)}&since=${encodeURIComponent(since)}&limit=500`,
        headers,
      );
    }
    if (requestedSections.has('k8s')) {
      const nsQs = namespace ? `&namespace=${encodeURIComponent(namespace)}` : '';
      const describe = await loopbackJson(
        base,
        `/api/sandboxes/_admin/k8s-describe?kind=Pod&name=${encodeURIComponent(id)}${nsQs}`,
        headers,
      );
      const podLogs = await loopbackText(
        base,
        `/api/sandboxes/_admin/k8s-pod-logs?pod=${encodeURIComponent(id)}${nsQs}&tailLines=500`,
        headers,
      );
      const events = await loopbackJson(
        base,
        `/api/sandboxes/_admin/k8s-events?involvedObjectName=${encodeURIComponent(id)}&involvedObjectKind=Pod${nsQs}&since=${encodeURIComponent(since)}`,
        headers,
      );
      sections.k8s = { pod: id, namespace: namespace || null, describe, podLogs, events };
    }
    if (requestedSections.has('daemon')) {
      sections.daemon = await loopbackJson(
        base,
        `/api/sandboxes/_admin/daemon-state?pod=${encodeURIComponent(id)}`,
        headers,
      );
    }
  }

  return withRateLimitHeaders(
    NextResponse.json({
      entity,
      id,
      since,
      fetchedAt: new Date().toISOString(),
      requestedSections: Array.from(requestedSections),
      sections,
    }),
    rl,
  );
}
