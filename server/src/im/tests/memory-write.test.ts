/**
 * MemoryWriteService (A3) integration tests against SQLite.
 *
 * Run:
 *   rm -f /tmp/prismer-memory-write.db
 *   DATABASE_URL="file:/tmp/prismer-memory-write.db" \
 *     npx prisma db push --schema prisma/schema.prisma --skip-generate --accept-data-loss
 *   DATABASE_URL="file:/tmp/prismer-memory-write.db" npx tsx src/im/tests/memory-write.test.ts
 */

import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import prisma from '../db';
import { _clearMemoryAclCache, loadWorkspaceForMemoryAccess } from '../services/memory-acl';
import { MemoryReadService } from '../services/memory-read.service';
import { MemoryWriteError, MemoryWriteService } from '../services/memory-write.service';
import type { MemoryInvalidatePayload } from '../ws/events';

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const ownerId = `mw_owner_${suffix}`;
const otherOwnerId = `mw_other_${suffix}`;
const agent1Id = `mw_agent1_${suffix}`;
const wsA = `mw_ws_a_${suffix}`;
const wsB = `mw_ws_b_${suffix}`;

let invalidations: MemoryInvalidatePayload[] = [];
const writer = new MemoryWriteService((payload) => {
  invalidations.push(payload);
});
const reader = new MemoryReadService();

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => Promise<void>) {
  _clearMemoryAclCache();
  invalidations = [];
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

async function cleanup() {
  await prisma.iMMemoryObservabilityEvent.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await prisma.iMMemoryLink.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await prisma.iMMemoryPageVersion.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await prisma.iMMemoryPage.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await prisma.iMAgentCard.deleteMany({ where: { imUserId: agent1Id } });
  await prisma.iMWorkspace.deleteMany({ where: { id: { in: [wsA, wsB] } } });
  await prisma.iMUser.deleteMany({ where: { id: { in: [ownerId, otherOwnerId, agent1Id] } } });
}

async function setup() {
  await prisma.iMUser.createMany({
    data: [
      { id: ownerId, username: `o_${suffix}`, displayName: 'Owner', role: 'human' },
      { id: otherOwnerId, username: `oo_${suffix}`, displayName: 'Other', role: 'human' },
      { id: agent1Id, username: `a1_${suffix}`, displayName: 'Agent 1', role: 'agent' },
    ],
  });
  await prisma.iMWorkspace.createMany({
    data: [
      { id: wsA, ownerImUserId: ownerId, name: 'A', slug: `a_${suffix}`, isDefault: true },
      { id: wsB, ownerImUserId: otherOwnerId, name: 'B', slug: `b_${suffix}`, isDefault: true },
    ],
  });
  await prisma.iMAgentCard.createMany({
    data: [{ imUserId: agent1Id, name: 'agent1', workspaceId: wsA }],
  });
}

async function loadOwnerAcl() {
  const acl = await loadWorkspaceForMemoryAccess(wsA, ownerId, 'user');
  assert.ok(acl);
  return acl!;
}

async function loadAgentAcl() {
  const acl = await loadWorkspaceForMemoryAccess(wsA, agent1Id, 'agent');
  assert.ok(acl);
  return acl!;
}

async function main() {
  console.log('[memory-write] setup fixtures');
  await cleanup();
  await setup();

  // ─── createPage ────────────────────────────────────────────
  await runTest('createPage happy path with sourceRefs', async () => {
    const acl = await loadOwnerAcl();
    const page = await writer.createPage({
      acl,
      path: 'memory/test/note-1.md',
      content: '# Note 1\n\nThis is a manual write.\n',
      sourceRefs: ['conversation:cv_xxx'],
      rationale: 'manual capture',
    });
    assert.equal(page.workspaceId, wsA);
    assert.equal(page.version, 1);
    assert.equal(page.visibility, 'workspace');
    const detail = await reader.readPage(acl, page.id);
    assert.ok(detail);
    assert.match(detail!.content, /manual write/);
  });

  await runTest('createPage rejects empty sourceRefs', async () => {
    const acl = await loadOwnerAcl();
    await assert.rejects(
      writer.createPage({ acl, path: 'memory/test/r.md', content: '# r', sourceRefs: [] }),
      (err: unknown) => err instanceof MemoryWriteError && err.code === 'source_refs_required',
    );
  });

  await runTest('createPage rejects oversized content (>64KB)', async () => {
    const acl = await loadOwnerAcl();
    const big = 'x'.repeat(64 * 1024 + 1);
    await assert.rejects(
      writer.createPage({ acl, path: 'memory/test/big.md', content: big, sourceRefs: ['cv:1'] }),
      (err: unknown) => err instanceof MemoryWriteError && err.code === 'content_too_large',
    );
  });

  await runTest('createPage rejects content with secret pattern', async () => {
    const acl = await loadOwnerAcl();
    await assert.rejects(
      writer.createPage({
        acl,
        path: 'memory/test/secret.md',
        content: 'leaked openai key sk-' + 'a'.repeat(48),
        sourceRefs: ['cv:1'],
      }),
      (err: unknown) => err instanceof MemoryWriteError && err.code === 'secret_detected',
    );
  });

  await runTest('createPage rejects forbidden visibility for agent caller', async () => {
    const acl = await loadAgentAcl();
    await assert.rejects(
      writer.createPage({
        acl,
        path: 'memory/test/forbidden.md',
        content: '# x',
        visibility: `human:${ownerId}`,
        sourceRefs: ['cv:1'],
      }),
      (err: unknown) => err instanceof MemoryWriteError && err.code === 'forbidden_visibility',
    );
  });

  // ─── archive / unarchive ──────────────────────────────────
  await runTest('archive sets archivedAt + emits invalidate', async () => {
    const acl = await loadOwnerAcl();
    const page = await writer.createPage({
      acl,
      path: `memory/test/arch_${suffix}_a.md`,
      content: '# arch',
      sourceRefs: ['cv:1'],
    });
    invalidations = [];
    const updated = await writer.archive(acl, page.id);
    assert.ok(updated.archivedAt);
    assert.equal(invalidations.length, 1);
    assert.equal(invalidations[0].reason, 'archive');

    const restored = await writer.unarchive(acl, page.id);
    assert.equal(restored.archivedAt, null);
  });

  // ─── softDelete + invalidate fan-out + broken-link cascade ─
  await runTest('softDelete writes deletedAt, marks inbound broken, fires invalidate', async () => {
    const acl = await loadOwnerAcl();
    const page = await writer.createPage({
      acl,
      path: `memory/test/del_${suffix}.md`,
      content: '# del',
      sourceRefs: ['cv:1'],
    });
    // Add inbound link from another page
    const inboundPage = await writer.createPage({
      acl,
      path: `memory/test/inbound_${suffix}.md`,
      content: '# inbound',
      sourceRefs: ['cv:1'],
    });
    await prisma.iMMemoryLink.create({
      data: {
        workspaceId: wsA,
        sourcePageId: inboundPage.id,
        targetPageId: page.id,
        sourceUri: `pkm://memory/test/inbound_${suffix}.md`,
        targetUri: `pkm://memory/test/del_${suffix}.md`,
        relation: 'markdown',
        weight: 1,
        broken: false,
      },
    });

    invalidations = [];
    const result = await writer.softDelete({ acl, pageId: page.id });
    assert.equal(result.invalidate.reason, 'soft_delete');
    assert.equal(invalidations.length, 1);
    assert.equal(invalidations[0].pageIds[0], page.id);

    const inbound = await prisma.iMMemoryLink.findFirst({
      where: { sourcePageId: inboundPage.id, targetPageId: page.id },
    });
    assert.equal(inbound?.broken, true, 'inbound link must be flagged broken');

    const detail = await reader.readPage(acl, page.id);
    assert.equal(detail, null, 'soft-deleted page must not be readable');
  });

  // ─── visibility change with ETag ──────────────────────────
  await runTest('changeVisibility rejects on If-Match mismatch', async () => {
    const acl = await loadOwnerAcl();
    const page = await writer.createPage({
      acl,
      path: `memory/test/vis_${suffix}.md`,
      content: '# vis',
      sourceRefs: ['cv:1'],
    });
    await assert.rejects(
      writer.changeVisibility({
        acl,
        pageId: page.id,
        visibility: `human:${ownerId}`,
        ifMatch: 'W/"99"', // wrong version
      }),
      (err: unknown) => err instanceof MemoryWriteError && err.code === 'etag_mismatch',
    );
  });

  await runTest('changeVisibility succeeds with matching If-Match', async () => {
    const acl = await loadOwnerAcl();
    const page = await writer.createPage({
      acl,
      path: `memory/test/vis2_${suffix}.md`,
      content: '# v',
      sourceRefs: ['cv:1'],
    });
    invalidations = [];
    const updated = await writer.changeVisibility({
      acl,
      pageId: page.id,
      visibility: `human:${ownerId}`,
      ifMatch: `W/"${page.version}"`,
    });
    assert.equal(updated.visibility, `human:${ownerId}`);
    assert.equal(updated.version, page.version + 1);
    assert.equal(invalidations[0].reason, 'visibility_changed');
  });

  // ─── promote (owner-only) ─────────────────────────────────
  await runTest('promote rejects agent caller with 403', async () => {
    const ownerAcl = await loadOwnerAcl();
    const page = await writer.createPage({
      acl: ownerAcl,
      path: `memory/test/prom_${suffix}.md`,
      content: '# x',
      visibility: `agent:${agent1Id}`,
      sourceRefs: ['cv:1'],
    });
    const agentAcl = await loadAgentAcl();
    await assert.rejects(
      writer.promote(agentAcl, page.id),
      (err: unknown) => err instanceof MemoryWriteError && err.code === 'owner_only',
    );
  });

  await runTest('promote sets visibility=workspace and bumps version', async () => {
    const acl = await loadOwnerAcl();
    const page = await writer.createPage({
      acl,
      path: `memory/test/prom2_${suffix}.md`,
      content: '# x',
      visibility: `agent:${agent1Id}`,
      sourceRefs: ['cv:1'],
    });
    const updated = await writer.promote(acl, page.id);
    assert.equal(updated.visibility, 'workspace');
    assert.equal(updated.version, page.version + 1);
  });

  // ─── stale ────────────────────────────────────────────────
  await runTest('setStale flips stale + reason', async () => {
    const acl = await loadOwnerAcl();
    const page = await writer.createPage({
      acl,
      path: `memory/test/stale_${suffix}.md`,
      content: '# x',
      sourceRefs: ['cv:1'],
    });
    const updated = await writer.setStale(acl, page.id, true, 'source-archived');
    assert.equal(updated.stale, true);
    assert.equal(updated.staleReason, 'source-archived');
  });

  // ─── sync inbox routing ───────────────────────────────────
  // Helper to build a daemon-style envelope. The cloud now enforces the doc 18
  // §C4 envelope contract (eventId/schemaVersion/idempotencyKey/deviceId/
  // createdAt/actorImUserId/actorKind), so each test event needs the full set.
  const envelope = (overrides: Partial<Parameters<typeof writer.ingestSyncInbox>[0][number]>) => ({
    schemaVersion: 1,
    idempotencyKey: `idem_${overrides.eventId ?? Math.random().toString(36).slice(2)}`,
    deviceId: `dev_${suffix}`,
    createdAt: new Date().toISOString(),
    workspaceId: wsA,
    actorImUserId: agent1Id,
    actorKind: 'agent' as const,
    payload: {},
    ...overrides,
  });

  await runTest('ingestSyncInbox routes recall_inject + feedback to observability', async () => {
    const beforeCount = await prisma.iMMemoryObservabilityEvent.count({ where: { workspaceId: wsA } });
    const result = await writer.ingestSyncInbox([
      envelope({
        eventId: `ev_recall_${suffix}_1`,
        eventType: 'recall_inject',
        payload: { pageId: 'pg_x', metrics: { tokenCount: 100 } },
        metadata: { sessionId: 's1' },
      }),
      envelope({
        eventId: `ev_fb_${suffix}_1`,
        eventType: 'feedback',
        metadata: { sessionId: 's1', signal: 1 },
      }),
    ]);
    assert.equal(result.acked.length, 2);
    assert.equal(result.errors.length, 0);
    const afterCount = await prisma.iMMemoryObservabilityEvent.count({ where: { workspaceId: wsA } });
    assert.equal(afterCount - beforeCount, 2);
  });

  await runTest('ingestSyncInbox dead-letters unknown eventType', async () => {
    const result = await writer.ingestSyncInbox([
      envelope({
        eventId: `ev_bad_${suffix}`,
        eventType: 'completely-unknown',
      }),
    ]);
    assert.equal(result.acked.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'unknown_event_type');
  });

  await runTest('ingestSyncInbox acks asset.* + memory.* without inserting', async () => {
    const beforeCount = await prisma.iMMemoryObservabilityEvent.count({ where: { workspaceId: wsA } });
    const result = await writer.ingestSyncInbox([
      envelope({
        eventId: `ev_asset_${suffix}`,
        eventType: 'asset.created',
        payload: { assetId: 'ast_y' },
      }),
      envelope({
        eventId: `ev_mem_${suffix}`,
        eventType: 'memory.page.upsert',
        payload: { pageId: 'pg_z', path: 'memory/x.md' },
      }),
    ]);
    assert.equal(result.acked.length, 2);
    const afterCount = await prisma.iMMemoryObservabilityEvent.count({ where: { workspaceId: wsA } });
    assert.equal(afterCount, beforeCount, 'asset.* + memory.* should not write observability events');
  });

  await runTest('ingestSyncInbox routes access_denied to observability table', async () => {
    const beforeCount = await prisma.iMMemoryObservabilityEvent.count({
      where: { workspaceId: wsA, eventType: 'access_denied' },
    });
    const result = await writer.ingestSyncInbox([
      envelope({
        eventId: `ev_ad_${suffix}`,
        eventType: 'access_denied',
        payload: { attemptedUri: 'pkm://memory/forbidden.md' },
        metadata: { sessionId: `s_ad_${suffix}`, reason: 'cross_workspace' },
      }),
    ]);
    assert.equal(result.acked.length, 1);
    assert.equal(result.errors.length, 0);
    const afterCount = await prisma.iMMemoryObservabilityEvent.count({
      where: { workspaceId: wsA, eventType: 'access_denied' },
    });
    assert.equal(afterCount - beforeCount, 1, 'access_denied must be persisted, not dead-lettered');
  });

  await runTest('ingestSyncInbox routes memory.feedback to observability (NOT memory mirror)', async () => {
    const beforeCount = await prisma.iMMemoryObservabilityEvent.count({
      where: { workspaceId: wsA, eventType: 'memory.feedback' },
    });
    const result = await writer.ingestSyncInbox([
      envelope({
        eventId: `ev_mfb_${suffix}`,
        eventType: 'memory.feedback',
        payload: { pageId: 'pg_q', metrics: { signal: -1 } },
        metadata: { sessionId: `s_mfb_${suffix}` },
      }),
    ]);
    assert.equal(result.acked.length, 1);
    assert.equal(result.errors.length, 0);
    const afterCount = await prisma.iMMemoryObservabilityEvent.count({
      where: { workspaceId: wsA, eventType: 'memory.feedback' },
    });
    assert.equal(
      afterCount - beforeCount,
      1,
      'memory.feedback shares the memory.* prefix but is observability — must persist, not deferred-mirror',
    );
  });

  // ─── pre-deploy hardening: workspace-isolation + idempotency + schema ───
  await runTest('ingestSyncInbox rejects cross-workspace events when caller provided', async () => {
    // wsB is owned by otherOwnerId; agent1 (in wsA) cannot post to wsB.
    const result = await writer.ingestSyncInbox(
      [
        envelope({
          eventId: `ev_cross_${suffix}`,
          eventType: 'recall_inject',
          workspaceId: wsB,
          payload: { pageId: 'pg_x' },
        }),
      ],
      { imUserId: agent1Id, callerKind: 'agent' },
    );
    assert.equal(result.acked.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'forbidden_workspace');
  });

  await runTest('ingestSyncInbox per-event ACL: mixed batch acks own + errors foreign', async () => {
    const result = await writer.ingestSyncInbox(
      [
        envelope({
          eventId: `ev_own_${suffix}`,
          eventType: 'recall_inject',
          workspaceId: wsA,
          payload: { pageId: 'pg_a' },
        }),
        envelope({
          eventId: `ev_foreign_${suffix}`,
          eventType: 'recall_inject',
          workspaceId: wsB,
          payload: { pageId: 'pg_b' },
        }),
      ],
      { imUserId: agent1Id, callerKind: 'agent' },
    );
    assert.equal(result.acked.length, 1);
    assert.equal(result.acked[0], `ev_own_${suffix}`);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'forbidden_workspace');
  });

  await runTest('ingestSyncInbox idempotency: duplicate event acks but does not double-write', async () => {
    const idem = `idem_dedup_${suffix}`;
    const ev = envelope({
      eventId: `ev_dedup_${suffix}`,
      eventType: 'recall_inject',
      idempotencyKey: idem,
      payload: { pageId: 'pg_dedup' },
    });
    const beforeCount = await prisma.iMMemoryObservabilityEvent.count({ where: { workspaceId: wsA } });
    const r1 = await writer.ingestSyncInbox([ev]);
    assert.equal(r1.acked.length, 1);
    assert.equal(r1.errors.length, 0);
    const midCount = await prisma.iMMemoryObservabilityEvent.count({ where: { workspaceId: wsA } });
    assert.equal(midCount - beforeCount, 1, 'first delivery writes one observability row');
    // Second delivery: same eventId + same idempotencyKey → P2002 → ack as no-op.
    const r2 = await writer.ingestSyncInbox([ev]);
    assert.equal(r2.acked.length, 1, 'duplicate must still ack so daemon can advance cursor');
    assert.equal(r2.errors.length, 0);
    const afterCount = await prisma.iMMemoryObservabilityEvent.count({ where: { workspaceId: wsA } });
    assert.equal(afterCount, midCount, 'duplicate must NOT write a second observability row');
  });

  await runTest('ingestSyncInbox rejects missing required envelope fields', async () => {
    const result = await writer.ingestSyncInbox([
      // Missing idempotencyKey
      {
        eventId: `ev_no_idem_${suffix}`,
        eventType: 'recall_inject',
        workspaceId: wsA,
        actorImUserId: agent1Id,
        actorKind: 'agent',
        schemaVersion: 1,
        deviceId: 'dev_x',
        createdAt: new Date().toISOString(),
        payload: {},
      } as Parameters<typeof writer.ingestSyncInbox>[0][number],
    ]);
    assert.equal(result.acked.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'schema_invalid');
    assert.match(result.errors[0].message, /idempotencyKey/);
  });

  await runTest('ingestSyncInbox rejects unsupported schemaVersion', async () => {
    const result = await writer.ingestSyncInbox([
      envelope({
        eventId: `ev_sv2_${suffix}`,
        eventType: 'recall_inject',
        schemaVersion: 2,
        payload: {},
      }),
    ]);
    assert.equal(result.acked.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'schema_invalid');
    assert.match(result.errors[0].message, /schemaVersion/);
  });

  // ─── feedback (owner-only) ────────────────────────────────
  await runTest('recordFeedback rejects agent caller', async () => {
    const acl = await loadAgentAcl();
    await assert.rejects(
      writer.recordFeedback({
        acl,
        workspaceId: wsA,
        signal: 1,
      }),
      (err: unknown) => err instanceof MemoryWriteError && err.code === 'owner_only',
    );
  });

  await runTest('recordFeedback owner writes observability row', async () => {
    const acl = await loadOwnerAcl();
    const result = await writer.recordFeedback({
      acl,
      workspaceId: wsA,
      sessionId: `s_fb_${suffix}`,
      signal: -1,
      note: 'not relevant',
    });
    assert.ok(result.eventId);
    const stored = await prisma.iMMemoryObservabilityEvent.findUnique({ where: { id: result.eventId } });
    assert.equal(stored?.eventType, 'feedback');
    assert.equal(stored?.actorKind, 'user');
  });

  // ─── purgeSoftDeleted cron ────────────────────────────────
  await runTest('purgeSoftDeleted physically deletes pages aged past 30 days', async () => {
    const acl = await loadOwnerAcl();
    const fresh = await writer.createPage({
      acl,
      path: `memory/test/purge_fresh_${suffix}.md`,
      content: '# fresh',
      sourceRefs: ['cv:1'],
    });
    const stale = await writer.createPage({
      acl,
      path: `memory/test/purge_stale_${suffix}.md`,
      content: '# stale',
      sourceRefs: ['cv:1'],
    });
    // backdate stale: set deletedAt 35 days ago
    const old = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
    await prisma.iMMemoryPage.update({ where: { id: stale.id }, data: { deletedAt: old } });
    await writer.softDelete({ acl, pageId: fresh.id }); // recent soft delete

    const result = await writer.purgeSoftDeleted();
    assert.ok(result.deleted >= 1, 'must purge at least the stale soft-delete');
    const remainingFresh = await prisma.iMMemoryPage.findUnique({ where: { id: fresh.id } });
    assert.ok(remainingFresh, 'recent soft-delete must NOT be physically purged');
    const removedStale = await prisma.iMMemoryPage.findUnique({ where: { id: stale.id } });
    assert.equal(removedStale, null, 'aged soft-delete must be physically removed');
  });

  console.log(`\n[memory-write] ${passed} passed, ${failed} failed`);
  await cleanup();
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
