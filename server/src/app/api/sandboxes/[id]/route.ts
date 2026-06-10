/**
 * GET    /api/sandboxes/:id — fetch container row + live status
 * DELETE /api/sandboxes/:id — remove pod via in-process K8s SDK, mark DB row stopped
 *
 * GET fetches the Prisma row + queries K8s for live pod status. If K8s no
 * longer knows about the pod (404 / unreachable), we still return the Prisma
 * snapshot — the DB is the source of truth for "this container existed", K8s
 * is only authoritative for liveness.
 *
 * DELETE on a pod that's already gone is treated as success ("already absent,
 * OK"). Other K8s errors → 502.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { logger } from '@/lib/logger';
import prisma from '@/lib/prisma';
import { resolvePersistent } from '@/lib/sandbox/registry';
import { ProviderError, httpStatusForProviderError } from '@/lib/execution/errors';
import { authorizeContainer } from '../_helpers';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await authorizeContainer(req, id);
  if (!auth.ok) return auth.response;

  const { container } = auth.data;

  // Best-effort live status lookup. getContainer returns null on 404 (handled
  // inside the client); fetch / network failures bubble up — log and fall back.
  let liveStatus: string | null = null;
  try {
    const provider = resolvePersistent(container.providerKind ?? 'k8s');
    const ctl = await provider.inspect(container.podName);
    liveStatus = ctl?.container.status ?? null;
  } catch (err) {
    logger.warn({ err, id, podName: container.podName }, 'sandbox inspect failed; returning Prisma snapshot only');
  }

  return NextResponse.json({
    container: {
      ...container,
      liveStatus: liveStatus ?? container.status,
    },
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await authorizeContainer(req, id);
  if (!auth.ok) return auth.response;

  const { container } = auth.data;

  try {
    const provider = resolvePersistent(container.providerKind ?? 'k8s');
    await provider.removeEnvironment(container.podName);
  } catch (err) {
    if (err instanceof ProviderError) {
      // "Already absent" is success for DELETE — historical behaviour from
      // `isAlreadyAbsentK8sError`. ProviderError code 'not_found' is the
      // adapter-mapped equivalent of K8sSandboxError CONTAINER_NOT_FOUND;
      // also tolerate adapters that surface it as a 404 in providerRef.
      const isAlreadyAbsent =
        err.code === 'not_found' ||
        (typeof err.providerRef?.k8sStatus === 'number' && err.providerRef.k8sStatus === 404);
      if (!isAlreadyAbsent) {
        logger.error({ err, id, podName: container.podName }, 'sandbox remove failed');
        return NextResponse.json(
          { error: err.code, message: err.message, retriable: err.retriable, providerRef: err.providerRef },
          { status: httpStatusForProviderError(err) },
        );
      }
      logger.info({ id, podName: container.podName, code: err.code }, 'sandbox already absent in cluster');
    } else {
      logger.error({ err, id, podName: container.podName }, 'sandbox remove failed');
      return NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }
  }

  await prisma.iMContainer.update({
    where: { id },
    data: { status: 'stopped', stoppedAt: new Date() },
  });

  // Cascade: mark all agent cards hosted by this daemon as deleted.
  // Uses the daemonId from the container row (both the DB column and
  // the derived daemonId from agentImUserId) so both local daemons
  // and K8s runtime installations are covered.
  const daemonId = container.daemonId || `container:${container.agentImUserId || ''}`;
  if (daemonId) {
    const hostedCards = await prisma.iMAgentCard.findMany({
      where: {
        workspaceId: container.workspaceId,
        OR: [
          { metadata: { contains: `"daemonId":"${daemonId}"` } },
          { metadata: { contains: `"daemonId":"container:${container.agentImUserId || ''}"` } },
        ],
      },
      select: { id: true, imUserId: true },
    });
    if (hostedCards.length > 0) {
      const typed = hostedCards as Array<{ id: string; imUserId: string }>;
      const cardIds = typed.map((c) => c.id);
      const imUserIds = typed.map((c) => c.imUserId);
      // Soft-delete agent cards
      await prisma.iMAgentCard.updateMany({
        where: { id: { in: cardIds } },
        data: { status: 'offline', metadata: '{}' },
      });
      logger.info(
        { id, podName: container.podName, agentCount: hostedCards.length, imUserIds },
        'sandbox removed — orphaned agent cards detached',
      );
    }
  }

  logger.info({ id, podName: container.podName }, 'sandbox removed');
  return NextResponse.json({ status: 'removed' });
}
