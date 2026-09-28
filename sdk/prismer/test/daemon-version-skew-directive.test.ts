/**
 * daemon-version-skew-directive.test.ts — release203/19 #2 (P2), daemon side.
 *
 * The daemon-side reaction to the cloud's host.acked.upgradeDirective:
 *   1. applyUpgradeDirective(undefined|'warn') → no gate (normal operation);
 *      a legacy/quiet cloud never sets one (backward compatible).
 *   2. 'refuse_dispatch' → gate set, NO drain watcher, daemon stays up.
 *   3. 'drain_respawn'  → gate set + drain watcher armed once (idempotent).
 *   4. onTaskDispatch with the gate set → NEW run is refused (no run started),
 *      while already-in-flight runs are untouched.
 *   5. drain watcher exits the process once in-flight runs settle.
 *
 * The Runner's directive methods are private + the class is heavy to fully
 * construct, so we instantiate WITHOUT start() and drive the private methods via
 * `as any`, stubbing only the fields the gate path touches (config, runningTasks,
 * ws). This isolates the P2 logic from boot I/O.
 *
 * Usage: npx vitest run test/daemon-version-skew-directive.test.ts
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Runner } from '../src/daemon/runner';
import { evaluateRuntimeUpdateDirection } from '../src/daemon/runtime-update-direction';
import type { TaskDispatchRequestPayload } from '../src/types/im-events';

function makeRunner(): any {
  const r = new Runner() as any;
  // Minimal field stubs the gate / directive paths read. No start() → no I/O.
  r.config = { daemon_id: 'daemon-self' };
  r.runningTasks = new Map();
  r.ws = { send: vi.fn(), close: vi.fn() };
  r.upgradeDirective = undefined;
  r.drainRespawnArmed = false;
  r.resolveDaemonVersion = vi.fn(() => '2.2.36');
  return r;
}

function dispatchPayload(taskId: string): TaskDispatchRequestPayload {
  // No targetDaemonId → not skipped (treated as "for this daemon").
  return { taskId, runtimeRoute: 'agent', agentImUserId: 'agent-a' } as unknown as TaskDispatchRequestPayload;
}

describe('applyUpgradeDirective', () => {
  it('undefined directive is a no-op (legacy/quiet cloud, backward compatible)', () => {
    const r = makeRunner();
    r.applyUpgradeDirective(undefined);
    expect(r.upgradeDirective).toBeUndefined();
    expect(r.drainRespawnArmed).toBe(false);
  });

  it("'warn' does not gate dispatch (observability-only)", () => {
    const r = makeRunner();
    r.applyUpgradeDirective('warn');
    expect(r.upgradeDirective).toBeUndefined();
    expect(r.drainRespawnArmed).toBe(false);
  });

  it("'refuse_dispatch' sets the gate but does NOT arm the drain watcher", () => {
    const r = makeRunner();
    const armSpy = vi.spyOn(r, 'armDrainRespawnWatcher');
    r.applyUpgradeDirective('refuse_dispatch');
    expect(r.upgradeDirective).toBe('refuse_dispatch');
    expect(r.drainRespawnArmed).toBe(false);
    expect(armSpy).not.toHaveBeenCalled();
  });

  it("'drain_respawn' sets the gate AND arms the drain watcher exactly once", () => {
    const r = makeRunner();
    const armSpy = vi.spyOn(r, 'armDrainRespawnWatcher').mockImplementation(() => {});
    r.applyUpgradeDirective('drain_respawn');
    r.applyUpgradeDirective('drain_respawn'); // repeat declare — idempotent
    expect(r.upgradeDirective).toBe('drain_respawn');
    expect(r.drainRespawnArmed).toBe(true);
    expect(armSpy).toHaveBeenCalledTimes(1);
  });

  it('clears a prior gate when the cloud relaxes back to warn/absent', () => {
    const r = makeRunner();
    vi.spyOn(r, 'armDrainRespawnWatcher').mockImplementation(() => {});
    r.applyUpgradeDirective('refuse_dispatch');
    expect(r.upgradeDirective).toBe('refuse_dispatch');
    r.applyUpgradeDirective(undefined);
    expect(r.upgradeDirective).toBeUndefined();
  });
});

describe('onTaskDispatch version-skew gate', () => {
  it('refuses a NEW run when refuse_dispatch is active (no run started)', async () => {
    const r = makeRunner();
    r.applyUpgradeDirective('refuse_dispatch');
    await r.onTaskDispatch(dispatchPayload('task-new'), 'req-1');
    // Gate returns before adding to runningTasks → no run accepted.
    expect(r.runningTasks.has('task-new')).toBe(false);
  });

  it('leaves already-in-flight runs untouched (they drain)', async () => {
    const r = makeRunner();
    // Simulate an in-flight run.
    r.runningTasks.set('task-inflight', {
      ctrl: new AbortController(),
      startedAt: Date.now(),
      lastProgressAt: Date.now(),
      timeoutMs: 0,
    });
    r.applyUpgradeDirective('drain_respawn');
    // A redelivery of the in-flight task is deduped (still present, untouched).
    await r.onTaskDispatch(dispatchPayload('task-inflight'), 'req-2');
    expect(r.runningTasks.has('task-inflight')).toBe(true);
    // A brand-new task under the gate is refused.
    await r.onTaskDispatch(dispatchPayload('task-new'), 'req-3');
    expect(r.runningTasks.has('task-new')).toBe(false);
  });
});

describe('runtime.update.apply direction gate', () => {
  it('accepts a forward OTA and arms drain_respawn', () => {
    const r = makeRunner();
    vi.spyOn(r, 'armDrainRespawnWatcher').mockImplementation(() => {});
    const applySpy = vi.spyOn(r, 'applyUpgradeDirective');

    r.onRuntimeUpdateApply({ decision: 'ota', targetVersion: '2.2.37', requestedBy: 'owner' }, 'req-up');

    expect(applySpy).toHaveBeenCalledWith('drain_respawn');
    const frame = r.ws.send.mock.calls[0][0];
    expect(frame.payload).toMatchObject({ accepted: true, currentVersion: '2.2.36', targetVersion: '2.2.37' });
  });

  it('rejects an ordinary stale downgrade without restarting', () => {
    const r = makeRunner();
    vi.spyOn(r, 'armDrainRespawnWatcher').mockImplementation(() => {});
    const applySpy = vi.spyOn(r, 'applyUpgradeDirective');

    r.onRuntimeUpdateApply({ decision: 'ota', targetVersion: '2.2.12', requestedBy: 'owner' }, 'req-stale');

    expect(applySpy).not.toHaveBeenCalled();
    const frame = r.ws.send.mock.calls[0][0];
    expect(frame.payload).toMatchObject({
      accepted: false,
      reason: 'downgrade_not_authorized',
      currentVersion: '2.2.36',
      targetVersion: '2.2.12',
    });
  });

  it('accepts an explicit rollback to a lower registered target', () => {
    const r = makeRunner();
    vi.spyOn(r, 'armDrainRespawnWatcher').mockImplementation(() => {});
    const applySpy = vi.spyOn(r, 'applyUpgradeDirective');

    r.onRuntimeUpdateApply({ decision: 'rollback', targetVersion: '2.2.12', requestedBy: 'owner' }, 'req-rb');

    expect(applySpy).toHaveBeenCalledWith('drain_respawn');
    const frame = r.ws.send.mock.calls[0][0];
    expect(frame.payload).toMatchObject({ accepted: true, decision: 'rollback', targetVersion: '2.2.12' });
  });

  it('rejects an apply for the version already running', () => {
    const r = makeRunner();
    vi.spyOn(r, 'armDrainRespawnWatcher').mockImplementation(() => {});
    const applySpy = vi.spyOn(r, 'applyUpgradeDirective');

    r.onRuntimeUpdateApply({ decision: 'ota', targetVersion: '2.2.36' }, 'req-same');

    expect(applySpy).not.toHaveBeenCalled();
    const frame = r.ws.send.mock.calls[0][0];
    expect(frame.payload).toMatchObject({ accepted: false, reason: 'up_to_date' });
  });
});

describe('evaluateRuntimeUpdateDirection — suffix + unparseable versions', () => {
  it('suffix-only difference is up_to_date (2.2.36+desktop vs 2.2.36 — no drain_respawn churn)', () => {
    // The desktop daemon reports a build-suffixed version; the cloud OTA
    // target is the bare registry version. A string compare would call this a
    // difference and trigger drain_respawn on the SAME release — direction
    // must be decided on the suffix-stripped numeric comparison.
    const res = evaluateRuntimeUpdateDirection({
      currentVersion: '2.2.36+desktop',
      targetVersion: '2.2.36',
    });
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('up_to_date');
  });

  it('prerelease suffix is also up_to_date (2.2.36-rc1 vs 2.2.36)', () => {
    const res = evaluateRuntimeUpdateDirection({
      currentVersion: '2.2.36-rc1',
      targetVersion: '2.2.36',
    });
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('up_to_date');
  });

  it('a real forward target still accepts (suffix stripping does not break direction)', () => {
    const res = evaluateRuntimeUpdateDirection({
      currentVersion: '2.2.36+desktop',
      targetVersion: '2.2.37',
    });
    expect(res).toMatchObject({ accepted: true, targetVersion: '2.2.37' });
  });

  it('unparseable CURRENT version rejects with version_unparseable (no blind both-direction accept)', () => {
    const res = evaluateRuntimeUpdateDirection({
      currentVersion: 'dev-build',
      targetVersion: '2.2.37',
    });
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('version_unparseable');
  });

  it('unparseable TARGET version rejects with version_unparseable', () => {
    const res = evaluateRuntimeUpdateDirection({
      currentVersion: '2.2.36',
      targetVersion: 'not-a-version',
    });
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('version_unparseable');
  });

  it('unparseable target under rollback also rejects (both directions)', () => {
    const res = evaluateRuntimeUpdateDirection({
      currentVersion: '2.2.36',
      targetVersion: 'garbage',
      decision: 'rollback',
    });
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('version_unparseable');
  });

  it('exact same version string still up_to_date (pre-existing oracle)', () => {
    const res = evaluateRuntimeUpdateDirection({ currentVersion: '2.2.36', targetVersion: '2.2.36' });
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('up_to_date');
  });
});

describe('onRuntimeUpdateApply — suffix-equivalence end to end', () => {
  it('2.2.36+desktop vs 2.2.36 → up_to_date, NO drain_respawn armed', () => {
    const r = makeRunner();
    r.resolveDaemonVersion = vi.fn(() => '2.2.36+desktop');
    vi.spyOn(r, 'armDrainRespawnWatcher').mockImplementation(() => {});
    const applySpy = vi.spyOn(r, 'applyUpgradeDirective');

    r.onRuntimeUpdateApply({ decision: 'ota', targetVersion: '2.2.36', requestedBy: 'owner' }, 'req-same-suffix');

    expect(applySpy).not.toHaveBeenCalled();
    const frame = r.ws.send.mock.calls[0][0];
    expect(frame.payload).toMatchObject({ accepted: false, reason: 'up_to_date' });
  });
});

describe('armDrainRespawnWatcher exits once drained', () => {
  let exitSpy: any;
  beforeEach(() => {
    vi.useFakeTimers();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    exitSpy.mockRestore();
  });

  it('waits for in-flight to settle, then stop() + exit(0)', async () => {
    const r = makeRunner();
    const closeSpy = vi.spyOn(r.ws, 'close');
    // One in-flight run blocks the first tick.
    r.runningTasks.set('task-inflight', {
      ctrl: new AbortController(),
      startedAt: Date.now(),
      lastProgressAt: Date.now(),
      timeoutMs: 0,
    });
    r.armDrainRespawnWatcher();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(closeSpy).not.toHaveBeenCalled(); // still draining
    // Run finishes → next poll sees an empty map → stop + exit.
    r.runningTasks.clear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
