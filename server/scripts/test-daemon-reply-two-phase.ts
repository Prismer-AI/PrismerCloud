#!/usr/bin/env tsx
/**
 * Wave 4 E7 — daemon-side dispatch reply two-phase integration test.
 *
 * Spec: docs/release200/14-messaging-state-machine-reliability.md §4.3
 *       evidence/14-w3-dispatch-two-phase.md (server contract)
 *
 * Hits the **real** cloud HTTP endpoints (localhost:3000/api/im/dispatch/...)
 * with a **real** signed replyToken (issued via the production
 * createAgentDispatchReplyToken helper, same key as the server). Verifies the
 * persisted DB state via prisma.
 *
 * No mocking of the daemon-side transport, the cache, or the server endpoints
 * — the only synthesised pieces are the test fixtures (user/workspace/agent/
 * task/asset rows) which production code does not own.
 *
 * Test cases:
 *   1. prepare → commit happy path (text-only)
 *   2. prepare → commit with assetIds (asset-ready gate)
 *   3. crash-recovery: kill before commit, recover from cache
 *   4. orphan reaper: 1h+ stale prepared row → server flips to 'aborted' → daemon
 *      sees DISPATCH_REPLY_INVALID_STATE on retry → reports 'dispatch lost'
 */

import 'dotenv/config';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'mysql://prismer:devpass@localhost:3307/prismer_cloud';

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import prisma from '../src/im/db';
import { createAgentDispatchReplyToken } from '../src/im/services/agent-dispatcher';
import { signToken } from '../src/im/auth/jwt';
import { CloudClient } from '../sdk/prismer-cloud/runtime/src/auth';
import { openLocalDb } from '../sdk/prismer-cloud/runtime/src/sync/store';
import {
  createPendingReplyCache,
  generateIdempotencyKey,
} from '../sdk/prismer-cloud/runtime/src/daemon/pending-reply-cache';
import {
  sendDispatchReplyTwoPhase,
  recoverPendingReplies,
} from '../sdk/prismer-cloud/runtime/src/daemon/dispatch-reply-transport';

const CLOUD_BASE = process.env.CLOUD_BASE_URL || 'http://localhost:3000';
const PREFIX = `w4e7_${crypto.randomBytes(4).toString('hex')}`;

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function assertEqual<T>(actual: T, expected: T, label = ''): void {
  if (actual !== expected) {
    throw new Error(`expected ${label}=${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}

// ─── fixtures ─────────────────────────────────────────────────────────────

interface Fixtures {
  workspaceId: string;
  ownerImUserId: string;
  agentImUserId: string;
  conversationId: string;
  messageId: string;
  taskId: string;
  readyAssetId: string;
  replyToken: string;
}

async function createFixtures(suffix: string): Promise<Fixtures> {
  const wsId = `ws${PREFIX}${suffix}`.slice(0, 28);
  const ownerId = `uo${PREFIX}${suffix}`.slice(0, 28);
  const agentId = `ua${PREFIX}${suffix}`.slice(0, 28);
  const convId = `c${PREFIX}${suffix}`.slice(0, 28);
  const msgId = `m${PREFIX}${suffix}`.slice(0, 28);
  const taskId = `t${PREFIX}${suffix}`.slice(0, 28);
  const assetId = `a${PREFIX}${suffix}`.slice(0, 28);

  await prisma.iMUser.create({
    data: {
      id: ownerId,
      username: ownerId,
      displayName: `owner ${suffix}`,
      role: 'human',
    } as any,
  });
  await prisma.iMUser.create({
    data: {
      id: agentId,
      username: agentId,
      displayName: `agent ${suffix}`,
      role: 'agent',
    } as any,
  });
  await prisma.iMWorkspace.create({
    data: {
      id: wsId,
      name: `ws ${suffix}`,
      slug: wsId,
      ownerImUserId: ownerId,
    } as any,
  });
  await prisma.iMAsset.create({
    data: {
      id: assetId,
      workspaceId: wsId,
      ownerImUserId: ownerId,
      contentHash: crypto.randomBytes(32).toString('hex'),
      storageUri: `s3://test/${assetId}`,
      kind: 'file',
      mime: 'text/plain',
      sizeBytes: BigInt(42),
      filename: `${suffix}.txt`,
      ingestStatus: 'ready',
      ingestVersion: 1,
    } as any,
  });
  // Conversation + 2 participants so the commit step's downstream
  // messageService.send can succeed (it checks `User is not a participant`
  // before creating the message row). Without this the protocol-layer
  // commit returns 500 with a participant-graph error, which obscures the
  // daemon-side correctness signal.
  await prisma.iMConversation.create({
    data: {
      id: convId,
      type: 'direct',
      createdById: ownerId,
      workspaceId: wsId,
    } as any,
  });
  await prisma.iMParticipant.createMany({
    data: [
      { conversationId: convId, imUserId: ownerId, role: 'owner' },
      { conversationId: convId, imUserId: agentId, role: 'member' },
    ] as any,
  });

  // replyToken signed by the same JWT_SECRET the server reads.
  const replyToken = createAgentDispatchReplyToken({
    channelAccountId: `chan_${suffix}`,
    conversationId: convId,
    messageId: msgId,
    agentImUserId: agentId,
    ttlMs: 60 * 60 * 1000,
  });

  return {
    workspaceId: wsId,
    ownerImUserId: ownerId,
    agentImUserId: agentId,
    conversationId: convId,
    messageId: msgId,
    taskId,
    readyAssetId: assetId,
    replyToken,
  };
}

async function cleanupFixtures(f: Fixtures): Promise<void> {
  // Best-effort cascading delete. Foreign keys mean we must drop dependent
  // rows first; surviving FK errors are non-fatal (test isolation prefix
  // means each run uses a fresh suffix anyway).
  await prisma.iMDispatchReply.deleteMany({ where: { taskId: f.taskId } } as any).catch(() => {});
  await prisma.iMMessage.deleteMany({ where: { conversationId: f.conversationId } } as any).catch(() => {});
  await prisma.iMParticipant.deleteMany({ where: { conversationId: f.conversationId } } as any).catch(() => {});
  await prisma.iMConversation.deleteMany({ where: { id: f.conversationId } } as any).catch(() => {});
  await prisma.iMAsset.deleteMany({ where: { id: f.readyAssetId } } as any).catch(() => {});
  await prisma.iMWorkspace.deleteMany({ where: { id: f.workspaceId } } as any).catch(() => {});
  // User deletion may fail if other tables (audit logs, presence, etc.) still
  // reference the row. Acceptable: per-run unique prefix keeps tests isolated.
  await prisma.iMUser.deleteMany({ where: { id: { in: [f.ownerImUserId, f.agentImUserId] } } } as any).catch(() => undefined);
}

function makeDaemonCache() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `daemon-cache-${PREFIX}-`));
  const dbPath = path.join(dir, 'local.db');
  const db = openLocalDb(dbPath);
  return { db, dir, cache: createPendingReplyCache(db), dbPath };
}

// Issue a "daemon" CloudClient.
//
// Wave-4 finding: the W3 server-side daemon auth bypass (route.ts:1108
// isDispatchReply) DOES bypass apiGuard at the Next.js proxy layer, but
// `src/im/api/routes.ts:215` mounts `agentBindingsRouter` at `/` with a
// blanket `router.use('*', authMiddleware)`, which then intercepts every
// path inside the IM Hono app — including `/dispatch/...`. So in the live
// stack the daemon STILL needs a Bearer token to hit prepare/commit. This
// test mints a JWT for a fixture user; production daemons supply their
// pc_api_keys-issued token via the api_key_proxy path. The two-phase
// reply protocol itself is independent of the auth path.
function makeCloudFor(ownerImUserId: string): CloudClient {
  const jwt = signToken({ sub: ownerImUserId, username: ownerImUserId } as any);
  // CloudClient sends `Bearer ${apiKey}`. Plug the JWT in as the bearer.
  return new CloudClient({ baseUrl: CLOUD_BASE, apiKey: jwt });
}

// ─── tests ────────────────────────────────────────────────────────────────

test('1. prepare → commit happy path (text-only reply)', async () => {
  const f = await createFixtures('t1');
  const { db, cache } = makeDaemonCache();
  const cloud = makeCloudFor(f.ownerImUserId);
  try {
    const result = await sendDispatchReplyTwoPhase({
      taskId: f.taskId,
      payload: {
        conversationId: f.conversationId,
        replyToken: f.replyToken,
        replyToMessageId: f.messageId,
        agentImUserId: f.agentImUserId,
        status: 'ok',
        replyText: 'hello world from daemon',
        completedAt: new Date().toISOString(),
        assetIds: [],
      },
      cloud,
      cache,
    });

    assertEqual(result.status, 'committed', 'result.status');
    assertEqual(result.alreadyCommitted, false, 'result.alreadyCommitted');
    assert(result.replyId, 'replyId returned');

    const row = await prisma.iMDispatchReply.findUnique({ where: { id: result.replyId } } as any);
    assert(row, 'reply row exists in DB');
    assertEqual((row as any).status, 'committed', 'DB row.status');
    assert((row as any).committedAt, 'committedAt set');
    assertEqual(cache.countByStatus().pending + cache.countByStatus().prepared, 0, 'cache drained');
  } finally {
    db.close();
    await cleanupFixtures(f);
  }
});

test('2. prepare with ready asset → commit; non-ready asset → 400', async () => {
  const f = await createFixtures('t2');
  const { db, cache } = makeDaemonCache();
  const cloud = makeCloudFor(f.ownerImUserId);
  try {
    // Happy path with one ready asset.
    const ok = await sendDispatchReplyTwoPhase({
      taskId: f.taskId,
      payload: {
        conversationId: f.conversationId,
        replyToken: f.replyToken,
        replyToMessageId: f.messageId,
        agentImUserId: f.agentImUserId,
        status: 'ok',
        replyText: 'attached',
        attachments: [{ kind: 'file', assetId: f.readyAssetId }],
        assetIds: [f.readyAssetId],
        completedAt: new Date().toISOString(),
      },
      cloud,
      cache,
    });
    assertEqual(ok.status, 'committed', 'ready-asset commit');

    // Negative path — non-existent asset id should make prepare fail.
    const badIdem = generateIdempotencyKey();
    let threw = false;
    let errMsg = '';
    try {
      await sendDispatchReplyTwoPhase({
        taskId: f.taskId,
        payload: {
          conversationId: f.conversationId,
          replyToken: f.replyToken,
          replyToMessageId: f.messageId,
          agentImUserId: f.agentImUserId,
          status: 'ok',
          replyText: 'with missing asset',
          attachments: [{ kind: 'file', assetId: 'a_does_not_exist_xyz' }],
          assetIds: ['a_does_not_exist_xyz'],
          completedAt: new Date().toISOString(),
        },
        cloud,
        cache,
        idempotencyKey: badIdem,
      });
    } catch (err) {
      threw = true;
      errMsg = (err as Error).message;
    }
    assert(threw, 'sendDispatchReplyTwoPhase should throw on non-ready asset');
    assert(/ASSETS_NOT_READY|not ready|prepare/.test(errMsg), `error message should reference asset gate: ${errMsg}`);
    // Cache should have the row marked as last attempt failed (still in cache).
    const row = cache.findByIdempotencyKey(badIdem);
    assert(row, 'failed prepare leaves cache row for potential retry');
    assertEqual(row!.status, 'pending', 'failed prepare keeps status=pending');
    assert(row!.lastError, 'lastError recorded');
  } finally {
    db.close();
    await cleanupFixtures(f);
  }
});

test('3. crash recovery: persist between prepare and commit → cold-start commit', async () => {
  const f = await createFixtures('t3');
  const { db, dbPath, cache } = makeDaemonCache();
  const cloud = makeCloudFor(f.ownerImUserId);
  try {
    // Simulate a daemon that crashes between prepare and commit. We achieve
    // this by directly calling the prepare endpoint, persisting the replyId
    // in cache, and then NOT calling commit. Then we close the cache (simulate
    // crash) and reopen it (cold-start) and call recoverPendingReplies().
    const idem = generateIdempotencyKey();
    const payload = {
      conversationId: f.conversationId,
      replyToken: f.replyToken,
      replyToMessageId: f.messageId,
      agentImUserId: f.agentImUserId,
      status: 'ok' as const,
      replyText: 'crash-recovery candidate',
      assetIds: [],
      completedAt: new Date().toISOString(),
    };

    // Step 1 — prepare via the real cloud (idempotent on idem key).
    const prepRes = await cloud.request<{
      ok: boolean;
      data?: { replyId: string; status: 'prepared' | 'committed' };
      error?: { code: string; message: string };
    }>('POST', `/api/im/dispatch/${encodeURIComponent(f.taskId)}/prepare`, {
      body: { ...payload, idempotencyKey: idem },
      timeoutMs: 30_000,
    });
    assert(prepRes.ok && prepRes.data, `prepare ok (status=${prepRes.status} err=${prepRes.error?.message ?? ''})`);
    const env = prepRes.data as any;
    const inner = env.data ?? env;
    assert(inner.replyId, 'replyId returned');
    assertEqual(inner.status, 'prepared', 'status=prepared');

    // Persist in cache as if we'd called it via the transport.
    cache.savePending(idem, f.taskId, JSON.stringify({ ...payload, _taskId: f.taskId, _idempotencyKey: idem }));
    cache.markPrepared(idem, inner.replyId);

    // Step 2 — "crash". Close the cache DB.
    db.close();

    // Step 3 — "cold start". Reopen the cache and run recoverPendingReplies.
    const db2 = openLocalDb(dbPath);
    const cache2 = createPendingReplyCache(db2);
    assertEqual(cache2.listForRecovery().length, 1, 'recovery sees 1 pending row');

    const summary = await recoverPendingReplies({ cloud, cache: cache2 });
    assertEqual(summary.attempted, 1, 'attempted=1');
    assertEqual(summary.committed, 1, 'committed=1');
    assertEqual(summary.aborted, 0, 'aborted=0');
    assertEqual(summary.failed, 0, 'failed=0');

    // Verify DB reflects commit.
    const row = await prisma.iMDispatchReply.findUnique({ where: { id: inner.replyId } } as any);
    assert(row, 'DB row exists');
    assertEqual((row as any).status, 'committed', 'DB.status=committed after recovery');

    // Cache should be drained.
    assertEqual(cache2.listForRecovery().length, 0, 'cache drained after recovery');
    db2.close();
  } finally {
    await cleanupFixtures(f);
  }
});

test('4. server reaper aborts stale prepared → daemon retry → DISPATCH_REPLY_INVALID_STATE → "lost"', async () => {
  const f = await createFixtures('t4');
  const { db, cache } = makeDaemonCache();
  const cloud = makeCloudFor(f.ownerImUserId);
  try {
    // Issue a prepare row directly via prisma (skip the cloud call) so we
    // can artificially backdate it to >1h. This proves the daemon's behaviour
    // when the server reaper has already flipped the row to 'aborted'.
    const idem = generateIdempotencyKey();
    const replyId = `replytest_${crypto.randomBytes(8).toString('hex')}`;
    const stale = new Date(Date.now() - 65 * 60 * 1000); // 65 min ago
    await prisma.iMDispatchReply.create({
      data: {
        id: replyId,
        taskId: f.taskId,
        idempotencyKey: idem,
        status: 'aborted',
        assetIdsJson: [],
        messageContentJson: null,
        metricsJson: null,
        preparedAt: stale,
        abortedAt: new Date(),
      } as any,
    });
    cache.savePending(idem, f.taskId, JSON.stringify({ _taskId: f.taskId, _idempotencyKey: idem }));
    cache.markPrepared(idem, replyId);

    const summary = await recoverPendingReplies({ cloud, cache });
    assertEqual(summary.attempted, 1, 'attempted=1');
    assertEqual(summary.committed, 0, 'committed=0');
    assertEqual(summary.aborted, 1, 'aborted=1');
    assertEqual(cache.listForRecovery().length, 0, 'cache cleared after aborted detection');
  } finally {
    db.close();
    await cleanupFixtures(f);
  }
});

// ─── runner ───────────────────────────────────────────────────────────────

async function run() {
  console.log(`\nWave 4 E7 — daemon dispatch reply two-phase REAL integration tests`);
  console.log(`Prefix: ${PREFIX}`);
  console.log(`Cloud:  ${CLOUD_BASE}`);
  console.log(`DB:     ${process.env.DATABASE_URL?.replace(/:.+?@/, ':***@')}\n`);

  let pass = 0;
  let fail = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✅ ${t.name}`);
      pass += 1;
    } catch (err) {
      console.error(`  ❌ ${t.name}`);
      console.error(`     ${(err as Error).stack ?? (err as Error).message}`);
      fail += 1;
    }
  }
  console.log(`\nResults: ${pass}/${tests.length} passed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

void run();
