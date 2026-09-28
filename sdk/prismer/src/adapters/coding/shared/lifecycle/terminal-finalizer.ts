import type { PostTurnInput } from './post-turn-store.js';
import { PostTurnStore } from './post-turn-store.js';

export interface TerminalFinalizerLike {
  finalize(input: PostTurnInput): { key: string; inserted: boolean };
}

export class TerminalFinalizer implements TerminalFinalizerLike {
  constructor(private readonly store: PostTurnStore) {}

  finalize(input: PostTurnInput): { key: string; inserted: boolean } {
    return this.store.enqueue(input);
  }
}

let activeFinalizer: TerminalFinalizerLike | null = null;

/** Runtime-owned process binding. Provider packages never construct the store. */
export function setTerminalFinalizer(finalizer: TerminalFinalizerLike | null): void {
  activeFinalizer = finalizer;
}

export function getTerminalFinalizer(): TerminalFinalizerLike | null {
  return activeFinalizer;
}

/**
 * Non-throwing reliability boundary for provider runners and host adapters.
 * A local SQLite failure must be loud, but it must never replace the provider's
 * actual turn result/error.
 */
export function finalizeTerminalTurn(input: PostTurnInput): { key: string; inserted: boolean } | null {
  if (!activeFinalizer) return null;
  try {
    return activeFinalizer.finalize(input);
  } catch (error) {
    console.error(`[TerminalFinalizer] durable post-turn insert failed turn=${input.turnId}`, error);
    return null;
  }
}

export interface HostCrashCheckpoint {
  runId: string;
  phaseName: string;
  payload: Record<string, unknown>;
}

export interface HostCrashSessionContext {
  workspaceId: string;
  agentImUserId: string;
  conversationId: string | null;
  taskId: string | null;
}

export interface HostCrashSynthesisResult {
  inserted: number;
  duplicate: number;
  skipped: number;
}

/**
 * Convert durable unfinished checkpoints into terminal jobs before the legacy
 * resume scanner clears them. Missing conversation ownership is preserved as
 * absent; missing workspace/agent ownership is not fabricated and is skipped.
 */
export function synthesizeHostCrashedTurns(
  checkpoints: HostCrashCheckpoint[],
  resolveSession: (runId: string) => HostCrashSessionContext | null,
  finalizer: TerminalFinalizerLike,
): HostCrashSynthesisResult {
  const result: HostCrashSynthesisResult = { inserted: 0, duplicate: 0, skipped: 0 };
  for (const checkpoint of checkpoints) {
    const session = resolveSession(checkpoint.runId);
    const workspaceId = stringField(checkpoint.payload.workspaceId) ?? session?.workspaceId;
    const agentImUserId = stringField(checkpoint.payload.agentImUserId) ?? session?.agentImUserId;
    const conversationId = stringField(checkpoint.payload.conversationId) ?? session?.conversationId ?? undefined;
    if (!workspaceId || !agentImUserId) {
      result.skipped += 1;
      continue;
    }
    const finalized = finalizer.finalize({
      workspaceId,
      agentImUserId,
      ...(conversationId ? { conversationId } : {}),
      turnId: checkpoint.runId,
      terminalState: 'host_crashed',
      userMessage: stringField(checkpoint.payload.userMessage) ?? '',
      assistantResponse: '',
      toolFailures: [
        {
          tool: 'runtime_host',
          code: 'HOST_CRASHED',
          summary: `runtime stopped during phase ${checkpoint.phaseName}`,
        },
      ],
      ...(stringField(checkpoint.payload.traceId) ? { traceId: stringField(checkpoint.payload.traceId) } : {}),
    });
    if (finalized.inserted) result.inserted += 1;
    else result.duplicate += 1;
  }
  return result;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
