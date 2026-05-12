/**
 * GET /api/sandboxes/_admin/sandbox-metrics — admin-gated daemon-first
 * cold-start metrics console data source.
 *
 * Replaces the deleted warm-pool route under this same `_admin` namespace.
 * Warm pool was removed in W1-W8 (commits `43956559..c10ea7cb`) because daemon-first
 * runtime starts in seconds — cold-start is now the only scheduling path,
 * so the question shifted from "how warm is the pool?" to "how fast is
 * cold-start?".
 *
 * Auth chain (mirrors the deleted warm-pool route):
 *   1. NextAuth session ➜ session.user.email
 *   2. isSandboxAdmin(email) — Phase 1 hardcoded allowlist (see src/lib/admin-rbac.ts)
 *
 * Returns 403 on RBAC denial — matches the deleted warm-pool route's
 * behaviour. The page-level notFound() gate on /admin/sandbox keeps the
 * route's existence cloaked from unauthenticated probes; direct probes
 * here legitimately get a 403.
 *
 * Performance notes:
 *   - groupBy aggregates are unbounded by row count but capped to the
 *     im_containers table size; the workspace fan-out is small enough
 *     that this is fine for Phase 1.
 *   - Run-log aggregates use a 24h window. `take: 1000` is the hard cap
 *     on the avg-duration sample; the table currently writes at most a
 *     few hundred rows/day so 1000 covers a comfortable margin.
 *   - p50/p99 use the last 200 completed runs, sorted in JS. Client-side
 *     percentile is acceptable here because N is small and we avoid a
 *     per-request `ORDER BY duration` index.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth/nextauth';
import { isSandboxAdmin } from '@/lib/admin-rbac';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';

const RECENT_LIMIT = 20;
const AGG_ROW_CAP = 1000; // hard cap on rows pulled for avg-duration
const PERCENTILE_SAMPLE = 200;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function normalizeProvisioningHistory(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function imageBaseName(image: string): string {
  // Strip registry host + path; keep only `name:tag` or `name` for display.
  // e.g. "dockerhub.services/prismer/library/sandbox:daemon-v1.0" → "sandbox:daemon-v1.0"
  const lastSlash = image.lastIndexOf('/');
  return lastSlash >= 0 ? image.slice(lastSlash + 1) : image;
}

export async function GET(_req: NextRequest): Promise<Response> {
  const session = await auth();
  if (!isSandboxAdmin(session?.user?.email)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  try {
    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Containers: total + byStatus + byRuntimeKind via groupBy.
    // Plus migration 322 — currently-in-flight provisioning rows (provisioningStep IS NOT NULL).
    const [statusGroups, runtimeGroups, totalContainers, recentRows, inFlightRows] = await Promise.all([
      prisma.iMContainer.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      prisma.iMContainer.groupBy({
        by: ['runtimeKind'],
        _count: { _all: true },
      }),
      prisma.iMContainer.count(),
      prisma.iMContainer.findMany({
        orderBy: { createdAt: 'desc' },
        take: RECENT_LIMIT,
        select: {
          id: true,
          podName: true,
          workspaceId: true,
          status: true,
          runtimeKind: true,
          image: true,
          createdAt: true,
          startedAt: true,
          stoppedAt: true,
        },
      }),
      prisma.iMContainer.findMany({
        where: { provisioningStep: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: RECENT_LIMIT,
        select: {
          id: true,
          podName: true,
          workspaceId: true,
          runtimeKind: true,
          createdAt: true,
          provisioningStep: true,
          provisioningHistory: true,
        },
      }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const g of statusGroups as Array<{ status: string; _count: { _all: number } }>) {
      byStatus[g.status] = g._count._all;
    }
    const byRuntimeKind: Record<string, number> = {};
    for (const g of runtimeGroups as Array<{ runtimeKind: string; _count: { _all: number } }>) {
      byRuntimeKind[g.runtimeKind] = g._count._all;
    }

    // Run logs: last24h count + activeNow + duration stats.
    const [last24hCount, activeNow, completedRuns] = await Promise.all([
      prisma.iMSandboxRunLog.count({ where: { startedAt: { gte: since24h } } }),
      prisma.iMSandboxRunLog.count({ where: { endedAt: null } }),
      prisma.iMSandboxRunLog.findMany({
        where: { startedAt: { gte: since24h }, durationMs: { not: null } },
        orderBy: { startedAt: 'desc' },
        take: AGG_ROW_CAP, // see PERFORMANCE comment at top
        select: { durationMs: true },
      }),
    ]);

    const durations: number[] = (completedRuns as Array<{ durationMs: number | null }>)
      .map((r) => r.durationMs)
      .filter((d): d is number => d !== null && d >= 0);

    const avgDurationSec =
      durations.length > 0 ? durations.reduce((a: number, b: number) => a + b, 0) / durations.length / 1000 : null;

    const sortedSample = durations.slice(0, PERCENTILE_SAMPLE).sort((a: number, b: number) => a - b);
    const p50DurationSec = percentile(sortedSample, 50);
    const p99DurationSec = percentile(sortedSample, 99);

    type RecentRow = {
      id: string;
      podName: string;
      workspaceId: string;
      status: string;
      runtimeKind: string;
      image: string;
      createdAt: Date;
      startedAt: Date | null;
      stoppedAt: Date | null;
    };

    const recent = (recentRows as RecentRow[]).map((row) => {
      const coldStartLatencyMs =
        row.startedAt && row.createdAt ? row.startedAt.getTime() - row.createdAt.getTime() : null;
      return {
        id: row.id,
        podName: row.podName,
        workspaceId: row.workspaceId,
        status: row.status,
        runtimeKind: row.runtimeKind,
        image: imageBaseName(row.image),
        createdAt: row.createdAt.toISOString(),
        startedAt: row.startedAt ? row.startedAt.toISOString() : null,
        stoppedAt: row.stoppedAt ? row.stoppedAt.toISOString() : null,
        coldStartLatencyMs,
      };
    });

    // Migration 322 — in-flight provisioning rows for admin "Provisioning Now"
    // section. Maps directly to im_containers.provisioning_step + history.
    type InFlightRow = {
      id: string;
      podName: string;
      workspaceId: string;
      runtimeKind: string;
      createdAt: Date;
      provisioningStep: string | null;
      provisioningHistory: unknown;
    };
    const inFlight = (inFlightRows as InFlightRow[]).map((row) => ({
      id: row.id,
      podName: row.podName,
      workspaceId: row.workspaceId,
      runtimeKind: row.runtimeKind,
      createdAt: row.createdAt.toISOString(),
      ageMs: Math.max(0, now.getTime() - row.createdAt.getTime()),
      step: row.provisioningStep,
      history: normalizeProvisioningHistory(row.provisioningHistory),
    }));

    return NextResponse.json({
      containers: {
        total: totalContainers,
        byStatus,
        byRuntimeKind,
      },
      runs: {
        last24h: last24hCount,
        activeNow,
        avgDurationSec: avgDurationSec !== null ? Number(avgDurationSec.toFixed(2)) : null,
        p50DurationSec: p50DurationSec !== null ? Number((p50DurationSec / 1000).toFixed(2)) : null,
        p99DurationSec: p99DurationSec !== null ? Number((p99DurationSec / 1000).toFixed(2)) : null,
      },
      recent,
      inFlight,
      generatedAt: now.toISOString(),
    });
  } catch (err) {
    logger.error({ err }, '[admin/sandbox-metrics] unexpected error');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
