/**
 * Task LIST visibility scope — release202/09 regression.
 *
 * Guards the fix for "我指派给CEO的任务为什么其他角色可以看到并开始处理":
 * a regular (executor) agent must NEVER be able to enumerate other roles'
 * cards via `GET /tasks`, regardless of which filters it passes. Only humans /
 * admins / system and the workspace's active orchestrator see the whole board.
 *
 * Tests the pure decision fn `decideTaskListScope` (the handler resolves the
 * one async input — is-orchestrator — and delegates the matrix here).
 *
 * Run: npx vitest run src/im/tests/acp-task-list-scope.test.ts
 */

import { describe, expect, it } from 'vitest';
import { decideTaskListScope } from '../api/tasks';

const SELF = 'u_self';

function decide(
  role: string | undefined,
  isWorkspaceOrchestrator: boolean,
  query: Record<string, unknown> = {},
) {
  return decideTaskListScope({ role, isWorkspaceOrchestrator, query, selfImUserId: SELF });
}

describe('decideTaskListScope — executor agents are self-scoped on every filter', () => {
  it('executor agent, no filter → self-scope', () => {
    expect(decide('agent', false, {})).toBe('self-scope');
  });

  it('executor agent + status filter → self-scope (the bug: used to leak whole board)', () => {
    expect(decide('agent', false, { status: 'pending' })).toBe('self-scope');
  });

  it('executor agent + kind filter → self-scope', () => {
    expect(decide('agent', false, { kind: 'work_item,goal' })).toBe('self-scope');
  });

  it('executor agent + view filter → self-scope', () => {
    expect(decide('agent', false, { view: 'board' })).toBe('self-scope');
  });

  it('executor agent + capability filter → self-scope', () => {
    expect(decide('agent', false, { capability: 'code-review' })).toBe('self-scope');
  });
});

describe('decideTaskListScope — whole-board viewers', () => {
  it('human + filter → whole-board', () => {
    expect(decide('human', false, { status: 'assigned' })).toBe('whole-board');
  });

  it('admin + filter → whole-board', () => {
    expect(decide('admin', false, { kind: 'work_item' })).toBe('whole-board');
  });

  it('system + filter → whole-board', () => {
    expect(decide('system', false, { status: 'running' })).toBe('whole-board');
  });

  it('orchestrator agent + filter → whole-board (needs full board to coordinate)', () => {
    expect(decide('agent', true, { status: 'pending' })).toBe('whole-board');
  });

  it('human, no filter → self-scope (existing "default to my tasks")', () => {
    expect(decide('human', false, {})).toBe('self-scope');
  });

  it('orchestrator agent, no filter → self-scope (no-filter default applies to everyone)', () => {
    expect(decide('agent', true, {})).toBe('self-scope');
  });
});

describe('decideTaskListScope — already self-scoped queries pass through', () => {
  it('--mine (assigneeId == self) → pass-through', () => {
    expect(decide('agent', false, { assigneeId: SELF })).toBe('pass-through');
  });

  it('creatorId == self → pass-through', () => {
    expect(decide('human', false, { creatorId: SELF })).toBe('pass-through');
  });

  it('pass-through wins even for a privileged viewer', () => {
    expect(decide('human', false, { assigneeId: SELF, status: 'running' })).toBe('pass-through');
  });
});
