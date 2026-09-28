// M-C — Dream scheduler unit tests.
//
// Drives the policy + scheduler with a fixed clock so the idle gate /
// interval gate / session threshold / lock semantics can be asserted
// without timing flakes. Production uses Date.now() and the
// setInterval timer; both are bypassed via the `now` constructor option
// and direct tickAll() calls.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DREAM_IDLE_WINDOW_MS,
  DREAM_MIN_INTERVAL_MS,
  DREAM_SESSION_THRESHOLD,
  DreamScheduler,
  acquireDreamLock,
  decideDreamRun,
  parseExtractOutput,
} from '../src/daemon/memory/dream/index.js';
import type { DreamRunner } from '../src/daemon/memory/dream/index.js';

class CapturingRunner implements DreamRunner {
  calls: string[] = [];
  shouldThrow = false;
  async run(workspaceId: string): Promise<void> {
    this.calls.push(workspaceId);
    if (this.shouldThrow) throw new Error('cloud unreachable');
  }
}

let now = 1_000_000_000;
let scheduler: DreamScheduler;
let runner: CapturingRunner;

beforeEach(() => {
  now = 1_000_000_000;
  runner = new CapturingRunner();
  scheduler = new DreamScheduler({
    runner,
    now: () => now,
    log: { info: () => {}, warn: () => {} },
  });
});

afterEach(() => {
  scheduler.stop();
});

describe('decideDreamRun policy', () => {
  it('returns shouldRun=false when lock is held', () => {
    const r = decideDreamRun({ lockHeldUntil: now + 1000 }, now);
    expect(r.shouldRun).toBe(false);
    expect(r.reason).toBe('lock_held');
  });

  it('returns shouldRun=false when host activity is within idle window', () => {
    const r = decideDreamRun({ lastActivityAt: now - DREAM_IDLE_WINDOW_MS / 2 }, now);
    expect(r.shouldRun).toBe(false);
    expect(r.reason).toBe('host_active');
  });

  it('returns shouldRun=true on first run when at least one session has happened', () => {
    const r = decideDreamRun({ sessionsSinceLastDream: 1 }, now);
    expect(r.shouldRun).toBe(true);
    expect(r.reason).toBe('first_run_with_sessions');
  });

  it('returns shouldRun=false on first run with no sessions yet', () => {
    const r = decideDreamRun({}, now);
    expect(r.shouldRun).toBe(false);
    expect(r.reason).toBe('no_sessions_yet');
  });

  it('returns shouldRun=true once DREAM_MIN_INTERVAL has elapsed', () => {
    const r = decideDreamRun({ lastDreamAt: now - DREAM_MIN_INTERVAL_MS - 1 }, now);
    expect(r.shouldRun).toBe(true);
    expect(r.reason).toBe('interval_elapsed');
  });

  it('returns shouldRun=true when session threshold reached even before interval', () => {
    const r = decideDreamRun(
      { lastDreamAt: now - 1000, sessionsSinceLastDream: DREAM_SESSION_THRESHOLD },
      now,
    );
    expect(r.shouldRun).toBe(true);
    expect(r.reason).toBe('session_threshold');
  });

  it('returns shouldRun=false when too soon and below session threshold', () => {
    const r = decideDreamRun(
      { lastDreamAt: now - 1000, sessionsSinceLastDream: 1 },
      now,
    );
    expect(r.shouldRun).toBe(false);
    expect(r.reason).toBe('too_soon');
  });

  it('acquireDreamLock sets lockHeldUntil', () => {
    const next = acquireDreamLock({}, now);
    expect(next.lockHeldUntil).toBeGreaterThan(now);
  });
});

describe('DreamScheduler', () => {
  it('skips ticks for unseen workspaces', async () => {
    await scheduler.tickAll();
    expect(runner.calls).toEqual([]);
  });

  it('runs a tick when sessions accumulated and host has been idle', async () => {
    scheduler.recordSessionEnd('ws_1');
    // Move past the idle window.
    now += DREAM_IDLE_WINDOW_MS + 1;
    await scheduler.tickAll();
    expect(runner.calls).toEqual(['ws_1']);
    const state = scheduler.getState('ws_1');
    expect(state?.lastDreamAt).toBeDefined();
    expect(state?.sessionsSinceLastDream).toBe(0);
  });

  it('does NOT run when host activity is recent (idle gate enforcement)', async () => {
    scheduler.recordSessionEnd('ws_1');
    scheduler.recordActivity('ws_1');
    await scheduler.tickAll();
    expect(runner.calls).toEqual([]);
    expect(scheduler.metrics().idleViolationCount).toBe(0);
  });

  it('honors the lock — concurrent ticks for the same workspace skip the second one', async () => {
    scheduler.recordSessionEnd('ws_1');
    now += DREAM_IDLE_WINDOW_MS + 1;
    // Hijack the runner to leave the lock visible during in-flight call.
    const slow = new Promise<void>((resolve) => setTimeout(resolve, 5));
    let inFlight = false;
    runner.run = async (id: string) => {
      runner.calls.push(id);
      inFlight = true;
      await slow;
      inFlight = false;
    };
    const t1 = scheduler.tickAll();
    const t2 = scheduler.tickAll();
    await Promise.all([t1, t2]);
    expect(runner.calls.length).toBe(1);
    expect(inFlight).toBe(false);
  });

  it('releases the lock + clears session counter after a successful run', async () => {
    scheduler.recordSessionEnd('ws_1');
    scheduler.recordSessionEnd('ws_1');
    now += DREAM_IDLE_WINDOW_MS + 1;
    await scheduler.tickAll();
    const state = scheduler.getState('ws_1');
    expect(state?.lockHeldUntil).toBeUndefined();
    expect(state?.sessionsSinceLastDream).toBe(0);
  });

  it('continues to release the lock even when runner throws', async () => {
    runner.shouldThrow = true;
    scheduler.recordSessionEnd('ws_1');
    now += DREAM_IDLE_WINDOW_MS + 1;
    await scheduler.tickAll();
    const state = scheduler.getState('ws_1');
    expect(state?.lockHeldUntil).toBeUndefined();
  });

  it('metrics().idleViolationCount stays at 0 across normal operation (acceptance gate)', async () => {
    // Repeatedly tick under various states; at no point should we observe
    // a Dream run while a recent activity timestamp would block it.
    for (let i = 0; i < 20; i++) {
      scheduler.recordSessionEnd('ws_1');
      // Half the time, simulate a busy user just before tick.
      if (i % 2 === 0) scheduler.recordActivity('ws_1');
      now += DREAM_IDLE_WINDOW_MS + 1;
      await scheduler.tickAll();
    }
    expect(scheduler.metrics().idleViolationCount).toBe(0);
  });
});

describe('parseExtractOutput', () => {
  it('parses a clean response', () => {
    const r = parseExtractOutput(
      JSON.stringify({
        proposals: [
          {
            path: 'memory/feedback/sdk-naming.md',
            title: 'Use kebab-case for SDK names',
            summary: 'User prefers @prismer/aip-sdk over @prismer/aipSdk.',
            rationale: 'Naming convention surfaces in every SDK PR.',
            confidence: 0.8,
          },
        ],
      }),
    );
    expect(r.length).toBe(1);
    expect(r[0]!.path).toBe('memory/feedback/sdk-naming.md');
    expect(r[0]!.confidence).toBe(0.8);
  });

  it('drops entries with missing required fields', () => {
    const r = parseExtractOutput(
      JSON.stringify({
        proposals: [
          { path: 'memory/x.md', summary: 'no title' }, // missing title
          { path: 'memory/y.md', title: 'ok', summary: '', rationale: 'r' }, // empty summary
          { path: 'not-a-memory-path', title: 't', summary: 's', rationale: 'r' }, // wrong path prefix
        ],
      }),
    );
    expect(r).toEqual([]);
  });

  it('caps at 3 entries', () => {
    const proposals = Array.from({ length: 6 }, (_, i) => ({
      path: `memory/p${i}.md`,
      title: `t${i}`,
      summary: `body ${i}`,
      rationale: 'r',
      confidence: 0.5,
    }));
    const r = parseExtractOutput(JSON.stringify({ proposals }));
    expect(r.length).toBe(3);
  });

  it('returns [] on garbage input', () => {
    expect(parseExtractOutput('not json')).toEqual([]);
    expect(parseExtractOutput('')).toEqual([]);
    expect(parseExtractOutput('{"proposals": "not an array"}')).toEqual([]);
  });
});
