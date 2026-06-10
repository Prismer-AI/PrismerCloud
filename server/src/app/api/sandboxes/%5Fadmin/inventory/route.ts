/**
 * GET /api/sandboxes/_admin/inventory — single-shot "what's currently alive" snapshot.
 *
 * Phase v2.1 follow-up (docs/release201/06-debug-pipeline-design.md §11 — admin
 * troubleshooting flow showed agents repeatedly fanning out to fleet / db-snapshot
 * / system-logs just to answer "what pods exist, what workspaces are hot, what
 * just broke". This endpoint is the inventory entry point that compresses those
 * three questions into one call.
 *
 * Shape (top-level keys):
 *   - pods           recent running k8s containers (top 10 by lastDaemonHealthAt)
 *   - workspaces     5 most-recently-updated workspaces + per-row counts
 *   - recentTasks    10 most-recent tasks regardless of state
 *   - recentErrors   10 latest warn/error log lines from the in-process ring buffer
 *   - containers     { byStatus, totalRunning } summary across the whole namespace
 *   - generatedAt    ISO timestamp of the snapshot
 *
 * Performance: all fan-out via Promise.all, target < 200ms end-to-end on a warm
 * cloud process. Each query is bounded (`take: N`) so a hot workspace cannot
 * blow up response size.
 *
 * Auth: same `isSandboxAdmin(email)` gate as the other `_admin` routes; uses
 * `resolveAdminEmail` so API-key callers (CLI / scripted regression) resolve
 * correctly. Audit log line is emitted for every call regardless of outcome.
 *
 * Rate limit: shared 30/min/email bucket via `debug-rate-limit` (same as the
 * rest of the debug pipeline).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { isSandboxAdmin } from '@/lib/admin-rbac';
import { resolveAdminEmail } from '@/lib/admin/resolve-admin-email';
import { logger } from '@/lib/logger';
import prisma from '@/lib/prisma';
import { queryLogs } from '@/lib/log-buffer';
import {
  checkRateLimit,
  rateLimitResponse,
  withRateLimitHeaders,
} from '@/lib/admin/debug-rate-limit';

interface InventoryPod {
  name: string;
  status: string;
  workspaceId: string;
  gatewayUrl: string | null;
  lastDaemonHealthAt: string | null;
}

interface InventoryWorkspace {
  id: string;
  name: string;
  ownerImUserId: string;
  agents: number;
  tasks: number;
  messages: number;
  updatedAt: string;
}

interface InventoryTask {
  id: string;
  title: string;
  status: string;
  workspaceId: string | null;
  agentId: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface InventoryError {
  time: string;
  level: string;
  module: string | null;
  msg: string;
  error: string | null;
}

interface InventoryContainersSummary {
  byStatus: Record<string, number>;
  totalRunning: number;
}

const POD_LIMIT = 10;
const WORKSPACE_LIMIT = 5;
const RECENT_TASK_LIMIT = 10;
const RECENT_ERROR_LIMIT = 10;
const RECENT_ERROR_TRUNCATE = 200;

function truncate(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

export async function GET(req: NextRequest): Promise<Response> {
  const adminEmail = await resolveAdminEmail(req);
  if (!isSandboxAdmin(adminEmail)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const rl = checkRateLimit(adminEmail);
  if (!rl.allowed) return rateLimitResponse(rl);

  // Audit trail — every admin debug call.
  logger.info(
    {
      admin: adminEmail ?? null,
      action: 'inventory',
      filters: {},
    },
    '[admin-debug] called',
  );

  try {
    // Fan out everything in parallel. `groupBy` for the container summary is
    // a single SQL aggregate; the recent-error path reads from the in-process
    // ring buffer so it doesn't touch MySQL at all.
    const [podRows, workspaceRows, recentTaskRows, containerGroups] = await Promise.all([
      prisma.iMContainer.findMany({
        where: { status: 'running' },
        take: POD_LIMIT,
        orderBy: { lastDaemonHealthAt: 'desc' },
        select: {
          podName: true,
          status: true,
          workspaceId: true,
          gatewayUrl: true,
          lastDaemonHealthAt: true,
        },
      }),
      prisma.iMWorkspace.findMany({
        take: WORKSPACE_LIMIT,
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          name: true,
          ownerImUserId: true,
          updatedAt: true,
        },
      }),
      prisma.iMTask.findMany({
        take: RECENT_TASK_LIMIT,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          status: true,
          workspaceId: true,
          assigneeId: true,
          createdAt: true,
          completedAt: true,
        },
      }),
      prisma.iMContainer.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ]);

    // Per-workspace counts — second fan-out, scoped to the 5 rows we just
    // pulled. Each count is a bounded index lookup so total cost stays small
    // even across 5 workspaces × 3 counts = 15 queries (Promise.all).
    type WorkspaceRow = {
      id: string;
      name: string;
      ownerImUserId: string;
      updatedAt: Date;
    };
    const workspaces: InventoryWorkspace[] = await Promise.all(
      (workspaceRows as WorkspaceRow[]).map(async (ws) => {
        const [agentCount, taskCount, messageCount] = await Promise.all([
          prisma.iMAgentProfile.count({ where: { workspaceId: ws.id } }),
          prisma.iMTask.count({ where: { workspaceId: ws.id } }),
          prisma.iMMessage.count({ where: { conversation: { workspaceId: ws.id } } }),
        ]);
        return {
          id: ws.id,
          name: ws.name,
          ownerImUserId: ws.ownerImUserId,
          agents: agentCount,
          tasks: taskCount,
          messages: messageCount,
          updatedAt: ws.updatedAt.toISOString(),
        };
      }),
    );

    type PodRow = {
      podName: string;
      status: string;
      workspaceId: string;
      gatewayUrl: string | null;
      lastDaemonHealthAt: Date | null;
    };
    const pods: InventoryPod[] = (podRows as PodRow[]).map((p) => ({
      name: p.podName,
      status: p.status,
      workspaceId: p.workspaceId,
      gatewayUrl: p.gatewayUrl ?? null,
      lastDaemonHealthAt: p.lastDaemonHealthAt ? p.lastDaemonHealthAt.toISOString() : null,
    }));

    type TaskRow = {
      id: string;
      title: string;
      status: string;
      workspaceId: string | null;
      assigneeId: string | null;
      createdAt: Date;
      completedAt: Date | null;
    };
    const recentTasks: InventoryTask[] = (recentTaskRows as TaskRow[]).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      workspaceId: t.workspaceId ?? null,
      agentId: t.assigneeId ?? null,
      createdAt: t.createdAt.toISOString(),
      completedAt: t.completedAt ? t.completedAt.toISOString() : null,
    }));

    // recentErrors come from the in-process ring buffer — same source as
    // /system-logs but pre-filtered to warn+error and bounded to N entries so
    // the response stays compact. Entries are already redacted by the buffer
    // write path (logger.ts streamWrite hook), so we don't re-scrub here.
    const errorEntries = queryLogs({ level: ['warn', 'error'], limit: RECENT_ERROR_LIMIT });
    const recentErrors: InventoryError[] = errorEntries.map((e) => {
      const moduleField = typeof e.module === 'string' ? e.module : null;
      // pino renders `err: Error` via stdSerializers into `{ message, stack, ... }`.
      // Surface a single line for inventory — `err.message` if present, else the
      // raw `error` field if the caller logged it as a plain string.
      let errMsg: string | null = null;
      const errField = e.err;
      if (errField && typeof errField === 'object' && 'message' in errField) {
        const m = (errField as { message?: unknown }).message;
        if (typeof m === 'string') errMsg = m;
      } else if (typeof e.error === 'string') {
        errMsg = e.error;
      }
      return {
        time: e.ts,
        level: e.level,
        module: moduleField,
        msg: e.msg,
        error: truncate(errMsg, RECENT_ERROR_TRUNCATE),
      };
    });

    const byStatus: Record<string, number> = {};
    let totalRunning = 0;
    for (const g of containerGroups) {
      const c = g._count._all;
      byStatus[g.status] = c;
      if (g.status === 'running') totalRunning += c;
    }
    const containers: InventoryContainersSummary = { byStatus, totalRunning };

    return withRateLimitHeaders(
      NextResponse.json({
        generatedAt: new Date().toISOString(),
        pods,
        workspaces,
        recentTasks,
        recentErrors,
        containers,
      }),
      rl,
    );
  } catch (err) {
    logger.error({ err }, '[admin/inventory] unexpected error');
    return NextResponse.json(
      { error: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
