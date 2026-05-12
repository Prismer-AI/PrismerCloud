/**
 * POST /api/sandboxes/:id/runCmd — execute a command inside a running container.
 *
 * Path is /runCmd (not /exec) — deliberate naming inherited from the original
 * controller surface to avoid confusion with shell exec semantics. Body
 * schema mirrors the in-process `k8sSandbox.runCmd` argument shape.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { K8sSandboxError, k8sSandbox } from '@/lib/k8s-sandbox';
import { authorizeContainer } from '../../_helpers';

const RunCmdBody = z.object({
  command: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().min(100).max(600_000).default(60_000),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await authorizeContainer(req, id);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  const parsed = RunCmdBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', details: parsed.error.flatten() }, { status: 400 });
  }

  const { container } = auth.data;

  try {
    const result = await k8sSandbox.runCmd(container.podName, parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof K8sSandboxError) {
      return NextResponse.json({ error: 'controller_error', status: err.status, body: err.body }, { status: 502 });
    }
    logger.error({ err, id, podName: container.podName }, 'sandbox runCmd failed');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
