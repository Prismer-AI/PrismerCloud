/**
 * GET /api/sandboxes/_admin/k8s-pod-logs — admin cross-workspace pod log fetch.
 *
 * Wraps `readNamespacedPodLog` so an admin can pull any pod's logs (including
 * the `previous` instance after a crash) without going through the
 * workspace-scoped `/api/sandboxes/[id]/logs` route. Returns `text/plain` by
 * default so a browser / curl can read it directly; `?json=1` switches to
 * `{ lines: string[] }`.
 *
 * Auth: same `isSandboxAdmin(email)` gate as the other _admin routes.
 *
 * Query params:
 *   pod=<name>                  (required)
 *   namespace=<ns>              (default getK8sNamespace())
 *   container=<name>            (multi-container pod only)
 *   tailLines=200               (max 5000)
 *   since=<iso>                 (timestamps after this point)
 *   previous=true               (crashed-container instance)
 *   grep=<substr>               (server-side substring filter)
 *   json=true|false             (default false → text/plain)
 *
 * Spec: docs/release201/06-debug-pipeline-design.md §3.2.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { resolveAdminEmail } from '@/lib/admin/resolve-admin-email';
import { isSandboxAdmin } from '@/lib/admin-rbac';
import { logger } from '@/lib/logger';
import { getCoreV1Api, getK8sNamespace } from '@/lib/k8s-client';
import {
  checkRateLimit,
  rateLimitHeaders,
  rateLimitResponse,
  withRateLimitHeaders,
} from '@/lib/admin/debug-rate-limit';

const DEFAULT_TAIL = 200;
const MAX_TAIL = 5000;

function isTrue(value: string | null | undefined): boolean {
  if (!value) return false;
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
  const pod = url.searchParams.get('pod');
  if (!pod) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'Missing required query param: pod' },
      { status: 400 },
    );
  }

  const namespace = url.searchParams.get('namespace') ?? getK8sNamespace();
  const container = url.searchParams.get('container') ?? undefined;
  const tailLinesRaw = Number(url.searchParams.get('tailLines') ?? String(DEFAULT_TAIL));
  const tailLines = Math.min(
    Math.max(Number.isFinite(tailLinesRaw) ? Math.floor(tailLinesRaw) : DEFAULT_TAIL, 1),
    MAX_TAIL,
  );
  const sinceParam = url.searchParams.get('since');
  const previous = isTrue(url.searchParams.get('previous'));
  const grep = url.searchParams.get('grep');
  const json = isTrue(url.searchParams.get('json'));

  let sinceSeconds: number | undefined;
  if (sinceParam) {
    const sinceMs = Date.parse(sinceParam);
    if (Number.isNaN(sinceMs)) {
      return NextResponse.json(
        { error: 'invalid_request', message: `Invalid ISO timestamp in since=${sinceParam}` },
        { status: 400 },
      );
    }
    const diffSec = Math.floor((Date.now() - sinceMs) / 1000);
    if (diffSec > 0) sinceSeconds = diffSec;
  }

  logger.info(
    {
      admin: adminEmail ?? null,
      action: 'k8s-pod-logs',
      filters: { pod, namespace, container, tailLines, previous, grep: Boolean(grep), since: sinceParam },
    },
    '[admin-debug] called',
  );

  let rawLog: string;
  try {
    const api = await getCoreV1Api();
    rawLog = (await api.readNamespacedPodLog({
      name: pod,
      namespace,
      container,
      tailLines,
      previous: previous || undefined,
      sinceSeconds,
      timestamps: true,
    })) as unknown as string;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const statusCode = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { statusCode?: number; code?: number })?.code;
    if (statusCode === 404) {
      return NextResponse.json(
        { error: 'not_found', message: `Pod ${namespace}/${pod} not found` },
        { status: 404 },
      );
    }
    logger.warn(
      { err: message, pod, namespace, statusCode },
      '[admin/k8s-pod-logs] readNamespacedPodLog failed',
    );
    return NextResponse.json(
      { error: 'k8s_unavailable', message },
      { status: 503 },
    );
  }

  // Normalize to per-line array, apply optional substring grep.
  const text = typeof rawLog === 'string' ? rawLog : String(rawLog ?? '');
  let lines = text.split('\n');
  // Drop trailing empty line from final newline (don't strip mid-content blanks).
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (grep) {
    const needle = grep;
    lines = lines.filter((line) => line.includes(needle));
  }

  if (json) {
    return withRateLimitHeaders(NextResponse.json({ lines }), rl);
  }

  const body = lines.length > 0 ? lines.join('\n') + '\n' : '';
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      ...rateLimitHeaders(rl),
    },
  });
}
