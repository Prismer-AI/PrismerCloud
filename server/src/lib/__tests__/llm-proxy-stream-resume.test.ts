/**
 * Streaming-resume runner tests.
 *
 * Covers the 5 scenarios called out in the design spec:
 *   1. Happy path — upstream streams fully, no resume
 *   2. Single mid-stream disconnect → resume with prefill → completes
 *   3. Provider echoes prefill on resume → dedupe heuristic strips echo
 *   4. Provider does NOT echo prefill on resume → dedupe forwards as-is
 *   5. MAX_RESUMES cap — 4 consecutive drops → error frame after cap
 *
 * The tests stub `openUpstream` to return a `ReadableStream` for each
 * attempt; we control exactly when/how each stream errors via a small
 * helper. We assert against the bytes the runner forwards to the client.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamWithResume, parseSseFrames, extractDelta, injectPrefill, __test } from '@/lib/llm-proxy-stream-resume';

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── helpers ──────────────────────────────────────────────────────────────

const enc = new TextEncoder();

/** Build a ReadableStream that emits the given string chunks then ends cleanly. */
function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
}

/** Build a ReadableStream that emits chunks then ERRORS mid-stream (simulates upstream close). */
function streamErroringAfter(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.error(new Error('peer closed connection without sending complete message body'));
        return;
      }
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
}

/** Drain a ReadableStream into a single string. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  return out;
}

/** Build an OpenAI-shape SSE chunk carrying a content delta. */
function openaiContentFrame(text: string): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content: text }, finish_reason: null }],
  })}\n\n`;
}

const OPENAI_DONE = `data: [DONE]\n\n`;

/**
 * Walk an OpenAI-shape SSE stream string and concatenate all
 * `choices[0].delta.content` values in order. Useful for asserting the
 * effective text the downstream consumer would assemble — independent of
 * JSON encoding overhead.
 */
function reassembleContent(sse: string): string {
  let out = '';
  for (const frame of sse.split('\n\n')) {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const c = parsed.choices?.[0]?.delta?.content;
        if (typeof c === 'string') out += c;
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

// ─── pure helpers ──────────────────────────────────────────────────────────

describe('parseSseFrames', () => {
  it('splits frames on blank lines and keeps the partial tail in leftover', () => {
    const buf = 'data: a\n\ndata: b\n\ndata: c';
    const { events, leftover } = parseSseFrames(buf);
    expect(events).toEqual(['data: a', 'data: b']);
    expect(leftover).toBe('data: c');
  });

  it('handles an empty buffer', () => {
    const { events, leftover } = parseSseFrames('');
    expect(events).toEqual([]);
    expect(leftover).toBe('');
  });
});

describe('extractDelta (OpenAI)', () => {
  it('extracts content from a delta frame', () => {
    const ev = openaiContentFrame('hello').trimEnd();
    const out = extractDelta(ev, 'openai-chat');
    expect(out.contentDelta).toBe('hello');
    expect(out.isTerminal).toBe(false);
  });
  it('detects [DONE] terminal', () => {
    const out = extractDelta('data: [DONE]', 'openai-chat');
    expect(out.isTerminal).toBe(true);
  });
  it('detects finish_reason terminal', () => {
    const ev = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`;
    const out = extractDelta(ev, 'openai-chat');
    expect(out.isTerminal).toBe(true);
  });
});

describe('extractDelta (Anthropic)', () => {
  it('extracts text from content_block_delta', () => {
    const ev =
      'event: content_block_delta\n' +
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hi' },
      })}`;
    const out = extractDelta(ev, 'anthropic-chat');
    expect(out.contentDelta).toBe('hi');
    expect(out.isTerminal).toBe(false);
  });
  it('detects message_stop terminal', () => {
    const ev = 'event: message_stop\ndata: {"type":"message_stop"}';
    const out = extractDelta(ev, 'anthropic-chat');
    expect(out.isTerminal).toBe(true);
  });
});

describe('injectPrefill', () => {
  it('appends an assistant message and drops any existing trailing assistant', () => {
    const out = injectPrefill(
      {
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'stale partial' },
        ],
      },
      'fresh partial',
      'openai-chat',
    );
    const msgs = out.body.messages as Array<{ role: string; content: string }>;
    expect(msgs.length).toBe(2);
    expect(msgs[msgs.length - 1].role).toBe('assistant');
    expect(msgs[msgs.length - 1].content).toBe('fresh partial');
  });

  it('trims trailing whitespace for Anthropic prefill', () => {
    const out = injectPrefill(
      { messages: [{ role: 'user', content: 'hi' }] },
      'hello world   \n\t  ',
      'anthropic-chat',
    );
    const msgs = out.body.messages as Array<{ role: string; content: string }>;
    expect(msgs[msgs.length - 1].content).toBe('hello world');
    expect(out.effectivePartial).toBe('hello world');
  });

  it('preserves trailing whitespace for OpenAI prefill', () => {
    const out = injectPrefill({ messages: [{ role: 'user', content: 'hi' }] }, 'hello   ', 'openai-chat');
    const msgs = out.body.messages as Array<{ role: string; content: string }>;
    expect(msgs[msgs.length - 1].content).toBe('hello   ');
  });
});

describe('getMaxResumes', () => {
  it('defaults to 3', () => {
    expect(__test.getMaxResumes()).toBe(3);
  });
  it('honours LLM_PROXY_STREAM_MAX_RESUMES env override', () => {
    vi.stubEnv('LLM_PROXY_STREAM_MAX_RESUMES', '7');
    expect(__test.getMaxResumes()).toBe(7);
  });
  it('rejects negative / non-numeric and falls back to 3', () => {
    vi.stubEnv('LLM_PROXY_STREAM_MAX_RESUMES', 'nope');
    expect(__test.getMaxResumes()).toBe(3);
  });
  it('accepts 0 to disable resume', () => {
    vi.stubEnv('LLM_PROXY_STREAM_MAX_RESUMES', '0');
    expect(__test.getMaxResumes()).toBe(0);
  });
});

// ─── runner integration scenarios ─────────────────────────────────────────

describe('streamWithResume — runner integration', () => {
  it('1) happy path: streams fully without resume', async () => {
    const chunks = [openaiContentFrame('hel'), openaiContentFrame('lo'), OPENAI_DONE];
    let calls = 0;
    const stream = streamWithResume({
      initialBody: { messages: [{ role: 'user', content: 'hi' }] },
      kind: 'openai-chat',
      openUpstream: async () => {
        calls += 1;
        return { ok: true, status: 200, body: streamFrom(chunks) };
      },
    });
    const out = await drain(stream);
    expect(calls).toBe(1);
    expect(out).toContain('hel');
    expect(out).toContain('lo');
    expect(out).toContain('[DONE]');
  });

  it('2) single mid-stream disconnect → resume → completes', async () => {
    // Use a partial that's exactly the probe length so dedupe accumulates
    // exactly one decision-worth then makes the call. Continuation does NOT
    // echo, so reassembled content should be partial + continuation, in order.
    const part1 = 'aaaa bbbb cccc dddd '; // 20 chars
    const part2 = 'eeee ffff gggg hhhh '; // 20 chars (total partial = 40)
    const initialChunks = [openaiContentFrame(part1), openaiContentFrame(part2)];
    const resumedChunks = [
      openaiContentFrame('iiii '),
      openaiContentFrame('jjjj '),
      openaiContentFrame('kkkk'),
      OPENAI_DONE,
    ];
    const attempts: Array<Record<string, unknown>> = [];
    let call = 0;
    const stream = streamWithResume({
      initialBody: { messages: [{ role: 'user', content: 'hi' }] },
      kind: 'openai-chat',
      openUpstream: async (body) => {
        attempts.push(body);
        call += 1;
        if (call === 1) return { ok: true, status: 200, body: streamErroringAfter(initialChunks) };
        return { ok: true, status: 200, body: streamFrom(resumedChunks) };
      },
    });
    const out = await drain(stream);
    expect(call).toBe(2);
    // First attempt body had no prefill.
    const firstMsgs = attempts[0].messages as Array<{ role: string }>;
    expect(firstMsgs.length).toBe(1);
    // Second attempt body has prefill assistant message containing all the
    // text the runner forwarded before the disconnect.
    const secondMsgs = attempts[1].messages as Array<{ role: string; content: string }>;
    expect(secondMsgs[secondMsgs.length - 1].role).toBe('assistant');
    expect(secondMsgs[secondMsgs.length - 1].content).toBe(part1 + part2);
    // Reassembled content should be every delta concatenated in order.
    expect(reassembleContent(out)).toBe(part1 + part2 + 'iiii ' + 'jjjj ' + 'kkkk');
    expect(out).toContain('[DONE]');
  });

  it('3) provider echoes prefill → dedupe strips echo prefix', async () => {
    // Use a distinctive 40-char content (>= the probe cap default of 8KB
    // would be overkill; for tests we just need length > 0 and unambiguous).
    // Use the digit '1' so we can count occurrences in the parsed delta
    // streams without colliding with JSON key chars (which contain a/e/r/n…).
    const partial = '1111111111111111111111111111111111111111'; // 40 chars
    expect(partial.length).toBe(40);
    const initialChunks = [openaiContentFrame(partial)];
    // Resumed stream ECHOES the full partial, then continues with new text.
    const resumedChunks = [
      openaiContentFrame(partial), // echo
      openaiContentFrame(' continuation'),
      OPENAI_DONE,
    ];
    let call = 0;
    const stream = streamWithResume({
      initialBody: { messages: [{ role: 'user', content: 'hi' }] },
      kind: 'openai-chat',
      openUpstream: async () => {
        call += 1;
        if (call === 1) return { ok: true, status: 200, body: streamErroringAfter(initialChunks) };
        return { ok: true, status: 200, body: streamFrom(resumedChunks) };
      },
    });
    const out = await drain(stream);
    // Parse out the content deltas from the SSE stream and concatenate.
    // The dedupe should have stripped the 40-char echo, leaving only the
    // original 40 ones + ' continuation' as content.
    const reassembled = reassembleContent(out);
    expect(reassembled).toBe('1111111111111111111111111111111111111111 continuation');
    expect(out).toContain('[DONE]');
  });

  it('4) provider does NOT echo prefill → dedupe forwards continuation as-is', async () => {
    // The resumed stream's first chunks do NOT echo the prefill — they
    // continue from where it left off. Dedupe must accumulate enough to
    // confirm "no echo" then forward everything verbatim.
    const partial = '2222222222222222222222222222222222222222'; // 40 chars
    const initialChunks = [openaiContentFrame(partial)];
    // Continuation begins with totally different content (not echoing).
    const resumedChunks = [
      openaiContentFrame('then'), // 4 chars, accum < 40 → keep buffering
      openaiContentFrame('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), // pushes accum to 40
      openaiContentFrame(' end'),
      OPENAI_DONE,
    ];
    let call = 0;
    const stream = streamWithResume({
      initialBody: { messages: [{ role: 'user', content: 'hi' }] },
      kind: 'openai-chat',
      openUpstream: async () => {
        call += 1;
        if (call === 1) return { ok: true, status: 200, body: streamErroringAfter(initialChunks) };
        return { ok: true, status: 200, body: streamFrom(resumedChunks) };
      },
    });
    const out = await drain(stream);
    // Effective content: 40 ones from attempt 1 + 'thenxxxx…xx' (40 chars
    // flushed once decision lands) + ' end' from the trailing frame.
    const reassembled = reassembleContent(out);
    expect(reassembled).toBe(
      '2222222222222222222222222222222222222222' + 'thenxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' + ' end',
    );
    expect(out).toContain('[DONE]');
  });

  it('5) MAX_RESUMES cap: 4 consecutive drops → error frame after 3 resumes', async () => {
    vi.stubEnv('LLM_PROXY_STREAM_MAX_RESUMES', '3');
    const initialChunks = [openaiContentFrame('start')];
    let call = 0;
    const stream = streamWithResume({
      initialBody: { messages: [{ role: 'user', content: 'hi' }] },
      kind: 'openai-chat',
      openUpstream: async () => {
        call += 1;
        // EVERY attempt errors mid-stream after emitting one chunk.
        return { ok: true, status: 200, body: streamErroringAfter(initialChunks) };
      },
    });
    const out = await drain(stream);
    // 1 initial attempt + 3 resumes = 4 total.
    expect(call).toBe(4);
    expect(out).toContain('upstream_disconnect_unrecoverable');
    expect(out).toContain('giving up');
  });

  it('bonus: respects MAX_RESUMES=0 (no resume on disconnect)', async () => {
    vi.stubEnv('LLM_PROXY_STREAM_MAX_RESUMES', '0');
    const initialChunks = [openaiContentFrame('partial')];
    let call = 0;
    const stream = streamWithResume({
      initialBody: { messages: [{ role: 'user', content: 'hi' }] },
      kind: 'openai-chat',
      openUpstream: async () => {
        call += 1;
        return { ok: true, status: 200, body: streamErroringAfter(initialChunks) };
      },
    });
    const out = await drain(stream);
    expect(call).toBe(1);
    expect(out).toContain('upstream_disconnect_unrecoverable');
  });

  it('bonus: Anthropic protocol terminal + prefill trim', async () => {
    // One round-trip with whitespace at the end of the partial → resume body
    // should carry trimmed assistant content.
    const startEvent =
      'event: message_start\n' +
      `data: ${JSON.stringify({
        type: 'message_start',
        message: { model: 'claude-opus-4-7', usage: { input_tokens: 5 } },
      })}\n\n`;
    const deltaEvent = (text: string) =>
      'event: content_block_delta\n' +
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      })}\n\n`;
    const stopEvent = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

    const initialChunks = [startEvent, deltaEvent('hello world   ')]; // trailing spaces
    const resumedChunks = [startEvent, deltaEvent(' more text'), stopEvent];

    const attempts: Array<Record<string, unknown>> = [];
    let call = 0;
    const stream = streamWithResume({
      initialBody: { messages: [{ role: 'user', content: 'hi' }] },
      kind: 'anthropic-chat',
      openUpstream: async (body) => {
        attempts.push(body);
        call += 1;
        if (call === 1) return { ok: true, status: 200, body: streamErroringAfter(initialChunks) };
        return { ok: true, status: 200, body: streamFrom(resumedChunks) };
      },
    });
    await drain(stream);
    expect(call).toBe(2);
    const secondMsgs = attempts[1].messages as Array<{ role: string; content: string }>;
    // Trailing whitespace stripped for Anthropic.
    expect(secondMsgs[secondMsgs.length - 1].role).toBe('assistant');
    expect(secondMsgs[secondMsgs.length - 1].content).toBe('hello world');
  });
});
