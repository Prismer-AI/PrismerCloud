// Deterministic unit test for Step 4 recall-before-write reliability:
// assemblePlaceContext must surface RECENTLY-WRITTEN leaves even when FTS
// returns nothing (mismatched query / unindexed just-written page). Without the
// recency merge, `nearest` would be [] and the agent couldn't see the earlier
// write to EXTEND it. No pod, no LLM — pure store + assembly logic.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from './src/daemon/memory/store';
import { assemblePlaceContext } from './src/daemon/memory/hook-server';

const dir = mkdtempSync(join(tmpdir(), 'recall-'));
const store = new MemoryStore({ dbPath: join(dir, 'm.db'), workspaceId: 'ws1', deviceId: 'dev1' });
store.open();

const leaves: Array<[string, string]> = [
  ['decisions/nimbus-d1', 'Nimbus D-1 architecture decision'],
  ['decisions/nimbus-throughput', 'Nimbus throughput metrics'],
  ['decisions/nimbus-security', 'Nimbus security policy'],
];
for (const [p, t] of leaves) {
  store.write({
    workspaceId: 'ws1', path: p, content: `<h1>${t}</h1><p>body about ${t}.</p>`,
    pageType: 'leaf', title: t, description: `${t} — one-line summary.`,
    actorImUserId: 'agent1', actorKind: 'agent',
  });
}

// Fake slot: REAL store + a search that returns NOTHING (simulates FTS miss on a
// restate query with different wording / CJK tokenization / unindexed row).
const slot = { store, search: { hybrid: () => [] } } as any;
const parts = assemblePlaceContext(slot, 'an unrelated query about the weather forecast');

const surfaced = parts.nearest.map((n: any) => n.path);
console.log('[recall] FTS returned [] (miss). nearest after recency-merge =', JSON.stringify(surfaced));
const allSeen = leaves.every(([p]) => surfaced.includes(p));
console.log(allSeen
  ? `✅ PASS — all ${leaves.length} recently-written leaves surfaced despite empty FTS (agent can now see the earlier write to EXTEND it)`
  : `❌ FAIL — recent writes NOT surfaced (nearest=${JSON.stringify(surfaced)})`);
store.close();
