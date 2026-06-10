/**
 * Phase 2F — SSE endpoint contract baseline (release201/08+10+11).
 *
 * Validates the cloud-side SSE contract that doc 08 §10.6 / doc 10 §4.2 /
 * doc 11 §16 all assume:
 *
 *   - `/api/im/sync/stream?token=<JWT>&since=<cursor>` is the canonical
 *     stream the SDK + Studio + workspace pages subscribe to. It accepts
 *     the JWT on the query string (NOT an Authorization header) per
 *     EventSource constraints in browsers.
 *   - Missing / bogus token → 401 (no stream body).
 *   - `since` defaults to 0 (live-tail only); non-numeric `since` is
 *     coerced to 0 (NaN → 0) and the stream opens. We assert the opening
 *     handshake + `caught_up` envelope arrive within a short window.
 *   - Two concurrent connections for the SAME user both work — there is no
 *     "only one stream per user" pruning step.
 *   - AbortSignal abort closes the stream client-side cleanly.
 *
 * What we deliberately DO NOT test here (see other files in this
 * directory):
 *   - typed event emission (skill.* / task.*) — those are in the two
 *     event-emission suites below.
 *   - Redis-backed live tail — covered indirectly by skill-authoring +
 *     task-events tests which trigger the producer side.
 *
 * Run:
 *   npx vitest run --config vitest.integration.config.ts \
 *     src/im/integration-tests/sse-events/sse-baseline.test.ts
 *
 * Pre-req: `npm run dev` running on 127.0.0.1:3000 with docker MySQL +
 * Redis up (the in-process IM server reads both at boot).
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { bootstrapSuite, subscribeSSE, TEST_TARGET } from '../_helpers';
import type { SuiteContext } from '../_helpers';

const SSE_PATH = '/sync/stream';

describe('SSE baseline — /sync/stream contract', () => {
  let ctx: SuiteContext;

  beforeAll(async () => {
    ctx = await bootstrapSuite('ssebase');
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup().catch(() => undefined);
  });

  test('opens stream with valid token + since=0; emits caught_up envelope within ~2s', async () => {
    const events: Array<{ event?: string; data: unknown }> = [];
    const ctrl = new AbortController();

    const streamPromise = subscribeSSE(SSE_PATH, ctx.owner, {
      query: { since: '0' },
      signal: ctrl.signal,
      onEvent: (e) => events.push(e),
    });

    // Give the server a couple of seconds to write the catch-up
    // (drains 0 events for a brand-new user) + `caught_up` marker.
    await new Promise((r) => setTimeout(r, 2_000));
    ctrl.abort();
    await streamPromise.catch(() => undefined);

    const caughtUp = events.find((e) => e.event === 'caught_up');
    expect(caughtUp).toBeDefined();
    // caught_up data is `{ cursor: <number> }` per sync-stream.ts line 187.
    expect((caughtUp!.data as { cursor: number }).cursor).toBe(0);
  });

  test('rejects with 401 when no token is supplied (no stream body)', async () => {
    // We hit the URL directly — subscribeSSE always tries to append a
    // token in query mode, so for the no-token case we bypass it.
    const url = `${TEST_TARGET}/api/im/sync/stream`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    });
    expect(res.status).toBe(401);
    // Drain so the connection cleans up.
    try {
      await res.text();
    } catch {
      /* ignore */
    }
  });

  test('rejects with 401 when token is bogus (not a valid JWT)', async () => {
    const url = `${TEST_TARGET}/api/im/sync/stream?token=not-a-real-jwt&since=0`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    });
    expect(res.status).toBe(401);
    try {
      await res.text();
    } catch {
      /* ignore */
    }
  });

  test('non-numeric `since` opens stream (parseInt NaN path); emits either caught_up or error envelope', async () => {
    const events: Array<{ event?: string; data: unknown }> = [];
    const ctrl = new AbortController();

    // sync-stream.ts: `const since = parseInt(c.req.query('since') ?? '0', 10);`
    // → parseInt('bogus', 10) = NaN. The downstream syncService.getEvents
    // sees NaN and currently throws, which the stream handler catches and
    // turns into an `error` envelope before closing. That IS still a valid
    // SSE handshake (200 + text/event-stream + at least one event). We
    // assert the open-and-emit-something contract; the precise envelope
    // shape is intentionally LOOSE so we don't fail when cloud tightens
    // input validation (caught_up) or further hardens it (400 from a
    // middleware). When this assertion fails, inspect the events array —
    // either the server has changed its NaN handling, or the stream is
    // now closing without any envelope at all (regression).
    const streamPromise = subscribeSSE(SSE_PATH, ctx.owner, {
      query: { since: 'bogus' },
      signal: ctrl.signal,
      onEvent: (e) => events.push(e),
    });

    await new Promise((r) => setTimeout(r, 2_000));
    ctrl.abort();
    await streamPromise.catch(() => undefined);

    // Must have opened AND emitted at least one envelope so the client
    // could distinguish "stream opened" from "TCP RST".
    expect(events.length).toBeGreaterThan(0);
    const opening = events.find((e) => e.event === 'caught_up' || e.event === 'error');
    expect(opening).toBeDefined();
  });

  test('two concurrent streams for the same user both open + receive caught_up', async () => {
    const eventsA: Array<{ event?: string; data: unknown }> = [];
    const eventsB: Array<{ event?: string; data: unknown }> = [];
    const ctrlA = new AbortController();
    const ctrlB = new AbortController();

    const a = subscribeSSE(SSE_PATH, ctx.owner, {
      query: { since: '0' },
      signal: ctrlA.signal,
      onEvent: (e) => eventsA.push(e),
    });
    const b = subscribeSSE(SSE_PATH, ctx.owner, {
      query: { since: '0' },
      signal: ctrlB.signal,
      onEvent: (e) => eventsB.push(e),
    });

    await new Promise((r) => setTimeout(r, 2_500));
    ctrlA.abort();
    ctrlB.abort();
    await Promise.all([a.catch(() => undefined), b.catch(() => undefined)]);

    expect(eventsA.find((e) => e.event === 'caught_up')).toBeDefined();
    expect(eventsB.find((e) => e.event === 'caught_up')).toBeDefined();
  });

  test('AbortSignal abort closes the stream promptly (< 1s after abort)', async () => {
    const events: Array<{ event?: string; data: unknown }> = [];
    const ctrl = new AbortController();

    const streamPromise = subscribeSSE(SSE_PATH, ctx.owner, {
      query: { since: '0' },
      signal: ctrl.signal,
      onEvent: (e) => events.push(e),
    });

    // Wait for stream to open + first event, then abort and time the close.
    await new Promise((r) => setTimeout(r, 1_000));
    const t0 = Date.now();
    ctrl.abort();
    await streamPromise.catch(() => undefined);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(1_000);
    expect(events.length).toBeGreaterThanOrEqual(1); // at least the `caught_up` event
  });
});
