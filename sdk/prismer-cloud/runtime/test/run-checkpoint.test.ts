// release201/26 Phase 4 — daemon-side checkpoint store + resume scan.
//
// Covers (logic + mock; real kill-restart e2e is an ops gate per the plan):
//   - v7 migration creates local_run_checkpoints (PRAGMA user_version bumps)
//   - writeCheckpoint / getCheckpoints round-trip (phase-level, ordered by seq)
//   - INSERT OR REPLACE idempotency on (run_id, phase_seq)
//   - listUnfinishedRuns returns latest checkpoint per run; terminal delete
//     removes a run from the unfinished set
//   - resume scan: healthy adapter → resumed; unhealthy / missing adapter →
//     resume_failed event emitted + checkpoints cleared

import { describe, expect, it, vi } from 'vitest';
import { openLocalDb, TARGET_SCHEMA_VERSION, currentSchemaVersion } from '../src/sync/store.js';
import { RunCheckpointStore } from '../src/daemon/memory/run-checkpoint-store.js';
import {
  runCheckpointResumeScan,
  type ResumeAdapterLookup,
  type ResumeAdapterProbe,
} from '../src/daemon/run-resume.js';

function freshStore(): RunCheckpointStore {
  const db = openLocalDb(':memory:');
  return new RunCheckpointStore(db);
}

function mockRegistry(map: Record<string, ResumeAdapterProbe>): ResumeAdapterLookup {
  return { get: (name: string) => map[name] };
}

describe('store v8 migration', () => {
  it('bumps schema version to 8 and creates local_run_checkpoints', () => {
    const db = openLocalDb(':memory:');
    // v7 added local_run_checkpoints; v8 added local_run_sessions.provider_session_id
    // (+ (conversation_id, agent_im_user_id, adapter_name) index).
    expect(TARGET_SCHEMA_VERSION).toBe(8);
    expect(currentSchemaVersion(db)).toBe(8);
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='local_run_checkpoints'",
      )
      .get() as { name?: string } | undefined;
    expect(row?.name).toBe('local_run_checkpoints');
  });
});

describe('RunCheckpointStore', () => {
  it('round-trips phase-level checkpoints ordered by phase_seq', () => {
    const store = freshStore();
    expect(store.writeCheckpoint('run_a', 1, 'thinking', { adapterName: 'hermes' })).toBe(true);
    expect(store.writeCheckpoint('run_a', 2, 'tool', { adapterName: 'hermes', tool: 'read' })).toBe(true);
    const cps = store.getCheckpoints('run_a');
    expect(cps.map((c) => c.phaseSeq)).toEqual([1, 2]);
    expect(cps[0].phaseName).toBe('thinking');
    expect(cps[1].payload.tool).toBe('read');
  });

  it('INSERT OR REPLACE on (run_id, phase_seq) is idempotent', () => {
    const store = freshStore();
    store.writeCheckpoint('run_a', 1, 'thinking', { v: 1 });
    store.writeCheckpoint('run_a', 1, 'thinking', { v: 2 });
    const cps = store.getCheckpoints('run_a');
    expect(cps).toHaveLength(1);
    expect(cps[0].payload.v).toBe(2);
  });

  it('listUnfinishedRuns returns latest checkpoint per run', () => {
    const store = freshStore();
    store.writeCheckpoint('run_a', 1, 'thinking', { adapterName: 'hermes' });
    store.writeCheckpoint('run_a', 2, 'tool', { adapterName: 'hermes' });
    store.writeCheckpoint('run_b', 1, 'thinking', { adapterName: 'openclaw' });
    const unfinished = store.listUnfinishedRuns();
    const byRun = Object.fromEntries(unfinished.map((c) => [c.runId, c]));
    expect(Object.keys(byRun).sort()).toEqual(['run_a', 'run_b']);
    expect(byRun.run_a.phaseSeq).toBe(2); // latest
    expect(byRun.run_a.phaseName).toBe('tool');
    expect(byRun.run_b.phaseSeq).toBe(1);
  });

  it('terminal delete removes a run from the unfinished set', () => {
    const store = freshStore();
    store.writeCheckpoint('run_a', 1, 'thinking', {});
    store.writeCheckpoint('run_b', 1, 'thinking', {});
    store.deleteCheckpoints('run_a');
    expect(store.getCheckpoints('run_a')).toHaveLength(0);
    expect(store.listUnfinishedRuns().map((c) => c.runId)).toEqual(['run_b']);
  });
});

describe('runCheckpointResumeScan', () => {
  it('no-op when there are no unfinished runs', async () => {
    const store = freshStore();
    const res = await runCheckpointResumeScan({
      store,
      registry: mockRegistry({}),
      onResume: vi.fn(),
      emitResumeFailed: vi.fn(),
    });
    expect(res).toEqual({ scanned: 0, resumed: 0, failed: 0 });
  });

  it('healthy adapter → resumed, no resume_failed, checkpoints cleared', async () => {
    const store = freshStore();
    store.writeCheckpoint('run_ok', 1, 'thinking', { adapterName: 'hermes' });
    const onResume = vi.fn();
    const emitResumeFailed = vi.fn();
    const onMetric = vi.fn();
    const res = await runCheckpointResumeScan({
      store,
      registry: mockRegistry({
        hermes: { name: 'hermes', health: async () => ({ available: true }) },
      }),
      onResume,
      emitResumeFailed,
      onMetric,
    });
    expect(res).toEqual({ scanned: 1, resumed: 1, failed: 0 });
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(emitResumeFailed).not.toHaveBeenCalled();
    expect(onMetric).toHaveBeenCalledWith('resumed');
    // settled — cleared
    expect(store.getCheckpoints('run_ok')).toHaveLength(0);
  });

  it('unhealthy adapter → resume_failed emitted with reason + cleared', async () => {
    const store = freshStore();
    store.writeCheckpoint('run_bad', 1, 'tool', { adapterName: 'hermes' });
    const emitResumeFailed = vi.fn();
    const onMetric = vi.fn();
    const res = await runCheckpointResumeScan({
      store,
      registry: mockRegistry({
        hermes: {
          name: 'hermes',
          health: async () => ({ available: false, reason: 'binary missing' }),
        },
      }),
      onResume: vi.fn(),
      emitResumeFailed,
      onMetric,
    });
    expect(res).toEqual({ scanned: 1, resumed: 0, failed: 1 });
    expect(emitResumeFailed).toHaveBeenCalledTimes(1);
    const arg = emitResumeFailed.mock.calls[0][0];
    expect(arg.runId).toBe('run_bad');
    expect(arg.taskId).toBe('run_bad');
    expect(arg.reason).toContain('unhealthy');
    expect(onMetric).toHaveBeenCalledWith('failed');
    expect(store.getCheckpoints('run_bad')).toHaveLength(0);
  });

  it('missing adapter → resume_failed', async () => {
    const store = freshStore();
    store.writeCheckpoint('run_gone', 1, 'thinking', { adapterName: 'ghost' });
    const emitResumeFailed = vi.fn();
    const res = await runCheckpointResumeScan({
      store,
      registry: mockRegistry({}),
      onResume: vi.fn(),
      emitResumeFailed,
    });
    expect(res.failed).toBe(1);
    expect(emitResumeFailed.mock.calls[0][0].reason).toContain('not registered');
  });

  it('onResume throwing falls back to resume_failed', async () => {
    const store = freshStore();
    store.writeCheckpoint('run_throw', 1, 'thinking', { adapterName: 'hermes' });
    const emitResumeFailed = vi.fn();
    const res = await runCheckpointResumeScan({
      store,
      registry: mockRegistry({
        hermes: { name: 'hermes', health: async () => ({ available: true }) },
      }),
      onResume: () => {
        throw new Error('redispatch boom');
      },
      emitResumeFailed,
    });
    expect(res).toEqual({ scanned: 1, resumed: 0, failed: 1 });
    expect(emitResumeFailed.mock.calls[0][0].reason).toContain('re-dispatch failed');
  });
});
