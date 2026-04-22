/**
 * @prismer/wire — tasks.ts test suite
 *
 * Covers TaskRouteStep, TaskRouteRequest, TaskRuntimeRouteStep,
 * WS event schemas (assigned / completed / needs_human) and the
 * TaskRouteEvent envelope union.
 */

import { describe, it, expect } from 'vitest';
import {
  TaskRouteStepSchema,
  TaskRouteRequestSchema,
  TaskRuntimeRouteStepSchema,
  TaskStepAssignedSchema,
  TaskStepCompletedSchema,
  TaskNeedsHumanSchema,
  TaskRouteEventSchema,
} from '../src/tasks.js';

function mustParse<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  return schema.parse(value);
}

function mustFail(schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown): void {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
}

describe('TaskRouteStep', () => {
  it('minimal step (capability only)', () => {
    mustParse(TaskRouteStepSchema, { capability: 'code.write' });
  });

  it('full step', () => {
    mustParse(TaskRouteStepSchema, {
      capability: 'code.review',
      assignee: 'agent:codex@MacBook',
      deadline: '2026-04-30T12:00:00Z',
    });
  });

  it('rejects empty capability', () => {
    mustFail(TaskRouteStepSchema, { capability: '' });
  });
});

describe('TaskRouteRequest', () => {
  it('valid multi-step request (spec §5.7 demo)', () => {
    mustParse(TaskRouteRequestSchema, {
      steps: [
        { capability: 'code.write', assignee: 'agent:claude-code@MacBook' },
        { capability: 'code.review', assignee: 'agent:codex@MacBook' },
        { capability: 'human.approve', assignee: 'user:tom' },
      ],
    });
  });

  it('rejects empty steps array', () => {
    mustFail(TaskRouteRequestSchema, { steps: [] });
  });

  it('rejects steps with non-string capability', () => {
    mustFail(TaskRouteRequestSchema, { steps: [{ capability: 123 }] });
  });
});

describe('TaskRuntimeRouteStep (persisted)', () => {
  it('parses a pending step', () => {
    mustParse(TaskRuntimeRouteStepSchema, {
      stepIdx: 0,
      capability: 'code.write',
      assignee: null,
      deadline: null,
      status: 'pending',
    });
  });

  it('parses a done step with completedBy', () => {
    mustParse(TaskRuntimeRouteStepSchema, {
      stepIdx: 1,
      capability: 'code.review',
      status: 'done',
      completedBy: 'agent:codex',
      completedAt: '2026-04-18T10:00:00Z',
    });
  });

  it('rejects invalid status', () => {
    mustFail(TaskRuntimeRouteStepSchema, {
      stepIdx: 0,
      capability: 'code.write',
      status: 'maybe',
    });
  });
});

describe('WS event schemas', () => {
  it('task.step.assigned', () => {
    mustParse(TaskStepAssignedSchema, {
      taskId: 't1',
      stepIdx: 0,
      assigneeId: 'agent:claude-code',
      capability: 'code.write',
    });
  });

  it('task.step.assigned allows null assignee (unmatched)', () => {
    mustParse(TaskStepAssignedSchema, {
      taskId: 't1',
      stepIdx: 0,
      assigneeId: null,
      capability: 'code.write',
    });
  });

  it('task.step.completed', () => {
    mustParse(TaskStepCompletedSchema, {
      taskId: 't1',
      stepIdx: 0,
      result: { artifactUrl: 'prismer://ctx/abc' },
      status: 'ok',
    });
  });

  it('task.step.completed rejects invalid status', () => {
    mustFail(TaskStepCompletedSchema, { taskId: 't1', stepIdx: 0, result: {}, status: 'queued' });
  });

  it('task.needs_human', () => {
    mustParse(TaskNeedsHumanSchema, {
      taskId: 't1',
      prompt: 'Approve the refactor?',
      stepIdx: 2,
      assignee: 'user:tom',
      ttlMs: 300_000,
    });
  });

  it('task.needs_human rejects non-positive ttlMs', () => {
    mustFail(TaskNeedsHumanSchema, { taskId: 't1', ttlMs: 0 });
  });
});

describe('TaskRouteEvent envelope', () => {
  it('wraps task.step.assigned', () => {
    mustParse(TaskRouteEventSchema, {
      type: 'task.step.assigned',
      data: { taskId: 't1', stepIdx: 0, assigneeId: 'agent:x', capability: 'code.write' },
    });
  });

  it('rejects mismatched type/data', () => {
    mustFail(TaskRouteEventSchema, {
      type: 'task.needs_human',
      data: { taskId: 't1', stepIdx: 0, result: {}, status: 'ok' },
    });
  });
});
