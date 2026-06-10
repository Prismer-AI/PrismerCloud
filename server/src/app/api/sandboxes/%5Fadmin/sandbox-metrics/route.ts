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
 * Release 200 §08 §7.2 — schema extended with:
 *   - containers.byProviderKind         (groupBy providerKind)
 *   - runs.coldStartP50/P99Sec          (im_containers.startedAt - createdAt; v210 → im_sandbox_runs)
 *   - runs.errorRate24h                 (im_sandbox_run_logs exitCode != 0)
 *   - daemon.{healthPassRateLastHour, avgRttMs, degradedNow}
 *   - slo.{coldStartP99, daemonHealthPassRate, reconcilerLag}
 *   - recentFailures                    (im_sandbox_run_logs non-zero exit)
 *   - recent[].providerKind             (added column)
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
 *   - All new queries fan out via Promise.all to keep the route < 500ms.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth/nextauth';
import { requireAuthIdentity } from '@/lib/auth/guard';
import { isSandboxAdmin } from '@/lib/admin-rbac';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import type { SandboxMetrics, ProvisioningHistoryEntry } from '@/types/sandbox-metrics';

const RECENT_LIMIT = 20;
const FAILURE_LIMIT = 20;
const AGG_ROW_CAP = 1000; // hard cap on rows pulled for avg-duration
const PERCENTILE_SAMPLE = 200;

/**
 * SLO targets — keep in sync with 08 §7.4. Single source of truth for both
 * server-side `ok` evaluation and client-side variant colouring.
 */
const SLO_COLD_START_P99_SEC = 60;
const SLO_DAEMON_HEALTH_PASS_RATE = 0.995;
const SLO_RECONCILER_LAG_SEC = 30;

/** Expected sample rate: 2/min × 60min = 120 samples per running container per hour. */
const SAMPLES_PER_CONTAINER_PER_HOUR = 120;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function normalizeProvisioningHistory(raw: unknown): ProvisioningHistoryEntry[] {
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? (() => {
          try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [];
  // Best-effort coercion — schema is open and rows may have legacy
  // shapes. Default unknown statuses to 'ok' and timestamps to 0.
  return arr.map((entry: unknown) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    return {
      step: typeof e.step === 'string' ? e.step : 'unknown',
      status: e.status === 'in_progress' || e.status === 'error' ? e.status : 'ok',
      startedAt: typeof e.startedAt === 'number' ? e.startedAt : 0,
      durationMs: typeof e.durationMs === 'number' ? e.durationMs : undefined,
      error: typeof e.error === 'string' ? e.error : undefined,
    } satisfies ProvisioningHistoryEntry;
  });
}

function imageBaseName(image: string): string {
  // Strip registry host + path; keep only `name:tag` or `name` for display.
  // e.g. "dockerhub.services/prismer/library/sandbox:daemon-v1.0" → "sandbox:daemon-v1.0"
  const lastSlash = image.lastIndexOf('/');
  return lastSlash >= 0 ? image.slice(lastSlash + 1) : image;
}

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

export async function GET(req: NextRequest): Promise<Response> {
  const adminEmail = await resolveAdminEmail(req);
  if (!isSandboxAdmin(adminEmail)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  try {
    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const since1h = new Date(now.getTime() - 60 * 60 * 1000);

    // Containers: total + byStatus + byRuntimeKind + byProviderKind via groupBy.
    // Plus migration 322 — currently-in-flight provisioning rows.
    // Plus 24h cold-start samples (startedAt - createdAt for non-null startedAt).
    // Plus reconciler / failure / sample queries fanned out concurrently.
    const [
      statusGroups,
      runtimeGroups,
      providerGroups,
      totalContainers,
      recentRows,
      inFlightRows,
      coldStartRows,
      degradedNow,
      runningK8sCount,
      sampleCountLastHour,
      avgRttRows,
      reconcilerLagRow,
      failureRows,
    ] = await Promise.all([
      prisma.iMContainer.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      prisma.iMContainer.groupBy({
        by: ['runtimeKind'],
        _count: { _all: true },
      }),
      prisma.iMContainer.groupBy({
        by: ['providerKind'],
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
          providerKind: true,
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
      // v200 cold-start fallback: pod scheduled → daemon ready ≈ startedAt - createdAt.
      // v210 TODO: switch to im_sandbox_runs.createdAt → startedAt once ephemeral path lands.
      prisma.iMContainer.findMany({
        where: {
          startedAt: { not: null, gte: since24h },
        },
        orderBy: { startedAt: 'desc' },
        take: AGG_ROW_CAP,
        select: { createdAt: true, startedAt: true },
      }),
      prisma.iMContainer.count({ where: { status: 'degraded' } }),
      // Running k8s containers — denominator for expected sample count.
      prisma.iMContainer.count({ where: { status: 'running', providerKind: 'k8s' } }),
      prisma.iMSandboxResourceSample.count({ where: { sampledAt: { gte: since1h } } }),
      prisma.iMSandboxResourceSample.findMany({
        where: { sampledAt: { gte: since1h } },
        select: { daemonRttMs: true },
        take: AGG_ROW_CAP,
      }),
      // Reconciler lag — oldest lastDaemonHealthAt over still-running k8s containers.
      prisma.iMContainer.findMany({
        where: {
          status: 'running',
          providerKind: 'k8s',
          lastDaemonHealthAt: { not: null },
        },
        orderBy: { lastDaemonHealthAt: 'asc' },
        take: 1,
        select: { lastDaemonHealthAt: true },
      }),
      // Recent failures — 24h non-zero exit. We accept either exitCode!=0 OR
      // exitReason in ('error','timeout') to capture cases where the daemon
      // never reported an exit code (e.g. crash before write).
      prisma.iMSandboxRunLog.findMany({
        where: {
          endedAt: { not: null, gte: since24h },
          OR: [{ exitCode: { not: 0 } }, { exitReason: { in: ['error', 'timeout'] } }],
        },
        orderBy: { endedAt: 'desc' },
        take: FAILURE_LIMIT,
        select: {
          id: true,
          containerId: true,
          workspaceId: true,
          exitCode: true,
          exitReason: true,
          durationMs: true,
          endedAt: true,
        },
      }),
    ]);

    // ── Containers grouping ────────────────────────────────────────────
    const byStatus: Record<string, number> = {};
    for (const g of statusGroups as Array<{ status: string; _count: { _all: number } }>) {
      byStatus[g.status] = g._count._all;
    }
    const byRuntimeKind: Record<string, number> = {};
    for (const g of runtimeGroups as Array<{ runtimeKind: string; _count: { _all: number } }>) {
      byRuntimeKind[g.runtimeKind] = g._count._all;
    }
    const byProviderKind: Record<string, number> = {};
    for (const g of providerGroups as Array<{ providerKind: string; _count: { _all: number } }>) {
      byProviderKind[g.providerKind] = g._count._all;
    }

    // ── Run-log aggregates (legacy duration) ───────────────────────────
    const [last24hCount, activeNow, completedRuns, errorCount24h, total24h] = await Promise.all([
      prisma.iMSandboxRunLog.count({ where: { startedAt: { gte: since24h } } }),
      prisma.iMSandboxRunLog.count({ where: { endedAt: null } }),
      prisma.iMSandboxRunLog.findMany({
        where: { startedAt: { gte: since24h }, durationMs: { not: null } },
        orderBy: { startedAt: 'desc' },
        take: AGG_ROW_CAP,
        select: { durationMs: true },
      }),
      prisma.iMSandboxRunLog.count({
        where: {
          endedAt: { not: null, gte: since24h },
          OR: [{ exitCode: { not: 0 } }, { exitReason: { in: ['error', 'timeout'] } }],
        },
      }),
      prisma.iMSandboxRunLog.count({
        where: { endedAt: { not: null, gte: since24h } },
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

    // Error rate: total24h is the completed-runs denominator. 0/0 = 0.
    const errorRate24h = total24h > 0 ? errorCount24h / total24h : 0;

    // ── Cold-start percentile (fallback algorithm) ─────────────────────
    type ColdRow = { createdAt: Date; startedAt: Date | null };
    const coldStartLatencies: number[] = (coldStartRows as ColdRow[])
      .map((r) => (r.startedAt ? r.startedAt.getTime() - r.createdAt.getTime() : null))
      .filter((d): d is number => d !== null && d >= 0);
    const sortedCold = coldStartLatencies.slice(0, PERCENTILE_SAMPLE).sort((a, b) => a - b);
    const coldStartP50Ms = percentile(sortedCold, 50);
    const coldStartP99Ms = percentile(sortedCold, 99);
    const coldStartP50Sec = coldStartP50Ms !== null ? Number((coldStartP50Ms / 1000).toFixed(2)) : null;
    const coldStartP99Sec = coldStartP99Ms !== null ? Number((coldStartP99Ms / 1000).toFixed(2)) : null;

    // ── Daemon health pass-rate (1h window) ────────────────────────────
    // expected = (running k8s containers) × 120 samples/hour.
    // No running containers → return 1.0 (no signal == healthy by convention).
    const expectedSamples = runningK8sCount * SAMPLES_PER_CONTAINER_PER_HOUR;
    const healthPassRateLastHour = expectedSamples === 0 ? 1.0 : Math.min(1.0, sampleCountLastHour / expectedSamples);

    // ── avgRttMs from samples ──────────────────────────────────────────
    const rttValues = (avgRttRows as Array<{ daemonRttMs: number }>).map((r) => r.daemonRttMs);
    const avgRttMs = rttValues.length > 0 ? Math.round(rttValues.reduce((a, b) => a + b, 0) / rttValues.length) : null;

    // ── Reconciler lag ─────────────────────────────────────────────────
    let reconcilerLagSec: number | null = null;
    if (reconcilerLagRow.length > 0 && reconcilerLagRow[0].lastDaemonHealthAt) {
      reconcilerLagSec = Math.max(
        0,
        Math.round((now.getTime() - reconcilerLagRow[0].lastDaemonHealthAt.getTime()) / 1000),
      );
    }

    // ── SLO evaluation ─────────────────────────────────────────────────
    const slo: SandboxMetrics['slo'] = {
      coldStartP99: {
        target: SLO_COLD_START_P99_SEC,
        current: coldStartP99Sec,
        ok: coldStartP99Sec === null || coldStartP99Sec <= SLO_COLD_START_P99_SEC,
      },
      daemonHealthPassRate: {
        target: SLO_DAEMON_HEALTH_PASS_RATE,
        current: Number(healthPassRateLastHour.toFixed(4)),
        ok: healthPassRateLastHour >= SLO_DAEMON_HEALTH_PASS_RATE,
      },
      reconcilerLag: {
        target: SLO_RECONCILER_LAG_SEC,
        current: reconcilerLagSec,
        ok: reconcilerLagSec === null || reconcilerLagSec <= SLO_RECONCILER_LAG_SEC,
      },
    };

    // ── Recent containers (added providerKind) ─────────────────────────
    type RecentRow = {
      id: string;
      podName: string;
      workspaceId: string;
      status: string;
      runtimeKind: string;
      providerKind: string;
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
        providerKind: row.providerKind ?? 'k8s',
        image: imageBaseName(row.image),
        createdAt: row.createdAt.toISOString(),
        startedAt: row.startedAt ? row.startedAt.toISOString() : null,
        stoppedAt: row.stoppedAt ? row.stoppedAt.toISOString() : null,
        coldStartLatencyMs,
      };
    });

    // ── In-flight provisioning rows ────────────────────────────────────
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

    // ── Recent failures (24h) ──────────────────────────────────────────
    type FailureRowDb = {
      id: string;
      containerId: string;
      workspaceId: string;
      exitCode: number | null;
      exitReason: string | null;
      durationMs: number | null;
      endedAt: Date | null;
    };

    // Fetch pod names + provider kinds for the failed containers in one shot.
    const failureContainerIds = Array.from(new Set((failureRows as FailureRowDb[]).map((r) => r.containerId)));
    const failureContainers = failureContainerIds.length
      ? await prisma.iMContainer.findMany({
          where: { id: { in: failureContainerIds } },
          select: { id: true, podName: true, providerKind: true },
        })
      : [];
    const containerMeta = new Map(
      (failureContainers as Array<{ id: string; podName: string; providerKind: string }>).map((c) => [
        c.id,
        { podName: c.podName, providerKind: c.providerKind ?? 'k8s' },
      ]),
    );

    const recentFailures = (failureRows as FailureRowDb[]).map((row) => {
      const meta = containerMeta.get(row.containerId);
      return {
        id: row.id,
        containerId: row.containerId,
        podName: meta?.podName ?? row.containerId.slice(0, 12),
        workspaceId: row.workspaceId,
        providerKind: meta?.providerKind ?? 'k8s',
        exitCode: row.exitCode,
        exitReason: row.exitReason,
        durationMs: row.durationMs,
        endedAt: (row.endedAt ?? new Date(0)).toISOString(),
      };
    });

    const response: SandboxMetrics = {
      generatedAt: now.toISOString(),
      containers: {
        total: totalContainers,
        byStatus,
        byRuntimeKind,
        byProviderKind,
      },
      runs: {
        last24h: last24hCount,
        activeNow,
        avgDurationSec: avgDurationSec !== null ? Number(avgDurationSec.toFixed(2)) : null,
        p50DurationSec: p50DurationSec !== null ? Number((p50DurationSec / 1000).toFixed(2)) : null,
        p99DurationSec: p99DurationSec !== null ? Number((p99DurationSec / 1000).toFixed(2)) : null,
        coldStartP50Sec,
        coldStartP99Sec,
        errorRate24h: Number(errorRate24h.toFixed(4)),
      },
      daemon: {
        healthPassRateLastHour: Number(healthPassRateLastHour.toFixed(4)),
        avgRttMs,
        degradedNow,
      },
      slo,
      recent,
      inFlight,
      recentFailures,
    };

    return NextResponse.json(response);
  } catch (err) {
    logger.error({ err }, '[admin/sandbox-metrics] unexpected error');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
