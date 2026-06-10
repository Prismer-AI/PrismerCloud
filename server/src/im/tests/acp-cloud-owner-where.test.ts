/**
 * release202/08 — numericId-aware owner-resolution primitives.
 *
 * Pins the security-sensitive identity matching that the api-key register +
 * agent.host.declare ownership checks depend on. The bug class these guard
 * against: api-key auth derives `cloudUserId` from `pc_api_keys.user_id`
 * (= `im_users.numericId`, a numeric string), NOT `im_users.userId`. A bare
 * `{ userId: cloudUserId }` lookup silently misses every account whose
 * `userId` was never backfilled to that numeric string.
 *
 * Two directions, one identity model:
 *   - cloudOwnerWhere(cloudUserId)  → Prisma OR clauses (FIND owner by cloud id)
 *   - ownerIdentityKeys(owner)      → key Set         (CHECK an agent's userId
 *                                                       belongs to a resolved owner)
 *
 * Security contracts asserted here:
 *   1. numericId clause is ONLY added for all-digit ids → a cuid cloudUserId
 *      never spuriously matches some account's numericId.
 *   2. malformed/oversized numeric input degrades to the userId clause, never throws.
 *   3. an agent whose userId matches neither the owner's userId nor numericId
 *      is rejected (the cross-account claim guard).
 */

import { describe, expect, it } from 'vitest';
import { cloudOwnerWhere, ownerIdentityKeys } from '../auth/middleware';

describe('cloudOwnerWhere — FIND direction (numericId-aware OR clauses)', () => {
  it('numeric cloudUserId → both userId and numericId clauses', () => {
    const clauses = cloudOwnerWhere('377');
    expect(clauses).toEqual([{ userId: '377' }, { numericId: BigInt(377) }]);
  });

  it('cuid cloudUserId → userId clause ONLY (no spurious numericId match)', () => {
    const clauses = cloudOwnerWhere('cmpfwvosd00azxzxmkn0rx83x');
    expect(clauses).toEqual([{ userId: 'cmpfwvosd00azxzxmkn0rx83x' }]);
    expect(clauses.some((c) => 'numericId' in c)).toBe(false);
  });

  it('mixed alphanumeric (has digits but not all-digit) → userId clause ONLY', () => {
    expect(cloudOwnerWhere('user-377')).toEqual([{ userId: 'user-377' }]);
    expect(cloudOwnerWhere('377x')).toEqual([{ userId: '377x' }]);
  });

  it('large all-digit id beyond Number range survives as BigInt', () => {
    const big = '9007199254740993'; // > Number.MAX_SAFE_INTEGER
    const clauses = cloudOwnerWhere(big);
    expect(clauses[1]).toEqual({ numericId: BigInt(big) });
  });

  it('empty / whitespace string is not treated as numeric', () => {
    expect(cloudOwnerWhere('')).toEqual([{ userId: '' }]);
    expect(cloudOwnerWhere(' 377 ')).toEqual([{ userId: ' 377 ' }]);
  });
});

describe('ownerIdentityKeys — CHECK direction (agent ownership guard)', () => {
  it('owner with both userId and numericId → both keys present', () => {
    const keys = ownerIdentityKeys({ userId: 'cmpOwner', numericId: BigInt(377) });
    expect(keys.has('cmpOwner')).toBe(true);
    expect(keys.has('377')).toBe(true);
    expect(keys.size).toBe(2);
  });

  it('owner with userId=null (only numericId) → numericId string key only', () => {
    const keys = ownerIdentityKeys({ userId: null, numericId: BigInt(377) });
    expect(keys.has('377')).toBe(true);
    expect(keys.size).toBe(1);
  });

  it('numericId as plain number is stringified consistently', () => {
    const keys = ownerIdentityKeys({ userId: null, numericId: 42 });
    expect(keys.has('42')).toBe(true);
  });

  it('owner with no identity → empty set (matches nothing, fail-closed)', () => {
    const keys = ownerIdentityKeys({ userId: null, numericId: null });
    expect(keys.size).toBe(0);
  });

  it('agent claimed by api-key register (userId = numericId string) is owned by the human owner', () => {
    // human owner: userId=null, numericId=377; agent.userId set to "377" at register
    const ownerKeys = ownerIdentityKeys({ userId: null, numericId: BigInt(377) });
    expect(ownerKeys.has('377')).toBe(true); // agent.userId === '377' → owned
  });

  it("cross-account guard: another owner's agent is NOT owned", () => {
    // connected human A: numericId=377; agent belongs to human B: userId='377'? no —
    // agent B carries B's identity (e.g. '500'), which is absent from A's key set.
    const ownerKeysA = ownerIdentityKeys({ userId: 'cmpA', numericId: BigInt(377) });
    const foreignAgentUserId = '500';
    expect(ownerKeysA.has(foreignAgentUserId)).toBe(false);
  });

  it('release202/09 §3.6 — userId↔numericId divergence: api-key cloudUserId=numericId still owns a userId-keyed agent', () => {
    // The winshare CEO bug. Human owner: numericId=2916, userId='909600419'
    // (the Go-userId, which diverges from numericId). api-key auth derives
    // cloudUserId='2916' (= numericId), so `cloudOwnerWhere('2916')` only
    // yields `[{userId:'2916'},{numericId:2916n}]` — neither matches the agent,
    // which was registered with userId='909600419'. The owner bridge resolves
    // the human, then unions `ownerIdentityKeys(owner)` into the clause.
    const cloudUserId = '2916'; // = pc_api_keys.user_id = owner.numericId
    const owner = { userId: '909600419', numericId: BigInt(2916) };

    // The bare api-key clause set CANNOT see the agent's userId.
    const apiKeyClauses = cloudOwnerWhere(cloudUserId);
    expect(apiKeyClauses).toEqual([{ userId: '2916' }, { numericId: BigInt(2916) }]);
    expect(apiKeyClauses.some((c) => 'userId' in c && c.userId === '909600419')).toBe(false);

    // The owner bridge yields BOTH identities, so the divergent agent matches.
    const ownerKeys = ownerIdentityKeys(owner);
    expect(ownerKeys.has('909600419')).toBe(true); // agent.userId → matched
    expect(ownerKeys.has('2916')).toBe(true); // numericId form also present
    expect(ownerKeys.size).toBe(2);

    // The widened union (cloudOwnerWhere ∪ {userId IN ownerKeys}) is what the
    // agentHint branch builds; the agent's userId='909600419' lands in it.
    const agentUserId = '909600419';
    expect(ownerKeys.has(agentUserId)).toBe(true);
  });
});
