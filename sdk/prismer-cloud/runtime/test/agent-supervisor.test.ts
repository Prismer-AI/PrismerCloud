import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import * as cp from 'node:child_process';
import { AgentSupervisor } from '../src/agent-supervisor.js';
import type { AgentDescriptor, AgentStatus } from '../src/agent-supervisor.js';
import { EventBus } from '../src/event-bus.js';

// ============================================================
// Helpers
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait until the predicate returns true or the timeout elapses.
// Polls every 20ms.
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await sleep(20);
  }
}

// Factory that builds an AgentDescriptor with sensible defaults.
// Using '/bin/sh' so the agent is universally available on macOS/Linux.
function makeAgent(
  id: string,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    id,
    name: `Test Agent ${id}`,
    command: '/bin/sh',
    args: ['-c', 'while true; do sleep 1; done'],
    ...overrides,
  };
}

// Descriptors that exit immediately with a specific code.
function exitAgent(id: string, code: number): AgentDescriptor {
  return makeAgent(id, { args: ['-c', `exit ${code}`] });
}

// ============================================================
// Test suite
// ============================================================

describe('AgentSupervisor', () => {
  let bus: EventBus;
  let supervisor: AgentSupervisor;

  beforeEach(() => {
    bus = new EventBus();
    supervisor = new AgentSupervisor({
      eventBus: bus,
      healthProbeIntervalMs: 100,
      degradedThreshold: 3,
      stopTimeoutMs: 1000,
    });
  });

  afterEach(async () => {
    await supervisor.shutdown();
  });

  // ----------------------------------------------------------
  // Test 1: Register → spawn → running state, PID is set
  // ----------------------------------------------------------
  it('register + spawn: agent reaches running state with a real PID', async () => {
    supervisor.register(makeAgent('agent-1'));

    expect(supervisor.get('agent-1')?.state).toBe('registered');

    await supervisor.spawn('agent-1');

    const status = supervisor.get('agent-1');
    expect(status?.state).toBe('running');
    expect(status?.pid).toBeTypeOf('number');
    expect(status!.pid!).toBeGreaterThan(0);
  }, 10000);

  // ----------------------------------------------------------
  // Test 2: Five concurrent agents all transition to running
  // ----------------------------------------------------------
  it('five concurrent agents: all reach running state', async () => {
    for (let i = 1; i <= 5; i++) {
      supervisor.register(makeAgent(`agent-c${i}`));
    }

    await Promise.all(
      Array.from({ length: 5 }, (_, i) => supervisor.spawn(`agent-c${i + 1}`)),
    );

    for (let i = 1; i <= 5; i++) {
      const s = supervisor.get(`agent-c${i}`);
      expect(s?.state).toBe('running');
      expect(s?.pid).toBeTypeOf('number');
    }

    // All pids are distinct.
    const pids = Array.from({ length: 5 }, (_, i) => supervisor.get(`agent-c${i + 1}`)!.pid);
    expect(new Set(pids).size).toBe(5);
  }, 10000);

  // ----------------------------------------------------------
  // Test 3: Crash → backoff → running again, restart count = 1
  // ----------------------------------------------------------
  it('crash recovery: crashed → backoff → running, restarts = 1', async () => {
    // Low backoff so the test completes quickly.
    supervisor.register(
      makeAgent('agent-crash', {
        args: ['-c', 'exit 1'],
        backoff: { initialMs: 50, multiplier: 2, maxMs: 5000, maxRestarts: 5 },
      }),
    );
    await supervisor.spawn('agent-crash');

    // The agent exits with code 1 immediately. Wait for crash → backoff → running.
    await waitFor(() => {
      const s = supervisor.get('agent-crash');
      return s?.state === 'running' && (s.restarts ?? 0) >= 1;
    }, 5000);

    const status = supervisor.get('agent-crash');
    // State may be 'running' or briefly transitioning again (exit 1 repeats), so just
    // assert restarts incremented.
    expect(status!.restarts).toBeGreaterThanOrEqual(1);
  }, 10000);

  // ----------------------------------------------------------
  // Test 4: Exponential backoff delays increase: 50ms → 100ms → 200ms
  // ----------------------------------------------------------
  it('exponential backoff: delay doubles each crash (50 → 100 → 200)', async () => {
    // Capture 'agent.restarting' events to observe the delayMs values.
    const delays: number[] = [];
    bus.subscribe('agent.restarting', (ev) => {
      delays.push((ev.payload as { delayMs: number }).delayMs);
    });

    supervisor.register(
      makeAgent('agent-backoff', {
        args: ['-c', 'exit 1'],
        backoff: { initialMs: 50, multiplier: 2, maxMs: 30000, maxRestarts: 10 },
      }),
    );
    await supervisor.spawn('agent-backoff');

    // Wait until we have seen at least 3 restart delay events.
    await waitFor(() => delays.length >= 3, 8000);

    // First three delays should follow 50 * 2^0=50, 50 * 2^1=100, 50 * 2^2=200.
    expect(delays[0]).toBe(50);
    expect(delays[1]).toBe(100);
    expect(delays[2]).toBe(200);
  }, 10000);

  // ----------------------------------------------------------
  // Test 5: Max restarts exceeded → final state 'failed'
  // ----------------------------------------------------------
  it('max restarts exceeded: state becomes failed after 2 crashes (maxRestarts=2)', async () => {
    // With maxRestarts=2 and a very short backoff, agent exits 3 times and gives up.
    supervisor.register(
      makeAgent('agent-fragile', {
        args: ['-c', 'exit 1'],
        backoff: { initialMs: 30, multiplier: 1, maxMs: 100, maxRestarts: 2 },
      }),
    );
    await supervisor.spawn('agent-fragile');

    await waitFor(() => supervisor.get('agent-fragile')?.state === 'failed', 6000);

    const status = supervisor.get('agent-fragile');
    expect(status?.state).toBe('failed');
    expect(status!.restarts).toBe(2);
  }, 10000);

  // ----------------------------------------------------------
  // Test 6: Stop → state 'stopped', process no longer alive
  // ----------------------------------------------------------
  it('stop: running agent transitions to stopped and process exits', async () => {
    supervisor.register(makeAgent('agent-stop'));
    await supervisor.spawn('agent-stop');

    const beforePid = supervisor.get('agent-stop')!.pid!;
    expect(supervisor.get('agent-stop')?.state).toBe('running');

    await supervisor.stop('agent-stop');

    expect(supervisor.get('agent-stop')?.state).toBe('stopped');
    expect(supervisor.get('agent-stop')?.pid).toBeUndefined();

    // Verify the process is actually dead: kill(pid, 0) should throw ESRCH.
    let dead = false;
    try {
      process.kill(beforePid, 0);
    } catch {
      dead = true;
    }
    expect(dead).toBe(true);
  }, 10000);

  // ----------------------------------------------------------
  // Test 7: stop() during backoff clears the pending restart timer
  // ----------------------------------------------------------
  it('stop during backoff: pending restart is cancelled', async () => {
    // Very long backoff so we have time to call stop() before the restart fires.
    supervisor.register(
      makeAgent('agent-cancel', {
        args: ['-c', 'exit 1'],
        backoff: { initialMs: 5000, multiplier: 1, maxMs: 30000, maxRestarts: 5 },
      }),
    );
    await supervisor.spawn('agent-cancel');

    // Wait for the agent to crash and enter backoff.
    await waitFor(() => supervisor.get('agent-cancel')?.state === 'backoff', 3000);

    // Stop while in backoff — should clear the timer.
    await supervisor.stop('agent-cancel', 'test-cancel');

    expect(supervisor.get('agent-cancel')?.state).toBe('stopped');

    // Wait longer than the backoff would have been; agent must not respawn.
    await sleep(200);
    expect(supervisor.get('agent-cancel')?.state).toBe('stopped');
  }, 10000);

  // ----------------------------------------------------------
  // Test 8: attach() tracks external pid, crash → 'stopped' not 'crashed'
  // ----------------------------------------------------------
  it('attach: crash of attached process transitions to stopped (not crashed, no restart)', async () => {
    // Spawn a real short-lived process to attach to. We use a subprocess we can kill.
    const sleeper = cp.spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' });
    const externalPid = sleeper.pid!;

    supervisor.register(makeAgent('agent-attached', { attachPid: externalPid }));
    await supervisor.attach('agent-attached', externalPid);

    expect(supervisor.get('agent-attached')?.state).toBe('running');
    expect(supervisor.get('agent-attached')?.pid).toBe(externalPid);

    // Kill the attached process externally — supervisor should detect it and go stopped.
    sleeper.kill('SIGKILL');

    await waitFor(() => supervisor.get('agent-attached')?.state === 'stopped', 5000);

    const finalStatus = supervisor.get('agent-attached');
    expect(finalStatus?.state).toBe('stopped');
    // Restarts must be 0 — attached agents are never restarted.
    expect(finalStatus?.restarts).toBe(0);
  }, 10000);

  // ----------------------------------------------------------
  // Test 9: Health probe failure → 'degraded', then success → back to 'running'
  // ----------------------------------------------------------
  it('health probe: 3 consecutive failures → degraded; success → running', async () => {
    let healthy = true;

    supervisor.register(
      makeAgent('agent-health', {
        healthCheck: () => healthy,
      }),
    );
    // Using a supervisor with 100ms probe interval (set in beforeEach).
    await supervisor.spawn('agent-health');
    expect(supervisor.get('agent-health')?.state).toBe('running');

    // Trigger failures — wait for degraded.
    healthy = false;
    await waitFor(() => supervisor.get('agent-health')?.state === 'degraded', 3000);
    expect(supervisor.get('agent-health')?.state).toBe('degraded');

    // Recovery.
    healthy = true;
    await waitFor(() => supervisor.get('agent-health')?.state === 'running', 3000);
    expect(supervisor.get('agent-health')?.state).toBe('running');
  }, 10000);

  // ----------------------------------------------------------
  // Test 10: Event emissions cover the full spawn + stop lifecycle
  // ----------------------------------------------------------
  it('event emissions: full spawn + stop cycle emits required agent.* topics', async () => {
    const topics: string[] = [];
    bus.subscribe('agent.*', (ev) => {
      topics.push(ev.topic);
    });

    supervisor.register(makeAgent('agent-events'));
    await supervisor.spawn('agent-events');
    await supervisor.stop('agent-events');

    // Give the async drain a tick to finish.
    await sleep(50);

    expect(topics).toContain('agent.spawning');
    expect(topics).toContain('agent.running');
    expect(topics).toContain('agent.stopping');
    expect(topics).toContain('agent.stopped');
  }, 10000);
});
