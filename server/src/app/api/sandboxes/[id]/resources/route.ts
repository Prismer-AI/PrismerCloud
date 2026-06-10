/**
 * GET /api/sandboxes/:id/resources?since=<iso>
 *
 * Release 200 §08 §8.2 — time-series readback of
 * `im_sandbox_resource_samples` for the admin detail page
 * (`/admin/sandbox/[id]`).
 *
 * Auth chain:
 *   1. NextAuth session → email
 *   2. Authorization: Bearer <jwt/api-key> → owning human email
 *   3. isSandboxAdmin(email) → 403 on denial
 *
 * The route is admin-scoped (not workspace-owner scoped) because the SRE
 * console legitimately inspects any container regardless of workspace
 * ownership; sample data is operational telemetry not user data. If the
 * gate is bypassed the table itself has no PII anyway (rtt + cpu/mem).
 *
 * Query params:
 *   - `since` (optional, ISO 8601) — start of window. Defaults to 24h ago.
 *     Caller-supplied invalid timestamps fall back to the default rather
 *     than 400-ing; the page polls every 5s and we'd rather show stale
 *     than break the chart on a client clock skew.
 *
 * Response:
 *   {
 *     containerId: string,
 *     since: string,                              // ISO
 *     samples: [{
 *       sampledAt: string,                        // ISO
 *       cpuUsagePct: number,                      // v200 placeholder 0
 *       memUsedBytes: string,                     // BigInt → string
 *       memLimitBytes: string,
 *       daemonRttMs: number,
 *     }]
 *   }
 *
 * BigInt JSON note: mem* are BigInt in Prisma; we explicitly stringify
 * because `JSON.stringify` throws on BigInt. The chart layer parses them
 * with Number() — bytes routinely fit in JS Number for container memory
 * (max safe ~9PB).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth/nextauth';
import { requireAuthIdentity } from '@/lib/auth/guard';
import { isSandboxAdmin } from '@/lib/admin-rbac';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_SAMPLES = 2000; // 24h × 30s cadence ≈ 2880; cap at 2000 to bound payload.

async function resolveAdminEmail(req: NextRequest): Promise<string | null> {
  const session = await auth();
  if (session?.user?.email) return session.user.email;

  try {
    const identity = await requireAuthIdentity(req);
    return identity.email ?? null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const adminEmail = await resolveAdminEmail(req);
  if (!isSandboxAdmin(adminEmail)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const { id } = await ctx.params;

  const url = new URL(req.url);
  const sinceParam = url.searchParams.get('since');
  let since: Date;
  if (sinceParam) {
    const parsed = new Date(sinceParam);
    if (Number.isNaN(parsed.getTime())) {
      since = new Date(Date.now() - DEFAULT_WINDOW_MS);
    } else {
      since = parsed;
    }
  } else {
    since = new Date(Date.now() - DEFAULT_WINDOW_MS);
  }

  try {
    // Container existence check — return 404 if missing so the page can
    // distinguish "no samples yet" (empty array) from "wrong id" (404).
    const container = await prisma.iMContainer.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!container) {
      return NextResponse.json({ error: 'container_not_found' }, { status: 404 });
    }

    const rows = await prisma.iMSandboxResourceSample.findMany({
      where: {
        containerId: id,
        sampledAt: { gte: since },
      },
      orderBy: { sampledAt: 'asc' },
      take: MAX_SAMPLES,
      select: {
        sampledAt: true,
        cpuUsagePct: true,
        memUsedBytes: true,
        memLimitBytes: true,
        daemonRttMs: true,
      },
    });

    type Row = {
      sampledAt: Date;
      cpuUsagePct: number;
      memUsedBytes: bigint;
      memLimitBytes: bigint;
      daemonRttMs: number;
    };

    const samples = (rows as Row[]).map((r) => ({
      sampledAt: r.sampledAt.toISOString(),
      cpuUsagePct: r.cpuUsagePct,
      memUsedBytes: r.memUsedBytes.toString(),
      memLimitBytes: r.memLimitBytes.toString(),
      daemonRttMs: r.daemonRttMs,
    }));

    return NextResponse.json({
      containerId: id,
      since: since.toISOString(),
      samples,
    });
  } catch (err) {
    logger.error({ err, containerId: id }, '[sandbox/resources] query failed');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
