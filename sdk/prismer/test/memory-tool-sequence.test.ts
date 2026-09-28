// memory211/01 §6.11 D11-4 (W7 item 4) — the tool-sequence ring + turn metrics.
//
// Acceptance (spec §6.11 item 4): after a search → browse → load sequence the
// per-workspace ring contains all three verbs; the ring is capped at 200
// entries per workspace; and it records ONLY verb + path + duration + timestamp
// (+ the two behavioural flags the turn metric needs) — never the query text.
// The turn summary derived from the same entries feeds `turn.navigation_used` /
// `turn.shortcuts_taken` (registry: src/im/services/metric-registry.ts 52-53).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintSystemCap } from '../src/daemon/memory/cap.js';
import {
  ALLOWED_ENTRY_KEYS,
  R5_ROUND_GAP_MS,
  TOOL_SEQUENCE_RING_LIMIT,
  getToolSequence,
  getToolSequenceSince,
  recordToolSequence,
  resetToolSequenceRing,
  summarizeR5Turn,
  summarizeR5TurnFor,
  summarizeToolTurn,
  summarizeToolTurnFor,
  type ToolSequenceEntry,
} from '../src/daemon/memory/tool-sequence.js';
// B-3 contract oracle (Minor 2) — the cloud registry is the semantics
// authority; the daemon analyzer mirrors it and the parity test below proves
// they cannot drift. metric-registry.ts is pure (no runtime imports), so the
// daemon test can consume it directly.
import {
  R5_ROUND_GAP_MS as CLOUD_R5_ROUND_GAP_MS,
  summarizeR5Turn as cloudSummarizeR5Turn,
} from '../../../src/im/services/metric-registry.js';

let cleanupDirs: string[] = [];
let server: LocalServer | undefined;
let runtime: MemoryRuntime | undefined;
let baseUrl = '';
let sysCap = '';

const baseState: LocalServerState = {
  daemonId: 'dev_x',
  daemonVersion: '0.0.0-test',
  cloudBaseUrl: 'http://cloud.test',
  workspaceId: null,
  pid: 99999,
  startedAt: Date.now(),
  wsConnected: false,
  hostedAgents: [],
  runningTaskIds: [],
};

beforeEach(async () => {
  // Placement is not under test here; keep the legacy flat-write posture.
  process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE = 'warn';
  resetToolSequenceRing();
  const dir = mkdtempSync(join(tmpdir(), 'prismer-tool-sequence-'));
  cleanupDirs.push(dir);
  sysCap = mintSystemCap();
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
  server = new LocalServer({
    port: 0,
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime }),
  });
  await server.start();
  baseUrl = boundBaseUrl(server);
});

afterEach(async () => {
  resetToolSequenceRing();
  delete process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE;
  await server?.stop();
  runtime?.closeAll();
  for (const d of cleanupDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { 'x-prismer-memory-cap': sysCap } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': sysCap },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function seedPages(): Promise<void> {
  await post('/local/memory/write', {
    workspaceId: 'ws_seq',
    path: 'INDEX.md',
    content: '# index\n\n- aurora/index.md',
    pageType: 'hub',
    title: 'Workspace Index',
    actorImUserId: 'im_alice',
    actorKind: 'human',
  });
  await post('/local/memory/write', {
    workspaceId: 'ws_seq',
    path: 'aurora/index.md',
    content: '# aurora\n\n## quorum-rings\n\nQuorum rings order themselves by lease age.',
    pageType: 'hub',
    title: 'Aurora',
    actorImUserId: 'im_alice',
    actorKind: 'human',
  });
  resetToolSequenceRing('ws_seq'); // seeding writes are not the behaviour under test
}

describe('tool-sequence ring — unit', () => {
  it('CONTROL — the entry shape is a closed key set (the privacy boundary)', () => {
    const entry: ToolSequenceEntry = {
      verb: 'search',
      path: '',
      durationMs: 3,
      at: new Date().toISOString(),
      queries: 2,
      navigation: 1,
    };
    recordToolSequence('ws_unit', entry);
    const stored = getToolSequence('ws_unit')[0]!;
    expect(Object.keys(stored).sort()).toEqual([...ALLOWED_ENTRY_KEYS].filter((k) => stored[k] !== undefined).sort());
    for (const key of Object.keys(stored)) {
      expect(ALLOWED_ENTRY_KEYS, `${key} is not an allowed field`).toContain(key as never);
    }
    // The one thing this ring must never carry:
    expect(JSON.stringify(stored)).not.toContain('queryText');
    expect(stored).not.toHaveProperty('query');
  });

  it('caps at 200 entries per workspace, oldest dropped, workspaces isolated', () => {
    for (let i = 0; i < TOOL_SEQUENCE_RING_LIMIT + 25; i++) {
      recordToolSequence('ws_cap', { verb: 'load', path: `p${i}.md`, durationMs: 1, at: new Date().toISOString() });
    }
    recordToolSequence('ws_other', { verb: 'load', path: 'x.md', durationMs: 1, at: new Date().toISOString() });

    const ring = getToolSequence('ws_cap');
    expect(ring.length).toBe(TOOL_SEQUENCE_RING_LIMIT);
    expect(ring[0]!.path).toBe('p25.md'); // the first 25 were dropped
    expect(ring[ring.length - 1]!.path).toBe('p224.md');
    expect(getToolSequence('ws_other').length).toBe(1);
  });

  it('summarizeToolTurn — the four behaviour shapes', () => {
    const e = (verb: ToolSequenceEntry['verb'], navigation?: 0 | 1): ToolSequenceEntry => ({
      verb,
      path: verb === 'load' ? 'aurora/index.md' : '',
      durationMs: 1,
      at: new Date().toISOString(),
      ...(navigation !== undefined ? { navigation } : {}),
    });

    // Progressive disclosure: browse → load. Navigation used, no shortcut.
    expect(summarizeToolTurn([e('browse'), e('load')])).toEqual({ navigationUsed: 1, shortcutsTaken: 0 });
    // Direct recall shortcut: a straight load, no browse.
    expect(summarizeToolTurn([e('load')])).toEqual({ navigationUsed: 0, shortcutsTaken: 1 });
    // Miss-lane navigation ACTED on: search(navigation) → load.
    expect(summarizeToolTurn([e('search', 1), e('load')])).toEqual({ navigationUsed: 1, shortcutsTaken: 1 });
    // 乱枪: repeated searches, miss lane offered but never followed. Not used.
    expect(summarizeToolTurn([e('search', 1), e('search', 1), e('search', 1)])).toEqual({
      navigationUsed: 0,
      shortcutsTaken: 0,
    });
    // Nothing happened ⇒ no row at all (never a zero row).
    expect(summarizeToolTurn([])).toBeNull();
    expect(summarizeToolTurnFor(null, 0)).toBeNull();
    expect(summarizeToolTurnFor('ws_none', 0)).toBeNull();
  });
});

describe('summarizeR5Turn — R5 first-round analysis (memory211/03 §7.2 B4, B-3)', () => {
  /** Synthetic entry factory on an advancing clock. The default step keeps
   *  consecutive calls in one round; pass a larger `step` to split rounds. */
  function clocked(
    step = 250,
  ): (verb: ToolSequenceEntry['verb'], queries?: number, stepOverride?: number) => ToolSequenceEntry {
    let t = 1_000_000;
    return (verb, queries, stepOverride) => {
      t += stepOverride ?? step;
      const entry: ToolSequenceEntry = {
        verb,
        path: verb === 'load' ? 'aurora/index.md' : '',
        durationMs: 1,
        at: new Date(t).toISOString(),
      };
      if (queries !== undefined) entry.queries = queries;
      return entry;
    };
  }
  const gap = R5_ROUND_GAP_MS + 1; // strictly beyond the threshold → new round

  it('round grouping + hybrid / direct-read derivation — the shapes and the gap boundary', () => {
    const e = clocked();
    // Positive: hybrid first round — batch search (>=2 queries) + browse together.
    expect(summarizeR5Turn([e('search', 3), e('browse')])).toEqual({
      firstRoundHybrid: 1,
      firstRoundDirectRead: 0,
      toolRounds: 1,
    });
    // Negative control: single-query search + browse is NOT the R5 batch hybrid.
    expect(summarizeR5Turn([e('search', 1), e('browse')])).toEqual({
      firstRoundHybrid: 0,
      firstRoundDirectRead: 0,
      toolRounds: 1,
    });
    // Negative control: batch search with NO browse in the same round.
    expect(summarizeR5Turn([e('search', 3), e('search', 2)])).toEqual({
      firstRoundHybrid: 0,
      firstRoundDirectRead: 0,
      toolRounds: 1,
    });
    // Negative control: same batches, own rounds (the collapsed-to-round-count
    // pathological pattern) — still not hybrid, two rounds.
    expect(summarizeR5Turn([e('search', 3, gap), e('search', 2, gap)])).toEqual({
      firstRoundHybrid: 0,
      firstRoundDirectRead: 0,
      toolRounds: 2,
    });
    // Negative control: browse-only first round.
    expect(summarizeR5Turn([e('browse')])).toEqual({
      firstRoundHybrid: 0,
      firstRoundDirectRead: 0,
      toolRounds: 1,
    });
    // Positive: direct-recall shortcut — straight load first, no browse before it.
    expect(summarizeR5Turn([e('load')])).toEqual({
      firstRoundHybrid: 0,
      firstRoundDirectRead: 1,
      toolRounds: 1,
    });
    // Positive: load after a same-round search, still no browse first.
    expect(summarizeR5Turn([e('search', 1), e('load')])).toEqual({
      firstRoundHybrid: 0,
      firstRoundDirectRead: 1,
      toolRounds: 1,
    });
    // Negative control: progressive disclosure — browse precedes the load in
    // the first round; the load must NOT count as direct-read.
    expect(summarizeR5Turn([e('browse'), e('load')])).toEqual({
      firstRoundHybrid: 0,
      firstRoundDirectRead: 0,
      toolRounds: 1,
    });
    // Negative control: the load belongs to a LATER round (browse appeared
    // first; the gap applies to BOTH calls so the round actually splits).
    expect(summarizeR5Turn([e('browse', undefined, gap), e('load', undefined, gap)])).toEqual({
      firstRoundHybrid: 0,
      firstRoundDirectRead: 0,
      toolRounds: 2,
    });
  });

  it('gap boundary: exactly R5_ROUND_GAP_MS stays one round, +1 splits it', () => {
    const e = clocked();
    expect(summarizeR5Turn([e('search', 2, 1_000), e('browse', undefined, R5_ROUND_GAP_MS)])).toEqual({
      firstRoundHybrid: 1,
      firstRoundDirectRead: 0,
      toolRounds: 1,
    });
    expect(summarizeR5Turn([e('search', 2, 1_000), e('browse', undefined, R5_ROUND_GAP_MS + 1)])).toEqual({
      firstRoundHybrid: 0,
      firstRoundDirectRead: 0,
      toolRounds: 2,
    });
  });

  it('mixed shape: hybrid first round, then a browse walk — a realistic turn', () => {
    const e = clocked();
    expect(summarizeR5Turn([e('search', 3), e('browse'), e('browse', undefined, gap), e('load')])).toEqual({
      firstRoundHybrid: 1,
      firstRoundDirectRead: 0,
      toolRounds: 2,
    });
  });

  it('null-for-empty — no memory call ⇒ no row, never a {0,0,0} row (review Minor 1)', () => {
    expect(summarizeR5Turn([])).toBeNull();
    expect(summarizeR5TurnFor(null, 0)).toBeNull();
    expect(summarizeR5TurnFor('ws_no_r5', 0)).toBeNull();
  });

  it('parity with the cloud contract oracle (metric-registry.ts summarizeR5Turn) — no drift (review Minor 2)', () => {
    // The 2s round gap MUST be verbatim, never a local re-tune.
    expect(R5_ROUND_GAP_MS).toBe(CLOUD_R5_ROUND_GAP_MS);
    const e = clocked();
    const cases: ToolSequenceEntry[][] = [
      [e('search', 3), e('browse')],
      [e('search', 1), e('browse')],
      [e('search', 3), e('search', 2)],
      [e('search', 3, gap), e('search', 2, gap)],
      [e('browse')],
      [e('load')],
      [e('search', 1), e('load')],
      [e('browse'), e('load')],
      [e('browse', undefined, gap), e('load', undefined, gap)],
      [e('search', 2, 1_000), e('browse', undefined, R5_ROUND_GAP_MS)],
      [e('search', 2, 1_000), e('browse', undefined, R5_ROUND_GAP_MS + 1)],
      [e('search', 3), e('browse'), e('browse', undefined, gap), e('load')],
    ];
    for (const seq of cases) {
      const daemon = summarizeR5Turn(seq);
      expect(daemon).not.toBeNull();
      const oracle = cloudSummarizeR5Turn(
        seq.map((x) => ({ verb: x.verb, at: x.at, ...(x.queries !== undefined ? { queries: x.queries } : {}) })),
      );
      expect(daemon).toEqual(oracle);
    }
    // The one intentional divergence is documented, not silent: the daemon
    // expresses empty as null (no emitted row), the cloud pure function as
    // zeros (it is always called on non-empty turn slices there).
    expect(cloudSummarizeR5Turn([])).toEqual({ firstRoundHybrid: 0, firstRoundDirectRead: 0, toolRounds: 0 });
  });
});

describe('tool-sequence ring — over the real RPC', () => {
  it('ACCEPTANCE — a search → browse → load sequence lands all three verbs, in order', async () => {
    await seedPages();
    expect(
      (await get(`/local/memory/search?workspaceId=ws_seq&q=${encodeURIComponent('quorum')}&topK=5`)).status,
    ).toBe(200);
    expect((await get('/local/memory/place-context?workspaceId=ws_seq')).status).toBe(200);
    expect((await get('/local/memory/load?workspaceId=ws_seq&path=aurora/index.md')).status).toBe(200);

    const ring = getToolSequence('ws_seq');
    expect(ring.map((e) => e.verb)).toEqual(['search', 'browse', 'load']);
    expect(ring[2]!.path).toBe('aurora/index.md');
    expect(ring.every((e) => Number.isFinite(e.durationMs))).toBe(true);
    // A turn summary over exactly this window reads as progressive disclosure.
    expect(summarizeToolTurn(ring)).toEqual({ navigationUsed: 1, shortcutsTaken: 0 });
  });

  it('a write lands the fourth verb (the browse → load → write loop tail is visible)', async () => {
    await seedPages();
    await get('/local/memory/place-context?workspaceId=ws_seq');
    await get('/local/memory/load?workspaceId=ws_seq&path=aurora/index.md');
    await post('/local/memory/write', {
      workspaceId: 'ws_seq',
      path: 'aurora/notes.md',
      content: 'noted',
      pageType: 'leaf',
      title: 'notes',
      actorImUserId: 'im_alice',
      actorKind: 'agent',
    });
    resetToolSequenceRing('ws_other_untouched');
    const ring = getToolSequence('ws_seq');
    expect(ring.map((e) => e.verb)).toEqual(['browse', 'load', 'write']);
    expect(ring[2]!.path).toBe('aurora/notes.md');
  });

  it('a miss-lane search records navigation=1 with the query count (never the text)', async () => {
    await seedPages();
    await get(
      `/local/memory/search?workspaceId=ws_seq&q=${encodeURIComponent('zzz no such term qqq')}&topK=5`,
    );
    const ring = getToolSequence('ws_seq');
    expect(ring.length).toBe(1);
    expect(ring[0]!.navigation).toBe(1);
    expect(ring[0]!.queries).toBe(1);
    // Privacy: the query text cannot be reconstructed from the ring.
    expect(JSON.stringify(ring)).not.toContain('zzz');
  });

  it('CONTROL — a rejected write never enters the ring', async () => {
    await seedPages();
    // Section op without the cloud wiring → 503, nothing persisted, nothing recorded.
    await post('/local/memory/write', {
      workspaceId: 'ws_seq',
      path: 'aurora/index.md',
      content: 'body',
      op: 'append-section',
      section: 'quorum-rings',
      pageType: 'hub',
      actorImUserId: 'im_alice',
      actorKind: 'agent',
    });
    // A malformed write (no content) → 400.
    await post('/local/memory/write', { workspaceId: 'ws_seq', path: 'x.md' });
    expect(getToolSequence('ws_seq')).toEqual([]);
  });

  it('the dispatch turn window reads the ring by time (summarizeToolTurnFor)', async () => {
    await seedPages();
    const before = Date.now() - 1;
    await get(`/local/memory/search?workspaceId=ws_seq&q=${encodeURIComponent('quorum')}&topK=5`);
    await get('/local/memory/load?workspaceId=ws_seq&path=aurora/index.md');
    // A window that starts after the calls sees nothing; one that covers them
    // sees both. This is exactly the dispatch finally{} contract.
    expect(summarizeToolTurnFor('ws_seq', Date.now() + 5_000)).toBeNull();
    expect(summarizeToolTurnFor('ws_seq', before)).toEqual({ navigationUsed: 0, shortcutsTaken: 1 });
  });
});
