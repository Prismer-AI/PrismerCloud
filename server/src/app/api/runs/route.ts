/**
 * POST /api/runs — ephemeral one-shot run (Release 200 T10).
 *
 * Per `docs/release200/08-execution-environment-design.md` §8.2, this route
 * is the ephemeral-path twin of `POST /api/sandboxes`. It resolves an
 * `EphemeralExecutor` from the registry (docker-host by default, e2b when
 * `E2B_API_KEY` is set), calls `executor.run()`, persists an
 * `IMSandboxRun` row, and returns stdout/stderr/exitCode to the caller.
 *
 * Differences vs. /api/sandboxes:
 *   - No persistent IMContainer row — the container is destroyed
 *     immediately after the run.
 *   - No daemon, no scoped API key, no skill sync — the executor runs
 *     a raw OCI image with caller-supplied command.
 *   - Auth: session-bound (workspace ownership), same as /api/sandboxes.
 *
 * 201 → run finished (exitCode may still be non-zero — that's a
 *        successful run with a failing command, not a route failure).
 * 503 → executor not registered (e.g. e2b but no API key).
 * 502 / 400 / 401 / 403 / 408 / 429 / 500 → see `httpStatusForProviderError`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { resolveEphemeral } from '@/lib/sandbox/registry';
import { ProviderError, httpStatusForProviderError } from '@/lib/execution/errors';
import { authorizeWorkspace } from '../sandboxes/_helpers';

const Body = z
  .object({
    workspaceId: z.string().min(1),
    executor: z.enum(['docker-host', 'e2b']).default('docker-host'),
    request: z
      .object({
        image: z.string().optional(),
        command: z.array(z.string()).min(1),
        env: z.record(z.string(), z.string()).optional(),
        workingDir: z.string().optional(),
        timeoutMs: z.number().int().min(1).max(3_600_000).optional(),
        stdin: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export async function POST(req: NextRequest): Promise<Response> {
  const body = await req.json().catch(() => null);
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', details: parsed.error.flatten() }, { status: 400 });
  }

  const auth = await authorizeWorkspace(req, parsed.data.workspaceId);
  if (!auth.ok) return auth.response;

  // tenantId follows the same Phase 1 convention as /api/sandboxes:
  // workspace owner == tenant. Phase 2 will switch to billing-account id.
  const tenantId = auth.data.workspace.ownerImUserId;
  const executorId = parsed.data.executor;

  let executor;
  try {
    executor = resolveEphemeral(executorId);
  } catch {
    // Executor not registered. Likely causes:
    //   - 'e2b' requested but E2B_API_KEY env var is not set
    //   - registry bootstrap hasn't run (shouldn't happen — IIFE imports on
    //     module load)
    const hint =
      executorId === 'e2b'
        ? 'set E2B_API_KEY env var and install @e2b/code-interpreter'
        : 'ensure the local docker daemon is reachable';
    return NextResponse.json(
      {
        error: 'executor_not_available',
        message: `Ephemeral executor '${executorId}' is not registered (${hint})`,
      },
      { status: 503 },
    );
  }

  const startedAt = new Date();
  try {
    const result = await executor.run(parsed.data.request);
    const endedAt = new Date();

    // Persist run row. Failures here log + swallow — we still want to
    // return the run output to the caller even if persistence is broken,
    // since the container has already executed and been destroyed.
    let persistedId: string | null = null;
    try {
      const row = await prisma.iMSandboxRun.create({
        data: {
          // Let Prisma generate the cuid (varchar(30) on MySQL). We surface
          // the executor's own runId via providerRefs.runId for traceability;
          // im_sandbox_runs.id is the cloud-side primary key.
          containerId: null,
          providerKind: executorId,
          executionKind: 'ephemeral',
          workspaceId: parsed.data.workspaceId,
          tenantId,
          taskId: null,
          startedAt,
          endedAt,
          durationMs: result.durationMs,
          exitCode: result.exitCode ?? null,
          exitReason: result.exitCode === 0 ? 'completed' : 'error',
        },
      });
      persistedId = row.id;
    } catch (err) {
      logger.error(
        { err, runId: result.runId, executorId, workspaceId: parsed.data.workspaceId },
        '[api/runs] failed to persist im_sandbox_runs row',
      );
    }

    return NextResponse.json(
      {
        run: {
          id: persistedId,
          executorRunId: result.runId,
          executor: executorId,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          providerRefs: result.providerRefs ?? null,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof ProviderError) {
      return NextResponse.json(
        { error: err.code, message: err.message, providerRef: err.providerRef ?? null },
        { status: httpStatusForProviderError(err) },
      );
    }
    logger.error({ err, executorId }, '[api/runs] ephemeral run failed');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
