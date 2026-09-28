/**
 * memory211/08 A4-① — N-A5: PostTurnWorker emits one `extract.done`
 * observability envelope per outcome transition (applied / skipped /
 * failed_retryable / failed_terminal) through the injected `emitObservability`
 * closure; the runner wires it to `slot.outbox.enqueue` in production.
 *
 * Contract:
 *   - idempotencyKey: `obs:extract.done:<job.idempotencyKey>:<attemptCount>:<outcome>`
 *     (attempt MUST be in the key — the cloud idempotency hash covers the whole
 *     envelope; same key + different body = 409 MEMORY_IDEMPOTENCY_CONFLICT).
 *   - error text rides from the STORE's lastError (redactSensitiveText already
 *     applied by post-turn-store fail()/terminalFailure()) — a raw extract
 *     error message containing secrets must never appear in any field.
 *   - replay paths (applyResult short-circuit / outcomeForStoredJob) emit NOTHING.
 *   - no actor identity (no agentImUserId) or no emit closure → skip silently
 *     (recall_pull discipline: never fabricate actor).
 *   - emitting is best-effort: a throwing closure must not change the outcome.
 *
 * 负控（N-A5 red→green）：本文件在 A4-① 落地前是红的 —— worker 无第 4 闭包、
 * envelope 联合无 extract.done 成员（⑦ safeParse 红、⑨ 真库 dead-letter 红）。
 * Tests ①-⑥/⑧ assert on the injected closure (the seam under test — the
 * memory_outbox table belongs to the MemoryStore schema, not the post-turn db);
 * ⑨ exercises the real MemoryOutbox.
 */

import { describe, expect, it, vi } from 'vitest';
import { openLocalDb } from '../src/sync/store.js';
import { PostTurnStore } from '../src/adapters/coding/shared/lifecycle/post-turn-store.js';
import { PostTurnWorker } from '../src/adapters/coding/shared/lifecycle/post-turn-worker.js';
import { MemoryOutbox } from '../src/daemon/memory/outbox.js';
import { MemoryOutboxEnvelope, eventFamily } from '../src/daemon/memory/envelope.js';
import { MemoryStore } from '../src/daemon/memory/store.js';

type Captured = Record<string, unknown>;

const JOB_NOW = 1_000;

function baseInput(turnId: string, overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 'ws_test',
    agentImUserId: 'agent_1',
    conversationId: 'conv_1',
    turnId,
    canonicalTurnId: `canon_${turnId}`,
    lane: 'durable' as const,
    terminalState: 'completed' as const,
    userMessage: 'remember this',
    assistantResponse: 'done',
    toolFailures: [],
    traceId: `trace_${turnId}`,
    executionContext: {
      model: 'served-model',
      provider: 'served-provider',
      routingEvidenceSource: 'adapter' as const,
    },
    ...overrides,
  };
}

function wire(opts: { maxAttempts?: number; withEmit?: boolean } = {}) {
  const db = openLocalDb(':memory:');
  const store = new PostTurnStore(db, { maxAttempts: opts.maxAttempts ?? 3 });
  const captured: Captured[] = [];
  const extract = vi.fn(async () => ({ pages: [{ path: 'notes/x' }] }));
  const apply = vi.fn(async () => [{ pageId: 'pg_1', path: 'notes/x', version: 1, contentHash: 'hash_1' }]);
  const deps = {
    store,
    extract,
    apply,
    // A4-① 4th closure — not in the interface yet (red): the cast keeps tsc
    // quiet until Task 10 lands the dependency.
    ...(opts.withEmit === false
      ? {}
      : {
          emitObservability: (event: Captured) => {
            captured.push(event);
          },
        }),
  };
  const worker = new PostTurnWorker(deps as never, { now: () => JOB_NOW });
  return { db, store, worker, captured, extract, apply };
}

describe('post-turn extract.done observability emit (memory211/08 A4-① / N-A5)', () => {
  it('① applied → exactly one envelope: outcome/pages/actor/idempotencyKey contract', async () => {
    const { store, worker, captured } = wire();
    const { key } = store.enqueue(baseInput('turn_applied'), JOB_NOW);
    const outcome = await worker.processKey(key, { ignoreSchedule: true });
    expect(outcome.state).toBe('persisted');

    expect(captured).toHaveLength(1);
    const event = captured[0]!;
    expect(event.eventType).toBe('extract.done');
    expect(event.schemaVersion).toBe(1);
    expect(event.workspaceId).toBe('ws_test');
    expect(event.actorImUserId).toBe('agent_1');
    expect(event.actorKind).toBe('agent');
    expect(event.query).toBeUndefined();
    expect(event.pageId).toBeUndefined();
    const meta = event.metadataJson as Record<string, unknown>;
    expect(meta.outcome).toBe('applied');
    expect(meta.pages).toBe(1);
    expect(meta.turnId).toBe('turn_applied');
    const attempt = store.get(key)?.attemptCount ?? 0;
    expect(event.idempotencyKey).toBe(`obs:extract.done:${key}:${attempt}:applied`);
  });

  it('② skipped → outcome skipped with the extractor skipReason verbatim', async () => {
    const { store, worker, captured, extract } = wire();
    extract.mockResolvedValue({ pages: [], skipReason: 'greeting' } as never);
    const { key } = store.enqueue(baseInput('turn_skip'), JOB_NOW);
    const outcome = await worker.processKey(key, { ignoreSchedule: true });
    expect(outcome.state).toBe('skipped_not_durable');

    expect(captured).toHaveLength(1);
    const meta = (captured[0]!.metadataJson ?? {}) as Record<string, unknown>;
    expect(meta.outcome).toBe('skipped');
    expect(meta.skipReason).toBe('greeting');
  });

  it('②b skipped-with-gate-rejections carries gatedOut (「全被门拒」≠「无事可做」)', async () => {
    const { store, worker, captured, extract } = wire();
    // The LLM ran but every page was refused by the deliverable gate — same
    // zero-page outcome, different diagnosis. metricsJson must say so.
    extract.mockResolvedValue({ pages: [], gatedOut: 3, truncated: false } as never);
    const { key } = store.enqueue(baseInput('turn_gated'), JOB_NOW);
    await worker.processKey(key, { ignoreSchedule: true });

    const meta = (captured[0]!.metadataJson ?? {}) as Record<string, unknown>;
    const metrics = (captured[0]!.metricsJson ?? {}) as Record<string, unknown>;
    expect(meta.outcome).toBe('skipped');
    expect(meta.skipReason).toBeUndefined(); // no precheck reason — the gate refused
    expect(metrics.gatedOut).toBe(3);
  });

  it('②c a failing extraction forwards the HTTP status attached to the thrown error', async () => {
    const { store, worker, captured, extract } = wire({ maxAttempts: 1 });
    const err = new Error('gateway 429') as Error & { status?: number };
    err.status = 429;
    extract.mockRejectedValue(err);
    const { key } = store.enqueue(baseInput('turn_429'), JOB_NOW);
    await worker.processKey(key, { ignoreSchedule: true });

    const metrics = (captured[0]!.metricsJson ?? {}) as Record<string, unknown>;
    expect(metrics.outcome).toBe('failed_terminal');
    expect(metrics.errorStatus).toBe(429);
  });

  it('③ retryable failures → one row per attempt, attempt monotonic in the key, error from redacted store lastError (secret never leaks)', async () => {
    const { store, worker, captured, extract } = wire({ maxAttempts: 3 });
    // The raw error carries a secret-SHAPED token (redactSensitiveText's
    // sk- pattern) — the store redacts it before persisting lastError, and
    // extract.done must carry the STORE's text, never the raw throw.
    extract.mockRejectedValue(new Error('sk-prismer-live-abcdef12345 leaked during extraction boom'));
    const { key } = store.enqueue(baseInput('turn_retry'), JOB_NOW);
    await worker.processKey(key, { ignoreSchedule: true });
    await worker.processKey(key, { ignoreSchedule: true });

    expect(captured).toHaveLength(2);
    const attempts = captured.map((e) => String(e.idempotencyKey));
    expect(attempts[0]).toMatch(new RegExp(`^obs:extract\\.done:${key}:\\d+:failed_retryable$`));
    expect(attempts[0]).not.toBe(attempts[1]);
    // The job key itself contains colons — anchor on the suffix, not split().
    const attemptOf = (k: string) => Number(k.match(/:(\d+):(applied|skipped|failed_retryable|failed_terminal)$/)?.[1]);
    const firstAttempt = attemptOf(attempts[0]!);
    const secondAttempt = attemptOf(attempts[1]!);
    expect(secondAttempt).toBeGreaterThan(firstAttempt);
    for (const event of captured) {
      const meta = (event.metadataJson ?? {}) as Record<string, unknown>;
      expect(meta.error).toBe(store.get(key)?.lastError);
      expect(JSON.stringify(event)).not.toContain('sk-prismer-live-abcdef12345');
    }
  });

  it('④ terminal failures → failed_terminal exactly once (maxAttempts=1 and both pre-extract guards)', async () => {
    // 4a: exhausted retries → dead_letter.
    const a = wire({ maxAttempts: 1 });
    const ka = a.store.enqueue(baseInput('turn_dead'), JOB_NOW).key;
    a.extract.mockRejectedValue(new Error('boom'));
    const outcomeA = await a.worker.processKey(ka, { ignoreSchedule: true });
    expect(outcomeA.state).toBe('terminal_failure');
    expect(a.captured).toHaveLength(1);
    expect(((a.captured[0]!.metadataJson ?? {}) as Record<string, unknown>).outcome).toBe('failed_terminal');

    // 4b: no_conversation_id guard (fires BEFORE extract).
    const b = wire({ maxAttempts: 1 });
    const kb = b.store.enqueue(baseInput('turn_noconv', { conversationId: undefined }), JOB_NOW).key;
    const outcomeB = await b.worker.processKey(kb, { ignoreSchedule: true });
    expect(outcomeB.state).toBe('terminal_failure');
    expect(((b.captured[0]!.metadataJson ?? {}) as Record<string, unknown>).error).toBe(
      'non_extractable:no_conversation_id',
    );
    expect(b.captured).toHaveLength(1);
    expect(b.extract).not.toHaveBeenCalled();

    // 4c: routing-evidence guard.
    const c = wire({ maxAttempts: 1 });
    const kc = c.store.enqueue(baseInput('turn_routing', { executionContext: undefined }), JOB_NOW).key;
    const outcomeC = await c.worker.processKey(kc, { ignoreSchedule: true });
    expect(outcomeC.state).toBe('terminal_failure');
    expect(((c.captured[0]!.metadataJson ?? {}) as Record<string, unknown>).error).toBe(
      'non_extractable:untrusted_routing_evidence',
    );
    expect(c.captured).toHaveLength(1);
  });

  it('⑤ replay after completion emits nothing new', async () => {
    const { store, worker, captured } = wire();
    const { key } = store.enqueue(baseInput('turn_replay'), JOB_NOW);
    await worker.processKey(key, { ignoreSchedule: true });
    const before = captured.length;
    await worker.processKey(key, { ignoreSchedule: true });
    expect(captured.length).toBe(before);
  });

  it('⑥ no emitObservability closure → persisted and skipped states still process without throwing', async () => {
    const db = openLocalDb(':memory:');
    const store = new PostTurnStore(db, { maxAttempts: 3 });
    const extract = vi.fn(async (job: { turnId: string }) =>
      job.turnId === 'turn_no_emit_ok' ? { pages: [{ path: 'notes/x' }] } : { pages: [] },
    );
    const worker = new PostTurnWorker({ store, extract, apply: vi.fn() } as never);
    const k1 = store.enqueue(baseInput('turn_no_emit_ok'), JOB_NOW).key;
    await expect(worker.processKey(k1, { ignoreSchedule: true })).resolves.toMatchObject({
      state: 'persisted',
    });
    const k2 = store.enqueue(baseInput('turn_no_emit_skip'), JOB_NOW).key;
    await expect(worker.processKey(k2, { ignoreSchedule: true })).resolves.toMatchObject({
      state: 'skipped_not_durable',
    });
    db.close();
  });

  it('⑦ the envelope parses against the daemon schema union and families as observability', async () => {
    const { store, worker, captured } = wire();
    const { key } = store.enqueue(baseInput('turn_schema'), JOB_NOW);
    await worker.processKey(key, { ignoreSchedule: true });

    const parsed = MemoryOutboxEnvelope.safeParse(captured[0]);
    expect(parsed.success).toBe(true);
    expect(eventFamily('extract.done')).toBe('observability');
  });

  it('⑧ a throwing emit closure never changes the processing outcome', async () => {
    const db = openLocalDb(':memory:');
    const store = new PostTurnStore(db, { maxAttempts: 3 });
    const worker = new PostTurnWorker({
      store,
      extract: vi.fn(async () => ({ pages: [] })),
      apply: vi.fn(),
      emitObservability: () => {
        throw new Error('sink down');
      },
    } as never);
    const { key } = store.enqueue(baseInput('turn_throw'), JOB_NOW);
    await expect(worker.processKey(key, { ignoreSchedule: true })).resolves.toMatchObject({
      state: 'skipped_not_durable',
    });
    db.close();
  });

  it('⑨ through the REAL outbox: enqueue validates against the union and dedupes on the same idempotencyKey', () => {
    const store = new MemoryStore({ dbPath: ':memory:', workspaceId: 'ws_x', deviceId: 'dev_1' });
    store.open();
    const outbox = new MemoryOutbox({ store });
    const envelope = {
      eventId: 'ev_extract_1',
      schemaVersion: 1,
      eventType: 'extract.done',
      workspaceId: 'ws_x',
      actorImUserId: 'agent_1',
      actorKind: 'agent',
      deviceId: 'dev_1',
      createdAt: new Date().toISOString(),
      idempotencyKey: 'obs:extract.done:job1:1:applied',
      metadataJson: { outcome: 'applied', pages: 2 },
      metricsJson: { outcome: 'applied' },
    };
    const first = outbox.enqueue(envelope);
    expect(first.deadLetter).toBeFalsy();
    const second = outbox.enqueue(envelope);
    expect(second.id).toBe(first.id);
    const rows = store
      .rawDb()
      .prepare('SELECT COUNT(*) AS n FROM memory_outbox WHERE eventType = ?')
      .get('extract.done') as { n: number };
    expect(rows.n).toBe(1);
    store.close();
  });
});
