#!/usr/bin/env tsx
/**
 * Wave 6 G2 — idempotencyKey VARCHAR overflow integration test.
 *
 * Verifies migration 419 (VARCHAR(64) → VARCHAR(255)) on both:
 *   - im_messages.idempotencyKey  (legacy /dispatch/reply path)
 *   - im_dispatch_replies.idempotencyKey  (new /dispatch/:taskId/prepare path)
 *
 * Idempotency invariants:
 *   - Long key (>64 chars) accepted by both paths.
 *   - 2nd call with same long key on /dispatch/reply returns existing
 *     message (single row in im_messages with that key).
 *   - 2nd call with same long key on /dispatch/:taskId/prepare returns
 *     existing reply (single row in im_dispatch_replies).
 *
 * Real docker MySQL + real fetch localhost:3000. No mocks.
 */

import 'dotenv/config';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'mysql://prismer:devpass@localhost:3307/prismer_cloud';

import * as crypto from 'node:crypto';
import prisma from '../src/im/db';
import { createAgentDispatchReplyToken } from '../src/im/services/agent-dispatcher';
import { signToken } from '../src/im/auth/jwt';

const CLOUD = process.env.CLOUD_BASE_URL || 'http://localhost:3000';
const PREFIX = `g2_${crypto.randomBytes(4).toString('hex')}`;

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

interface Fixtures {
  workspaceId: string;
  ownerImUserId: string;
  agentImUserId: string;
  conversationId: string;
  messageId: string;
  taskId: string;
  replyToken: string;
  jwt: string;
}

async function createFixtures(suffix: string): Promise<Fixtures> {
  // 25-char IDs => realistic cuid-shape. Legacy idempotencyKey will be
  //   `dispatch_reply:<25>:<25>:<25>` = 15 + 25 + 1 + 25 + 1 + 25 = 92 chars
  // — definitively > 64.
  const pad = (s: string) => s.padEnd(25, 'x').slice(0, 25);
  const wsId = pad(`ws${PREFIX}${suffix}`);
  const ownerId = pad(`uo${PREFIX}${suffix}`);
  const agentId = pad(`ua${PREFIX}${suffix}`);
  const convId = pad(`cv${PREFIX}${suffix}`);
  const msgId = pad(`mg${PREFIX}${suffix}`);
  const taskId = pad(`tk${PREFIX}${suffix}`);

  await prisma.iMUser.create({
    data: { id: ownerId, username: ownerId, displayName: `owner ${suffix}`, role: 'human' } as any,
  });
  await prisma.iMUser.create({
    data: { id: agentId, username: agentId, displayName: `agent ${suffix}`, role: 'agent' } as any,
  });
  await prisma.iMWorkspace.create({
    data: { id: wsId, name: `ws ${suffix}`, slug: wsId, ownerImUserId: ownerId } as any,
  });
  await prisma.iMConversation.create({
    data: { id: convId, type: 'direct', createdById: ownerId, workspaceId: wsId } as any,
  });
  await prisma.iMParticipant.createMany({
    data: [
      { conversationId: convId, imUserId: ownerId, role: 'owner' },
      { conversationId: convId, imUserId: agentId, role: 'member' },
    ] as any,
  });

  const replyToken = createAgentDispatchReplyToken({
    channelAccountId: `ch_${suffix}`,
    conversationId: convId,
    messageId: msgId,
    agentImUserId: agentId,
    ttlMs: 60 * 60 * 1000,
  });
  const jwt = signToken({ sub: ownerId, username: ownerId } as any);

  return { workspaceId: wsId, ownerImUserId: ownerId, agentImUserId: agentId,
    conversationId: convId, messageId: msgId, taskId, replyToken, jwt };
}

async function cleanupFixtures(f: Fixtures): Promise<void> {
  // FK-order cleanup. User deletion may fail if other tables reference; safe to ignore.
  await prisma.iMDispatchReply.deleteMany({ where: { taskId: f.taskId } } as any).catch(() => {});
  await prisma.iMMessage.deleteMany({ where: { conversationId: f.conversationId } } as any).catch(() => {});
  await prisma.iMParticipant.deleteMany({ where: { conversationId: f.conversationId } } as any).catch(() => {});
  await prisma.iMConversation.deleteMany({ where: { id: f.conversationId } } as any).catch(() => {});
  await prisma.iMWorkspace.deleteMany({ where: { id: f.workspaceId } } as any).catch(() => {});
  await prisma.iMUser.deleteMany({ where: { id: { in: [f.ownerImUserId, f.agentImUserId] } } } as any).catch(() => {});
}

// ─── tests ────────────────────────────────────────────────────────────────

test('1. legacy /dispatch/reply accepts long internal idempotencyKey', async () => {
  const f = await createFixtures('t1');
  try {
    const expectedKey = `dispatch_reply:${f.conversationId}:${f.messageId}:${f.agentImUserId}`;
    assert(expectedKey.length > 64, `pre-condition: legacy key length=${expectedKey.length} must be > 64`);

    const r = await fetch(`${CLOUD}/api/im/dispatch/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.jwt}` },
      body: JSON.stringify({
        replyToken: f.replyToken,
        conversationId: f.conversationId,
        replyToMessageId: f.messageId,
        agentImUserId: f.agentImUserId,
        status: 'ok',
        replyText: 'g2 t1 hello',
        completedAt: new Date().toISOString(),
      }),
    });
    const body = await r.json() as any;
    assertEqual(r.status, 200, 'HTTP status');
    assertEqual(body.ok, true, 'body.ok');
    assert(body.data?.messageId, 'messageId returned');

    // Row persisted with the 92-char key intact.
    const row = await prisma.iMMessage.findUnique({ where: { id: body.data.messageId } } as any);
    assert(row, 'message row exists');
    assertEqual((row as any).idempotencyKey, expectedKey, 'persisted idempotencyKey');
  } finally {
    await cleanupFixtures(f);
  }
});

test('2. legacy /dispatch/reply 2nd call with same long key returns existing (idempotent)', async () => {
  const f = await createFixtures('t2');
  try {
    const post = () => fetch(`${CLOUD}/api/im/dispatch/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.jwt}` },
      body: JSON.stringify({
        replyToken: f.replyToken,
        conversationId: f.conversationId,
        replyToMessageId: f.messageId,
        agentImUserId: f.agentImUserId,
        status: 'ok',
        replyText: 'g2 t2 same key both calls',
        completedAt: new Date().toISOString(),
      }),
    });

    const r1 = await post(); const b1 = await r1.json() as any;
    const r2 = await post(); const b2 = await r2.json() as any;
    assertEqual(r1.status, 200, 'call 1 status');
    assertEqual(r2.status, 200, 'call 2 status');
    // Same message returned both times — DB-level dedupe via UNIQUE
    // (conversationId, idempotencyKey).
    assertEqual(b1.data.messageId, b2.data.messageId, 'idempotency: same messageId');

    // Exactly ONE row in im_messages for this convId with that key.
    const expectedKey = `dispatch_reply:${f.conversationId}:${f.messageId}:${f.agentImUserId}`;
    const rows = await prisma.iMMessage.findMany({
      where: { conversationId: f.conversationId, idempotencyKey: expectedKey },
    } as any);
    assertEqual(rows.length, 1, 'exactly one im_messages row');
  } finally {
    await cleanupFixtures(f);
  }
});

test('3. new /dispatch/:taskId/prepare accepts long daemon-supplied idempotencyKey', async () => {
  const f = await createFixtures('t3');
  try {
    // Daemon-supplied key longer than 64 chars (e.g. uuid-pair shape).
    const longIdem = `daemon-pair:${crypto.randomUUID()}:${crypto.randomUUID()}`;
    assert(longIdem.length > 64, `pre-condition: longIdem length=${longIdem.length} must be > 64`);

    const r = await fetch(`${CLOUD}/api/im/dispatch/${f.taskId}/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.jwt}` },
      body: JSON.stringify({
        idempotencyKey: longIdem,
        conversationId: f.conversationId,
        replyToken: f.replyToken,
        replyToMessageId: f.messageId,
        agentImUserId: f.agentImUserId,
        status: 'ok',
        replyText: 'g2 t3 prepare long key',
        completedAt: new Date().toISOString(),
      }),
    });
    const body = await r.json() as any;
    assertEqual(r.status, 200, 'HTTP status');
    assertEqual(body.ok, true, 'body.ok');
    const replyId = body.data?.replyId as string;
    assert(replyId, 'replyId returned');

    const row = await prisma.iMDispatchReply.findUnique({ where: { id: replyId } } as any);
    assert(row, 'dispatch reply row exists');
    assertEqual((row as any).idempotencyKey, longIdem, 'persisted long idempotencyKey');

    // Re-prepare with same long key → returns existing (existed=true).
    const r2 = await fetch(`${CLOUD}/api/im/dispatch/${f.taskId}/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.jwt}` },
      body: JSON.stringify({
        idempotencyKey: longIdem,
        conversationId: f.conversationId,
        replyToken: f.replyToken,
        replyToMessageId: f.messageId,
        agentImUserId: f.agentImUserId,
        status: 'ok',
        replyText: 'g2 t3 second prepare',
        completedAt: new Date().toISOString(),
      }),
    });
    const body2 = await r2.json() as any;
    assertEqual(r2.status, 200, 'HTTP status 2');
    assertEqual(body2.data.replyId, replyId, 'idempotency: same replyId');
    assertEqual(body2.data.existed, true, 'existed=true on re-prepare');
  } finally {
    await cleanupFixtures(f);
  }
});

// ─── runner ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`[G2-test] cloud=${CLOUD} prefix=${PREFIX}`);
  let passed = 0, failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`[G2-test] PASS — ${t.name}`);
      passed++;
    } catch (e) {
      console.error(`[G2-test] FAIL — ${t.name}: ${(e as Error).message}`);
      failed++;
    }
  }
  console.log(`[G2-test] ${passed}/${tests.length} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
