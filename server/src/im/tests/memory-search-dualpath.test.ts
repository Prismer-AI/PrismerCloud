/**
 * C6 dual-path + presence registry + correlation tracker tests.
 *
 * Pure in-memory — no DB / Prisma needed. Run:
 *   npx tsx src/im/tests/memory-search-dualpath.test.ts
 */

import assert from 'node:assert/strict';
import {
  registerDaemonPresence,
  unregisterDaemonPresence,
  getDualPathState,
  getDualPathMetrics,
  setDaemonRpcSender,
  deliverDaemonReply,
  rejectDaemonReply,
  __resetDualPathStates,
  MemorySearchService,
} from '../services/memory-search.service';

const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, fn });
}

// ─── presence registry ────────────────────────────────────────

test('registerDaemonPresence makes a workspace ping-eligible', () => {
  __resetDualPathStates();
  registerDaemonPresence('ws_a', 'daemon_1');
  // pingDaemon is module-private; we exercise it via getDualPathState behavior
  // — but presence registry itself can be probed via getDualPathMetrics indirectly.
  // Direct verification: unregister + re-register without throwing.
  unregisterDaemonPresence('ws_a', 'daemon_1');
  unregisterDaemonPresence('ws_a', 'daemon_1'); // idempotent on missing
  // No assertion — we're just confirming the registry doesn't crash on basic use.
});

// ─── dual-path state machine ──────────────────────────────────

test('dual-path inactive by default (no failures recorded)', () => {
  __resetDualPathStates();
  const s = getDualPathState('ws_a');
  assert.equal(s.active, false);
  assert.equal(s.recentFailures, 0);
});

test('search() with FF off does not touch dual-path state', async () => {
  __resetDualPathStates();
  delete process.env.FF_MEMORY_SEARCH_DAEMON_FIRST;
  const svc = new MemorySearchService();
  // search() will call cloudFallbackSearch which needs Prisma — we only care
  // that it doesn't enter the daemon-first branch. Catch any DB error and
  // verify dual-path state stayed unchanged.
  await svc
    .search({
      acl: { workspaceId: 'ws_ff_off', actorImUserId: 'im_x', actorKind: 'human' } as never,
      query: 'x',
    } as never)
    .catch(() => {
      /* DB unavailable — expected outside test container */
    });
  const s = getDualPathState('ws_ff_off');
  assert.equal(s.active, false);
  assert.equal(s.recentFailures, 0);
});

test('search() with FF on + no daemon presence records a failure', async () => {
  __resetDualPathStates();
  process.env.FF_MEMORY_SEARCH_DAEMON_FIRST = 'true';
  const svc = new MemorySearchService();
  await svc
    .search({
      acl: { workspaceId: 'ws_ff_on', actorImUserId: 'im_x', actorKind: 'human' } as never,
      query: 'x',
    } as never)
    .catch(() => {
      /* cloudFallbackSearch may fail (no DB) — fine */
    });
  delete process.env.FF_MEMORY_SEARCH_DAEMON_FIRST;
  const s = getDualPathState('ws_ff_on');
  // Failure recorded but threshold (3) not yet hit
  assert.equal(s.recentFailures, 1);
  assert.equal(s.active, false);
});

test('three failures in window → dual-path active + counter increments', async () => {
  __resetDualPathStates();
  process.env.FF_MEMORY_SEARCH_DAEMON_FIRST = 'true';
  const svc = new MemorySearchService();
  for (let i = 0; i < 3; i++) {
    await svc
      .search({
        acl: { workspaceId: 'ws_thresh', actorImUserId: 'im_x', actorKind: 'human' } as never,
        query: 'x',
      } as never)
      .catch(() => {});
  }
  delete process.env.FF_MEMORY_SEARCH_DAEMON_FIRST;
  const s = getDualPathState('ws_thresh');
  assert.equal(s.active, true);
  assert.equal(s.recentFailures, 3);
  const m = getDualPathMetrics();
  assert.ok(m.enteredTotal >= 1);
  assert.ok(m.activeWorkspaces >= 1);
});

test('daemon presence + RPC sender → search forwards to daemon', async () => {
  __resetDualPathStates();
  registerDaemonPresence('ws_rpc', 'daemon_1');

  let sent: { workspaceId: string; payload: unknown } | null = null;
  setDaemonRpcSender(async (workspaceId, payload) => {
    sent = { workspaceId, payload };
    // Simulate daemon replying immediately
    const corrId = (payload as { correlationId: string }).correlationId;
    setTimeout(
      () =>
        deliverDaemonReply(corrId, {
          memory: [{ pageId: 'p1', path: 'a.md', score: 0.9 }],
          files: [],
          cursor: null,
          took_ms: 12,
        }),
      5,
    );
  });

  process.env.FF_MEMORY_SEARCH_DAEMON_FIRST = 'true';
  const svc = new MemorySearchService();
  const res = await svc.search({
    acl: { workspaceId: 'ws_rpc', actorImUserId: 'im_x', actorKind: 'human' } as never,
    query: 'oauth',
  } as never);
  delete process.env.FF_MEMORY_SEARCH_DAEMON_FIRST;

  assert.ok(sent !== null, 'sendDaemonRpc should have been called');
  assert.equal((sent as unknown as { workspaceId: string }).workspaceId, 'ws_rpc');
  assert.equal(res.ok, true);
  assert.equal(res.data?.memory.length, 1);
});

test('forwardToDaemon timeout → falls back + records failure', async () => {
  __resetDualPathStates();
  registerDaemonPresence('ws_timeout', 'daemon_1');
  setDaemonRpcSender(async () => {
    /* no reply ever sent → timeout fires */
  });

  process.env.FF_MEMORY_SEARCH_DAEMON_FIRST = 'true';
  const svc = new MemorySearchService();
  await svc
    .search({
      acl: { workspaceId: 'ws_timeout', actorImUserId: 'im_x', actorKind: 'human' } as never,
      query: 'x',
    } as never)
    .catch(() => {});
  delete process.env.FF_MEMORY_SEARCH_DAEMON_FIRST;
  const s = getDualPathState('ws_timeout');
  assert.equal(s.recentFailures, 1, 'timeout should count as ping failure');
});

test('rejectDaemonReply propagates an error to forwardToDaemon caller', async () => {
  __resetDualPathStates();
  registerDaemonPresence('ws_reject', 'daemon_1');
  setDaemonRpcSender(async (_, payload) => {
    const corrId = (payload as { correlationId: string }).correlationId;
    setTimeout(() => rejectDaemonReply(corrId, new Error('daemon WS closed mid-rpc')), 5);
  });

  process.env.FF_MEMORY_SEARCH_DAEMON_FIRST = 'true';
  const svc = new MemorySearchService();
  await svc
    .search({
      acl: { workspaceId: 'ws_reject', actorImUserId: 'im_x', actorKind: 'human' } as never,
      query: 'x',
    } as never)
    .catch(() => {});
  delete process.env.FF_MEMORY_SEARCH_DAEMON_FIRST;
  // Failure recorded
  const s = getDualPathState('ws_reject');
  assert.equal(s.recentFailures, 1);
});

// ─── runner ───────────────────────────────────────────────────

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL  ${t.name}\n        ${(err as Error).message}`);
      failed++;
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
})();
