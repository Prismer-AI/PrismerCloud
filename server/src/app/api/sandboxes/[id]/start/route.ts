/**
 * POST /api/sandboxes/:id/start — start a stopped container.
 *
 * Schedules the pod in-process via `k8sSandbox.startContainer`; on success
 * syncs Prisma row to status='running' and refreshes startedAt (preserves
 * prior startedAt if already set, so the field reflects "first start" rather
 * than "most recent start").
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
    await k8sSandbox.startContainer(container.podName);
    await prisma.iMContainer.update({
      where: { id },
      data: {
        status: 'running',
        startedAt: container.startedAt ?? new Date(),
      },
    });
    logger.info({ id, podName: container.podName }, 'sandbox started');
    return NextResponse.json({ status: 'started' });
  } catch (err) {
    if (err instanceof K8sSandboxError) {
      return NextResponse.json({ error: 'controller_error', status: err.status, body: err.body }, { status: 502 });
    }
    logger.error({ err, id, podName: container.podName }, 'sandbox start failed');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
