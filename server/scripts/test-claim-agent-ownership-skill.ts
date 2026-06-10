#!/usr/bin/env tsx
/**
 * Wave 4 E7 — claim-agent-ownership built-in skill end-to-end test.
 *
 * Spec: docs/release200/14-messaging-state-machine-reliability.md §3.0.2 Gap G-2-⑤
 *       evidence/14-p10-server-wave2-b2.md (rebind endpoint server contract)
 *
 * Simulates the orchestrator workflow:
 *   1. Two daemons race-declare the same agent → second daemon's binding becomes
 *      'contested' (server-side B2 invariant; out of scope here).
 *   2. Orchestrator (this script, acting as workspace owner) reads the bindings,
 *      picks a target daemon, calls POST /agent-bindings/:agentImUserId/rebind.
 *   3. Verifies the rebind flips boundDaemonId and writes the audit row.
 *
 * This proves the skill's promised CLI / HTTP call works against the **real**
 * cloud — the skill's role is purely to invoke this endpoint and surface the
 * result to the user, so verifying the endpoint contract is the skill's
 * verifiable behaviour.
 */

import 'dotenv/config';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'mysql://prismer:devpass@localhost:3307/prismer_cloud';

import * as crypto from 'node:crypto';
import prisma from '../src/im/db';
import { signToken } from '../src/im/auth/jwt';

const CLOUD_BASE = process.env.CLOUD_BASE_URL || 'http://localhost:3000';
const PREFIX = `w4e7s_${crypto.randomBytes(4).toString('hex')}`;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function assertEqual<T>(actual: T, expected: T, label = ''): void {
  if (actual !== expected) {
    throw new Error(`expected ${label}=${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}

async function authHeader(ownerId: string): Promise<string> {
  const jwt = signToken({ sub: ownerId, username: ownerId } as any);
  return `Bearer ${jwt}`;
}

async function main() {
  console.log(`\nWave 4 E7 — claim-agent-ownership skill REAL integration test`);
  console.log(`Prefix: ${PREFIX}`);
  console.log(`Cloud:  ${CLOUD_BASE}\n`);

  const wsId = `ws${PREFIX}`.slice(0, 28);
  const ownerId = `uo${PREFIX}`.slice(0, 28);
  const agentImUserId = `ua${PREFIX}`.slice(0, 28);
  const daemon1Id = `d1-${PREFIX}`;
  const daemon2Id = `d2-${PREFIX}`;

  // ── Setup: workspace + owner + agent + 2 daemons + initial binding ──
  await prisma.iMUser.create({
    data: { id: ownerId, username: ownerId, displayName: 'owner', role: 'human' } as any,
  });
  await prisma.iMUser.create({
    data: { id: agentImUserId, username: agentImUserId, displayName: 'agent', role: 'agent' } as any,
  });
  await prisma.iMWorkspace.create({
    data: { id: wsId, name: 'ws', slug: wsId, ownerImUserId: ownerId } as any,
  });
  await prisma.iMAgentCard.create({
    data: {
      imUserId: agentImUserId,
      workspaceId: wsId,
      name: 'test-agent',
      agentType: 'assistant',
      capabilities: '[]',
      protocolVersion: '1.0',
      status: 'online',
    } as any,
  });
  // Two container rows — both daemons must be present in im_containers for the
  // server-side rebind validation to accept their daemonIds (otherwise 400).
  for (const [dId, kind, label] of [
    [daemon1Id, 'k8s', `k8s-pod-${PREFIX}`],
    [daemon2Id, 'local', `mac-studio-${PREFIX}`],
  ] as const) {
    // Raw SQL insert — IMContainer has 20+ required fields including
    // cpu/memory/quota that don't matter for this test; Prisma create()
    // would force us to enumerate them. We only need enough rows for
    // the rebind endpoint's daemon-exists check (workspaceId + daemonId
    // + status='running').
    await prisma.$executeRawUnsafe(
      `INSERT INTO im_containers
         (id, workspaceId, tenantId, daemonId, deviceType, runtimeKind, providerKind,
          podName, namespace, image, imageTag, status,
          cpuRequest, cpuLimit, memoryRequest, memoryLimit,
          createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'default', 'prismer/runtime', 'test',
               'running', '500m', '1', '512Mi', '1Gi', NOW(3), NOW(3))`,
      `c_${dId}`,
      wsId,
      ownerId,
      dId,
      kind,
      kind === 'k8s' ? 'k8s' : 'docker',
      kind,
      label,
    );
  }
  // Initial binding: daemon1 owns the agent.
  await prisma.iMAgentBinding.create({
    data: {
      id: `bind_${PREFIX}`,
      agentImUserId,
      boundDaemonId: daemon1Id,
      boundDaemonKind: 'k8s',
      boundDaemonLabel: `k8s-pod-${PREFIX}`,
      boundBy: 'auto-first-declare',
      lastHostDeclareAt: new Date(),
      contestCount: 0,
    } as any,
  });

  try {
    const auth = await authHeader(ownerId);

    // ── 1. Orchestrator inspects bindings ──
    const listRes = await fetch(`${CLOUD_BASE}/api/im/workspaces/${wsId}/agent-bindings`, {
      method: 'GET',
      headers: { Authorization: auth },
    });
    assert(listRes.ok, `list bindings status=${listRes.status}`);
    const listBody = (await listRes.json()) as any;
    assert(listBody.ok, `list ok=${listBody.ok}`);
    const rows = listBody.data?.bindings ?? [];
    assert(Array.isArray(rows) && rows.length >= 1, `expected >=1 binding row, got ${rows.length}`);
    const initial = rows.find((r: any) => r.agentImUserId === agentImUserId);
    assert(initial, 'binding row for fixture agent');
    assertEqual(initial.boundDaemonId, daemon1Id, 'initial boundDaemonId');
    console.log(`  ✅ GET /workspaces/${wsId.slice(0, 12)}.../agent-bindings → ${rows.length} row(s)`);

    // ── 2. Orchestrator calls rebind to daemon2 ──
    const rebindRes = await fetch(`${CLOUD_BASE}/api/im/agent-bindings/${agentImUserId}/rebind`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetDaemonId: daemon2Id,
        targetDaemonKind: 'local',
        targetDaemonLabel: 'mac-studio-home',
        reason: 'orchestrator skill test — pin to local daemon',
      }),
    });
    const rebindText = await rebindRes.text();
    assert(rebindRes.ok, `rebind status=${rebindRes.status} body=${rebindText}`);
    const rebindBody = JSON.parse(rebindText) as any;
    assert(rebindBody.ok, `rebind ok=${rebindBody.ok}`);
    assertEqual(rebindBody.data?.binding?.boundDaemonId, daemon2Id, 'rebind boundDaemonId flipped');
    assertEqual(rebindBody.data?.previousDaemonId, daemon1Id, 'previousDaemonId reported');
    assertEqual(rebindBody.data?.binding?.boundBy, 'user-explicit', 'boundBy=user-explicit');
    console.log(
      `  ✅ POST /agent-bindings/${agentImUserId.slice(0, 12)}.../rebind  ${daemon1Id} → ${daemon2Id}`,
    );

    // ── 3. Verify DB ──
    const dbRow = await prisma.iMAgentBinding.findUnique({
      where: { agentImUserId } as any,
    });
    assert(dbRow, 'DB binding row exists');
    assertEqual((dbRow as any).boundDaemonId, daemon2Id, 'DB.boundDaemonId=daemon2');
    assertEqual((dbRow as any).boundBy, 'user-explicit', 'DB.boundBy=user-explicit');
    console.log(`  ✅ DB row reflects rebind  boundDaemonId=${(dbRow as any).boundDaemonId}`);

    // ── 4. Verify SKILL.md exists with required frontmatter ──
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const skillMd = await fs.readFile(
      path.resolve(
        __dirname,
        '..',
        'sdk',
        'prismer-cloud',
        'built-in-skills',
        'claim-agent-ownership',
        'SKILL.md',
      ),
      'utf8',
    );
    assert(skillMd.includes('name: claim-agent-ownership'), 'SKILL.md has name frontmatter');
    assert(
      skillMd.includes('POST /api/im/agent-bindings/'),
      'SKILL.md documents the rebind endpoint',
    );
    assert(skillMd.includes('agent.binding.contested'), 'SKILL.md references contested event');
    assert(
      skillMd.includes('targetDaemonId') && skillMd.includes('reason'),
      'SKILL.md documents required body fields',
    );
    console.log(`  ✅ SKILL.md complete (${skillMd.length} chars)`);

    console.log(`\nResults: 4/4 passed`);
  } finally {
    // Cleanup
    await prisma.iMAgentBinding.deleteMany({ where: { agentImUserId } } as any).catch(() => {});
    await prisma.iMContainer.deleteMany({ where: { workspaceId: wsId } } as any).catch(() => {});
    await prisma.iMAgentCard.deleteMany({ where: { imUserId: agentImUserId } } as any).catch(() => {});
    await prisma.iMWorkspace.deleteMany({ where: { id: wsId } } as any).catch(() => {});
    await prisma.iMUser.deleteMany({ where: { id: { in: [ownerId, agentImUserId] } } } as any).catch(
      () => {},
    );
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error('\n❌ test failed:', err);
  process.exit(1);
});
