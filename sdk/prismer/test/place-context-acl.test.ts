// product204/34 Track 0.1c — assemblePlaceContext ACL.
//
// assemblePlaceContext returns `hubPages` (raw slot.store.list({pageType:'hub'}))
// + `nearest` (raw slot.search.hybrid + recent leaves) — all agent/LLM-facing
// (memory_browse RPC, extraction placement prompt, write-placement 422 hint).
// Without a reader filter every role:/council:/other-agent-private page leaks.
// A `reader` scopes both listings through the ONE canReaderReadVisibility matrix.
//
// Side-effect oracle = the returned PlaceContextParts structure (paths), not logs.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryRuntime } from '../src/daemon/memory/runtime.js';
import { assemblePlaceContext } from '../src/daemon/memory/hook-server.js';
import type { MemoryReader } from '../src/daemon/memory/acl-predicate.js';

const WS = 'ws_place_acl';
const TOKEN = 'quantumplacexyz';

let runtime: MemoryRuntime | undefined;
let baseDir = '';

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'prismer-place-acl-'));
  runtime = new MemoryRuntime({ baseDir, deviceId: 'dev_test' });
  const store = runtime.resolve(WS).store;
  // Two hubs (one workspace, one role:roleB) — exercises hubPages filter.
  store.write({ workspaceId: WS, path: 'arch-hub.md', content: 'architecture hub', pageType: 'hub', actorImUserId: 'im_seed', actorKind: 'human', visibility: { kind: 'workspace' } });
  store.write({ workspaceId: WS, path: 'roleB-hub.md', content: 'roleB hub', pageType: 'hub', actorImUserId: 'im_seed', actorKind: 'agent', visibility: { kind: 'role', slug: 'roleB' } });
  // Three leaves matching the shared token — exercises nearest (hybrid + recent).
  store.write({ workspaceId: WS, path: 'shared-leaf.md', content: `${TOKEN} note`, pageType: 'leaf', actorImUserId: 'im_seed', actorKind: 'human', visibility: { kind: 'workspace' } });
  store.write({ workspaceId: WS, path: 'roleB-leaf.md', content: `${TOKEN} note`, pageType: 'leaf', actorImUserId: 'im_seed', actorKind: 'agent', visibility: { kind: 'role', slug: 'roleB' } });
  store.write({ workspaceId: WS, path: 'convB-leaf.md', content: `${TOKEN} note`, pageType: 'leaf', actorImUserId: 'im_seed', actorKind: 'agent', visibility: { kind: 'council', id: 'convB' } });
});

afterEach(() => {
  runtime?.closeAll();
  if (baseDir) rmSync(baseDir, { recursive: true, force: true });
});

function place(reader?: MemoryReader): { hubs: string[]; nearest: string[] } {
  const parts = assemblePlaceContext(runtime!.resolve(WS), `${TOKEN} eviction`, reader);
  return { hubs: parts.hubPages.map((h) => h.path), nearest: parts.nearest.map((n) => n.path) };
}

describe('assemblePlaceContext ACL (product204/34 Track 0.1c)', () => {
  it('roleA/convA reader: role/council pages filtered from hubs AND nearest; workspace retained', () => {
    const { hubs, nearest } = place({ imUserId: 'agent_a', roleSlugs: ['roleA'], councilIds: ['convA'] });
    // workspace pages retained
    expect(hubs).toContain('arch-hub.md');
    expect(nearest).toContain('shared-leaf.md');
    // other role / council pages dropped from BOTH listings
    expect(hubs).not.toContain('roleB-hub.md');
    expect(nearest).not.toContain('roleB-leaf.md');
    expect(nearest).not.toContain('convB-leaf.md');
  });

  it('roleB reader: its own role hub + role leaf are allowed (positive); council-B still filtered', () => {
    const { hubs, nearest } = place({ imUserId: 'agent_b', roleSlugs: ['roleB'] });
    expect(hubs).toContain('roleB-hub.md');
    expect(nearest).toContain('roleB-leaf.md');
    expect(nearest).not.toContain('convB-leaf.md');
  });

  it('convB member reader: council-B leaf allowed (positive); roleB filtered', () => {
    const { hubs, nearest } = place({ imUserId: 'agent_c', councilIds: ['convB'] });
    expect(nearest).toContain('convB-leaf.md');
    expect(nearest).not.toContain('roleB-leaf.md');
    expect(hubs).not.toContain('roleB-hub.md');
  });

  it('no reader (enforce-off legacy) → unchanged: everything present', () => {
    const { hubs, nearest } = place(undefined);
    expect(hubs).toContain('arch-hub.md');
    expect(hubs).toContain('roleB-hub.md');
    expect(nearest).toContain('shared-leaf.md');
    expect(nearest).toContain('roleB-leaf.md');
    expect(nearest).toContain('convB-leaf.md');
  });

  it('system reader sees everything (daemon-internal)', () => {
    const { hubs, nearest } = place({ imUserId: 'daemon-system', isSystem: true });
    expect(hubs).toContain('roleB-hub.md');
    expect(nearest).toContain('roleB-leaf.md');
    expect(nearest).toContain('convB-leaf.md');
  });
});

// ─── product209/16 §8.3 — exact-actor-set pre-check ─────────────────────────
//
// A V3 REPLICATED row (replicaActorIdsJson NOT NULL) names the Cloud-generated
// exact actor set. The place-context hub/recent/nearest surfaces must check
// membership BEFORE the coarse visibility matrix (same semantics as
// acl-predicate canCapReadPage step 2): without it, a ready replica leaks a
// workspace-visible page to an actor the exact set excluded (the row was
// replicated for actor A only; actor B on the same daemon must not see it).
// Side-effect oracle = the returned PlaceContextParts paths, not logs.

describe('assemblePlaceContext exact-actor-set pre-check (product209/16 §8.3)', () => {
  function markReplica(path: string, actorIds: string[] | null): void {
    runtime!.resolve(WS).store
      .rawDb()
      .prepare('UPDATE memory_pages SET replicaActorIdsJson = ? WHERE workspaceId = ? AND path = ?')
      .run(actorIds === null ? null : JSON.stringify(actorIds), WS, path);
  }

  it('workspace-visible hub with exact set [agent_a] → agent_b excluded from hubs (negative: coarse visibility would pass)', () => {
    markReplica('arch-hub.md', ['im_agent_a']);
    const { hubs, nearest } = place({ imUserId: 'im_agent_b' });
    expect(hubs).not.toContain('arch-hub.md');
    // unrelated rows without a set (NULL) keep normal visibility — no over-blocking
    expect(nearest).toContain('shared-leaf.md');
  });

  it('same hub, exact set contains the reader → included (positive)', () => {
    markReplica('arch-hub.md', ['im_agent_a']);
    const { hubs } = place({ imUserId: 'im_agent_a' });
    expect(hubs).toContain('arch-hub.md');
  });

  it('workspace-visible leaf with exact set [agent_a] → agent_b excluded from nearest/recent (filterRecallHits pre-check)', () => {
    markReplica('shared-leaf.md', ['im_agent_a']);
    const { nearest } = place({ imUserId: 'im_agent_b' });
    expect(nearest).not.toContain('shared-leaf.md');
    // the set's own member still gets it — membership, not blanket exclusion
    expect(place({ imUserId: 'im_agent_a' }).nearest).toContain('shared-leaf.md');
  });

  it('empty exact set → deny all non-system readers even for workspace visibility (fail closed)', () => {
    markReplica('arch-hub.md', []);
    expect(place({ imUserId: 'im_agent_a' }).hubs).not.toContain('arch-hub.md');
    expect(place({ imUserId: 'im_agent_b' }).hubs).not.toContain('arch-hub.md');
  });

  it('NULL set (pre-V3 / local-authored) → unchanged visibility rules', () => {
    markReplica('arch-hub.md', null);
    expect(place({ imUserId: 'im_agent_b' }).hubs).toContain('arch-hub.md');
  });

  it('system reader bypasses the exact set (daemon-internal maintenance channel)', () => {
    markReplica('arch-hub.md', ['im_agent_a']);
    const { hubs, nearest } = place({ imUserId: 'daemon-system', isSystem: true });
    expect(hubs).toContain('arch-hub.md');
    expect(nearest).toContain('shared-leaf.md');
  });
});
