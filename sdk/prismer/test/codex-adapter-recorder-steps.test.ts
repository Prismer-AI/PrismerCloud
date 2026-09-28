// release203/06 §3.0 / P0 — Codex JSONL → normalized StepRecorder frame.
// Pure-function tests over codexJsonlToStep (no spawn, no network).

import { describe, expect, it } from 'vitest';
import { codexJsonlToStep } from '../src/adapters/coding/codex/index.js';

describe('codexJsonlToStep — codex v0.133 JSONL → recorder frames', () => {
  it('maps item.started command_execution → tool_call (paired by item.id)', () => {
    const step = codexJsonlToStep(
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"ls -la"}}',
    );
    expect(step).toEqual({
      kind: 'tool_call',
      toolName: 'shell',
      input: { command: 'ls -la' },
      toolCallId: 'item_1',
    });
  });

  it('maps item.completed command_execution → tool_result (same item.id)', () => {
    const step = codexJsonlToStep(
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls -la","aggregated_output":"marker.txt\\n","exit_code":0}}',
    );
    expect(step).toEqual({
      kind: 'tool_result',
      toolCallId: 'item_1',
      output: { exitCode: 0, output: 'marker.txt\n' },
    });
  });

  it('falls back to a command-derived toolCallId when item.id is absent', () => {
    const started = codexJsonlToStep(
      '{"type":"item.started","item":{"type":"command_execution","command":"echo hi"}}',
    );
    const completed = codexJsonlToStep(
      '{"type":"item.completed","item":{"type":"command_execution","command":"echo hi","exit_code":0}}',
    );
    // started + completed for the same command pair on the same fallback key.
    expect((started as { toolCallId: string }).toolCallId).toBe('cmd:echo hi');
    expect((completed as { toolCallId: string }).toolCallId).toBe('cmd:echo hi');
  });

  it('maps item.completed reasoning → reasoning_chunk', () => {
    const step = codexJsonlToStep(
      '{"type":"item.completed","item":{"type":"reasoning","text":"I should list files first."}}',
    );
    expect(step).toEqual({ kind: 'reasoning_chunk', text: 'I should list files first.' });
  });

  it('maps item.completed agent_message → reply (carried via TaskResult.output, not a step frame)', () => {
    const step = codexJsonlToStep(
      '{"type":"item.completed","item":{"type":"agent_message","text":"Done."}}',
    );
    expect(step).toEqual({ kind: 'reply', text: 'Done.' });
  });

  it('ignores non-item lines and parse failures', () => {
    expect(codexJsonlToStep('{"type":"thread.started","thread_id":"t1"}')).toBeNull();
    expect(codexJsonlToStep('{"type":"turn.completed"}')).toBeNull();
    expect(codexJsonlToStep('not json')).toBeNull();
    expect(codexJsonlToStep('')).toBeNull();
  });

  it('end-to-end: a JSONL stream yields ordered tool_call→tool_result→reasoning frames', () => {
    const jsonl = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"reasoning","text":"think"}}',
      '{"type":"item.started","item":{"id":"c1","type":"command_execution","command":"ls"}}',
      '{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"ls","exit_code":0,"aggregated_output":"x"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}',
      '{"type":"turn.completed"}',
    ];
    const frames = jsonl.map(codexJsonlToStep).filter(Boolean);
    expect(frames.map((f) => (f as { kind: string }).kind)).toEqual([
      'reasoning_chunk',
      'tool_call',
      'tool_result',
      'reply',
    ]);
  });
});
