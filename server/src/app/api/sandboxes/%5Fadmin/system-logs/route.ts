/**
 * GET /api/sandboxes/_admin/system-logs — cloud-process pino ring buffer query.
 *
 * Phase A of the v2.1 unified debug pipeline (docs/release201/06-debug-pipeline-design.md §3.1).
 * Returns recent pino log entries from the in-process ring buffer maintained
 * by `src/lib/log-buffer.ts`. Buffer is bounded to 5000 entries / 30 min;
 * older lines fall off to stdout / Datadog only.
 *
 * Auth: same `isSandboxAdmin(email)` gate as the other `_admin` routes
 * (admin-rbac.ts allowlist, with dev short-circuit). API-key callers
 * resolve via NextAuth `auth()` since the same email check applies.
 *
 * Query params (all optional):
 *   - since=<iso|relative>     e.g. "2026-05-24T10:00:00Z" | "10m" | "1h"
 *   - level=info,warn,error,fatal
 *   - contains=<substr>        case-insensitive substring match against the
 *                              entry's full searchable surface (msg + every
 *                              string-valued extra rendered as `key:value`,
 *                              e.g. `module:LLMProxy`). Cached at write time
 *                              by `src/lib/log-buffer.ts`.
 *   - route=<path-prefix>      e.g. "/api/im/workspaces"
 *   - correlationId=<X-Request-ID>
 *   - limit=200                max 1000
 *
 * Response top-level `coverage` echoes the buffer's actual time span so the
 * CLI can warn when a `--since=1h` query exceeds what the in-memory buffer
 * can answer.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { isSandboxAdmin } from '@/lib/admin-rbac';
import { resolveAdminEmail } from '@/lib/admin/resolve-admin-email';
import { logger } from '@/lib/logger';
import { queryLogs, getBufferStats, type LogEntry } from '@/lib/log-buffer';
import {
  checkRateLimit,
  rateLimitResponse,
  withRateLimitHeaders,
} from '@/lib/admin/debug-rate-limit';

const VALID_LEVELS = new Set<LogEntry['level']>(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

export async function GET(req: NextRequest): Promise<Response> {
  const adminEmail = await resolveAdminEmail(req);
  if (!isSandboxAdmin(adminEmail)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const rl = checkRateLimit(adminEmail);
  if (!rl.allowed) return rateLimitResponse(rl);

  const url = new URL(req.url);
  const since = url.searchParams.get('since') ?? undefined;
  const levelCsv = url.searchParams.get('level');
  const level = levelCsv
    ? (levelCsv
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s): s is LogEntry['level'] => VALID_LEVELS.has(s as LogEntry['level'])))
    : undefined;
  const contains = url.searchParams.get('contains') ?? undefined;
  const route = url.searchParams.get('route') ?? undefined;
  const correlationId = url.searchParams.get('correlationId') ?? undefined;
  const limitRaw = Number(url.searchParams.get('limit') ?? '200');
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 200, 1), 1000);

  // Audit trail — every admin debug call.
  logger.info(
    {
      admin: adminEmail ?? null,
      action: 'system-logs',
      filters: { since, level, contains, route, correlationId, limit },
    },
    '[admin-debug] called',
  );

  const entries = queryLogs({ since, level, contains, route, correlationId, limit });
  const bufferStats = getBufferStats();

  // `truncated` = the buffer has dropped entries since process start, so the
  // current view may be incomplete relative to the requested window.
  const truncated = bufferStats.droppedSinceStart > 0;

  // Top-level `coverage` is what the CLI prints to warn users about the
  // buffer's actual time span. Derived from bufferStats so a single source
  // of truth is maintained; `durationMs` is null when the buffer is empty.
  const oldestMs = bufferStats.oldestAt ? new Date(bufferStats.oldestAt).getTime() : null;
  const newestMs = bufferStats.newestAt ? new Date(bufferStats.newestAt).getTime() : null;
  const coverage = {
    oldestAt: bufferStats.oldestAt,
    newestAt: bufferStats.newestAt,
    durationMs:
      oldestMs !== null && newestMs !== null ? Math.max(0, newestMs - oldestMs) : null,
  };

  return withRateLimitHeaders(
    NextResponse.json({
      entries,
      truncated,
      bufferStats,
      coverage,
    }),
    rl,
  );
}
