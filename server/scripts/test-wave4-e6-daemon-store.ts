#!/usr/bin/env tsx
/**
 * Wave 4-E6 — Real SQLite test for ScopedMemoryStore + recall-injector.
 *
 * Validates:
 *   1. Bucketed filesystem layout (_shared.db + agents/<id>.db)
 *   2. Write to shared bucket — agent-private bucket isolated
 *   3. Write to agent-A bucket — not visible from agent-B bucket
 *   4. FTS5 search returns correct scope results
 *   5. searchForAgent merges shared + own-private but excludes other agents
 *   6. recall-injector builds correct [Relevant memory] block
 *   7. operatingPrinciples opt-out (enabled=false) → no injection
 *
 * No mocks. Real better-sqlite3 + real tmp dirs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ScopedMemoryStore } from '../sdk/prismer-cloud/runtime/src/daemon/memory/scoped-store.js';
import { buildRecallInjection } from '../sdk/prismer-cloud/runtime/src/daemon/memory/recall-injector.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wave4-e6-'));
console.log(`[test] tmp dir: ${TMP}`);

let passes = 0;
let failures = 0;

function check(name: string, cond: boolean, extra?: string): void {
  if (cond) {
    passes++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function group(name: string, fn: () => void): void {
  console.log(`\n[${name}]`);
  fn();
}

const WORKSPACE_ID = 'ws_test_001';
const DEVICE = 'device_test';
const AGENT_A = 'agent_alice';
const AGENT_B = 'agent_bob';

const store = new ScopedMemoryStore({
  rootDir: TMP,
  workspaceId: WORKSPACE_ID,
  workspaceSlug: 'test-workspace',
  deviceId: DEVICE,
});

// ─── Group 1: Layout ─────────────────────────────────────────────
group('layout', () => {
  store.write({
    scope: 'workspace-shared',
    path: 'team-rules.md',
    content: 'All agents follow the standard release process. Use semver for versioning.',
    title: 'Team Rules',
    actorImUserId: 'user_admin',
    actorKind: 'human',
  });
  store.write({
    scope: 'agent-private',
    agentImUserId: AGENT_A,
    path: 'alice-notes.md',
    content: 'Alice owns the billing migration. Stripe integration is on a feature branch.',
    title: "Alice's notes",
    actorImUserId: AGENT_A,
    actorKind: 'agent',
  });
  store.write({
    scope: 'agent-private',
    agentImUserId: AGENT_B,
    path: 'bob-notes.md',
    content: 'Bob is debugging memory leak. Heap dump showed retention in cache layer.',
    title: "Bob's notes",
    actorImUserId: AGENT_B,
    actorKind: 'agent',
  });

  const sharedPath = path.join(TMP, 'test-workspace', '_shared.db');
  const aliceBucket = path.join(TMP, 'test-workspace', 'agents', `${AGENT_A}.db`);
  const bobBucket = path.join(TMP, 'test-workspace', 'agents', `${AGENT_B}.db`);

  check('shared.db exists', fs.existsSync(sharedPath));
  check('agents/alice.db exists', fs.existsSync(aliceBucket));
  check('agents/bob.db exists', fs.existsSync(bobBucket));
  check(
    'shared.db and agents are different files',
    fs.statSync(sharedPath).ino !== fs.statSync(aliceBucket).ino &&
      fs.statSync(aliceBucket).ino !== fs.statSync(bobBucket).ino,
  );

  const buckets = store.listAgentBuckets();
  check('listAgentBuckets reports both agents', buckets.includes(AGENT_A) && buckets.includes(AGENT_B));
});

// ─── Group 2: Cross-bucket isolation ─────────────────────────────
group('isolation', () => {
  // Alice's bucket should not contain Bob's content
  const aliceResults = store.search({
    query: 'memory leak heap',
    scope: 'agent-private',
    agentImUserId: AGENT_A,
  });
  check(
    'alice bucket does not contain bob content',
    aliceResults.length === 0,
    `expected 0 results, got ${aliceResults.length}`,
  );

  const bobResults = store.search({
    query: 'billing Stripe migration',
    scope: 'agent-private',
    agentImUserId: AGENT_B,
  });
  check(
    'bob bucket does not contain alice content',
    bobResults.length === 0,
    `expected 0 results, got ${bobResults.length}`,
  );

  // Shared bucket should be queryable from either agent perspective
  const sharedFromAlice = store.search({
    query: 'release semver',
    scope: 'workspace-shared',
  });
  check('shared bucket queryable', sharedFromAlice.length > 0);
});

// ─── Group 3: searchForAgent merges shared + own-private ─────────
group('searchForAgent', () => {
  const aliceMerged = store.searchForAgent('Alice billing Stripe', AGENT_A, { topK: 5 });
  check(
    "Alice's merged search includes her own private notes",
    aliceMerged.some((r) => r.path === 'alice-notes.md'),
  );
  check(
    "Alice's merged search excludes Bob's private notes",
    !aliceMerged.some((r) => r.path === 'bob-notes.md'),
  );

  const bobMerged = store.searchForAgent('Bob memory leak debug', AGENT_B, { topK: 5 });
  check(
    "Bob's merged search includes his own private notes",
    bobMerged.some((r) => r.path === 'bob-notes.md'),
  );
  check(
    "Bob's merged search excludes Alice's private notes",
    !bobMerged.some((r) => r.path === 'alice-notes.md'),
  );

  // Both agents should see shared rule
  const aliceShared = store.searchForAgent('release semver versioning', AGENT_A, { topK: 5 });
  const bobShared = store.searchForAgent('release semver versioning', AGENT_B, { topK: 5 });
  check(
    'shared rule visible to Alice',
    aliceShared.some((r) => r.path === 'team-rules.md'),
  );
  check(
    'shared rule visible to Bob',
    bobShared.some((r) => r.path === 'team-rules.md'),
  );
});

// ─── Group 4: Defensive — resolve() rejects bad combos ───────────
group('resolve guards', () => {
  let threw = false;
  try {
    store.write({
      scope: 'workspace-shared',
      agentImUserId: AGENT_A,
      path: 'invalid.md',
      content: 'x',
      actorImUserId: AGENT_A,
      actorKind: 'agent',
    });
  } catch (e) {
    threw = true;
  }
  check('workspace-shared with agentImUserId is rejected', threw);

  threw = false;
  try {
    store.write({
      scope: 'agent-private',
      path: 'invalid.md',
      content: 'x',
      actorImUserId: AGENT_A,
      actorKind: 'agent',
    });
  } catch (e) {
    threw = true;
  }
  check('agent-private without agentImUserId is rejected', threw);

  threw = false;
  try {
    store.forAgent('../../../etc/passwd');
  } catch (e) {
    threw = true;
  }
  check('directory-traversal in agentImUserId rejected', threw);
});

// ─── Group 5: Recall auto-inject ─────────────────────────────────
group('recall-injector', () => {
  // FTS5 uses implicit AND between tokens; the query must overlap with the
  // indexed corpus. Use words that actually appear in alice-notes.md.
  const inj1 = buildRecallInjection(store, {
    text: 'billing Stripe migration',
    agentImUserId: AGENT_A,
    topK: 3,
    minScore: 0.0,
  });
  check('alice billing query produces a system block', inj1.systemBlock !== null);
  check(
    'alice billing block contains [Relevant memory] header',
    inj1.systemBlock?.startsWith('[Relevant memory]') ?? false,
  );
  check(
    'alice billing block surfaces own private note',
    inj1.systemBlock?.includes('alice-notes.md') === true || inj1.selectedResults.some((r) => r.path === 'alice-notes.md'),
  );

  // opt-out via enabled=false (operatingPrinciples)
  const inj2 = buildRecallInjection(store, {
    text: 'I need to update the billing flow',
    agentImUserId: AGENT_A,
    enabled: false,
  });
  check('enabled=false → no injection', inj2.systemBlock === null);
  check('enabled=false → skipReason=disabled', inj2.skipReason === 'disabled');

  // empty query
  const inj3 = buildRecallInjection(store, {
    text: '   ',
    agentImUserId: AGENT_A,
  });
  check('empty query → no injection', inj3.systemBlock === null);

  // threshold above any plausible score → no injection
  const inj4 = buildRecallInjection(store, {
    text: 'unrelated cosmological topic gravitational waves',
    agentImUserId: AGENT_A,
    minScore: 0.999,
  });
  check('high threshold + irrelevant query → no injection', inj4.systemBlock === null);
});

// ─── Group 6: Disk footprint diagnostics ─────────────────────────
group('diagnostics', () => {
  const disk = store.diskBytes();
  check('disk.shared > 0', disk.shared > 0);
  check('disk.perAgent has alice + bob', disk.perAgent[AGENT_A] > 0 && disk.perAgent[AGENT_B] > 0);
  check(
    'disk.total = shared + sum(perAgent)',
    disk.total === disk.shared + Object.values(disk.perAgent).reduce((a, b) => a + b, 0),
  );
});

store.close();

console.log(`\n[test] ${passes} passed, ${failures} failed`);
console.log(`[test] cleanup: rm -rf ${TMP}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
