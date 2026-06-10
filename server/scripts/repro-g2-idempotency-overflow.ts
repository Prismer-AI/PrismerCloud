#!/usr/bin/env tsx
/**
 * G2 repro: legacy /dispatch/reply long idempotencyKey overflow.
 *
 * Generates the legacy idempotencyKey shape that persistAgentDispatchReply
 * produces (`dispatch_reply:<conversationId>:<replyToMessageId>:<agentImUserId>`)
 * with realistic cuid(30) ids — total ~107 chars, overflows VARCHAR(64).
 */
import 'dotenv/config';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'mysql://prismer:devpass@localhost:3307/prismer_cloud';

import * as crypto from 'node:crypto';
import prisma from '../src/im/db';
import { createAgentDispatchReplyToken } from '../src/im/services/agent-dispatcher';
import { signToken } from '../src/im/auth/jwt';

const CLOUD = 'http://localhost:3000';
const PREFIX = `g2_${crypto.randomBytes(4).toString('hex')}`;

async function main() {
  // realistic-sized ids (cuid is 25 chars; we use 28 to be a bit conservative)
  const wsId = `ws${PREFIX}t`.padEnd(25, 'x').slice(0, 25);
  const ownerId = `uo${PREFIX}t`.padEnd(25, 'x').slice(0, 25);
  const agentId = `ua${PREFIX}t`.padEnd(25, 'x').slice(0, 25);
  const convId = `cv${PREFIX}t`.padEnd(25, 'x').slice(0, 25);
  const msgId = `mg${PREFIX}t`.padEnd(25, 'x').slice(0, 25);

  await prisma.iMUser.create({ data: { id: ownerId, username: ownerId, displayName: 'owner', role: 'human' } as any });
  await prisma.iMUser.create({ data: { id: agentId, username: agentId, displayName: 'agent', role: 'agent' } as any });
  await prisma.iMWorkspace.create({ data: { id: wsId, name: 'ws', slug: wsId, ownerImUserId: ownerId } as any });
  await prisma.iMConversation.create({ data: { id: convId, type: 'direct', createdById: ownerId, workspaceId: wsId } as any });
  await prisma.iMParticipant.createMany({ data: [
    { conversationId: convId, imUserId: ownerId, role: 'owner' },
    { conversationId: convId, imUserId: agentId, role: 'member' },
  ] as any });

  const replyToken = createAgentDispatchReplyToken({
    channelAccountId: `ch_${PREFIX}`,
    conversationId: convId,
    messageId: msgId,
    agentImUserId: agentId,
    ttlMs: 60 * 60 * 1000,
  });
  const jwt = signToken({ sub: ownerId, username: ownerId } as any);

  // The internal key constructed by persistAgentDispatchReply will be:
  //   `dispatch_reply:${convId}:${msgId}:${agentId}` 
  //   = 15 + 25 + 1 + 25 + 1 + 25 = 92 chars > 64
  const internalKey = `dispatch_reply:${convId}:${msgId}:${agentId}`;
  console.log(`[repro] internal idempotencyKey computed by server = "${internalKey}" len=${internalKey.length}`);

  const r = await fetch(`${CLOUD}/api/im/dispatch/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      replyToken,
      conversationId: convId,
      replyToMessageId: msgId,
      agentImUserId: agentId,
      status: 'ok',
      replyText: 'hello from legacy path repro',
      completedAt: new Date().toISOString(),
    }),
  });
  const text = await r.text();
  console.log(`[repro] HTTP ${r.status}  body=${text}`);

  // cleanup
  await prisma.iMMessage.deleteMany({ where: { conversationId: convId } } as any).catch(() => {});
  await prisma.iMParticipant.deleteMany({ where: { conversationId: convId } } as any).catch(() => {});
  await prisma.iMConversation.deleteMany({ where: { id: convId } } as any).catch(() => {});
  await prisma.iMWorkspace.deleteMany({ where: { id: wsId } } as any).catch(() => {});
  await prisma.iMUser.deleteMany({ where: { id: { in: [ownerId, agentId] } } } as any).catch(() => {});
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
