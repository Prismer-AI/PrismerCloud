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
import { K8sSandboxError, k8sSandbox, isAlreadyAbsentK8sError } from '@/lib/k8s-sandbox';
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
    const ctl = await k8sSandbox.getContainer(container.podName);
    liveStatus = ctl?.container.status ?? null;
  } catch (err) {
    logger.warn(
      { err, id, podName: container.podName },
      'k8sSandbox getContainer failed; returning Prisma snapshot only',
    );
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
    await k8sSandbox.removeContainer(container.podName);
  } catch (err) {
    if (err instanceof K8sSandboxError) {
      if (!isAlreadyAbsentK8sError(err)) {
        logger.error({ err, id, podName: container.podName }, 'k8sSandbox remove failed');
        return NextResponse.json({ error: 'controller_error', status: err.status, body: err.body }, { status: 502 });
      }
      logger.info({ id, podName: container.podName, status: err.status }, 'sandbox already absent in cluster');
    } else {
      logger.error({ err, id, podName: container.podName }, 'sandbox remove failed');
      return NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }
  }

  await prisma.iMContainer.update({
    where: { id },
    data: { status: 'stopped', stoppedAt: new Date() },
  });

  logger.info({ id, podName: container.podName }, 'sandbox removed');
  return NextResponse.json({ status: 'removed' });
}
