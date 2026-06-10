// release202/08 Phase 1 — one-shot task-run dispatch via Hermes `/v1/runs`.
//
// Reverses release201/25 §16.4 A3 *only* for one-shot work items (kanban /
// scheduled fire / programmatic orchestration). FLAG-GATED, DEFAULT OFF — the
// router in index.ts only reaches this path when HERMES_TASK_RUNS_DISPATCH is
// on AND deriveDispatchKind() classifies the dispatch as `'run'`. Chat turns
// (group/dm with a triggering sender) keep going through dispatchViaSessions.
//
// Why a separate path (doc 08 §2):
//   * STATELESS — a run has no server-side transcript and no fork lineage, so
//     we do NOT create a Hermes session and do NOT touch local_run_sessions'
//     session mapping. There is nothing to "resume"; each fire is independent.
//   * PRECISE prompt — the run's input is the task spec + a standalone
//     <execution_context> block (the `task-run` type already encodes "no
//     participants / no current_turn_sender"). No SEED/THIN envelope — that is
//     a multi-turn-session optimisation and is meaningless for a one-shot run.
//   * The /events SSE is the SAME event family as the sessions stream
//     (run.started / assistant.delta / tool.* / run.completed), so we reuse
//     consumeSessionsSse verbatim instead of forking a second parser.
//
// Transport shape (spike-verified @ gateway/platforms/api_server.py):
//   POST /v1/runs            → 202 + { run_id }   (input + system_prompt)
//   GET  /v1/runs/{id}/events → SSE lifecycle
//   POST /v1/runs/{id}/stop  → cancellation (already used by HermesService)

import type { TaskInput, TaskResult } from '../contract.js';
import { categorizeDispatchError } from '../contract.js';
import type { ResolvedAssetRef } from '../../types/im-events.js';
import { renderExecutionContextXml } from '../../daemon/conversation-context.js';
import {
  buildMessage,
  deriveExecutionContext,
  type ExecutionContextDeps,
} from './sessions-dispatcher.js';
import { consumeSessionsSse, type SessionsSseState } from './sessions-sse.js';

export interface RunsDispatchDeps extends ExecutionContextDeps {
  baseUrl: string;
  apiKey: string;
  /**
   * Composed instructions string (capsSection + artifactsDirective + sysPrompt +
   * skillPrompt) — same value the sessions path receives. The run prepends the
   * standalone <execution_context> block to this and ships the whole thing as
   * `system_prompt`.
   */
  instructions: string;
  /** Idempotency key shared with the sessions path (LLM proxy cache stability). */
  idempotencyKey: string;
}

export interface RunsDispatchOutcome {
  result: TaskResult;
  /** runId captured from POST→202 (or run.started), used to wire currentRunId. */
  runId: string | null;
}

/**
 * Extract the run_id from the 202 POST body. Hermes returns `{ run_id }`; we
 * also tolerate `{ id }` / `{ run: { id } }` so a minor schema drift doesn't
 * lose the cancellation handle (the SSE run.started re-confirms it anyway).
 */
function extractRunId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  if (typeof o.run_id === 'string' && o.run_id.length > 0) return o.run_id;
  if (typeof o.id === 'string' && o.id.length > 0) return o.id;
  const run = o.run;
  if (run && typeof run === 'object') {
    const r = run as Record<string, unknown>;
    if (typeof r.id === 'string' && r.id.length > 0) return r.id;
    if (typeof r.run_id === 'string' && r.run_id.length > 0) return r.run_id;
  }
  return null;
}

export async function dispatchViaRuns(
  task: TaskInput,
  deps: RunsDispatchDeps,
): Promise<RunsDispatchOutcome> {
  const startedAt = Date.now();
  const sseState: SessionsSseState = { approvalRequested: false, runId: null };

  // Multimodal input — same image_url derivation as the sessions path. Run
  // input has no prior-turn quotes to re-inject (stateless), so we only fold in
  // the current-turn image asset refs.
  const imageRefs: ResolvedAssetRef[] = (task.assetRefs ?? []).filter((r) =>
    r.mime?.startsWith('image/'),
  );

  // The run's "精简 prompt": the original user prompt (+ any inline non-image
  // asset blocks dispatch.ts already produced). No <conversation_context>
  // envelope — a one-shot run has no participants / prior messages.
  const promptText = task.currentPrompt ?? task.prompt;
  const inlineBlocks = task.assetPromptBlocks ?? [];
  const inputText =
    inlineBlocks.length > 0 ? `${promptText}\n\n${inlineBlocks.join('\n\n')}` : promptText;
  const input = buildMessage(inputText, imageRefs);

  // system_prompt = standalone <execution_context> (task-run subset) + the
  // composed instructions (caps + artifacts + persona + skill). execution_context
  // goes first so scope ids / now / model lead the system attention window.
  const executionContext = deriveExecutionContext(task, deps);
  const executionContextXml = renderExecutionContextXml(executionContext);
  const systemPrompt = deps.instructions
    ? `${executionContextXml}\n\n${deps.instructions}`
    : executionContextXml;

  const body: Record<string, unknown> = { input, system_prompt: systemPrompt };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${deps.apiKey}`,
    'Content-Type': 'application/json',
    'X-Prismer-Idempotency-Key': deps.idempotencyKey,
  };

  const baseMetadata = (extra: Record<string, unknown>): Record<string, unknown> => ({
    hermes: {
      endpoint: '/v1/runs',
      baseUrl: deps.baseUrl,
      model: deps.model,
      dispatchKind: 'run',
      ...extra,
    },
  });

  try {
    const postRes = await fetch(`${deps.baseUrl}/v1/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: task.signal,
    });
    if (!postRes.ok) {
      const text = await postRes.text().catch(() => '');
      return {
        result: {
          ok: false,
          error: {
            code: 'adapter_dispatch_failed',
            message: `Hermes runs ${postRes.status}: ${text || '<no body>'}`,
          },
          metadata: baseMetadata({ status: 'failed' }),
        },
        runId: null,
      };
    }

    const postBody = await postRes.json().catch(() => null);
    const runId = extractRunId(postBody);
    if (!runId) {
      return {
        result: {
          ok: false,
          error: {
            code: 'adapter_dispatch_failed',
            message: 'Hermes /v1/runs 202 did not return a run_id',
          },
          metadata: baseMetadata({ status: 'failed' }),
        },
        runId: null,
      };
    }
    sseState.runId = runId;
    task.heartbeat?.setPhase('running');

    // Subscribe to the run lifecycle SSE — SAME event family as the sessions
    // stream, so consumeSessionsSse parses it verbatim.
    const eventsRes = await fetch(
      `${deps.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${deps.apiKey}`, Accept: 'text/event-stream' },
        signal: task.signal,
      },
    );
    if (!eventsRes.ok || !eventsRes.body) {
      const text = eventsRes.ok ? 'no body' : await eventsRes.text().catch(() => '');
      return {
        result: {
          ok: false,
          error: {
            code: 'adapter_dispatch_failed',
            message: `Hermes runs events ${eventsRes.status}: ${text || '<no body>'}`,
          },
          metadata: baseMetadata({ status: 'failed', runId }),
        },
        runId,
      };
    }

    const sseResult = await consumeSessionsSse(eventsRes.body, task, sseState);

    // release202/12 (D1) — mirror sessions-dispatcher: an exhausted upstream LLM
    // call must surface as a FAILED result, not a fake-successful task. Even
    // though this /v1/runs path is flag-gated (HERMES_TASK_RUNS_DISPATCH), keep
    // the two paths in lockstep so flipping the flag never reintroduces the bug.
    if (sseResult.upstreamError) {
      const { status, message } = sseResult.upstreamError;
      return {
        result: {
          ok: false,
          output: '',
          error: { code: 'upstream_llm_error', message },
          metrics: { durationMs: Date.now() - startedAt },
          metadata: baseMetadata({
            status: 'failed',
            runId: sseResult.runId ?? runId,
            upstreamStatus: status ?? null,
            error: message,
          }),
        },
        runId: sseResult.runId ?? runId,
      };
    }

    return {
      result: {
        ok: true,
        output: sseResult.output,
        metrics: { durationMs: Date.now() - startedAt },
        metadata: baseMetadata({
          status: 'dispatched',
          runId: sseResult.runId ?? runId,
          ...(imageRefs.length > 0 ? { multimodal: true, imageRefs: imageRefs.length } : {}),
          ...(sseResult.usage ? { usage: sseResult.usage } : {}),
          ...(sseResult.approvalRequested ? { approvalRequested: true } : {}),
        }),
      },
      runId: sseResult.runId ?? runId,
    };
  } catch (err) {
    const categorized = categorizeDispatchError(err, task.signal);
    return {
      result: {
        ...categorized,
        metadata: baseMetadata({
          status: categorized.error?.code === 'task_cancelled' ? 'cancelled' : 'failed',
          runId: sseState.runId,
          ...(categorized.error?.code !== 'task_cancelled'
            ? { error: (err as Error).message }
            : {}),
        }),
      },
      runId: sseState.runId,
    };
  }
}
