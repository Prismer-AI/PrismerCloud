/**
 * POST /api/sandboxes/_admin/bulk-action — Admin batch operations on
 * sandbox containers (and stray K8s pods that have no DB row).
 *
 * Auth: same `isSandboxAdmin(email)` gate as sandbox-metrics + fleet.
 *
 * Actions:
 *   - `force-delete` (containerIds): delete K8s pod + DELETE im_containers row.
 *     Best-effort per id; one row's failure does not abort the batch.
 *   - `force-stop` (containerIds): delete K8s pod, set im_containers.status='stopped'.
 *     Keeps the DB row so the workspace UI shows "stopped" cards for history.
 *   - `reconcile` (containerIds): pull live pod state, update DB.status to match.
 *     If pod missing → row.status='stopped' + stoppedAt=now. No K8s side-effect.
 *   - `delete-orphan-pod` (podNames): delete K8s pods that have NO DB row.
 *     Use the orphanPods list from GET /fleet.
 *
 * Response: { results: Array<{ id?: string; podName?: string; ok: boolean;
 *   error?: string; previousStatus?: string }> }
 *
 * Why batch instead of per-id calls:
 *   - The user repro had 22+ accumulated rows; doing 22 separate UI clicks
 *     is the very friction this endpoint is meant to remove.
 *   - K8s API is rate-limited; the existing per-id `/api/sandboxes/[id]`
 *     handlers would each redo workspace authz + DB lookup, ~5x the cost.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/nextauth';
import { isSandboxAdmin } from '@/lib/admin-rbac';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { resolvePersistent } from '@/lib/sandbox/registry';
import { getCoreV1Api, getK8sNamespace } from '@/lib/k8s-client';

const BodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('force-delete'),
    containerIds: z.array(z.string().min(1)).min(1).max(200),
  }),
  z.object({
    action: z.literal('force-stop'),
    containerIds: z.array(z.string().min(1)).min(1).max(200),
  }),
  z.object({
    action: z.literal('reconcile'),
    containerIds: z.array(z.string().min(1)).min(1).max(200),
  }),
  z.object({
    action: z.literal('delete-orphan-pod'),
    podNames: z.array(z.string().min(1)).min(1).max(200),
  }),
]);

interface ItemResult {
  id?: string;
  podName?: string;
  ok: boolean;
  error?: string;
  previousStatus?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await auth();
  if (!isSandboxAdmin(session?.user?.email)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let parsed;
  try {
    const body = await req.json();
    parsed = BodySchema.parse(body);
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid_body', message: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  const results: ItemResult[] = [];

  if (parsed.action === 'force-delete') {
    const rows = (await prisma.iMContainer.findMany({
      where: { id: { in: parsed.containerIds } },
      select: { id: true, podName: true, runtimeKind: true, status: true },
    })) as Array<{ id: string; podName: string; runtimeKind: string; status: string }>;
    const rowsById = new Map(rows.map((r) => [r.id, r]));
    for (const id of parsed.containerIds) {
      const row = rowsById.get(id);
      if (!row) {
        results.push({ id, ok: false, error: 'row not found' });
        continue;
      }
      let podErr: string | undefined;
      if (row.runtimeKind === 'k8s') {
        try {
          // Provider-agnostic; under the hood k8s-provider.removeEnvironment
          // calls sandbox.removeContainer which swallows 404 via isMissingPod.
          await resolvePersistent('k8s').removeEnvironment(row.podName);
        } catch (e) {
          podErr = e instanceof Error ? e.message : String(e);
        }
      }
      try {
        await prisma.iMContainer.delete({ where: { id } });
        results.push({ id, ok: true, previousStatus: row.status });
      } catch (e) {
        results.push({
          id,
          ok: false,
          previousStatus: row.status,
          error: podErr
            ? `pod delete: ${podErr}; row delete: ${e instanceof Error ? e.message : String(e)}`
            : `row delete: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  } else if (parsed.action === 'force-stop') {
    const rows = (await prisma.iMContainer.findMany({
      where: { id: { in: parsed.containerIds } },
      select: { id: true, podName: true, runtimeKind: true, status: true },
    })) as Array<{ id: string; podName: string; runtimeKind: string; status: string }>;
    const rowsById = new Map(rows.map((r) => [r.id, r]));
    const now = new Date();
    for (const id of parsed.containerIds) {
      const row = rowsById.get(id);
      if (!row) {
        results.push({ id, ok: false, error: 'row not found' });
        continue;
      }
      let podErr: string | undefined;
      if (row.runtimeKind === 'k8s') {
        try {
          await resolvePersistent('k8s').removeEnvironment(row.podName);
        } catch (e) {
          podErr = e instanceof Error ? e.message : String(e);
        }
      }
      try {
        await prisma.iMContainer.update({
          where: { id },
          data: { status: 'stopped', stoppedAt: now, provisioningStep: null },
        });
        results.push({ id, ok: true, previousStatus: row.status, error: podErr });
      } catch (e) {
        results.push({
          id,
          ok: false,
          previousStatus: row.status,
          error: `row update: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  } else if (parsed.action === 'reconcile') {
    const rows = (await prisma.iMContainer.findMany({
      where: { id: { in: parsed.containerIds } },
      select: { id: true, podName: true, runtimeKind: true, status: true, namespace: true },
    })) as Array<{ id: string; podName: string; runtimeKind: string; status: string; namespace: string }>;
    let api;
    try {
      api = await getCoreV1Api();
    } catch (e) {
      return NextResponse.json(
        { error: 'k8s_unavailable', message: e instanceof Error ? e.message : String(e) },
        { status: 503 },
      );
    }
    const now = new Date();
    for (const row of rows) {
      if (row.runtimeKind !== 'k8s') {
        results.push({ id: row.id, ok: true, previousStatus: row.status, error: 'skipped (non-k8s)' });
        continue;
      }
      try {
        let phase: string | null = null;
        try {
          const pod = (await api.readNamespacedPod({ name: row.podName, namespace: row.namespace })) as {
            status?: { phase?: string };
          };
          phase = pod?.status?.phase ?? null;
        } catch (e) {
          // 404 from K8s = pod gone → mark stopped. Anything else: error.
          const msg = e instanceof Error ? e.message : String(e);
          if (/not\s*found|404/i.test(msg)) phase = null;
          else throw e;
        }
        if (phase === null && row.status !== 'stopped' && row.status !== 'errored') {
          await prisma.iMContainer.update({
            where: { id: row.id },
            data: { status: 'stopped', stoppedAt: now, provisioningStep: null },
          });
          results.push({ id: row.id, ok: true, previousStatus: row.status, error: 'pod missing → stopped' });
        } else if (phase === 'Running' && row.status !== 'running') {
          await prisma.iMContainer.update({
            where: { id: row.id },
            data: { status: 'running' },
          });
          results.push({ id: row.id, ok: true, previousStatus: row.status, error: 'pod running → row updated' });
        } else {
          results.push({ id: row.id, ok: true, previousStatus: row.status, error: 'aligned' });
        }
      } catch (e) {
        results.push({
          id: row.id,
          ok: false,
          previousStatus: row.status,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } else if (parsed.action === 'delete-orphan-pod') {
    const namespace = getK8sNamespace();
    // Defense-in-depth: confirm the pod is genuinely orphan (no DB row)
    // before deleting. UI may be stale; admin clicking from a refreshed
    // list still has a small race window. One Prisma query covers the batch.
    const stillReferenced = (await prisma.iMContainer.findMany({
      where: { podName: { in: parsed.podNames } },
      select: { podName: true },
    })) as Array<{ podName: string }>;
    const referencedSet = new Set(stillReferenced.map((r) => r.podName));
    for (const podName of parsed.podNames) {
      if (referencedSet.has(podName)) {
        results.push({
          podName,
          ok: false,
          error: 'pod has a DB row — use force-delete on the row id instead',
        });
        continue;
      }
      try {
        await resolvePersistent('k8s').removeEnvironment(podName);
        results.push({ podName, ok: true });
      } catch (e) {
        results.push({
          podName,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    void namespace; // currently unused — namespace is fixed via k8sSandbox internals
  }

  const okCount = results.filter((r) => r.ok).length;
  logger.info(
    {
      action: parsed.action,
      requested: 'containerIds' in parsed ? parsed.containerIds.length : parsed.podNames.length,
      ok: okCount,
      failed: results.length - okCount,
      admin: session?.user?.email,
    },
    '[admin/bulk-action] completed',
  );

  return NextResponse.json({ results });
}
