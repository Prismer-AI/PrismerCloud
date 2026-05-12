/**
 * POST /api/sandboxes/:id/stop — stop a running container.
 *
 * Tears down the pod in-process via `k8sSandbox.stopContainer`; on success
 * syncs Prisma row to status='stopped' with stoppedAt=now.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { logger } from '@/lib/logger';
import prisma from '@/lib/prisma';
import { K8sSandboxError, k8sSandbox } from '@/lib/k8s-sandbox';
import { authorizeContainer } from '../../_helpers';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await authorizeContainer(req, id);
  if (!auth.ok) return auth.response;

  const { container } = auth.data;

  try {
    await k8sSandbox.stopContainer(container.podName);
    await prisma.iMContainer.update({
      where: { id },
      data: { status: 'stopped', stoppedAt: new Date() },
    });
    logger.info({ id, podName: container.podName }, 'sandbox stopped');
    return NextResponse.json({ status: 'stopped' });
  } catch (err) {
    if (err instanceof K8sSandboxError) {
      return NextResponse.json({ error: 'controller_error', status: err.status, body: err.body }, { status: 502 });
    }
    logger.error({ err, id, podName: container.podName }, 'sandbox stop failed');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
