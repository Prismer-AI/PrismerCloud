/**
 * GET /api/sandboxes/:id/logs — Server-Sent Events stream of container logs.
 *
 * §26 B4 — sole path: polls `k8sSandbox.getContainerLogs(podName)` every 1s,
 * diffs against the previously-emitted length, frames new lines as SSE
 * `data: <line>\n\n` events. The poll-and-diff loop was originally lifted
 * from the now-deleted controller (per §26 B2 audit decision #3, which
 * preserved exact byte-level behavior); using the K8s SDK's `Log.log()`
 * follow stream is the alternative path but its cleanup story under
 * Next.js Edge/Node-runtime split is untested.
 *
 * Post-§26 review A3 fix: each poll caps the K8s log fetch via `tail: 1000`
 * lines instead of pulling the ENTIRE pod log (which was unbounded — a pod
 * with multi-MB logs would re-stream the full text every second). Bounded
 * per-poll fetch + lastLength diff keeps memory + bytes/sec sane while
 * still surfacing every new line emitted since the previous poll. The
 * 1000-line ceiling assumes a pod emits < 1000 lines/sec at steady state;
 * if a pod bursts past that, this loop drops middle lines (the diff sees a
 * fresh tail window) — acceptable for an SSE log preview, not for
 * authoritative log shipping.
 *
 * dynamic='force-dynamic' to opt out of Next.js full-route caching (SSE
 * must stream).
 *
 * Client abort propagation: the inbound request signal is forwarded to the
 * poll loop via `abortSignal.aborted` so closing the SSE connection from
 * the client side cancels the in-flight loop.
 */

import type { NextRequest } from 'next/server';
import { logger } from '@/lib/logger';
import { resolvePersistent } from '@/lib/sandbox/registry';
import { ProviderError } from '@/lib/execution/errors';
import { authorizeContainer } from '../../_helpers';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await authorizeContainer(req, id);
  if (!auth.ok) return auth.response;

  const { container } = auth.data;
  return streamPodLogs(req, container.podName, container.providerKind ?? 'k8s');
}

/**
 * Poll-and-diff SSE loop. Polls `k8sSandbox.getContainerLogs` every 1s, emits
 * new bytes as SSE frames.
 *
 * Teardown paths (all funnel through `cleanup()`):
 *   1. Client aborts the request (`req.signal.aborted`)
 *   2. ReadableStream cancel callback (consumer disconnected)
 *   3. K8sSandboxError(code='CONTAINER_NOT_FOUND') → emit one `event: error`
 *      then close
 *   4. Any other error → emit one `event: error` then close (do NOT
 *      reschedule — otherwise a K8s outage produces a duplicate-error flood
 *      every 1s)
 */
function streamPodLogs(req: NextRequest, podName: string, providerKind: string): Response {
  const abortSignal = req.signal;
  const encoder = new TextEncoder();
  let lastLength = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Wrap enqueue: an in-flight enqueue can race with abort/cancel and
      // throw on a closed controller. Returns false on failure so the loop
      // can stop.
      const safeEnqueue = (data: Uint8Array): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(data);
          return true;
        } catch {
          cleanup();
          return false;
        }
      };

      const poll = async (): Promise<void> => {
        if (abortSignal.aborted || closed) {
          cleanup();
          return;
        }
        try {
          // Cap the per-poll K8s fetch to the most recent 1000 lines. Without
          // this, `readNamespacedPodLog` returns the entire pod history on
          // each call — N polls × full-history-bytes/sec wasted bandwidth.
          // `lastLength` still drives line-level dedupe across polls.
          const provider = resolvePersistent(providerKind);
          const text = await provider.getLogs(podName, { tailLines: 1000 });
          if (text.length > lastLength) {
            const delta = text.slice(lastLength);
            lastLength = text.length;
            for (const line of delta.split('\n')) {
              if (line.length === 0) continue;
              if (!safeEnqueue(encoder.encode(`data: ${line}\n\n`))) return;
            }
          } else if (text.length < lastLength) {
            // Pod log rotated or tail-window slid past the previously-tracked
            // offset — reset lastLength to the new buffer's tail so we don't
            // re-emit. Acceptable miss: lines emitted between the previous
            // poll's window and the new tail are dropped (preview, not audit).
            lastLength = text.length;
          }
          if (!abortSignal.aborted && !closed) {
            timer = setTimeout(poll, 1000);
          }
        } catch (err) {
          if (err instanceof ProviderError && err.code === 'not_found') {
            safeEnqueue(encoder.encode(`event: error\ndata: not_found\n\n`));
            cleanup();
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          const payload = JSON.stringify({ error: message });
          safeEnqueue(encoder.encode(`event: error\ndata: ${payload}\n\n`));
          cleanup();
        }
      };

      abortSignal.addEventListener('abort', cleanup);

      poll().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err: message, podName }, '[sandboxes/logs] poll loop crashed');
        cleanup();
      });
    },
    cancel() {
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}
