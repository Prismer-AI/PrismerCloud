// release202/09 §3.2 — PRISMER_RUN_ID vs PRISMER_TASK_ID split.
//
// A chat-dispatch RUN must inject ONLY PRISMER_RUN_ID (never PRISMER_TASK_ID),
// so an in-container skill can't `cloud task complete "$PRISMER_TASK_ID"`
// against a run id (the 404 incident). A kanban TASK injects ONLY
// PRISMER_TASK_ID. Bare-cuid task ids (legacy) keep injecting PRISMER_TASK_ID.

import { describe, it, expect } from 'vitest';
import { prismerScopeEnvFromMetadata } from '../src/adapters/prismer-env';

describe('prismer-env run/task split (release202/09 §3.2)', () => {
  it('kind=run → PRISMER_RUN_ID only, no PRISMER_TASK_ID', () => {
    const env = prismerScopeEnvFromMetadata({
      prismerKind: 'run',
      prismerRunId: 'run_abc123',
    });
    expect(env.PRISMER_RUN_ID).toBe('run_abc123');
    expect(env.PRISMER_TASK_ID).toBeUndefined();
  });

  it('kind=task → PRISMER_TASK_ID only, no PRISMER_RUN_ID', () => {
    const env = prismerScopeEnvFromMetadata({
      prismerKind: 'task',
      prismerTaskId: 'cBareTaskId01',
    });
    expect(env.PRISMER_TASK_ID).toBe('cBareTaskId01');
    expect(env.PRISMER_RUN_ID).toBeUndefined();
  });

  it('legacy bare-cuid task id with no kind → PRISMER_TASK_ID (back-compat)', () => {
    const env = prismerScopeEnvFromMetadata({
      prismerTaskId: 'cLegacyBareCuid',
    });
    expect(env.PRISMER_TASK_ID).toBe('cLegacyBareCuid');
    expect(env.PRISMER_RUN_ID).toBeUndefined();
  });

  it('fallback: run_-prefixed id under prismerTaskId routes to PRISMER_RUN_ID', () => {
    // A stale cloud payload that lost the typed split but carries a run_ id in
    // the legacy taskId slot must still NOT become PRISMER_TASK_ID.
    const env = prismerScopeEnvFromMetadata({
      prismerTaskId: 'run_legacyShape',
    });
    expect(env.PRISMER_RUN_ID).toBe('run_legacyShape');
    expect(env.PRISMER_TASK_ID).toBeUndefined();
  });

  it('fallback: prismerRunId present without kind → treated as run', () => {
    const env = prismerScopeEnvFromMetadata({
      prismerRunId: 'run_only',
      prismerTaskId: 'run_only', // wire mirror; must not leak to PRISMER_TASK_ID
    });
    expect(env.PRISMER_RUN_ID).toBe('run_only');
    expect(env.PRISMER_TASK_ID).toBeUndefined();
  });
});
