// spec16 §8.2/§8.3 — cap v2: mint ONLY from a valid Cloud authority snapshot.
//
// Fixed product parameters:
//   - Cloud authority snapshot lease: 60 minutes;
//   - agent cap TTL: 15 minutes AND cap.exp <= snapshot.validUntil;
//   - the daemon may refresh short caps offline inside the snapshot lease,
//     never beyond snapshot expiry;
//   - lease expired + Cloud unreachable → non-system Memory RPC fail closed
//     (no v2 cap can be minted once the registered snapshot expires; a stale
//     snapshot can never be infinitely re-let);
//   - v1 decode kept for ONE compat cycle (old caps still verify); NEW mints
//     only emit v2.
//
// RED contract for THIS task (Task 10): the imports below target the future
// exports in `src/daemon/memory/cap.ts` (registerMemoryAuthoritySnapshot /
// mintCapV2 / snapshot helpers). Expected RED failure mode = import/export
// resolution failure, NOT a syntax error.

import { afterEach, describe, expect, it } from 'vitest';
import {
  mintCap,
  mintCapV2,
  renewCapV2,
  mintSystemCap,
  verifyCap,
  capAllowsWorkspace,
  isSystemCap,
  registerMemoryAuthoritySnapshot,
  invalidateMemoryAuthoritySnapshot,
  getMemoryAuthoritySnapshot,
  computeMemoryAuthoritySnapshotHash,
  verifyMemoryAuthoritySnapshotHash,
  MEMORY_CAP_TTL_MS,
  MEMORY_RUNTIME_CAPABILITIES_V1,
  __resetCapKeyForTest,
  type MemoryAuthoritySnapshotBundleV1,
} from '../src/daemon/memory/cap.js';
import { canCapReadPage, capToReader, canReaderReadVisibility, type MemoryReader } from '../src/daemon/memory/acl-predicate.js';

const NOW = Date.parse('2026-08-15T00:00:00.000Z');
const LEASE_MS = 60 * 60 * 1000;

afterEach(() => {
  __resetCapKeyForTest();
  invalidateMemoryAuthoritySnapshot('ws_snap');
  invalidateMemoryAuthoritySnapshot('ws_golden');
  invalidateMemoryAuthoritySnapshot('ws_other');
});

// ─── snapshot fixture (valid, canonical) ─────────────────────────────────────

function makeSnapshot(overrides: Partial<MemoryAuthoritySnapshotBundleV1> = {}): MemoryAuthoritySnapshotBundleV1 {
  return {
    schemaVersion: 1,
    workspaceId: 'ws_snap',
    daemonId: 'd_snap',
    replicaMode: 'strict',
    minRuntimeVersion: '2.2.12',
    requiredRuntimeCapabilities: [
      'memory-authority-snapshot-v1',
      'memory-replica-manifest-v1',
      'memory-replica-content-v1',
    ],
    accessVersion: 7,
    replicaSubjectHash: 'aaaa1111',
    issuedAt: new Date(NOW).toISOString(),
    validUntil: new Date(NOW + LEASE_MS).toISOString(),
    actors: [
      {
        actorId: 'a_deputy',
        actorKind: 'agent',
        principalKind: 'human',
        principalId: 'u_member',
        authority: 'deputy',
        bindingId: 'ws_snap:u_member',
        roleSlugs: ['deputy-role'],
        taskIds: ['t_1'],
        councilIds: ['c_1'],
        canCurate: false,
        canReplicate: true,
      },
      {
        actorId: 'a_orch',
        actorKind: 'agent',
        principalKind: 'human',
        principalId: 'u_owner',
        authority: 'orchestrator',
        roleSlugs: ['orchestrator-role'],
        taskIds: [],
        councilIds: [],
        canCurate: true,
        canReplicate: true,
      },
      {
        actorId: 'a_spec',
        actorKind: 'agent',
        principalKind: 'workspace',
        principalId: 'ws_snap',
        authority: 'specialist',
        roleSlugs: [],
        taskIds: [],
        councilIds: [],
        canCurate: false,
        canReplicate: true,
      },
    ],
    snapshotHash: '',
    ...overrides,
  };
}

/** Snapshot whose snapshotHash matches its canonical body (valid bundle). */
function makeValidSnapshot(overrides: Partial<MemoryAuthoritySnapshotBundleV1> = {}): MemoryAuthoritySnapshotBundleV1 {
  const base = makeSnapshot(overrides);
  const hash = computeMemoryAuthoritySnapshotHash(base);
  return { ...base, snapshotHash: hash };
}

// ─── canonical hash golden vector (pins BOTH ends: cloud src + daemon) ──────

describe('canonical snapshot hash — golden vector shared with Cloud', () => {
  it('produces the SAME sha256 the cloud side pins', () => {
    const body = {
      schemaVersion: 1,
      workspaceId: 'ws_w',
      daemonId: 'd1',
      replicaMode: 'legacy',
      minRuntimeVersion: '2.2.12',
      requiredRuntimeCapabilities: [
        'memory-authority-snapshot-v1',
        'memory-replica-manifest-v1',
        'memory-replica-content-v1',
      ],
      accessVersion: 12345,
      replicaSubjectHash: 'abc123',
      issuedAt: '2026-08-15T00:00:00.000Z',
      validUntil: '2026-08-15T01:00:00.000Z',
      actors: [],
    };
    expect(computeMemoryAuthoritySnapshotHash(body)).toBe(
      'sha256:cc101423dfafd6015d004cfea3f46cb2256d9d81b1d8404243aec02bc1db506f',
    );
  });
});

// ─── snapshot registration (60m lease, hash/configVersion gate) ─────────────

describe('registerMemoryAuthoritySnapshot — fail-closed registry (§8.2/§8.3)', () => {
  it('registers a valid, unexpired, hash-correct snapshot', () => {
    const snap = makeValidSnapshot();
    expect(registerMemoryAuthoritySnapshot(snap, 'd_snap', NOW)).toBe(true);
    expect(getMemoryAuthoritySnapshot('ws_snap')).toEqual(snap);
  });

  it('NEGATIVE (I1): daemonId mismatch → rejected; registry stays empty and mint stays closed', () => {
    const snap = makeValidSnapshot(); // daemonId = 'd_snap'
    expect(registerMemoryAuthoritySnapshot(snap, 'd_intruder', NOW)).toBe(false);
    expect(getMemoryAuthoritySnapshot('ws_snap')).toBeNull();
    expect(mintCapV2('a_deputy', 'ws_snap', { now: NOW })).toBeNull();
  });

  it('NEGATIVE (I1): a later registration cannot switch the process-bound daemon id', () => {
    expect(registerMemoryAuthoritySnapshot(makeValidSnapshot(), 'd_snap', NOW)).toBe(true);
    const intruder = makeValidSnapshot({ daemonId: 'd_intruder' });
    expect(registerMemoryAuthoritySnapshot(intruder, 'd_intruder', NOW)).toBe(false);
    // 原 snapshot 仍有效（daemonId 匹配本进程绑定 id）→ mint 正常。
    expect(mintCapV2('a_deputy', 'ws_snap', { now: NOW })).not.toBeNull();
  });

  it('NEGATIVE: tampered body (hash mismatch) → rejected, nothing registered', () => {
    const snap = makeValidSnapshot();
    const tampered = { ...snap, actors: snap.actors.map((a) => (a.actorId === 'a_deputy' ? { ...a, taskIds: ['t_forged'] } : a)) };
    expect(verifyMemoryAuthoritySnapshotHash(tampered)).toBe(false);
    expect(registerMemoryAuthoritySnapshot(tampered, 'd_snap', NOW)).toBe(false);
    expect(getMemoryAuthoritySnapshot('ws_snap')).toBeNull();
  });

  it('NEGATIVE: expired snapshot (now >= validUntil) → rejected', () => {
    const snap = makeValidSnapshot({ issuedAt: new Date(NOW - 2 * LEASE_MS).toISOString(), validUntil: new Date(NOW - LEASE_MS).toISOString() });
    // expired body hash is still correct — expiry alone must reject.
    expect(registerMemoryAuthoritySnapshot(snap, 'd_snap', NOW)).toBe(false);
    expect(getMemoryAuthoritySnapshot('ws_snap')).toBeNull();
  });

  it('NEGATIVE: wrong schemaVersion / workspace shape → rejected', () => {
    const snap = makeValidSnapshot();
    expect(registerMemoryAuthoritySnapshot({ ...snap, schemaVersion: 2 }, 'd_snap', NOW)).toBe(false);
    expect(registerMemoryAuthoritySnapshot({ ...snap, workspaceId: 42 }, 'd_snap', NOW)).toBe(false);
    expect(registerMemoryAuthoritySnapshot({ ...snap, actors: 'nope' }, 'd_snap', NOW)).toBe(false);
    expect(getMemoryAuthoritySnapshot('ws_snap')).toBeNull();
  });

  it('epoch regression guard: a snapshot with LOWER accessVersion cannot replace the registered one', () => {
    const newer = makeValidSnapshot({ accessVersion: 9, replicaSubjectHash: 'bbbb2222' });
    expect(registerMemoryAuthoritySnapshot(newer, 'd_snap', NOW)).toBe(true);
    const stale = makeValidSnapshot({ accessVersion: 5, replicaSubjectHash: 'cccc3333' });
    expect(registerMemoryAuthoritySnapshot(stale, 'd_snap', NOW)).toBe(false);
    expect(getMemoryAuthoritySnapshot('ws_snap')!.accessVersion).toBe(9);
  });

  it('invalidateMemoryAuthoritySnapshot drops the registered snapshot (fail closed)', () => {
    expect(registerMemoryAuthoritySnapshot(makeValidSnapshot(), 'd_snap', NOW)).toBe(true);
    invalidateMemoryAuthoritySnapshot('ws_snap');
    expect(getMemoryAuthoritySnapshot('ws_snap')).toBeNull();
  });
});

// ─── cap v2 mint (only from a valid snapshot) ───────────────────────────────

describe('mintCapV2 — claims come from the snapshot actor row (§8.3)', () => {
  function register(overrides: Partial<MemoryAuthoritySnapshotBundleV1> = {}) {
    expect(registerMemoryAuthoritySnapshot(makeValidSnapshot(overrides), 'd_snap', NOW)).toBe(true);
  }

  it('mints v2 with full §8.3 claims for a deputy actor', () => {
    register();
    const token = mintCapV2('a_deputy', 'ws_snap', { now: NOW });
    expect(token).not.toBeNull();
    const cap = verifyCap(token, NOW);
    expect(cap).not.toBeNull();
    expect(cap).toMatchObject({
      sub: 'a_deputy',
      ws: 'ws_snap',
      scope: ['ws:ws_snap'],
      ver: 2,
      verbs: ['read', 'write'],
      principalKind: 'human',
      principalId: 'u_member',
      roleSlugs: ['deputy-role'],
      taskIds: ['t_1'],
      councilIds: ['c_1'],
      accessVersion: 7,
      replicaSubjectHash: 'aaaa1111',
    });
    expect(cap!.snapshotHash).toBe(makeValidSnapshot().snapshotHash);
    expect(cap!.isOrchestrator).toBeUndefined();
  });

  it('orchestrator actor: verbs include curate; principal = owner', () => {
    register();
    const cap = verifyCap(mintCapV2('a_orch', 'ws_snap', { now: NOW }), NOW)!;
    expect(cap.verbs).toEqual(['read', 'write', 'curate']);
    expect(cap.principalKind).toBe('human');
    expect(cap.principalId).toBe('u_owner');
  });

  it('specialist actor: principal = workspace', () => {
    register();
    const cap = verifyCap(mintCapV2('a_spec', 'ws_snap', { now: NOW }), NOW)!;
    expect(cap.principalKind).toBe('workspace');
    expect(cap.principalId).toBe('ws_snap');
    expect(cap.verbs).toEqual(['read', 'write']);
  });

  it('NEGATIVE: no registered snapshot → NO mint at all (fail closed, null)', () => {
    expect(mintCapV2('a_deputy', 'ws_snap', { now: NOW })).toBeNull();
  });

  it('NEGATIVE: actor not in snapshot → no mint (server-derived actor list is authoritative)', () => {
    register();
    expect(mintCapV2('a_stranger', 'ws_snap', { now: NOW })).toBeNull();
  });

  it('NEGATIVE: workspace/daemon mismatch (snapshot for another ws) → no mint', () => {
    register();
    expect(mintCapV2('a_deputy', 'ws_other', { now: NOW })).toBeNull();
  });

  it('NEGATIVE: expired snapshot → no mint (lease 到期 fail closed, 不可无限续租)', () => {
    register();
    expect(mintCapV2('a_deputy', 'ws_snap', { now: NOW + LEASE_MS + 1 })).toBeNull();
  });

  it('cap TTL is 15m and cap.exp <= snapshot.validUntil (upper bound at lease edge)', () => {
    register();
    expect(MEMORY_CAP_TTL_MS).toBe(15 * 60 * 1000);
    const token = mintCapV2('a_deputy', 'ws_snap', { now: NOW });
    const cap = verifyCap(token, NOW)!;
    expect(cap.exp).toBe(NOW + 15 * 60 * 1000);

    // Near the lease edge the cap is truncated so exp never crosses validUntil.
    const lateNow = NOW + LEASE_MS - 5 * 60 * 1000;
    const late = verifyCap(mintCapV2('a_deputy', 'ws_snap', { now: lateNow }), lateNow)!;
    expect(late.exp).toBe(NOW + LEASE_MS);
    expect(late.exp).toBeLessThanOrEqual(NOW + LEASE_MS);
  });

  it('offline refresh: re-mint inside the lease works without re-registering (daemon-local)', () => {
    register();
    const t0 = mintCapV2('a_deputy', 'ws_snap', { now: NOW });
    const t30 = mintCapV2('a_deputy', 'ws_snap', { now: NOW + 30 * 60 * 1000 });
    expect(t0).not.toBeNull();
    expect(t30).not.toBeNull();
    expect(verifyCap(t30!, NOW + 30 * 60 * 1000)).not.toBeNull();
    // ...but never beyond snapshot expiry.
    expect(mintCapV2('a_deputy', 'ws_snap', { now: NOW + LEASE_MS })).toBeNull();
  });

  it('renews an expired v2 cap only while current authority still grants the actor', () => {
    register();
    const expired = mintCapV2('a_deputy', 'ws_snap', { now: NOW })!;
    const refreshAt = NOW + MEMORY_CAP_TTL_MS + 1;

    const renewed = renewCapV2(expired, { now: refreshAt });

    expect(renewed).not.toBeNull();
    expect(verifyCap(renewed, refreshAt)).toMatchObject({
      sub: 'a_deputy',
      ws: 'ws_snap',
      accessVersion: 7,
      snapshotHash: makeValidSnapshot().snapshotHash,
    });
    invalidateMemoryAuthoritySnapshot('ws_snap');
    expect(renewCapV2(expired, { now: refreshAt })).toBeNull();
  });

  it('NEGATIVE: renewal rejects tampering, legacy v1, and an expired authority lease', () => {
    register();
    const expired = mintCapV2('a_deputy', 'ws_snap', { now: NOW })!;
    const tampered = expired.slice(0, -1) + (expired.endsWith('a') ? 'b' : 'a');

    expect(renewCapV2(tampered, { now: NOW + MEMORY_CAP_TTL_MS + 1 })).toBeNull();
    expect(renewCapV2(mintCap('im_alice', 'ws_a', { now: NOW }), { now: NOW + 1 })).toBeNull();
    expect(renewCapV2(expired, { now: NOW + LEASE_MS })).toBeNull();
  });

  it('v2 cap expiry at verify: expired v2 cap → null (fail closed at RPC gate)', () => {
    register();
    const token = mintCapV2('a_deputy', 'ws_snap', { now: NOW })!;
    expect(verifyCap(token, NOW + 15 * 60 * 1000 + 1)).toBeNull();
    expect(verifyCap(token, NOW)).not.toBeNull();
  });

  it('tampered v2 signature → null (same per-boot HMAC spine)', () => {
    register();
    const token = mintCapV2('a_deputy', 'ws_snap', { now: NOW })!;
    const flipped = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    expect(verifyCap(flipped, NOW)).toBeNull();
  });

  it('NEGATIVE CONTROL: v1 legacy mint still round-trips (one-compat-cycle decode; v1 remains the legacy minter)', () => {
    const v1 = mintCap('im_alice', 'ws_a', { now: NOW, ttlMs: 60_000 });
    const cap = verifyCap(v1, NOW);
    expect(cap).toEqual({ sub: 'im_alice', ws: 'ws_a', scope: ['ws:ws_a'] });
    expect(capAllowsWorkspace(cap!, 'ws_a')).toBe(true);
  });

  it('system cap unchanged (independent daemon-internal channel)', () => {
    const cap = verifyCap(mintSystemCap({ now: NOW }), NOW)!;
    expect(isSystemCap(cap)).toBe(true);
    expect(capAllowsWorkspace(cap, 'ws_snap')).toBe(true);
  });
});

// ─── predicate: actor/principal 双认（deputy 读绑定 member 的 human:*） ─────

describe('acl-predicate actor/principal adjudication (§8.3)', () => {
  it('capToReader projects principal/task claims from a v2 cap', () => {
    registerMemoryAuthoritySnapshot(makeValidSnapshot(), 'd_snap', NOW);
    const cap = verifyCap(mintCapV2('a_deputy', 'ws_snap', { now: NOW }), NOW)!;
    const reader = capToReader(cap);
    expect(reader).toMatchObject({
      imUserId: 'a_deputy',
      principalKind: 'human',
      principalId: 'u_member',
      taskIds: ['t_1'],
      councilIds: ['c_1'],
    });
  });

  it('deputy reads bound member\'s human:* page (modeled as private:<member>)', () => {
    registerMemoryAuthoritySnapshot(makeValidSnapshot(), 'd_snap', NOW);
    const cap = verifyCap(mintCapV2('a_deputy', 'ws_snap', { now: NOW }), NOW)!;
    expect(canCapReadPage(cap, { workspaceId: 'ws_snap', visibility: { kind: 'private', imUserId: 'u_member' } })).toBe(true);
  });

  it('NEGATIVE: deputy does NOT read another member\'s or agent\'s private pages (no scope widening)', () => {
    registerMemoryAuthoritySnapshot(makeValidSnapshot(), 'd_snap', NOW);
    const cap = verifyCap(mintCapV2('a_deputy', 'ws_snap', { now: NOW }), NOW)!;
    expect(canCapReadPage(cap, { workspaceId: 'ws_snap', visibility: { kind: 'private', imUserId: 'u_owner' } })).toBe(false);
    expect(canCapReadPage(cap, { workspaceId: 'ws_snap', visibility: { kind: 'private', imUserId: 'a_spec' } })).toBe(false);
    expect(canCapReadPage(cap, { workspaceId: 'ws_snap', visibility: { kind: 'agent', imUserId: 'a_spec' } })).toBe(false);
    // 自己的 agent/private 页面仍可读。
    expect(canCapReadPage(cap, { workspaceId: 'ws_snap', visibility: { kind: 'agent', imUserId: 'a_deputy' } })).toBe(true);
  });

  it('NEGATIVE: principal is NEVER used as cap sub (sub stays the actor)', () => {
    registerMemoryAuthoritySnapshot(makeValidSnapshot(), 'd_snap', NOW);
    const cap = verifyCap(mintCapV2('a_deputy', 'ws_snap', { now: NOW }), NOW)!;
    expect(cap.sub).toBe('a_deputy');
    expect(cap.sub).not.toBe('u_member');
    expect(canCapReadPage(cap, { workspaceId: 'ws_snap', visibility: { kind: 'private', imUserId: 'a_deputy' } })).toBe(true);
    // 绑定 member 的 agent:* 页面（该 member 是 human，不可能有 agent 页）…
    // deputy 只能读 principal 的 human 页 + 自己的 agent 页。
    expect(canCapReadPage(cap, { workspaceId: 'ws_snap', visibility: { kind: 'agent', imUserId: 'u_member' } })).toBe(false);
  });

  it('task visibility: v2 cap carries snapshot taskIds → readable; stranger task → denied', () => {
    registerMemoryAuthoritySnapshot(makeValidSnapshot(), 'd_snap', NOW);
    const cap = verifyCap(mintCapV2('a_deputy', 'ws_snap', { now: NOW }), NOW)!;
    expect(canCapReadPage(cap, { workspaceId: 'ws_snap', visibility: { kind: 'task', id: 't_1' } })).toBe(true);
    expect(canCapReadPage(cap, { workspaceId: 'ws_snap', visibility: { kind: 'task', id: 't_other' } })).toBe(false);
  });

  it('NEGATIVE: v1 cap has no principal/task claims → human/task reads fail closed (compat cycle)', () => {
    const v1 = verifyCap(mintCap('im_alice', 'ws_a', { now: NOW, ttlMs: 60_000 }), NOW)!;
    expect(v1.principalId).toBeUndefined();
    expect(v1.taskIds).toBeUndefined();
    expect(canCapReadPage(v1, { workspaceId: 'ws_a', visibility: { kind: 'private', imUserId: 'im_alice' } })).toBe(true);
    expect(canCapReadPage(v1, { workspaceId: 'ws_a', visibility: { kind: 'private', imUserId: 'someone_else' } })).toBe(false);
    expect(canCapReadPage(v1, { workspaceId: 'ws_a', visibility: { kind: 'task', id: 't_1' } })).toBe(false);
  });

  it('canReaderReadVisibility: reader-level principal rule matches the cap-level projection', () => {
    const reader: MemoryReader = { imUserId: 'a_deputy', principalKind: 'human', principalId: 'u_member', taskIds: ['t_1'] };
    expect(canReaderReadVisibility(reader, { kind: 'private', imUserId: 'u_member' })).toBe(true);
    expect(canReaderReadVisibility(reader, { kind: 'private', imUserId: 'u_owner' })).toBe(false);
    expect(canReaderReadVisibility(reader, { kind: 'task', id: 't_1' })).toBe(true);
    expect(canReaderReadVisibility(reader, { kind: 'task', id: 't_9' })).toBe(false);
  });

  it('cross-workspace: v2 cap never authorizes another workspace', () => {
    registerMemoryAuthoritySnapshot(makeValidSnapshot(), 'd_snap', NOW);
    const cap = verifyCap(mintCapV2('a_deputy', 'ws_snap', { now: NOW }), NOW)!;
    expect(capAllowsWorkspace(cap, 'ws_other')).toBe(false);
  });
});

// ─── runtime capability constants (host.declare 声明源) ─────────────────────

describe('MEMORY_RUNTIME_CAPABILITIES_V1 (daemon declare source)', () => {
  it('is the exact §8.2 three-capability list (single constant source)', () => {
    expect([...MEMORY_RUNTIME_CAPABILITIES_V1]).toEqual([
      'memory-authority-snapshot-v1',
      'memory-replica-manifest-v1',
      'memory-replica-content-v1',
    ]);
  });
});
