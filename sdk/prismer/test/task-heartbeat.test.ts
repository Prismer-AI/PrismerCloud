// Tests for TaskHeartbeat — Wave 3 D2 (Gap B-④).
//
// Covers:
//   1. 15s tick → ws.send envelope with monotonic heartbeatVersion
//   2. setPhase() pushes immediately and updates next tick
//   3. retry exponential backoff + give-up after max retries
//   4. give-up does NOT crash the timer; next tick still attempts send
//   5. stop() is idempotent; no further sends after stop
//   6. isOpen()=false skips send without burning retries

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskHeartbeat, type WsSender } from '../src/daemon/task-heartbeat.js';

interface Sent {
  type: string;
  payload: { taskId: string; heartbeatVersion: number; currentPhase: string; lastStepAt?: number };
  timestamp: number;
}

function makeFakeWs(opts: {
  failFirstN?: number;
  isOpen?: () => boolean;
} = {}): WsSender & { sent: Sent[]; attempts: number } {
  let attempts = 0;
  const sent: Sent[] = [];
  return {
    sent,
    get attempts() {
      return attempts;
    },
    set attempts(v: number) {
      attempts = v;
    },
    isOpen: opts.isOpen,
    send(msg: unknown) {
      attempts += 1;
      if (opts.failFirstN && attempts <= opts.failFirstN) {
        throw new Error(`fake-send-fail attempt=${attempts}`);
      }
      sent.push(msg as Sent);
    },
  };
}

describe('TaskHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends envelope-shaped task.heartbeat with monotonic heartbeatVersion on each tick', async () => {
    const ws = makeFakeWs();
    const hb = new TaskHeartbeat({ ws, intervalMs: 15_000 });
    hb.start('task-1', () => 'thinking');

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(ws.sent.length).toBe(3);
    for (const frame of ws.sent) {
      expect(frame.type).toBe('task.heartbeat');
      expect(frame.payload.taskId).toBe('task-1');
      expect(frame.payload.currentPhase).toBe('thinking');
      expect(typeof frame.timestamp).toBe('number');
    }
    expect(ws.sent[0]!.payload.heartbeatVersion).toBe(1);
    expect(ws.sent[1]!.payload.heartbeatVersion).toBe(2);
    expect(ws.sent[2]!.payload.heartbeatVersion).toBe(3);
    hb.stop();
  });

  it('setPhase() pushes immediately AND updates the phase reported by subsequent ticks', async () => {
    const ws = makeFakeWs();
    const hb = new TaskHeartbeat({ ws });
    let phase = 'thinking';
    hb.start('task-2', () => phase);

    // Immediate setPhase fires one frame right away (doesn't wait for tick).
    hb.setPhase('tool_use');
    // forceTick should NOT be needed — setPhase already pushed. But assert
    // the very next timer tick still increments and carries 'tool_use'.
    expect(ws.sent.length).toBe(1);
    expect(ws.sent[0]!.payload.currentPhase).toBe('tool_use');
    expect(ws.sent[0]!.payload.heartbeatVersion).toBe(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(ws.sent.length).toBe(2);
    expect(ws.sent[1]!.payload.currentPhase).toBe('tool_use');
    expect(ws.sent[1]!.payload.heartbeatVersion).toBe(2);
    hb.stop();
  });

  it('heartbeatVersion is monotonic across phase changes (does not reset)', async () => {
    const ws = makeFakeWs();
    const hb = new TaskHeartbeat({ ws });
    hb.start('task-3', () => 'thinking');
    hb.setPhase('a');
    hb.setPhase('b');
    hb.setPhase('c');
    expect(ws.sent.map((s) => s.payload.heartbeatVersion)).toEqual([1, 2, 3]);
    hb.stop();
  });

  it('retries ws.send 3 times with exponential backoff, then gives up — without throwing', async () => {
    const ws = makeFakeWs({ failFirstN: 99 }); // always fails
    const onGiveUp = vi.fn();
    const hb = new TaskHeartbeat({
      ws,
      maxRetries: 3,
      retryBackoffMs: 10,
      onGiveUp,
    });
    hb.start('task-4', () => 'thinking');

    // Trigger immediate push via forceTick.
    const p = hb.forceTick();
    // 4 attempts total: initial + 3 retries (backoffs 10, 20, 40 ms).
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(40);
    await p;

    expect(ws.attempts).toBe(4); // 1 initial + 3 retries
    expect(ws.sent.length).toBe(0); // never succeeded
    expect(onGiveUp).toHaveBeenCalledOnce();
    expect(onGiveUp.mock.calls[0]![0]).toBe('task-4');
    hb.stop();
  });

  it('give-up on one tick does not break subsequent ticks', async () => {
    let calls = 0;
    const ws: WsSender = {
      send: () => {
        calls += 1;
        if (calls <= 4) throw new Error('boom'); // first tick exhausts all 4 attempts
      },
    };
    const onGiveUp = vi.fn();
    const hb = new TaskHeartbeat({
      ws,
      intervalMs: 1000,
      maxRetries: 3,
      retryBackoffMs: 5,
      onGiveUp,
    });
    hb.start('task-5', () => 'thinking');

    // First tick: 4 failing attempts, give up.
    await vi.advanceTimersByTimeAsync(1000);
    // wait out backoff
    await vi.advanceTimersByTimeAsync(100);
    expect(onGiveUp).toHaveBeenCalledOnce();

    // Second tick: succeeds on first attempt (calls > 4 now).
    await vi.advanceTimersByTimeAsync(1000);
    expect(onGiveUp).toHaveBeenCalledOnce(); // still 1
    hb.stop();
  });

  it('isOpen() returning false skips send without burning retries', async () => {
    const isOpen = vi.fn(() => false);
    const sendSpy = vi.fn();
    const ws: WsSender = { send: sendSpy, isOpen };
    const onGiveUp = vi.fn();
    const hb = new TaskHeartbeat({ ws, intervalMs: 1000, onGiveUp });
    hb.start('task-6', () => 'thinking');

    await vi.advanceTimersByTimeAsync(1000);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(onGiveUp).not.toHaveBeenCalled();
    expect(isOpen).toHaveBeenCalled();
    hb.stop();
  });

  it('stop() halts the timer; no further sends after stop()', async () => {
    const ws = makeFakeWs();
    const hb = new TaskHeartbeat({ ws, intervalMs: 1000 });
    hb.start('task-7', () => 'thinking');

    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.sent.length).toBe(1);

    hb.stop();

    await vi.advanceTimersByTimeAsync(5000);
    expect(ws.sent.length).toBe(1);
  });

  it('stop() is idempotent', () => {
    const ws = makeFakeWs();
    const hb = new TaskHeartbeat({ ws });
    hb.start('task-8', () => 'thinking');
    expect(() => {
      hb.stop();
      hb.stop();
      hb.stop();
    }).not.toThrow();
  });

  it('setPhase() before start is a no-op', () => {
    const ws = makeFakeWs();
    const hb = new TaskHeartbeat({ ws });
    expect(() => hb.setPhase('whatever')).not.toThrow();
    expect(ws.sent.length).toBe(0);
  });

  it('lastStepAt is surfaced when touchStep() called', async () => {
    const ws = makeFakeWs();
    const hb = new TaskHeartbeat({ ws, now: () => 1_000_000 });
    hb.start('task-9', () => 'thinking');
    hb.touchStep();
    hb.setPhase('tool_use');
    expect(ws.sent[0]!.payload.lastStepAt).toBe(1_000_000);
    hb.stop();
  });
});
