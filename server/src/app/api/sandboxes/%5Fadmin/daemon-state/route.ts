/**
 * GET /api/sandboxes/_admin/daemon-state — cloud relay to a pod's daemon.
 *
 * Phase C of the v2.1 unified debug pipeline (docs/release201/06-debug-pipeline-design.md §3.6).
 *
 * Reads `im_containers.gatewayUrl` for the requested pod (set by
 * `probeHealthz` after the daemon went healthy at least once) and proxies to
 * the daemon's `/healthz` route — the canonical broad state-dump the
 * local-server exposes (sdk/prismer-cloud/runtime/src/daemon/local-server.ts:278,
 * which returns daemonId, daemonVersion, hostedAgents, observability,
 * adapters, resources, readyForDispatch, etc.).
 *
 * The daemon has no top-level `/state` route; the design doc's "state dump"
 * is the /healthz payload. The per-agent `/v1/agents/<id>/dump-state` POST
 * is exposed separately via the existing dumpAgentState path in
 * k8s-sandbox.ts and is not the broad daemon-wide view this endpoint serves.
 *
 * The /healthz route does not require auth (sdk runtime local-server doesn't
 * gate it on DISPATCH_DAEMON_SECRET, which is dispatch-path only).
 *
 * Auth: same `isSandboxAdmin(email)` gate as the other `_admin` routes.
 *
 * Query params:
 *   pod=<name>                  (required)
 *   include=<csv>               (forwarded as ?include= to the daemon)
 *
 * Errors:
 *   400 — missing pod query param
 *   404 — no `im_containers` row for the pod
 *   503 — container row exists but `gatewayUrl` is null (daemon never reached
 *         a healthy state) or the daemon HTTP call failed
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

const DAEMON_FETCH_TIMEOUT_MS = 10_000;

function wsToHttp(url: string): string {
  return url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
}

export async function GET(req: NextRequest): Promise<Response> {
  const adminEmail = await resolveAdminEmail(req);
  if (!isSandboxAdmin(adminEmail)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const rl = checkRateLimit(adminEmail);
  if (!rl.allowed) return rateLimitResponse(rl);

  const url = new URL(req.url);
  const pod = url.searchParams.get('pod');
  const include = url.searchParams.get('include');

  logger.info(
    {
      admin: adminEmail ?? null,
      action: 'daemon-state',
      filters: { pod, include },
    },
    '[admin-debug] called',
  );

  if (!pod) {
    return NextResponse.json(
      { error: 'bad_request', message: 'pod query param required' },
      { status: 400 },
    );
  }

  const container = await prisma.iMContainer.findUnique({
    where: { podName: pod },
    select: {
      id: true,
      podName: true,
      status: true,
      gatewayUrl: true,
      daemonId: true,
      lastDaemonHealthAt: true,
    },
  });

  if (!container) {
    return NextResponse.json(
      { error: 'not_found', message: `no im_containers row for pod=${pod}` },
      { status: 404 },
    );
  }

  if (!container.gatewayUrl) {
    return NextResponse.json(
      {
        error: 'daemon_unreachable',
        message:
          'daemon never reached healthy state (gatewayUrl null on im_containers row)',
        pod,
        containerStatus: container.status,
      },
      { status: 503 },
    );
  }

  const baseHttpUrl = wsToHttp(container.gatewayUrl).replace(/\/$/, '');
  const includeQs = include ? `?include=${encodeURIComponent(include)}` : '';
  const endpoint = `${baseHttpUrl}/healthz${includeQs}`;

  let daemonBody: unknown;
  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      signal: AbortSignal.timeout(DAEMON_FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      logger.warn(
        { pod, endpoint, status: res.status, snippet: text.slice(0, 256) },
        '[admin/daemon-state] daemon HTTP non-ok',
      );
      return NextResponse.json(
        {
          error: 'daemon_unreachable',
          message: `daemon returned HTTP ${res.status}`,
          pod,
          gatewayUrl: container.gatewayUrl,
          bodySnippet: text.slice(0, 256),
        },
        { status: 503 },
      );
    }
    try {
      daemonBody = JSON.parse(text);
    } catch {
      // /healthz always returns JSON when healthy; non-JSON means the daemon
      // crashed mid-response or returned an error page. Surface as 503 so
      // the caller knows the upstream is unhealthy, not that we're broken.
      return NextResponse.json(
        {
          error: 'daemon_unreachable',
          message: 'daemon /healthz body was not JSON',
          pod,
          gatewayUrl: container.gatewayUrl,
          bodySnippet: text.slice(0, 256),
        },
        { status: 503 },
      );
    }
  } catch (err) {
    logger.warn(
      { pod, endpoint, err: err instanceof Error ? err.message : String(err) },
      '[admin/daemon-state] daemon fetch failed',
    );
    return NextResponse.json(
      {
        error: 'daemon_unreachable',
        message: err instanceof Error ? err.message : String(err),
        pod,
        gatewayUrl: container.gatewayUrl,
      },
      { status: 503 },
    );
  }

  return withRateLimitHeaders(
    NextResponse.json({
      daemon: daemonBody,
      gatewayUrl: container.gatewayUrl,
      pod: container.podName,
      containerId: container.id,
      daemonId: container.daemonId,
      fetchedAt: new Date().toISOString(),
    }),
    rl,
  );
}
