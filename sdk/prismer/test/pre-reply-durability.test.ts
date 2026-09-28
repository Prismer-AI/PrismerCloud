import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalDb } from '../src/sync/store.js';
import {
  canonicalDurabilityCommitKey,
  resolveCanonicalTurnIdentity,
} from '../src/adapters/coding/shared/lifecycle/canonical-turn-identity.js';
import {
  PostTurnStore,
  type PostTurnPageReceipt,
} from '../src/adapters/coding/shared/lifecycle/post-turn-store.js';
import { PostTurnWorker } from '../src/adapters/coding/shared/lifecycle/post-turn-worker.js';
import {
  DurabilityCommitStore,
  PreReplyDurabilityBarrier,
  resolveBarrierTimeoutMs,
} from '../src/adapters/coding/shared/lifecycle/pre-reply-durability.js';
import { MemoryRuntime } from '../src/daemon/memory/runtime.js';
import { ExtractedPageApplicator } from '../src/daemon/memory/extracted-page-applicator.js';
import type { ExtractedPage } from '../src/daemon/memory/extract.js';

describe('canonical terminal identity', () => {
  it('maps a provider api_* run onto the cloud run_* turn', () => {
    expect(
      resolveCanonicalTurnIdentity({
        taskId: 'run_cloud_1',
        runId: 'run_cloud_1',
        providerTurnId: 'api_provider_9',
      }),
    ).toEqual({
      canonicalTurnId: 'run_cloud_1',
      runId: 'run_cloud_1',
      providerTurnId: 'api_provider_9',
    });
  });

  it('uses one commit key for explicit, pre-reply, and async observations of the same turn', () => {
    const identity = {
      workspaceId: 'ws_test',
      agentImUserId: 'agent_1',
      canonicalTurnId: 'run_cloud_1',
    };
    expect(new Set(['explicit', 'pre-reply', 'async-repair'].map(() => canonicalDurabilityCommitKey(identity))).size).toBe(1);
  });

  it('merges a later explicit receipt into the existing canonical repair row', () => {
    const db = openLocalDb(':memory:');
    const store = new PostTurnStore(db);
    const input = postTurnInput();
    const first = store.enqueue(input);
    const second = store.enqueue({
      ...input,
      lane: 'explicit',
      explicitMemoryReceipts: [
        { pageId: 'page_explicit', path: 'decisions/explicit.pkf', version: 2, contentHash: 'hash_explicit' },
      ],
    });

    expect(second).toEqual({ key: first.key, inserted: false });
    expect(store.get(first.key)).toMatchObject({
      lane: 'explicit',
      payload: {
        explicitMemoryReceipts: [
          { pageId: 'page_explicit', path: 'decisions/explicit.pkf', version: 2, contentHash: 'hash_explicit' },
        ],
      },
    });
    db.close();
  });
});

describe('pre-reply durability barrier', () => {
  const cleanup: string[] = [];
  const confirmAuthoritative = async ({ receipts }: { receipts: PostTurnPageReceipt[] }): Promise<PostTurnPageReceipt[]> =>
    receipts;

  afterEach(() => {
    cleanup.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  it('persists one authoritative Page receipt before reply and replays all lanes without another revision', async () => {
    const rig = makeRig(cleanup);
    const extract = vi.fn(async () => ({ pages: [PAGE] }));
    const worker = makeWorker(rig, extract);
    const barrier = new PreReplyDurabilityBarrier({
      store: rig.postTurnStore,
      worker,
      commits: rig.commits,
      confirmAuthoritative,
      timeoutMs: 1_000,
    });

    const first = await barrier.run(barrierInput());
    const replay = await barrier.run({ ...barrierInput(), lane: 'explicit' });
    rig.postTurnStore.enqueue({ ...postTurnInput(), lane: 'async-repair' });
    await worker.processKey(first.postTurnKey);

    expect(first).toMatchObject({
      state: 'persisted',
      canonicalTurnId: 'run_cloud_1',
      conversationId: 'conv_1',
      runId: 'run_cloud_1',
      messageId: 'msg_1',
      profileId: 'profile_1',
      model: 'deepseek-v4-flash',
      provider: 'prismer-gateway',
      receipts: [
        {
          path: 'decisions/runtime-control.pkf',
          version: 1,
          contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          pageId: expect.stringMatching(/^page_/),
        },
      ],
    });
    expect(first.replyCommittedAt).toEqual(expect.any(Number));
    expect(replay).toMatchObject({
      state: 'skipped_duplicate',
      commitKey: first.commitKey,
      receipts: [],
      duplicateOf: {
        state: 'persisted',
        receipts: first.receipts,
        replyCommittedAt: first.replyCommittedAt,
      },
    });
    expect(extract).toHaveBeenCalledOnce();
    expect(memoryCounts(rig.slot.store.rawDb())).toEqual({ pages: 1, versions: 1, outbox: 1, applies: 1 });
    expect(rig.commits.get(first.commitKey)).toMatchObject({
      state: 'persisted',
      replyCommittedAt: first.replyCommittedAt,
    });
    rig.close();
  });

  it('replays the frozen receipt after a runtime restart without extraction or another revision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pre-reply-restart-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'runtime.db');
    const memoryDir = join(dir, 'memory');
    const firstDb = openLocalDb(dbPath);
    const firstRuntime = new MemoryRuntime({ baseDir: memoryDir, deviceId: 'device_1' });
    const firstRig = {
      runtime: firstRuntime,
      slot: firstRuntime.resolve('ws_test'),
      db: firstDb,
      postTurnStore: new PostTurnStore(firstDb, { retryBaseMs: 0 }),
      commits: new DurabilityCommitStore(firstDb),
    };
    const firstExtract = vi.fn(async () => ({ pages: [PAGE] }));
    const firstBarrier = new PreReplyDurabilityBarrier({
      store: firstRig.postTurnStore,
      worker: makeWorker(firstRig as ReturnType<typeof makeRig>, firstExtract),
      commits: firstRig.commits,
      confirmAuthoritative,
      timeoutMs: 1_000,
    });
    const first = await firstBarrier.run(barrierInput());
    firstDb.close();
    firstRuntime.closeAll();

    const secondDb = openLocalDb(dbPath);
    const secondRuntime = new MemoryRuntime({ baseDir: memoryDir, deviceId: 'device_1' });
    const secondRig = {
      runtime: secondRuntime,
      slot: secondRuntime.resolve('ws_test'),
      db: secondDb,
      postTurnStore: new PostTurnStore(secondDb, { retryBaseMs: 0 }),
      commits: new DurabilityCommitStore(secondDb),
    };
    const secondExtract = vi.fn(async () => ({ pages: [PAGE] }));
    const secondBarrier = new PreReplyDurabilityBarrier({
      store: secondRig.postTurnStore,
      worker: makeWorker(secondRig as ReturnType<typeof makeRig>, secondExtract),
      commits: secondRig.commits,
      confirmAuthoritative,
      timeoutMs: 1_000,
    });

    const replay = await secondBarrier.run({ ...barrierInput(), lane: 'async-repair' });

    expect(replay).toMatchObject({
      state: 'skipped_duplicate',
      commitKey: first.commitKey,
      receipts: [],
      duplicateOf: {
        state: 'persisted',
        receipts: first.receipts,
        replyCommittedAt: first.replyCommittedAt,
      },
    });
    expect(secondExtract).not.toHaveBeenCalled();
    expect(memoryCounts(secondRig.slot.store.rawDb())).toEqual({ pages: 1, versions: 1, outbox: 1, applies: 1 });
    secondDb.close();
    secondRuntime.closeAll();
  });

  it('negative control: same canonical turn with different content fails closed without another revision', async () => {
    const rig = makeRig(cleanup);
    const extract = vi.fn(async () => ({ pages: [PAGE] }));
    const worker = makeWorker(rig, extract);
    const barrier = new PreReplyDurabilityBarrier({
      store: rig.postTurnStore,
      worker,
      commits: rig.commits,
      confirmAuthoritative,
      timeoutMs: 1_000,
    });

    const first = await barrier.run(barrierInput());
    const conflict = await barrier.run({
      ...barrierInput(),
      assistantResponse: 'DIFFERENT terminal content under the same canonical turn id.',
    });

    expect(first.state).toBe('persisted');
    expect(conflict).toMatchObject({
      state: 'terminal_failure',
      receipts: [],
      error: { code: 'memory_idempotency_conflict' },
    });
    expect(extract).toHaveBeenCalledOnce();
    expect(memoryCounts(rig.slot.store.rawDb())).toEqual({ pages: 1, versions: 1, outbox: 1, applies: 1 });
    rig.close();
  });

  it('reopens a no-provider durability failure for the same cloud task after routing evidence is repaired', async () => {
    const rig = makeRig(cleanup);
    const retryResponse = 'The repaired gateway produced a fresh terminal response for the same task.';
    const extract = vi.fn(async (job) => {
      expect(job.payload.assistantResponse).toBe(retryResponse);
      return { pages: [PAGE] };
    });
    const worker = makeWorker(rig, extract);
    const barrier = new PreReplyDurabilityBarrier({
      store: rig.postTurnStore,
      worker,
      commits: rig.commits,
      confirmAuthoritative,
      timeoutMs: 1_000,
    });

    const failed = await barrier.run({
      ...barrierInput(),
      provider: undefined,
      assistantResponse: 'The first attempt generated text before routing evidence was available.',
    });
    const recovered = await barrier.run({
      ...barrierInput(),
      assistantResponse: retryResponse,
    });

    expect(failed).toMatchObject({
      state: 'terminal_failure',
      receipts: [],
      error: { code: 'memory_identity_invalid' },
    });
    expect(recovered).toMatchObject({
      state: 'persisted',
      commitKey: failed.commitKey,
      receipts: [
        {
          path: 'decisions/runtime-control.pkf',
          version: 1,
          contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
    });
    expect(extract).toHaveBeenCalledOnce();
    expect(rig.postTurnStore.get(recovered.postTurnKey)).toMatchObject({
      status: 'completed',
      payload: {
        assistantResponse: retryResponse,
        executionContext: {
          model: 'deepseek-v4-flash',
          provider: 'prismer-gateway',
          routingEvidenceSource: 'adapter',
        },
      },
    });
    expect(memoryCounts(rig.slot.store.rawDb())).toEqual({ pages: 1, versions: 1, outbox: 1, applies: 1 });
    rig.close();
  });

  it('negative control: same canonical turn and content cannot be rebound to a different target Page', async () => {
    const rig = makeRig(cleanup);
    const extract = vi.fn(async () => ({ pages: [PAGE] }));
    const worker = makeWorker(rig, extract);
    const barrier = new PreReplyDurabilityBarrier({
      store: rig.postTurnStore,
      worker,
      commits: rig.commits,
      confirmAuthoritative,
      timeoutMs: 1_000,
    });
    const firstTarget = {
      pageId: 'page_a',
      path: 'decisions/target-a.pkf',
      version: 1,
      contentHash: 'hash_a',
    };
    const secondTarget = {
      pageId: 'page_b',
      path: 'decisions/target-b.pkf',
      version: 1,
      contentHash: 'hash_b',
    };

    const first = await barrier.run({
      ...barrierInput(),
      lane: 'explicit',
      explicitMemoryReceipts: [firstTarget],
    });
    const conflict = await barrier.run({
      ...barrierInput(),
      lane: 'explicit',
      explicitMemoryReceipts: [secondTarget],
    });

    expect(first).toMatchObject({ state: 'persisted', targetPageKey: firstTarget.path });
    expect(conflict).toMatchObject({
      state: 'terminal_failure',
      targetPageKey: secondTarget.path,
      receipts: [],
      error: { code: 'memory_idempotency_conflict' },
    });
    expect(extract).not.toHaveBeenCalled();
    expect(rig.commits.get(first.commitKey)).toMatchObject({
      state: 'persisted',
      targetPageKey: firstTarget.path,
      receipts: [firstTarget],
    });
    expect(memoryCounts(rig.slot.store.rawDb())).toEqual({ pages: 0, versions: 0, outbox: 0, applies: 0 });
    rig.close();
  });

  it('accepts an explicit memory_write receipt without invoking automatic extraction', async () => {
    const rig = makeRig(cleanup);
    const extract = vi.fn(async () => ({ pages: [PAGE] }));
    const worker = makeWorker(rig, extract);
    rig.postTurnStore.enqueue({
      ...postTurnInput(),
      lane: 'explicit',
      explicitMemoryReceipts: [
        { pageId: 'page_written', path: 'decisions/written.pkf', version: 4, contentHash: 'hash_written' },
      ],
    });
    const barrier = new PreReplyDurabilityBarrier({
      store: rig.postTurnStore,
      worker,
      commits: rig.commits,
      confirmAuthoritative,
      timeoutMs: 1_000,
    });

    const result = await barrier.run(barrierInput());

    expect(result).toMatchObject({
      state: 'persisted',
      receipts: [
        { pageId: 'page_written', path: 'decisions/written.pkf', version: 4, contentHash: 'hash_written' },
      ],
    });
    expect(extract).not.toHaveBeenCalled();
    expect(memoryCounts(rig.slot.store.rawDb())).toEqual({ pages: 0, versions: 0, outbox: 0, applies: 0 });
    rig.close();
  });

  it('consumes a daemon-staged explicit receipt when the provider hook loses its in-process buffer', async () => {
    const rig = makeRig(cleanup);
    const extract = vi.fn(async () => ({ pages: [PAGE] }));
    const worker = makeWorker(rig, extract);
    const receipt = {
      pageId: 'page_section_written',
      path: 'decisions/section-written.pkf',
      version: 7,
      contentHash: 'hash_section_written',
      authority: 'cloud' as const,
    };
    rig.commits.stageExplicitReceipt({
      workspaceId: 'ws_test',
      agentSubject: 'agent_1',
      canonicalTurnId: 'run_cloud_1',
      receipt,
    });
    const barrier = new PreReplyDurabilityBarrier({
      store: rig.postTurnStore,
      worker,
      commits: rig.commits,
      confirmAuthoritative,
      timeoutMs: 1_000,
    });

    const result = await barrier.run(barrierInput());

    expect(result).toMatchObject({ state: 'persisted', receipts: [receipt] });
    expect(extract).not.toHaveBeenCalled();
    expect(memoryCounts(rig.slot.store.rawDb())).toEqual({ pages: 0, versions: 0, outbox: 0, applies: 0 });
    rig.close();
  });

  it('does not report persisted until the authoritative writer confirms the exact Page receipt', async () => {
    const rig = makeRig(cleanup);
    const order: string[] = [];
    const worker = makeWorker(rig, async () => {
      order.push('extract');
      return { pages: [PAGE] };
    });
    const confirmAuthoritative = vi.fn(async ({ receipts }: { receipts: PostTurnPageReceipt[] }) => {
      order.push('authority-acked');
      expect(receipts).toHaveLength(1);
      const inFlight = rig.commits.get(canonicalDurabilityCommitKey({
        workspaceId: 'ws_test',
        agentImUserId: 'agent_1',
        canonicalTurnId: 'run_cloud_1',
      }));
      expect(inFlight?.state).toBe('writing');
      expect(inFlight?.replyCommittedAt).toBeUndefined();
      return receipts.map((receipt) => ({ ...receipt, version: 5, authority: 'cloud' as const }));
    });
    const barrier = new PreReplyDurabilityBarrier({
      store: rig.postTurnStore,
      worker,
      commits: rig.commits,
      confirmAuthoritative,
      timeoutMs: 1_000,
    });

    const result = await barrier.run(barrierInput());
    order.push('barrier-returned');

    expect(result).toMatchObject({
      state: 'persisted',
      receipts: [{ version: 5, authority: 'cloud' }],
    });
    expect(confirmAuthoritative).toHaveBeenCalledOnce();
    expect(order).toEqual(['extract', 'authority-acked', 'barrier-returned']);
    rig.close();
  });

  it('freezes a retryable failure when the local Page exists but authority has not acked it', async () => {
    const rig = makeRig(cleanup);
    const worker = makeWorker(rig, async () => ({ pages: [PAGE] }));
    const barrier = new PreReplyDurabilityBarrier({
      store: rig.postTurnStore,
      worker,
      commits: rig.commits,
      confirmAuthoritative: async () => {
        throw new Error('memory_authority_pending');
      },
      timeoutMs: 1_000,
    });

    const result = await barrier.run(barrierInput());
    const replay = await barrier.run({ ...barrierInput(), lane: 'async-repair' });

    expect(result).toMatchObject({
      state: 'retryable_failure',
      receipts: [],
      error: { code: 'memory_write_retryable', message: 'memory_authority_pending' },
      replyCommittedAt: expect.any(Number),
    });
    expect(replay).toMatchObject({
      state: 'retryable_failure',
      receipts: [],
      error: { code: 'memory_write_retryable' },
      duplicateOf: { state: 'retryable_failure', receipts: [] },
    });
    expect(memoryCounts(rig.slot.store.rawDb())).toEqual({ pages: 1, versions: 1, outbox: 1, applies: 1 });
    expect(rig.commits.get(result.commitKey)).toMatchObject({
      state: 'retryable_failure',
      replyCommittedAt: result.replyCommittedAt,
    });
    rig.close();
  });

  it('projects a permanent Cloud authority rejection as terminal failure', async () => {
    const rig = makeRig(cleanup);
    const worker = makeWorker(rig, async () => ({ pages: [PAGE] }));
    const barrier = new PreReplyDurabilityBarrier({
      store: rig.postTurnStore,
      worker,
      commits: rig.commits,
      confirmAuthoritative: async () => {
        throw Object.assign(new Error('Cloud rejected the exact Page event'), {
          code: 'memory_authority_rejected',
          retryable: false,
        });
      },
      timeoutMs: 1_000,
    });

    await expect(barrier.run(barrierInput())).resolves.toMatchObject({
      state: 'terminal_failure',
      receipts: [],
      error: {
        code: 'memory_authority_rejected',
        message: 'Cloud rejected the exact Page event',
      },
    });
    await expect(barrier.run({ ...barrierInput(), lane: 'explicit' })).resolves.toMatchObject({
      state: 'terminal_failure',
      receipts: [],
      duplicateOf: { state: 'terminal_failure', receipts: [] },
    });
    rig.close();
  });

  it('suppresses auto-apply when an explicit receipt arrives during extraction', async () => {
    const rig = makeRig(cleanup);
    let releaseExtraction!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseExtraction = resolve; });
    const worker = makeWorker(rig, async () => {
      markStarted();
      await blocked;
      return { pages: [PAGE] };
    });
    const inserted = rig.postTurnStore.enqueue(postTurnInput());
    const processing = worker.processKey(inserted.key);
    await started;
    rig.postTurnStore.enqueue({
      ...postTurnInput(),
      lane: 'explicit',
      explicitMemoryReceipts: [
        { pageId: 'page_race', path: 'decisions/race.pkf', version: 2, contentHash: 'hash_race' },
      ],
    });
    releaseExtraction();

    await expect(processing).resolves.toMatchObject({
      state: 'persisted',
      receipts: [{ pageId: 'page_race', path: 'decisions/race.pkf', version: 2, contentHash: 'hash_race' }],
    });
    expect(memoryCounts(rig.slot.store.rawDb())).toEqual({ pages: 0, versions: 0, outbox: 0, applies: 0 });
    rig.close();
  });

  it('records missing conversation/message identity as terminal failure instead of completed', async () => {
    const rig = makeRig(cleanup);
    const extract = vi.fn(async () => ({ pages: [PAGE] }));
    const worker = makeWorker(rig, extract);
    const barrier = new PreReplyDurabilityBarrier({
      store: rig.postTurnStore,
      worker,
      commits: rig.commits,
      confirmAuthoritative,
      timeoutMs: 1_000,
    });

    const result = await barrier.run({
      ...barrierInput(),
      conversationId: undefined,
      messageId: undefined,
    });

    expect(result).toMatchObject({
      state: 'terminal_failure',
      error: { code: 'memory_identity_invalid' },
    });
    expect(extract).not.toHaveBeenCalled();
    expect(rig.postTurnStore.get(result.postTurnKey)?.status).toBe('dead_letter');
    expect(rig.postTurnStore.get(result.postTurnKey)?.lastError).toContain('no_conversation_id');
    expect(memoryCounts(rig.slot.store.rawDb()).pages).toBe(0);
    rig.close();
  });

  it('negative control: terminal model without the actual served provider fails the same identity journey', async () => {
    const rig = makeRig(cleanup);
    const extract = vi.fn(async () => ({ pages: [PAGE] }));
    const barrier = new PreReplyDurabilityBarrier({
      store: rig.postTurnStore,
      worker: makeWorker(rig, extract),
      commits: rig.commits,
      confirmAuthoritative,
      timeoutMs: 1_000,
    });

    const result = await barrier.run({ ...barrierInput(), provider: undefined });

    expect(result).toMatchObject({
      model: 'deepseek-v4-flash',
      state: 'terminal_failure',
      receipts: [],
      error: {
        code: 'memory_identity_invalid',
        message: expect.stringContaining('no_provider'),
      },
    });
    expect(result).not.toHaveProperty('provider');
    expect(extract).not.toHaveBeenCalled();
    expect(rig.postTurnStore.get(result.postTurnKey)).toMatchObject({
      status: 'dead_letter',
      lastError: expect.stringContaining('no_provider'),
    });
    expect(memoryCounts(rig.slot.store.rawDb())).toEqual({ pages: 0, versions: 0, outbox: 0, applies: 0 });
    rig.close();
  });

  it('classifies a real zero-page extraction as not durable with zero writes', async () => {
    const rig = makeRig(cleanup);
    const extract = vi.fn(async () => ({ pages: [] }));
    const worker = makeWorker(rig, extract);
    const barrier = new PreReplyDurabilityBarrier({
      store: rig.postTurnStore,
      worker,
      commits: rig.commits,
      confirmAuthoritative,
      timeoutMs: 1_000,
    });

    const result = await barrier.run(barrierInput());

    expect(result).toMatchObject({ state: 'skipped_not_durable', receipts: [] });
    expect(extract).toHaveBeenCalledOnce();
    expect(memoryCounts(rig.slot.store.rawDb())).toEqual({ pages: 0, versions: 0, outbox: 0, applies: 0 });
    rig.close();
  });

  it('returns a bounded retryable timeout and never relabels the original reply when async repair later succeeds', async () => {
    const rig = makeRig(cleanup);
    let first = true;
    const extract = vi.fn(async (_job, signal?: AbortSignal) => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('aborted by barrier');
      }
      return { pages: [PAGE] };
    });
    const worker = makeWorker(rig, extract);
    const barrier = new PreReplyDurabilityBarrier({
      store: rig.postTurnStore,
      worker,
      commits: rig.commits,
      confirmAuthoritative,
      timeoutMs: 10,
    });

    const result = await barrier.run(barrierInput());
    expect(result).toMatchObject({
      state: 'retryable_failure',
      error: { code: 'memory_barrier_timeout' },
      timeoutMs: 10,
    });
    expect(memoryCounts(rig.slot.store.rawDb()).pages).toBe(0);

    await worker.processKey(result.postTurnKey, { ignoreSchedule: true });
    expect(memoryCounts(rig.slot.store.rawDb()).pages).toBe(1);
    expect(rig.commits.get(result.commitKey)).toMatchObject({
      state: 'retryable_failure',
      replyCommittedAt: result.replyCommittedAt,
    });
    rig.close();
  });

  it('joins a background claim of the same canonical turn instead of false-failing the reply', async () => {
    const rig = makeRig(cleanup);
    let releaseExtraction!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseExtraction = resolve; });
    const worker = makeWorker(rig, async () => {
      markStarted();
      await blocked;
      return { pages: [PAGE] };
    });
    rig.postTurnStore.enqueue(postTurnInput());
    const background = worker.drainOnce();
    await started;
    const barrier = new PreReplyDurabilityBarrier({
      store: rig.postTurnStore,
      worker,
      commits: rig.commits,
      confirmAuthoritative,
      timeoutMs: 1_000,
    });
    const pendingReply = barrier.run(barrierInput());
    releaseExtraction();

    await expect(pendingReply).resolves.toMatchObject({ state: 'persisted' });
    await background;
    expect(memoryCounts(rig.slot.store.rawDb())).toEqual({ pages: 1, versions: 1, outbox: 1, applies: 1 });
    rig.close();
  });

  it('returns at the configured bound when a joined background claim cannot be aborted', async () => {
    const rig = makeRig(cleanup);
    let releaseExtraction!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseExtraction = resolve; });
    const worker = makeWorker(rig, async () => {
      markStarted();
      await blocked;
      return { pages: [PAGE] };
    });
    rig.postTurnStore.enqueue(postTurnInput());
    const background = worker.drainOnce();
    await started;
    const barrier = new PreReplyDurabilityBarrier({
      store: rig.postTurnStore,
      worker,
      commits: rig.commits,
      confirmAuthoritative,
      timeoutMs: 10,
    });
    const releaseLater = setTimeout(releaseExtraction, 100);
    const start = Date.now();

    const result = await barrier.run(barrierInput());

    expect(result.state).toBe('retryable_failure');
    expect(result.error?.code).toBe('memory_barrier_timeout');
    expect(Date.now() - start).toBeLessThan(80);
    clearTimeout(releaseLater);
    releaseExtraction();
    await background;
    rig.close();
  });
});

const PAGE: ExtractedPage = {
  path: 'decisions/runtime-control.pkf',
  title: 'Runtime control plane',
  content: '# Runtime control plane\n\nRuntime owns terminal lifecycle reliability.',
  placement: 'new',
  pageType: 'leaf',
  visibility: 'workspace',
};

function postTurnInput() {
  return {
    workspaceId: 'ws_test',
    agentImUserId: 'agent_1',
    conversationId: 'conv_1',
    runId: 'run_cloud_1',
    messageId: 'msg_1',
    canonicalTurnId: 'run_cloud_1',
    turnId: 'api_provider_9',
    lane: 'pre-reply' as const,
    terminalState: 'completed' as const,
    userMessage: 'Remember this durable architecture ownership decision for future work.',
    assistantResponse: 'The runtime owns terminal lifecycle reliability and bounded durability before reply.',
    toolFailures: [],
    executionContext: {
      adapterName: 'hermes',
      profileId: 'profile_1',
      profileName: 'team-manager',
      roleSlug: 'team-manager',
      model: 'deepseek-v4-flash',
      provider: 'prismer-gateway',
      routingEvidenceSource: 'adapter' as const,
      proxyProvider: 'default',
      providerTurnId: 'api_provider_9',
    },
  };
}

describe('pre-reply durability barrier env budget hot-resolve', () => {
  const cleanup: string[] = [];
  const confirmAuthoritative = async ({ receipts }: { receipts: PostTurnPageReceipt[] }): Promise<PostTurnPageReceipt[]> =>
    receipts;

  afterEach(() => {
    cleanup.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  it('re-reads PRISMER_MEMORY_BARRIER_TIMEOUT_MS per run, not only at construction', async () => {
    const rig = makeRig(cleanup);
    // No explicit timeoutMs → budget derives from env at resolve time.
    const barrier = new PreReplyDurabilityBarrier({
      store: rig.postTurnStore,
      // Never settles: the run must be cut off by the barrier timeout itself.
      worker: { processKey: () => new Promise(() => {}) },
      commits: rig.commits,
      confirmAuthoritative,
    });
    // The daemon is a long-lived process: the singleton barrier was built at
    // boot with the 120s default. A ConfigDelivery env update (e.g. 30000)
    // must bind to the NEXT run, not require a daemon restart.
    const prev = process.env.PRISMER_MEMORY_BARRIER_TIMEOUT_MS;
    process.env.PRISMER_MEMORY_BARRIER_TIMEOUT_MS = '80';
    try {
      const started = Date.now();
      const result = await barrier.run(barrierInput());
      const elapsed = Date.now() - started;
      expect(result.state).toBe('retryable_failure');
      expect(result.error?.code).toBe('memory_barrier_timeout');
      expect(elapsed).toBeLessThan(4_000);
    } finally {
      if (prev === undefined) delete process.env.PRISMER_MEMORY_BARRIER_TIMEOUT_MS;
      else process.env.PRISMER_MEMORY_BARRIER_TIMEOUT_MS = prev;
      rig.close();
    }
  }, 10_000);
});

function barrierInput() {
  return {
    ...postTurnInput(),
    profileId: 'profile_1',
    profileName: 'team-manager',
    model: 'deepseek-v4-flash',
    provider: 'prismer-gateway',
  };
}

function makeRig(cleanup: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'pre-reply-durability-'));
  cleanup.push(dir);
  const runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'device_1' });
  const slot = runtime.resolve('ws_test');
  const db = openLocalDb(':memory:');
  const postTurnStore = new PostTurnStore(db, { retryBaseMs: 0 });
  const commits = new DurabilityCommitStore(db);
  return {
    runtime,
    slot,
    db,
    postTurnStore,
    commits,
    close: () => {
      db.close();
      runtime.closeAll();
    },
  };
}

function makeWorker(
  rig: ReturnType<typeof makeRig>,
  extract: (job: any, signal?: AbortSignal) => Promise<{ pages: ExtractedPage[] }>,
) {
  const applicator = new ExtractedPageApplicator(rig.slot);
  return new PostTurnWorker(
    {
      store: rig.postTurnStore,
      extract,
      apply: (job, result, resultHash) =>
        applicator.applyAll(result.pages, {
          postTurnKey: job.idempotencyKey,
          commitKey: canonicalDurabilityCommitKey({
            workspaceId: job.workspaceId,
            agentImUserId: job.agentImUserId,
            canonicalTurnId: job.canonicalTurnId,
          }),
          resultHash,
          workspaceId: job.workspaceId,
          agentImUserId: job.agentImUserId,
          ...(job.conversationId ? { conversationId: job.conversationId } : {}),
          turnId: job.canonicalTurnId,
          deviceId: 'device_1',
        }),
    },
    { now: () => Date.now() },
  );
}

function memoryCounts(db: import('better-sqlite3').Database) {
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    pages: count('memory_pages'),
    versions: count('memory_page_versions'),
    outbox: count('memory_outbox'),
    applies: count('memory_post_turn_applies'),
  };
}

describe('barrier timeout budget (TDD)', () => {
  const prevBarrier = process.env.PRISMER_MEMORY_BARRIER_TIMEOUT_MS;
  const prevExtract = process.env.MEMORY_EXTRACT_TIMEOUT_MS;
  afterEach(() => {
    if (prevBarrier === undefined) delete process.env.PRISMER_MEMORY_BARRIER_TIMEOUT_MS;
    else process.env.PRISMER_MEMORY_BARRIER_TIMEOUT_MS = prevBarrier;
    if (prevExtract === undefined) delete process.env.MEMORY_EXTRACT_TIMEOUT_MS;
    else process.env.MEMORY_EXTRACT_TIMEOUT_MS = prevExtract;
  });

  it('defaults to 120s (extraction gateway budget) when both env knobs are unset', () => {
    delete process.env.PRISMER_MEMORY_BARRIER_TIMEOUT_MS;
    delete process.env.MEMORY_EXTRACT_TIMEOUT_MS;
    expect(resolveBarrierTimeoutMs()).toBe(120_000);
  });

  it('derives from MEMORY_EXTRACT_TIMEOUT_MS when the barrier knob is unset — never below the extraction budget', () => {
    delete process.env.PRISMER_MEMORY_BARRIER_TIMEOUT_MS;
    process.env.MEMORY_EXTRACT_TIMEOUT_MS = '90000';
    expect(resolveBarrierTimeoutMs()).toBe(90_000);
  });

  it('explicit barrier knob wins over the extraction budget', () => {
    process.env.PRISMER_MEMORY_BARRIER_TIMEOUT_MS = '30000';
    process.env.MEMORY_EXTRACT_TIMEOUT_MS = '120_000';
    expect(resolveBarrierTimeoutMs()).toBe(30_000);
  });

  it('constructor override (deps.timeoutMs) wins over env', () => {
    process.env.PRISMER_MEMORY_BARRIER_TIMEOUT_MS = '30000';
    expect(resolveBarrierTimeoutMs(5_000)).toBe(5_000);
  });
});
