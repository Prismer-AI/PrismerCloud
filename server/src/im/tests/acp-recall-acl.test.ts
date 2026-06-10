/**
 * Release 201 P0-6 regression — /recall must apply MemoryAclContext to the
 * IMMemoryPage subquery. Without the predicate (the pre-201 behavior), any
 * workspace member could recall any visibility class.
 *
 * Run: npx vitest run src/im/tests/acp-recall-acl.test.ts
 */

import { describe, expect, it } from 'vitest';
import { pageVisibilityPredicate } from '../api/recall';
import type { MemoryAclContext } from '../services/memory-acl';

function ctx(allowed: string[], prefixes: string[] = []): MemoryAclContext {
  return {
    workspaceId: 'ws_test',
    callerImUserId: 'caller',
    callerKind: 'agent',
    allowedVisibilities: allowed,
    allowedVisibilityPrefixes: prefixes,
    canRead: () => true,
    canWrite: () => true,
  };
}

describe('recall ACL — pageVisibilityPredicate', () => {
  it('null ACL → null predicate (caller skipped entirely)', () => {
    expect(pageVisibilityPredicate(null)).toBeNull();
  });

  it('empty allowlist + empty prefixes → null (no visibility allowed)', () => {
    expect(pageVisibilityPredicate(ctx([], []))).toBeNull();
  });

  it('agent caller with one allowed visibility → exact-match predicate', () => {
    // Agent ACL: `['workspace', 'agent:<self>']` — most common shape from
    // memory-acl.ts:computeContext.
    const predicate = pageVisibilityPredicate(ctx(['workspace', 'agent:u_self']));
    expect(predicate).toEqual({ visibility: { in: ['workspace', 'agent:u_self'] } });
  });

  it('owner caller with prefix → combined OR predicate', () => {
    // Owner ACL: exact allowlist `['workspace', 'human:<id>', 'agent:<a1>', ...]`
    // + prefix `['task:']` for wildcard `task:<id>` matches.
    const predicate = pageVisibilityPredicate(
      ctx(['workspace', 'human:owner', 'agent:u_a1'], ['task:']),
    );
    expect(predicate).toEqual({
      OR: [
        { visibility: { in: ['workspace', 'human:owner', 'agent:u_a1'] } },
        { visibility: { startsWith: 'task:' } },
      ],
    });
  });

  it('agent A ACL does NOT include agent B private visibility (the leak this guards)', () => {
    // Pre-201, /recall queried IMMemoryPage WHERE workspaceId only — agent A
    // would receive rows with visibility='agent:u_b' (agent B's private
    // pages). With the ACL filter, the predicate restricts to A's allowlist.
    const aclForA = ctx(['workspace', 'agent:u_a']);
    const predicate = pageVisibilityPredicate(aclForA) as { visibility: { in: string[] } };
    expect(predicate.visibility.in).not.toContain('agent:u_b');
    expect(predicate.visibility.in).toContain('workspace');
    expect(predicate.visibility.in).toContain('agent:u_a');
  });

  it('predicate stays stable on repeat call (no hidden mutation of acl)', () => {
    const acl = ctx(['workspace'], ['task:']);
    const p1 = pageVisibilityPredicate(acl);
    const p2 = pageVisibilityPredicate(acl);
    expect(p1).toEqual(p2);
  });
});
