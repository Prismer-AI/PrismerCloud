import { describe, expect, it } from 'vitest';

import { TASK_KINDS } from '../db-notifications';

describe('ACP notification grouping', () => {
  it('keeps human approvals and existing task approvals in the task bell group', () => {
    expect(TASK_KINDS).toContain('approval_requested');
    expect(TASK_KINDS).toContain('task_approval_requested');
  });
});
