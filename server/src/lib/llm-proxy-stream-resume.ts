/**
 * LLM streaming "resume with prefill" — covers NewAPI's 5min upstream-idle
 * disconnect bug without requiring an upstream config change.
 *
 * Problem
 * -------
 * The NewAPI gateway in front of OpenAI / Anthropic has a hard-coded
 * `STREAMING_TIMEOUT=300` watchdog on the upstream→NewAPI scanner. If the
 * actual LLM model goes silent for >5min mid-generation (e.g. tool-step
 * compute, slow reasoning model), NewAPI closes the downstream chunked
 * response → cloud llm-proxy sees `RemoteProtocolError: incomplete chunked
 * read` → hermes adapter sees the same → daemon reaper kills the task.
 *
 * Operations workaround exists (`STREAMING_TIMEOUT=1800` on NewAPI), but we
 * want code-side resilience that works regardless of upstream config.
 *
 * Strategy
 * --------
 * When the upstream stream drops BEFORE a terminal SSE event:
 *   1. Buffer the assistant content already streamed downstream
 *      (`assistantPartial: string`, accumulated from streamed `content` deltas).
 *   2. Detect terminal per protocol — OpenAI: `data: [DONE]` or
 *      `choices[0].finish_reason !== null`; Anthropic: `event: message_stop`.
 *      Only non-terminal disconnects trigger resume.
 *   3. Re-POST upstream with the original body BUT injecting
 *      `{ role: 'assistant', content: assistantPartial }` as the trailing
 *      message (prefill). OpenAI + Anthropic both accept assistant prefill.
 *   4. Dedupe possible prefill echo from the new stream (most providers do
 *      NOT echo, but some do).
 *   5. Forward seamlessly to the client — no intermediate "resumed" marker.
 *   6. Cap at MAX_RESUMES (default 3) per single client request. After the
 *      cap, surface the upstream error to downstream so the caller knows it
 *      gave up.
 *
 * Idempotency-cache interaction (Cleanup-2 / TODO-3, see `llm-proxy-cache.ts`)
 * ---------------------------------------------------------------------------
 * The idempotency cache key is `sha256(prompt + ...)`. A resume uses a
 * DIFFERENT prompt (original + assistantPartial prefill), so it generates a
 * different cache key → a real upstream call. That's intentional: a resume is
 * a continuation, not a retry of the same call. No cache collision.
 *
 * Dedupe heuristic (documented choice)
 * ------------------------------------
 * Most providers do NOT echo the prefill — they continue from where the
 * prefill ends. A small minority (or older NewAPI shims) may re-emit the
 * partial content. We use a FULL-PREFIX echo-detection test bounded by the
 * partial length, with a hard cap to avoid pathological buffering:
 *
 *   - Let `partial = effectivePartial` (the assistant prefill we injected).
 *     Let `probeLen = min(partial.length, DEDUPE_MAX_PROBE_BYTES)`.
 *   - Accumulate new content into `dedupeAccum` until its length ≥ probeLen
 *     (or we see a terminal frame, whichever first).
 *   - If `dedupeAccum.startsWith(partial.slice(0, probeLen))` → provider IS
 *     echoing. Drop the entire echo: skip `partial.length` characters of new
 *     content total (we've already accumulated `probeLen` and dropped them;
 *     if `partial.length > probeLen`, set `dedupeSkipRemaining` so the rest
 *     of the echo is dropped on the next chunks). Then forward any tail.
 *   - Else → provider didn't echo. Forward `dedupeAccum` verbatim as a
 *     synthetic content frame and continue forwarding upstream frames as-is.
 *
 * Why full-prefix instead of last-32-char fingerprint: a "last-N chars
 * match" check is ambiguous when the partial contains repeating sequences
 * ("aaaa…") — it would falsely "succeed" on a partial echo and incorrectly
 * skip only N of M echoed bytes, leaving M-N spurious bytes in the stream.
 * Full-prefix dedupe is unambiguous: either the echo matches exactly or it
 * doesn't. The 8KB cap ensures we never buffer more than one chunk's worth
 * of latency on the dedupe path even for very long completions.
 */

import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('LLMProxyStreamResume');

export interface StreamResumeContext {
  taskRunId?: string;
  cacheKey?: string | null;
}

export type EndpointKind = 'openai-chat' | 'anthropic-chat';

/**
 * Parse one or more SSE frames out of a buffer. Returns the complete frames
 * and the leftover (partial) tail that should be carried into the next read.
 *
 * SSE frames are separated by a blank line (`\n\n`). Note: spec also allows
 * `\r\n\r\n`, but every upstream we proxy (OpenAI, NewAPI, Anthropic) uses
 * plain `\n\n`, so we don't bother with the CRLF variant.
 */
export function parseSseFrames(buf: string): { events: string[]; leftover: string } {
  const parts = buf.split('\n\n');
  const leftover = parts.pop() ?? '';
  // Each `events[i]` does NOT include the trailing `\n\n` separator.
  return { events: parts, leftover };
}

/**
 * Extract content delta + terminal-ness from a single SSE event (one frame
 * without the trailing `\n\n`). Returns `contentDelta = ''` when the frame
 * carries no text (e.g. role marker, ping, message_start).
 */
export function extractDelta(event: string, kind: EndpointKind): { contentDelta: string; isTerminal: boolean } {
  // OpenAI: one `data: …` line per frame, JSON shape with choices[0].delta.
  // `data: [DONE]` is terminal.
  if (kind === 'openai-chat') {
    let contentDelta = '';
    let isTerminal = false;
    for (const line of event.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') {
        isTerminal = true;
        continue;
      }
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{
            delta?: { content?: string };
            finish_reason?: string | null;
          }>;
        };
        const choice = parsed.choices?.[0];
        if (typeof choice?.delta?.content === 'string') {
          contentDelta += choice.delta.content;
        }
        if (choice?.finish_reason != null) isTerminal = true;
      } catch {
        // partial JSON — caller will keep buffering and retry on next read
      }
    }
    return { contentDelta, isTerminal };
  }

  // Anthropic: `event: <name>` + `data: <json>` lines. Terminal is
  // `event: message_stop`. Content lives on `content_block_delta` with
  // `delta.type === 'text_delta'` and `delta.text`.
  let eventName = '';
  let dataLine = '';
  for (const line of event.split('\n')) {
    if (line.startsWith('event: ')) eventName = line.slice(7).trim();
    else if (line.startsWith('data: ')) dataLine = line.slice(6);
  }
  if (eventName === 'message_stop') return { contentDelta: '', isTerminal: true };
  if (eventName !== 'content_block_delta' || !dataLine) {
    return { contentDelta: '', isTerminal: false };
  }
  try {
    const parsed = JSON.parse(dataLine) as { delta?: { type?: string; text?: string } };
    if (parsed.delta?.type === 'text_delta' && typeof parsed.delta.text === 'string') {
      return { contentDelta: parsed.delta.text, isTerminal: false };
    }
  } catch {
    // partial JSON
  }
  return { contentDelta: '', isTerminal: false };
}

/**
 * Build a request body for the resume call: drop any trailing assistant
 * message (to avoid double-prefill on multi-resume), then append a fresh
 * assistant prefill carrying `partial`.
 *
 * Anthropic-specific caveat: the Anthropic Messages API forbids prefill
 * content that ENDS with whitespace. Trim trailing whitespace just for the
 * prefill message (the dedupe later compares against the trimmed value).
 */
export function injectPrefill(
  originalBody: Record<string, unknown>,
  partial: string,
  kind: EndpointKind,
): { body: Record<string, unknown>; effectivePartial: string } {
  type Message = { role?: string; content?: unknown };
  const next: Record<string, unknown> = { ...originalBody };
  const baseMessages: Message[] = Array.isArray(originalBody.messages) ? [...(originalBody.messages as Message[])] : [];

  // If a previous resume left an assistant message at the tail, drop it —
  // we'll replace it with the fresh accumulated partial below.
  while (baseMessages.length > 0 && baseMessages[baseMessages.length - 1].role === 'assistant') {
    baseMessages.pop();
  }

  let effectivePartial = partial;
  if (kind === 'anthropic-chat') {
    // Anthropic: assistant prefill content must NOT end with whitespace.
    effectivePartial = partial.replace(/\s+$/, '');
  }

  baseMessages.push({ role: 'assistant', content: effectivePartial });
  next.messages = baseMessages;
  return { body: next, effectivePartial };
}

/**
 * Emit a synthetic SSE error frame to the client so a downstream parser
 * (hermes adapter) sees a structured failure instead of a silent close.
 * Format is chosen to be parseable by both OpenAI and Anthropic clients
 * (data line carries a JSON object; Anthropic clients ignore unknown event
 * names, OpenAI clients see a data frame they can decode).
 */
export function buildErrorFrame(kind: EndpointKind, message: string): Uint8Array {
  const enc = new TextEncoder();
  if (kind === 'openai-chat') {
    return enc.encode(
      `data: ${JSON.stringify({
        error: { message, type: 'proxy_error', code: 'upstream_disconnect_unrecoverable' },
      })}\n\n`,
    );
  }
  // Anthropic-shape error event.
  return enc.encode(
    `event: error\ndata: ${JSON.stringify({
      type: 'error',
      error: { type: 'upstream_disconnect_unrecoverable', message },
    })}\n\n`,
  );
}

/**
 * Max resume attempts per single client request. Default 3 — after the cap
 * the proxy surfaces an error frame so the caller knows it gave up. Override
 * with `LLM_PROXY_STREAM_MAX_RESUMES` to tune (e.g. 0 to disable resume).
 */
export function getMaxResumes(): number {
  const raw = process.env.LLM_PROXY_STREAM_MAX_RESUMES;
  if (!raw) return 3;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3;
}

/**
 * Hard cap on how many characters of `assistantPartial` we'll buffer-and-
 * compare on the dedupe path. 8 KB covers typical LLM completions well past
 * any realistic prefill length while bounding the worst-case "wait for first
 * byte after resume" latency at a single chunk.
 */
const DEDUPE_MAX_PROBE_BYTES = 8 * 1024;

export interface StreamWithResumeOptions {
  /** Original parsed request body (for prefill injection on resume). */
  initialBody: Record<string, unknown>;
  /** OpenAI vs Anthropic — controls SSE parsing + prefill shape. */
  kind: EndpointKind;
  /**
   * Open an upstream streaming connection. The runner calls this once per
   * attempt (initial + each resume) with the body for that attempt. Should
   * throw on connection failure.
   */
  openUpstream: (body: Record<string, unknown>) => Promise<{
    ok: boolean;
    status: number;
    body: ReadableStream<Uint8Array> | null;
  }>;
  /**
   * Side-channel: invoked once per non-aborted SSE event so the caller can
   * still extract usage / model from in-stream frames for billing + cache
   * writes. Receives the raw event text (no trailing `\n\n`).
   */
  onEvent?: (event: string) => void;
  /** Caller-supplied logging context — taskRunId from hermes, cache key, etc. */
  ctx?: StreamResumeContext;
}

/**
 * Wrap an upstream-streaming fetch in a resume-on-disconnect loop. Returns
 * a ReadableStream you can hand to the client (`new Response(stream, …)`).
 *
 * The returned stream:
 *   - forwards every upstream chunk byte-for-byte to the client (no
 *     reformatting on the happy path)
 *   - tracks `assistantPartial` from streamed `content` deltas so we know
 *     what to inject as prefill on resume
 *   - on non-terminal upstream drop, re-opens upstream with the prefilled
 *     body and continues seamlessly (after applying the dedupe heuristic
 *     described in this file's header)
 *   - on terminal SSE event, closes the stream cleanly
 *   - on `MAX_RESUMES` consecutive drops, emits a synthetic error frame
 *     then closes
 */
export function streamWithResume(options: StreamWithResumeOptions): ReadableStream<Uint8Array> {
  const { initialBody, kind, openUpstream, onEvent, ctx } = options;
  const MAX_RESUMES = getMaxResumes();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      let assistantPartial = '';
      let resumeCount = 0;

      // Dedupe state — only consulted while we're in the "first N chars of a
      // resumed stream" window. After we make the keep-or-skip decision once,
      // we set `dedupePending = false` for the rest of that attempt.
      let dedupePending = false;
      // The expected echo prefix we'll test for. Either equal to
      // `assistantPartial` itself (when partial.length <= probe cap) or a
      // truncated head used for the initial decision (when partial is huge).
      let dedupeProbeTarget = '';
      // Full assistantPartial as injected (used when partial.length > probe
      // cap — after the probe confirms echo, we still need to drop the
      // remaining `partial.length - probe.length` echoed chars).
      let dedupeExpectedTotal = '';
      let dedupeAccum = '';
      // Once we know the resume IS echoing the prefill, we still need to
      // skip the rest of the echo. `dedupeSkipRemaining` tracks how many
      // more characters of new content we should drop before forwarding.
      let dedupeSkipRemaining = 0;

      // forwardChunk: emit raw bytes to the client. The happy path forwards
      // upstream bytes verbatim. The dedupe path may need to rewrite a frame
      // (strip the prefill echo prefix) — for that we emit a re-encoded
      // OpenAI/Anthropic frame carrying the kept tail.
      const forwardChunk = (bytes: Uint8Array): void => {
        try {
          controller.enqueue(bytes);
        } catch {
          // Consumer cancelled — nothing more to do.
        }
      };

      const forwardText = (text: string): void => {
        if (!text) return;
        forwardChunk(encoder.encode(text));
      };

      // Build a minimal SSE frame carrying just `text` as a content delta.
      // Used only on the dedupe path when we want to emit the kept tail of
      // a stripped frame. We deliberately don't try to reconstruct every
      // upstream field (model, id, role) — the hermes adapter only consumes
      // the text delta, and downstream concatenation is order-preserving.
      const buildContentFrame = (text: string): string => {
        if (kind === 'openai-chat') {
          return `data: ${JSON.stringify({
            choices: [{ delta: { content: text }, finish_reason: null }],
          })}\n\n`;
        }
        return `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        })}\n\n`;
      };

      // Process one frame's worth of content delta — apply dedupe if active,
      // forward otherwise.
      const handleContentDelta = (contentDelta: string, originalFrameBytes: Uint8Array): void => {
        if (!dedupePending && dedupeSkipRemaining === 0) {
          assistantPartial += contentDelta;
          forwardChunk(originalFrameBytes);
          return;
        }

        // We're in dedupe mode. Two sub-phases:
        //
        // Phase A: dedupePending = true. We're still accumulating the first
        //   `dedupeProbeTarget.length` chars of new content to decide
        //   whether the provider echoed.
        // Phase B: dedupePending = false but dedupeSkipRemaining > 0. We've
        //   confirmed echo and partial was longer than the probe target —
        //   drop the remaining echoed chars before forwarding.

        if (dedupePending) {
          dedupeAccum += contentDelta;
          if (dedupeAccum.length < dedupeProbeTarget.length) {
            // Not enough to decide yet — DO NOT forward.
            return;
          }
          // Decision time. dedupeAccum.length >= probe.length.
          if (dedupeAccum.startsWith(dedupeProbeTarget)) {
            // Provider IS echoing — the first `probe.length` characters of
            // new content match what we injected as prefill. If partial was
            // longer than the probe cap, schedule the remainder as skip;
            // otherwise the full echo is what we just consumed.
            const remainingEchoLen = dedupeExpectedTotal.length - dedupeProbeTarget.length;
            // `extraAlreadyConsumed` is what we accumulated PAST the probe
            // target — this is either part of the longer-echo remainder, or
            // genuinely new content if the echo length equals partial length.
            const extraAlreadyConsumed = dedupeAccum.length - dedupeProbeTarget.length;
            if (remainingEchoLen <= 0) {
              // Whole echo fit in the probe — anything past probe is real
              // new content.
              const tail = dedupeAccum.slice(dedupeProbeTarget.length);
              assistantPartial += tail;
              if (tail) forwardText(buildContentFrame(tail));
              dedupePending = false;
              dedupeAccum = '';
              dedupeSkipRemaining = 0;
            } else {
              // We still need to drop `remainingEchoLen` more characters.
              // Some (or all) of those may already be in `extraAlreadyConsumed`.
              const dropFromExtra = Math.min(extraAlreadyConsumed, remainingEchoLen);
              const keepFromExtra = extraAlreadyConsumed - dropFromExtra;
              dedupeSkipRemaining = remainingEchoLen - dropFromExtra;
              if (keepFromExtra > 0) {
                const tail = dedupeAccum.slice(dedupeAccum.length - keepFromExtra);
                assistantPartial += tail;
                forwardText(buildContentFrame(tail));
              }
              dedupePending = false;
              dedupeAccum = '';
            }
            log.warn(
              {
                taskRunId: ctx?.taskRunId,
                resumeAttempt: resumeCount,
                partialLen: assistantPartial.length,
                droppedEchoChars: dedupeExpectedTotal.length,
              },
              'llm-proxy: provider echoed prefill — stripped echo prefix',
            );
            return;
          }
          // Provider did NOT echo. Forward the accumulated content as a
          // single synthetic frame (we can't replay the original frame bytes
          // here because they were split across multiple upstream reads
          // while we were buffering). Then continue forwarding subsequent
          // frames verbatim.
          assistantPartial += dedupeAccum;
          forwardText(buildContentFrame(dedupeAccum));
          dedupePending = false;
          dedupeAccum = '';
          dedupeSkipRemaining = 0;
          log.info(
            {
              taskRunId: ctx?.taskRunId,
              resumeAttempt: resumeCount,
              partialLen: assistantPartial.length,
              forwardedFirstChars: dedupeProbeTarget.length,
            },
            'llm-proxy: provider continued from prefill (no echo) — forwarded as-is',
          );
          return;
        }

        // dedupeSkipRemaining > 0 — we're mid-skip on a longer-than-probe
        // echo. Drop characters until we've consumed the remaining echo.
        if (dedupeSkipRemaining >= contentDelta.length) {
          dedupeSkipRemaining -= contentDelta.length;
          return;
        }
        const keep = contentDelta.slice(dedupeSkipRemaining);
        dedupeSkipRemaining = 0;
        assistantPartial += keep;
        forwardText(buildContentFrame(keep));
      };

      // Outer loop: initial attempt + up to MAX_RESUMES resume attempts.
      let attemptBody: Record<string, unknown> = initialBody;

      while (true) {
        let upstream: {
          ok: boolean;
          status: number;
          body: ReadableStream<Uint8Array> | null;
        };
        try {
          upstream = await openUpstream(attemptBody);
        } catch (err) {
          // Fetch itself failed. If this is the initial attempt, surface as
          // a hard error — we never streamed anything. If this is a resume,
          // emit the error frame (we already streamed partial content).
          const msg = err instanceof Error ? err.message : String(err);
          if (resumeCount === 0 && assistantPartial.length === 0) {
            forwardChunk(buildErrorFrame(kind, `upstream unreachable: ${msg}`));
          } else {
            forwardChunk(buildErrorFrame(kind, `upstream disconnected mid-stream and resume failed: ${msg}`));
          }
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          return;
        }

        if (!upstream.ok || !upstream.body) {
          forwardChunk(buildErrorFrame(kind, `upstream returned status ${upstream.status}`));
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          return;
        }

        const reader = upstream.body.getReader();
        let buf = '';
        let sawTerminal = false;
        let connectionDropped = false;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const { events, leftover } = parseSseFrames(buf);
            buf = leftover;
            for (const event of events) {
              if (!event) continue;
              // Side channel for usage extraction (billing + cache writes).
              if (onEvent) {
                try {
                  onEvent(event);
                } catch {
                  /* non-critical */
                }
              }
              const { contentDelta, isTerminal } = extractDelta(event, kind);
              const frameBytes = encoder.encode(event + '\n\n');
              if (contentDelta) {
                handleContentDelta(contentDelta, frameBytes);
              } else {
                // Non-content frame (role marker, ping, message_start, etc.).
                // If we're mid-dedupe, hold off forwarding non-content frames
                // until the decision lands so we don't reorder around the
                // first content chunk. In practice non-content frames
                // between content frames are rare for both OpenAI and
                // Anthropic; if we still haven't decided by the time the
                // stream ends, we flush below.
                if (dedupePending) {
                  // Buffer — but to keep this simple we forward immediately.
                  // Reasoning: non-content frames don't carry semantic state
                  // the downstream consumer needs to interleave with the
                  // content stream (they're either metadata or terminal).
                  forwardChunk(frameBytes);
                } else {
                  forwardChunk(frameBytes);
                }
              }
              if (isTerminal) {
                sawTerminal = true;
                // Flush any pending dedupe buffer — provider didn't echo
                // (we'd have decided already if it had).
                if (dedupePending && dedupeAccum) {
                  assistantPartial += dedupeAccum;
                  forwardText(buildContentFrame(dedupeAccum));
                  dedupePending = false;
                  dedupeAccum = '';
                }
              }
            }
            if (sawTerminal) break;
          }
        } catch (err) {
          if (!sawTerminal) {
            connectionDropped = true;
            log.warn(
              {
                taskRunId: ctx?.taskRunId,
                resumeAttempt: resumeCount,
                partialLen: assistantPartial.length,
                reason: err instanceof Error ? err.message : String(err),
              },
              'llm-proxy: upstream disconnect — will attempt resume with prefill',
            );
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            /* may have already errored */
          }
        }

        if (sawTerminal) {
          // Clean terminal — flush any remaining buffered text, close.
          if (dedupePending && dedupeAccum) {
            assistantPartial += dedupeAccum;
            forwardText(buildContentFrame(dedupeAccum));
          }
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          return;
        }

        if (!connectionDropped) {
          // Upstream ended cleanly (reader done=true) WITHOUT a terminal SSE
          // event. Unusual but possible (e.g. upstream proxy closed
          // gracefully at end of body without forwarding [DONE]). Treat as
          // "done" — we have whatever we have, no resume.
          if (dedupePending && dedupeAccum) {
            assistantPartial += dedupeAccum;
            forwardText(buildContentFrame(dedupeAccum));
          }
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          return;
        }

        // Non-terminal disconnect → resume.
        if (resumeCount >= MAX_RESUMES) {
          log.error(
            {
              taskRunId: ctx?.taskRunId,
              resumeAttempts: resumeCount,
              partialLen: assistantPartial.length,
            },
            'llm-proxy: hit MAX_RESUMES cap — surfacing error to downstream',
          );
          forwardChunk(
            buildErrorFrame(
              kind,
              `upstream disconnected ${resumeCount + 1} times — giving up after ${MAX_RESUMES} resume(s)`,
            ),
          );
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          return;
        }

        resumeCount += 1;
        const injected = injectPrefill(initialBody, assistantPartial, kind);
        attemptBody = injected.body;

        // Prime dedupe state for the resumed stream.
        const effective = injected.effectivePartial;
        if (effective.length > 0) {
          dedupePending = true;
          dedupeExpectedTotal = effective;
          dedupeProbeTarget =
            effective.length > DEDUPE_MAX_PROBE_BYTES ? effective.slice(0, DEDUPE_MAX_PROBE_BYTES) : effective;
          dedupeAccum = '';
          dedupeSkipRemaining = 0;
        } else {
          dedupePending = false;
        }

        log.warn(
          {
            taskRunId: ctx?.taskRunId,
            resumeAttempt: resumeCount,
            partialLen: assistantPartial.length,
            reason: 'upstream non-terminal disconnect',
          },
          'llm-proxy: upstream disconnect — resuming with prefill',
        );

        // Loop continues — openUpstream(attemptBody) on next iteration.
      }
    },
  });
}

// Test-only exports — used by src/lib/__tests__/llm-proxy-stream-resume.test.ts.
// Not part of the public proxy surface.
export const __test = {
  parseSseFrames,
  extractDelta,
  injectPrefill,
  buildErrorFrame,
  getMaxResumes,
  DEDUPE_MAX_PROBE_BYTES,
};
