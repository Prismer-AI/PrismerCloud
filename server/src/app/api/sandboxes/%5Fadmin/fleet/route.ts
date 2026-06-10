/**
 * GET /api/sandboxes/_admin/fleet — Admin fleet inventory.
 *
 * Returns the cross-referenced view of `im_containers` rows (cloud's
 * source-of-truth) and the actual K8s pods alive in the agent namespace
 * (kubelet's source-of-truth). The diff is exposed so the SRE console can
 * surface drift cases the user reported:
 *
 *   - DB row says `status='running'` but no pod exists  → `drift='pod-missing'`
 *     (typical after a pod was kubectl-deleted out-of-band; cloud row stuck)
 *   - K8s pod exists but no DB row references it        → `drift='pod-orphan'`
 *     (DB row was deleted but pod survived; consumes scheduling slots)
 *   - DB.status='running' but pod.phase != 'Running'    → `drift='phase-mismatch'`
 *     (pod fell out of healthy state since the row was last updated)
 *   - DB.status='errored' but pod still alive           → `drift='phase-mismatch'`
 *     (cleanup left the pod behind — pre-fix, before route.ts hard-delete)
 *
 * Auth: same `isSandboxAdmin(email)` gate as sandbox-metrics (NextAuth email
 * → admin-rbac.ts allowlist; ADMIN_EMAILS env var or hardcoded fallback).
 *
 * Query params (all optional):
 *   - status=running,errored,stopped  → CSV filter on DB status
 *   - kind=k8s,docker                 → CSV filter on runtimeKind
 *   - workspaceId=cmp...              → scope to one workspace
 *   - olderThanHours=24               → only rows created > N hours ago
 *   - limit=200 (default, max 500)    → DB row cap
 */

import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth/nextauth';
import { isSandboxAdmin } from '@/lib/admin-rbac';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { getCoreV1Api, getK8sNamespace } from '@/lib/k8s-client';

interface FleetContainer {
  id: string;
  podName: string;
  namespace: string;
  workspaceId: string;
  status: string;
  runtimeKind: string;
  image: string;
  cpuRequest: string;
  cpuLimit: string;
  memoryRequest: string;
  memoryLimit: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
  daemonId: string | null;
  lastDaemonHealthAt: string | null;
  /** K8s pod.phase if live; null if pod missing or runtimeKind!='k8s'. */
  livePhase: string | null;
  /** First waiting reason on the primary container — usually image-pull/etc. */
  liveWaitReason: string | null;
  /** True when one of the pod's conditions reports Unschedulable. */
  liveUnschedulable: boolean;
  drift: 'aligned' | 'pod-missing' | 'phase-mismatch' | null;
  ageHours: number;
}

interface OrphanPod {
  name: string;
  namespace: string;
  phase: string;
  createdAt: string;
  containerImage: string | null;
  ageHours: number;
}

export interface FleetResponse {
  containers: FleetContainer[];
  orphanPods: OrphanPod[];
  summary: {
    totalRows: number;
    byStatus: Record<string, number>;
    driftCount: number;
    orphanPodCount: number;
    namespace: string;
  };
}

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;

export async function GET(req: NextRequest): Promise<Response> {
  const session = await auth();
  if (!isSandboxAdmin(session?.user?.email)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const url = new URL(req.url);
  const statusFilter = (url.searchParams.get('status') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const kindFilter = (url.searchParams.get('kind') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const workspaceFilter = url.searchParams.get('workspaceId') ?? null;
  const olderThanHours = Number(url.searchParams.get('olderThanHours') ?? '0');
  const limitRaw = Number(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT));
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT, 1), MAX_LIMIT);

  try {
    const rows = await prisma.iMContainer.findMany({
      where: {
        ...(statusFilter.length > 0 ? { status: { in: statusFilter } } : {}),
        ...(kindFilter.length > 0 ? { runtimeKind: { in: kindFilter } } : {}),
        ...(workspaceFilter ? { workspaceId: workspaceFilter } : {}),
        ...(olderThanHours > 0
          ? { createdAt: { lt: new Date(Date.now() - olderThanHours * 60 * 60 * 1000) } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    // One K8s API call covers the whole namespace — much cheaper than N
    // per-pod reads. Phase + waiting reason + first PodScheduled condition
    // are extracted; the rest is metadata.
    const namespace = getK8sNamespace();
    const livePodsByName = new Map<
      string,
      {
        phase: string | null;
        waitReason: string | null;
        unschedulable: boolean;
        image: string | null;
        createdAt: string;
      }
    >();
    try {
      const api = await getCoreV1Api();
      const list = (await api.listNamespacedPod({ namespace, limit: 500 })) as {
        items?: Array<{
          metadata?: { name?: string; creationTimestamp?: string };
          spec?: { containers?: Array<{ image?: string }> };
          status?: {
            phase?: string;
            conditions?: Array<{ type?: string; status?: string; reason?: string }>;
            containerStatuses?: Array<{ state?: { waiting?: { reason?: string } } }>;
          };
        }>;
      };
      for (const pod of list.items ?? []) {
        const name = pod.metadata?.name;
        if (!name) continue;
        const podScheduled = pod.status?.conditions?.find((c) => c.type === 'PodScheduled');
        livePodsByName.set(name, {
          phase: pod.status?.phase ?? null,
          waitReason: pod.status?.containerStatuses?.[0]?.state?.waiting?.reason ?? null,
          unschedulable:
            podScheduled?.status === 'False' &&
            (podScheduled.reason === 'Unschedulable' || !podScheduled.reason),
          image: pod.spec?.containers?.[0]?.image ?? null,
          createdAt: pod.metadata?.creationTimestamp ?? '',
        });
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[admin/fleet] listNamespacedPod failed; returning DB-only view',
      );
      // Continue — livePodsByName stays empty, all k8s containers will be
      // marked drift='pod-missing' which is also informative.
    }

    const containers: FleetContainer[] = [];
    const seenPodNames = new Set<string>();
    const byStatus: Record<string, number> = {};
    let driftCount = 0;

    for (const row of rows) {
      seenPodNames.add(row.podName);
      const ageHours = Math.round((Date.now() - new Date(row.createdAt).getTime()) / 36e5);

      const livePod = livePodsByName.get(row.podName);
      let livePhase: string | null = null;
      let liveWaitReason: string | null = null;
      let liveUnschedulable = false;
      let drift: FleetContainer['drift'] = null;

      if (row.runtimeKind === 'k8s') {
        if (livePod) {
          livePhase = livePod.phase;
          liveWaitReason = livePod.waitReason;
          liveUnschedulable = livePod.unschedulable;
          const podRunning = livePod.phase === 'Running';
          if (row.status === 'running' && !podRunning) drift = 'phase-mismatch';
          else if ((row.status === 'errored' || row.status === 'stopped') && livePod.phase && livePod.phase !== 'Failed') {
            drift = 'phase-mismatch';
          } else drift = 'aligned';
        } else if (row.status !== 'stopped' && row.status !== 'errored') {
          drift = 'pod-missing';
        } else {
          drift = 'aligned';
        }
      }

      if (drift && drift !== 'aligned') driftCount++;
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;

      containers.push({
        id: row.id,
        podName: row.podName,
        namespace: row.namespace,
        workspaceId: row.workspaceId,
        status: row.status,
        runtimeKind: row.runtimeKind,
        image: row.image,
        cpuRequest: row.cpuRequest,
        cpuLimit: row.cpuLimit,
        memoryRequest: row.memoryRequest,
        memoryLimit: row.memoryLimit,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        startedAt: row.startedAt ? row.startedAt.toISOString() : null,
        stoppedAt: row.stoppedAt ? row.stoppedAt.toISOString() : null,
        daemonId: row.daemonId,
        lastDaemonHealthAt: row.lastDaemonHealthAt ? row.lastDaemonHealthAt.toISOString() : null,
        livePhase,
        liveWaitReason,
        liveUnschedulable,
        drift,
        ageHours,
      });
    }

    // Orphan K8s pods: live pod with no corresponding DB row.
    const orphanPods: OrphanPod[] = [];
    for (const [name, live] of livePodsByName) {
      if (seenPodNames.has(name)) continue;
      const createdMs = live.createdAt ? new Date(live.createdAt).getTime() : Date.now();
      orphanPods.push({
        name,
        namespace,
        phase: live.phase ?? 'Unknown',
        createdAt: live.createdAt,
        containerImage: live.image,
        ageHours: Math.round((Date.now() - createdMs) / 36e5),
      });
    }

    return NextResponse.json({
      containers,
      orphanPods,
      summary: {
        totalRows: containers.length,
        byStatus,
        driftCount,
        orphanPodCount: orphanPods.length,
        namespace,
      },
    } satisfies FleetResponse);
  } catch (err) {
    logger.error({ err }, '[admin/fleet] unexpected error');
    return NextResponse.json(
      { error: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
