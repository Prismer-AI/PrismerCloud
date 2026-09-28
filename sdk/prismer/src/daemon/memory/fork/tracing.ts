// Fork tracing — emits one observability event per fork-driven recall.
//
// The event flows through the same daemon outbox as recall_preload /
// recall_inject / recall_pull (hooks.ts emits those in-process; the
// Hermes provider emits them out-of-process via /local/memory/
// observability/emit). Cloud-side aggregation reads the
// `metadataJson.forkLabel` discriminator to count fork frequency / cache
// hit rate per label, mirroring CC's `tengu_fork_agent_query`.

import { randomUUID } from 'node:crypto';
import type { MemoryRuntime } from '../runtime.js';
import type { ForkTraceEvent } from './types.js';
import { createLogger } from '../../../lib/logger.js';

const log = createLogger('memory.fork.tracing');

export interface EmitForkTraceOptions {
  runtime: MemoryRuntime;
  /** Stamped onto outbox rows — same as the runtime's deviceId. */
  deviceId: string;
  /** Identifies the actor that triggered the fork. */
  actorImUserId: string;
  actorKind: 'agent' | 'user';
  /** Optional session id for joining traces to a conversation. */
  sessionId?: string;
}

/**
 * Enqueue a `recall_fork` observability envelope for the given trace.
 * Best-effort: failures are logged and swallowed so the recall path
 * never blows up on tracing.
 */
export function emitForkTrace(
  event: ForkTraceEvent,
  opts: EmitForkTraceOptions,
): void {
  try {
    const slot = opts.runtime.peek(event.workspaceId);
    if (!slot) return;
    const eventId = randomUUID();
    const createdAt = new Date().toISOString();
    slot.outbox.enqueue({
      eventId,
      schemaVersion: 1,
      eventType: 'recall_fork',
      workspaceId: event.workspaceId,
      actorImUserId: opts.actorImUserId,
      actorKind: opts.actorKind,
      deviceId: opts.deviceId,
      createdAt,
      idempotencyKey: `obs:recall_fork:${event.forkId}`,
      metadataJson: {
        forkLabel: event.forkLabel,
        forkId: event.forkId,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        startedAt: event.startedAt,
        manifestEntryCount: event.manifestEntryCount,
        selectedCount: event.selectedCount,
      },
      metricsJson: {
        durationMs: event.durationMs,
        ...(event.promptCache
          ? {
              cacheReadTokens: event.promptCache.cacheReadTokens,
              cacheCreationTokens: event.promptCache.cacheCreationTokens,
              inputTokens: event.promptCache.inputTokens,
              outputTokens: event.promptCache.outputTokens,
            }
          : {}),
      },
    });
  } catch (err) {
    log.warn(
      `failed to emit recall_fork for ${event.workspaceId} ${event.forkLabel}: ${(err as Error).message}`,
    );
  }
}

/** Generate a fork id. Hex16 for log brevity. */
export function newForkId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}
