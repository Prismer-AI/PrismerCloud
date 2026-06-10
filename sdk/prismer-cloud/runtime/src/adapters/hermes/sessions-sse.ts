// release201/25 §16.4 A1.4 — SSE consumer for /api/sessions/{id}/chat/stream.
//
// Distinct from the /v1/runs SSE consumer (legacy `consumeSse` in index.ts):
// the sessions stream is the new Hermes-native primary endpoint with the
// most structured lifecycle events. Event list per §16.12 S4 (spike-verified
// against api_server.py:1530-1670):
//
//   run.started          — id capture; setPhase('running')
//   message.started      — no-op (assistant message id assigned)
//   assistant.delta      — accumulate to output
//   tool.started         — recordToolCall; setPhase('tool_call')
//   tool.progress        — recordReasoningChunk (partial tool output OR, when
//                          `tool_name === '_thinking'`, the model reasoning
//                          trace remapped by the sessions emitter — see below)
//   reasoning.available  — recordReasoningChunk(text) (direct reasoning event,
//                          emitted by the /v1/runs path and defensively handled
//                          here for hermes builds that surface it on sessions)
//   tool.completed       — recordToolResult
//   tool.failed          — recordError
//   assistant.completed  — finalize output; check content for upstream error markers
//   run.completed        — usage metrics (input_tokens / output_tokens / cache_*)
//   done                 — stream end
//
// LLM upstream errors are recoverable at the SSE protocol layer — the
// spike (§16.12 S4) confirmed that even when the LLM call returns HTTP
// 500, the assistant.completed event still fires with error content in
// the body and run.completed still closes the stream. The consumer
// therefore only needs to surface errors via the recorder/onProgress
// channels; it never throws on upstream LLM failure.

import type { TaskInput } from '../contract.js';

export interface SessionsSseResult {
  /** Concatenated assistant output (assistant.delta tokens). */
  output: string;
  /**
   * `run_id` captured from `run.started`. Stashed on HermesService so
   * task.signal abort can call POST /v1/runs/{id}/stop and so A6 native
   * approval forwarding can target the right run.
   */
  runId: string | null;
  /**
   * usage block from run.completed — input / output / cache tokens.
   * Surface to metrics so cost + prefix-cache hit-rate are observable
   * without us re-computing them (§16.12 S3 — hermes self-tracks cache).
   */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  /**
   * True iff the agent invoked the human-approval MCP tool during this
   * run. Set on the conventional `tool.started` for that tool name AND
   * on a dedicated `approval.request` event when hermes emits one
   * directly.
   */
  approvalRequested: boolean;
  /**
   * release202/12 — set when the assistant's final content is a hermes-generated
   * upstream LLM failure (`API call failed after N retries: …`) rather than a
   * real reply. Hermes still emits `assistant.completed` + `run.completed` on an
   * upstream 5xx/4xx, so the SSE layer succeeds; this flag lets the caller turn
   * it into a FAILED AdapterResult instead of a fake-successful task whose
   * output is the error string. `status` is the HTTP code parsed from the
   * message when present.
   */
  upstreamError?: { status?: number; message: string };
  /**
   * release202 — the most recent `clarify.request` seen on this stream
   * (Hermes native clarify tool, surfaced as a structured AskUserQuestion).
   * Unlike approval, the stream is NOT torn down: the run blocks server-side
   * on the clarify primitive and resumes in-place once the daemon forwards
   * the user's answer via HermesService.resolveClarify → POST
   * /v1/runs/{runId}/clarify. The daemon's inbound-reply path uses
   * {runId, clarifyId} to target the resolve.
   */
  clarify?: {
    clarifyId: string;
    question: string;
    choices: string[] | null;
    runId: string | null;
  };
}

const APPROVAL_TOOL_NAME = 'prismer.approval.request_human_approval';
const STREAMING_PROGRESS_INTERVAL_MS = 15_000;

/**
 * release202/12 — hermes serializes an exhausted-LLM-call into the assistant's
 * final content with one of these exact prefixes (verified against hermes
 * `agent/conversation_loop.py`):
 *   - `:3298` `f"API call failed after {max_retries} retries: {summary}"`
 *   - `:1488` `f"Invalid API response after {max_retries} retries: {summary}"`
 *   - `:3294` `f"Billing or credits exhausted: {summary}"` (FailoverReason.billing,
 *      i.e. an HTTP 402 — this is what the cloud P1 balance gate produces, so it
 *      MUST be detected or a 402 reverts to a fake-successful task).
 * The `{summary}` (`_summarize_provider_error`) frequently begins `HTTP <status>:`
 * but drops the JSON `error.type` field — so detection/classification must key on
 * the human message wording, never on a machine token like `provider_chain_unconfigured`.
 * Anchored at start (after trimStart) so a real agent reply merely *mentioning*
 * the phrase mid-text doesn't match; corroborated by zero streamed deltas.
 */
const HERMES_UPSTREAM_ERROR_RE =
  /^(?:(?:API call failed|Invalid API response) after \d+ retr(?:y|ies):|Billing or credits exhausted:)/;
const HERMES_UPSTREAM_STATUS_RE = /(?:^|[\s:])HTTP (\d{3})\b/;

function detectUpstreamError(
  finalContent: string | undefined,
  streamedDeltas: string,
): { status?: number; message: string } | undefined {
  // Only when the final content IS the error (no real tokens streamed) — this
  // avoids mis-flagging an agent that legitimately writes about a failure.
  if (!finalContent || streamedDeltas.length > 0) return undefined;
  const probe = finalContent.trimStart();
  if (!HERMES_UPSTREAM_ERROR_RE.test(probe)) return undefined;
  const m = probe.match(HERMES_UPSTREAM_STATUS_RE);
  const status = m ? Number(m[1]) : undefined;
  return { ...(status !== undefined ? { status } : {}), message: finalContent };
}

/**
 * Return the first argument that is a non-empty string or a non-null object
 * (objects are kept as-is — StepRecorder.summarize JSON-stringifies them).
 * Used to extract the tool output from a `tool.completed` payload whose field
 * name varies across hermes builds/endpoints. Empty strings and null/undefined
 * are skipped so `outputSummary` only ends up blank when nothing usable exists.
 */
function firstPresent(...candidates: unknown[]): unknown {
  for (const c of candidates) {
    if (typeof c === 'string') {
      if (c.length > 0) return c;
    } else if (c != null) {
      return c;
    }
  }
  return undefined;
}

/**
 * Out-parameter mirroring the pattern in consumeSse() — exposed so the
 * caller's catch block can still read approvalRequested when reader.read()
 * aborts mid-stream (reaper kill / signal cancel).
 */
export interface SessionsSseState {
  approvalRequested: boolean;
  runId: string | null;
  /** release202 — set true when a `clarify.request` is seen; last one stashed. */
  clarifyRequested?: boolean;
  clarify?: SessionsSseResult['clarify'];
}

export async function consumeSessionsSse(
  body: ReadableStream<Uint8Array>,
  task: TaskInput,
  state?: SessionsSseState,
): Promise<SessionsSseResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let deltas = '';
  let finalContent: string | undefined;
  let runId: string | null = null;
  let approvalRequested = false;
  let clarify: SessionsSseResult['clarify'] | undefined;
  let usage: SessionsSseResult['usage'] | undefined;
  let lastProgress = 0;
  let lastStreamProgressAt = 0;

  const bumpProgress = (by: number) => {
    lastProgress = Math.min(0.99, Math.max(0.01, lastProgress + by));
  };

  const reportStreamingProgress = () => {
    const now = Date.now();
    if (lastStreamProgressAt !== 0 && now - lastStreamProgressAt < STREAMING_PROGRESS_INTERVAL_MS) {
      return;
    }
    lastStreamProgressAt = now;
    bumpProgress(0.01);
    task.heartbeat?.touchStep();
    task.onProgress?.({
      progress: lastProgress,
      message: 'streaming',
      detail: {
        kind: 'llm_stream',
        event: 'assistant.delta',
        chars: deltas.length,
      },
    });
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE frames separated by blank line. Each frame has either an
    // `event: <type>\n` line + `data: <json>\n`, or just `data: <json>\n`
    // — we parse both.
    const events = buf.split('\n\n');
    buf = events.pop() ?? '';
    for (const ev of events) {
      const eventLine = ev.match(/^event: (.+)$/m);
      const dataLine = ev.match(/^data: ([\s\S]+)$/m);
      if (!dataLine) continue;
      const eventNameOuter = eventLine?.[1]?.trim();
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(dataLine[1]!);
      } catch (err) {
        process.stderr.write(
          `[hermes-adapter] sessions SSE JSON parse skipped: ${(err as Error).message}; head=${dataLine[1]!.slice(0, 200).replace(/\n/g, '\\n')}\n`,
        );
        continue;
      }
      // Prefer the outer `event:` line when present; fall back to a
      // payload-embedded `event` field (some hermes paths emit that
      // style).
      const eventName =
        eventNameOuter ?? (typeof payload.event === 'string' ? payload.event : '<missing>');
      process.stderr.write(
        `[hermes-adapter] task=${task.taskId ?? '?'} sessions-sse event=${eventName}\n`,
      );

      switch (eventName) {
        case 'run.started': {
          const rid = typeof payload.run_id === 'string' ? payload.run_id : null;
          if (rid) {
            runId = rid;
            if (state) state.runId = rid;
            task.heartbeat?.setPhase('running');
          }
          break;
        }
        case 'message.started':
          // No structured action — assistant message id is informational.
          break;
        case 'assistant.delta': {
          const delta = typeof payload.delta === 'string' ? payload.delta : '';
          if (delta) {
            deltas += delta;
            reportStreamingProgress();
          }
          break;
        }
        case 'tool.started': {
          const toolName =
            typeof payload.tool_name === 'string'
              ? payload.tool_name
              : typeof payload.tool === 'string'
                ? payload.tool
                : typeof payload.name === 'string'
                  ? payload.name
                  : undefined;
          const toolCallId =
            typeof payload.message_id === 'string'
              ? payload.message_id
              : typeof payload.tool_call_id === 'string'
                ? payload.tool_call_id
                : toolName ?? 'tool';
          if (toolName) {
            task.recorder?.recordToolCall(
              toolName,
              payload.arguments ?? payload.args ?? payload.preview ?? {},
              toolCallId,
            );
            task.heartbeat?.setPhase('tool_call');
          }
          if (toolName === APPROVAL_TOOL_NAME) {
            approvalRequested = true;
            if (state) state.approvalRequested = true;
          }
          bumpProgress(0.05);
          task.onProgress?.({
            progress: lastProgress,
            message: toolName,
            detail: {
              kind: 'tool',
              event: eventName,
              tool: toolName,
              preview: payload.preview,
              arguments: payload.arguments ?? payload.args,
            },
          });
          break;
        }
        case 'tool.progress': {
          // The sessions emitter (api_server.py:1585-1590 `_tool_progress`)
          // remaps the model's per-turn reasoning trace into this event with
          // `tool_name: '_thinking'` and the reasoning text in `delta` — NOT
          // `preview` (which it only sets for real tool progress). The
          // /v1/runs path instead emits a dedicated `reasoning.available`
          // event (handled below); on sessions it arrives HERE. Reading only
          // `preview` (the pre-2cdd2cad behaviour) silently dropped reasoning,
          // which is why the expandable reasoning block vanished from agent
          // messages. Read `delta` first so the trace is recorded again.
          const reasoningText =
            typeof payload.delta === 'string' && payload.delta.length > 0
              ? payload.delta
              : undefined;
          const preview =
            typeof payload.preview === 'string'
              ? payload.preview
              : payload.preview != null
                ? JSON.stringify(payload.preview).slice(0, 800)
                : undefined;
          const text = reasoningText ?? preview;
          if (text) {
            // Feed the persistent recorder (step-recorder batches reasoning
            // chunks on a throttle so a multi-chunk turn won't spam the cloud).
            task.recorder?.recordReasoningChunk(text);
            // Surface a low-progress reasoning hint so the in-chat activity
            // timeline shows the model thinking alongside tool calls. Mirror
            // the deleted /v1/runs handler: kind:'reasoning', do NOT bump
            // lastProgress (reasoning is not a tool execution unit and must
            // not feed the inactivity reaper's progress signal).
            task.onProgress?.({
              progress: lastProgress,
              message: 'thinking',
              detail: {
                kind: 'reasoning',
                event: eventName,
                tool: typeof payload.tool_name === 'string' ? payload.tool_name : undefined,
                text: text.length > 800 ? `${text.slice(0, 800)}…` : text,
              },
            });
          }
          task.heartbeat?.touchStep();
          break;
        }
        case 'reasoning.available': {
          // Direct reasoning event. The /v1/runs callback emits this with the
          // trace in `text` (api_server.py:3503-3510, `preview or ""`). The
          // primary sessions endpoint remaps reasoning into `tool.progress`
          // (handled above) and does NOT send this event today, but we handle
          // it defensively so a hermes build/path that DOES surface it on the
          // sessions stream still records the trace. Accept every field name a
          // build might use: `text` (legacy /v1/runs), `reasoning_content`
          // (sessions message field, api_server.py:1273), `delta`, `content`.
          const text =
            typeof payload.text === 'string' && payload.text.length > 0
              ? payload.text
              : typeof payload.reasoning_content === 'string' && payload.reasoning_content.length > 0
                ? payload.reasoning_content
                : typeof payload.delta === 'string' && payload.delta.length > 0
                  ? payload.delta
                  : typeof payload.content === 'string' && payload.content.length > 0
                    ? payload.content
                    : undefined;
          if (text) {
            task.recorder?.recordReasoningChunk(text);
            // Same semantics as the tool.progress reasoning branch: low hint,
            // no lastProgress bump (reasoning ≠ progress for the reaper).
            task.onProgress?.({
              progress: lastProgress,
              message: 'thinking',
              detail: {
                kind: 'reasoning',
                event: eventName,
                text: text.length > 800 ? `${text.slice(0, 800)}…` : text,
              },
            });
          }
          task.heartbeat?.touchStep();
          break;
        }
        case 'tool.completed': {
          const toolCallId =
            typeof payload.message_id === 'string'
              ? payload.message_id
              : typeof payload.tool_call_id === 'string'
                ? payload.tool_call_id
                : 'tool';
          // FIX 3 (tool-output recording): pull the actual tool output from
          // every field name a hermes build might use. The Hermes agent core
          // DOES pass the output to its `tool_progress_callback` as the
          // `result` kwarg (agent/tool_executor.py:388-392 / :823-826), but the
          // gateway's sessions-chat-stream callback (gateway/platforms/
          // api_server.py:1585-1590, `_tool_progress`) only enqueues
          // {message_id, tool_name, preview, args} and DROPS **kwargs — so on
          // THIS endpoint `result`/`output` are usually absent and `preview` is
          // None for `tool.completed`. We still read every candidate so that a
          // build/path which DOES forward the output (e.g. the responses bridge
          // which sets `payload.result`, api_server.py:2886) records non-empty
          // output. When all are absent we fall back to a synthetic marker so
          // outputSummary is never blank (the agent was blind → confabulated).
          const toolOutput =
            firstPresent(
              payload.result,
              payload.output,
              payload.preview,
              payload.content,
              payload.result_preview,
              payload.stdout,
            ) ??
            (payload.is_error === true
              ? '[tool errored]'
              : typeof payload.tool_name === 'string'
                ? `[${payload.tool_name} completed${typeof payload.duration === 'number' ? ` in ${payload.duration}s` : ''}; output not forwarded by hermes sessions stream]`
                : '[tool completed; output not forwarded by hermes sessions stream]');
          task.recorder?.recordToolResult(toolCallId, toolOutput);
          bumpProgress(0.05);
          task.onProgress?.({
            progress: lastProgress,
            detail: {
              kind: 'tool',
              event: eventName,
              tool: typeof payload.tool_name === 'string' ? payload.tool_name : undefined,
              result: payload.result,
              preview: payload.preview,
            },
          });
          break;
        }
        case 'tool.failed': {
          const message =
            typeof payload.error === 'string'
              ? payload.error
              : typeof payload.message === 'string'
                ? payload.message
                : 'tool failed';
          task.recorder?.recordError(message, payload as Record<string, unknown>);
          task.onProgress?.({
            progress: lastProgress,
            detail: {
              kind: 'tool',
              event: eventName,
              error: true,
              message,
            },
          });
          break;
        }
        case 'approval.request': {
          // Some hermes paths emit a dedicated approval event in addition
          // to (or instead of) `tool.started` with the approval tool name.
          // Mirror the existing /v1/runs consumer behaviour: flag it and
          // tear down the stream so the daemon doesn't block waiting for
          // events that won't arrive until the human decides.
          approvalRequested = true;
          if (state) state.approvalRequested = true;
          task.onProgress?.({
            progress: lastProgress,
            message: 'awaiting human approval',
            detail: {
              kind: 'approval',
              event: eventName,
              preview: payload.preview,
            },
          });
          try {
            await reader.cancel();
          } catch {
            /* reader cancel can throw if already closed */
          }
          return {
            output: deltas,
            runId,
            usage,
            approvalRequested,
            ...(clarify ? { clarify } : {}),
          };
        }
        case 'clarify.request': {
          // release202 — Hermes native clarify tool asked the user a blocking
          // question. UNLIKE approval, do NOT tear down the stream: the run
          // blocks server-side on the clarify primitive and resumes in-place
          // when the daemon forwards the answer (resolveClarify → POST
          // /v1/runs/{runId}/clarify). We surface the question via onProgress
          // so the cloud can render an AskUserQuestion card, stash the
          // {clarifyId, runId} the resolve needs, and keep reading.
          const clarifyId =
            typeof payload.clarify_id === 'string' ? payload.clarify_id : '';
          const question = typeof payload.question === 'string' ? payload.question : '';
          const choices = Array.isArray(payload.choices)
            ? (payload.choices.filter((c) => typeof c === 'string') as string[])
            : null;
          clarify = { clarifyId, question, choices, runId };
          if (state) {
            state.clarifyRequested = true;
            state.clarify = clarify;
          }
          task.heartbeat?.setPhase('waiting_user');
          task.onProgress?.({
            progress: lastProgress,
            message: 'awaiting user clarification',
            detail: {
              kind: 'clarify',
              event: eventName,
              clarifyId,
              question,
              choices,
              runId,
            },
          });
          break;
        }
        case 'clarify.responded': {
          task.heartbeat?.setPhase('running');
          task.onProgress?.({
            progress: lastProgress,
            detail: {
              kind: 'clarify',
              event: eventName,
              clarifyId: typeof payload.clarify_id === 'string' ? payload.clarify_id : undefined,
            },
          });
          break;
        }
        case 'assistant.completed': {
          // §16.12 S4 — LLM upstream errors still fire assistant.completed
          // with the error text in `content`. We finalize regardless; the
          // return path (release202/12 detectUpstreamError) classifies whether
          // that content is a hermes upstream-failure string and surfaces it as
          // a FAILED result rather than a fake-successful task.
          if (typeof payload.content === 'string') {
            finalContent = payload.content;
          }
          break;
        }
        case 'run.completed': {
          const u = (payload.usage ?? {}) as Record<string, unknown>;
          const num = (k: string): number | undefined =>
            typeof u[k] === 'number' ? (u[k] as number) : undefined;
          usage = {
            inputTokens: num('input_tokens'),
            outputTokens: num('output_tokens'),
            cacheReadTokens: num('cache_read_tokens'),
            cacheWriteTokens: num('cache_write_tokens'),
          };
          break;
        }
        case 'done':
          // End-of-stream sentinel; loop exits next reader.read().
          break;
        default:
          // Unknown event — log once for visibility but don't fail the run.
          process.stderr.write(
            `[hermes-adapter] sessions SSE unknown event=${eventName} keys=${Object.keys(payload).join(',')}\n`,
          );
      }
    }
  }

  const upstreamError = detectUpstreamError(finalContent, deltas);

  return {
    output: finalContent && finalContent.length > 0 ? finalContent : deltas,
    runId,
    usage,
    approvalRequested,
    ...(upstreamError ? { upstreamError } : {}),
    ...(clarify ? { clarify } : {}),
  };
}
