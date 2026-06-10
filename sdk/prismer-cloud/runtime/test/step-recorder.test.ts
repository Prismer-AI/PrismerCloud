// Tests for StepRecorder — Wave 3 D2 (Gap C-④).
//
// Covers:
//   1. recordPhaseChange / tool_call / tool_result / error → immediate send
//   2. seq is monotonic per taskRunId starting at 1
//   3. reasoning_chunk batches within 500ms window, flushes as one frame
//   4. flush() drains the pending buffer
//   5. summarize() caps oversized payloads

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StepRecorder } from '../src/daemon/step-recorder.js';
import type { WsSender } from '../src/daemon/task-heartbeat.js';

interface Sent {
  type: string;
  payload: { taskRunId: string; step: { seq: number; kind: string; payload: Record<string, unknown>; occurredAt: number } };
  timestamp: number;
}

function makeFakeWs(): WsSender & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    send(msg: unknown) {
      sent.push(msg as Sent);
    },
  };
}

describe('StepRecorder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits phase_change, tool_call, tool_result, error frames immediately with monotonic seq', () => {
    const ws = makeFakeWs();
    const r = new StepRecorder({ ws, taskRunId: 'run-1' });
    r.recordPhaseChange('thinking');
    r.recordToolCall('shell', { cmd: 'ls' }, 'tc-1');
    r.recordToolResult('tc-1', { stdout: 'file.txt' });
    r.recordError('boom', { code: 'TEST' });

    expect(ws.sent.length).toBe(4);
    expect(ws.sent.map((s) => s.type)).toEqual([
      'task.step.append',
      'task.step.append',
      'task.step.append',
      'task.step.append',
    ]);
    expect(ws.sent.map((s) => s.payload.step.kind)).toEqual([
      'phase_change',
      'tool_call',
      'tool_result',
      'error',
    ]);
    expect(ws.sent.map((s) => s.payload.step.seq)).toEqual([1, 2, 3, 4]);
    expect(ws.sent.every((s) => s.payload.taskRunId === 'run-1')).toBe(true);
  });

  it('phase_change payload carries the new phase', () => {
    const ws = makeFakeWs();
    const r = new StepRecorder({ ws, taskRunId: 'run-2' });
    r.recordPhaseChange('tool_use');
    expect(ws.sent[0]!.payload.step.payload).toEqual({ phase: 'tool_use' });
  });

  it('tool_call carries toolName + inputSummary + optional toolCallId', () => {
    const ws = makeFakeWs();
    const r = new StepRecorder({ ws, taskRunId: 'run-3' });
    r.recordToolCall('shell', { cmd: 'ls' }, 'tc-7');
    expect(ws.sent[0]!.payload.step.payload).toMatchObject({
      toolName: 'shell',
      toolCallId: 'tc-7',
    });
    expect(typeof ws.sent[0]!.payload.step.payload.inputSummary).toBe('string');
  });

  it('reasoning_chunk batches within 500ms window into a single frame', async () => {
    const ws = makeFakeWs();
    const r = new StepRecorder({ ws, taskRunId: 'run-4' });
    r.recordReasoningChunk('a');
    r.recordReasoningChunk('b');
    r.recordReasoningChunk('c');

    // Nothing on the wire yet — still buffered.
    expect(ws.sent.length).toBe(0);

    await vi.advanceTimersByTimeAsync(500);

    expect(ws.sent.length).toBe(1);
    expect(ws.sent[0]!.payload.step.kind).toBe('reasoning_chunk');
    expect(ws.sent[0]!.payload.step.payload).toEqual({ text: 'abc' });
  });

  it('reasoning_chunk timer resets after flush; subsequent chunks open a new window', async () => {
    const ws = makeFakeWs();
    const r = new StepRecorder({ ws, taskRunId: 'run-5' });
    r.recordReasoningChunk('first-window');
    await vi.advanceTimersByTimeAsync(500);
    expect(ws.sent.length).toBe(1);

    r.recordReasoningChunk('second-window');
    expect(ws.sent.length).toBe(1); // still buffered
    await vi.advanceTimersByTimeAsync(500);
    expect(ws.sent.length).toBe(2);
    expect(ws.sent[0]!.payload.step.payload).toEqual({ text: 'first-window' });
    expect(ws.sent[1]!.payload.step.payload).toEqual({ text: 'second-window' });
  });

  it('flush() drains pending reasoning buffer immediately', () => {
    const ws = makeFakeWs();
    const r = new StepRecorder({ ws, taskRunId: 'run-6' });
    r.recordReasoningChunk('partial');
    expect(ws.sent.length).toBe(0);
    r.flush();
    expect(ws.sent.length).toBe(1);
    expect(ws.sent[0]!.payload.step.payload).toEqual({ text: 'partial' });
  });

  it('flush() is a no-op when no reasoning buffer pending', () => {
    const ws = makeFakeWs();
    const r = new StepRecorder({ ws, taskRunId: 'run-7' });
    expect(() => r.flush()).not.toThrow();
    expect(ws.sent.length).toBe(0);
  });

  it('reasoning chunks interleaved with other kinds preserve seq order', async () => {
    const ws = makeFakeWs();
    const r = new StepRecorder({ ws, taskRunId: 'run-8' });
    r.recordPhaseChange('reasoning');     // seq 1, immediate
    r.recordReasoningChunk('think...');   // buffered
    r.recordToolCall('shell', { cmd: 'x' });  // seq 2, immediate
    await vi.advanceTimersByTimeAsync(500);
    // reasoning flush gets seq 3.
    expect(ws.sent.map((s) => s.payload.step.kind)).toEqual([
      'phase_change',
      'tool_call',
      'reasoning_chunk',
    ]);
    expect(ws.sent.map((s) => s.payload.step.seq)).toEqual([1, 2, 3]);
  });

  it('inputSummary caps oversize payloads', () => {
    const ws = makeFakeWs();
    const r = new StepRecorder({ ws, taskRunId: 'run-9' });
    const huge = 'x'.repeat(2000);
    r.recordToolCall('shell', { blob: huge });
    const summary = ws.sent[0]!.payload.step.payload.inputSummary as string;
    expect(summary.length).toBeLessThan(huge.length);
    expect(summary).toMatch(/…\(\+\d+ chars\)$/);
  });

  it('isOpen()=false → skip send (best effort)', () => {
    const sent: Sent[] = [];
    const ws: WsSender = {
      send: (m) => sent.push(m as Sent),
      isOpen: () => false,
    };
    const r = new StepRecorder({ ws, taskRunId: 'run-10' });
    r.recordPhaseChange('tool_use');
    expect(sent.length).toBe(0);
  });

  it('does not crash when ws.send throws', () => {
    const ws: WsSender = {
      send: () => {
        throw new Error('boom');
      },
    };
    const r = new StepRecorder({ ws, taskRunId: 'run-11' });
    expect(() => {
      r.recordPhaseChange('tool_use');
      r.recordError('whatever');
    }).not.toThrow();
  });
});
