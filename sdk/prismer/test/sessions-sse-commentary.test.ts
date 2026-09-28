// S6/M1 — v2026.9.21 assistant.commentary 回流。多段旁白必须全量保留并逐段
// 回调；最终 output 仍= 最后一条 assistant.completed（现状不变）。
//
// 契约锚点（2026-09-21 本地 source 真跑实测）：上游真实字段是 `text`
// （附 message_id / already_streamed / session_id / run_id / seq / ts）；
// brief 期 fixture 用的是 `content`。消费层两者都收（text 优先，content
// 兜底——同文件 reasoning.available 的多字段容忍先例），旁白永不并入
// deltas / finalContent（与 delta 累加保持不相交 = already_streamed 去重语义）。
import { describe, it, expect } from 'vitest';
import { consumeSessionsSse } from '../src/adapters/persistence/hermes/sessions-sse.js';
import type { TaskInput } from '../src/adapters/contract.js';

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}
function frame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
const task = { taskId: 't1' } as unknown as TaskInput;

describe('consumeSessionsSse commentary relay (S6/M1)', () => {
  it('keeps every commentary segment in order and invokes onInterimReply with 1-based seq', async () => {
    const observed: Array<{ text: string; seq: number }> = [];
    const t = { ...task, onInterimReply: (s: { text: string; seq: number }) => observed.push(s) };
    const body = sseStream([
      frame('run.started', { run_id: 'r1' }),
      frame('assistant.commentary', { content: 'All 433 tests pass. Now let me commit.' }),
      frame('tool.started', { tool_name: 'shell' }),
      frame('assistant.commentary', { content: 'Clean, minimal diff. Let me commit and push.' }),
      frame('assistant.completed', { content: 'Done. Root cause was X; fixed in three places.' }),
      frame('done', {}),
    ]);
    const result = await consumeSessionsSse(body, t as TaskInput);
    expect(observed).toEqual([
      { text: 'All 433 tests pass. Now let me commit.', seq: 1 },
      { text: 'Clean, minimal diff. Let me commit and push.', seq: 2 },
    ]);
    expect(result.commentarySegments).toHaveLength(2);
    // 压扁现状不回归：output 仍= 最终 completed 段
    expect(result.output).toBe('Done. Root cause was X; fixed in three places.');
  });

  it('kealive comment lines and blank commentary never emit callbacks', async () => {
    const observed: unknown[] = [];
    const t = { ...task, onInterimReply: (s: unknown) => observed.push(s) };
    const body = sseStream([
      ': keepalive\n\n',
      frame('assistant.commentary', { content: '   ' }),
      frame('assistant.completed', { content: 'final' }),
      frame('done', {}),
    ]);
    const result = await consumeSessionsSse(body, t as TaskInput);
    expect(observed).toEqual([]);
    expect(result.output).toBe('final');
  });

  it('onInterimReply callback throwing never breaks the SSE loop', async () => {
    const t = {
      ...task,
      onInterimReply: () => {
        throw new Error('consumer exploded');
      },
    };
    const body = sseStream([
      frame('assistant.commentary', { content: 'seg' }),
      frame('assistant.completed', { content: 'final' }),
      frame('done', {}),
    ]);
    const result = await consumeSessionsSse(body, t as TaskInput);
    expect(result.output).toBe('final');
  });

  it('relays the real upstream shape (text field + already_streamed) without merging into deltas/output', async () => {
    // 实测上游 payload：字段名是 text（不是 content），already_streamed=true
    // 表示该段已作为 assistant.delta 流出——去重语义 = 旁白只走
    // onInterimReply/commentarySegments，绝不并入 delta 累加与最终 output。
    const observed: Array<{ text: string; seq: number }> = [];
    const t = { ...task, onInterimReply: (s: { text: string; seq: number }) => observed.push(s) };
    const body = sseStream([
      frame('run.started', { run_id: 'r1' }),
      frame('assistant.commentary', {
        message_id: 'msg_9',
        text: 'Milestone: all 433 tests pass. Now committing.',
        already_streamed: true,
        session_id: 'sess_1',
        run_id: 'r1',
        seq: 7,
        ts: '2026-09-21T00:00:00.000Z',
      }),
      frame('assistant.completed', { content: 'Committed in three places.' }),
      frame('done', {}),
    ]);
    const result = await consumeSessionsSse(body, t as TaskInput);
    expect(observed).toEqual([
      { text: 'Milestone: all 433 tests pass. Now committing.', seq: 1 },
    ]);
    expect(result.commentarySegments).toEqual([
      'Milestone: all 433 tests pass. Now committing.',
    ]);
    // 旁白不并入 output：仍= completed content（而非 deltas/拼接）。
    expect(result.output).toBe('Committed in three places.');
  });

  it('kill-switch HERMES_COMMENTARY_RELAY=off silences the relay but keeps final output', async () => {
    // kill-switch 定义在 flag.ts；这里直接用 env 字面量，避免测试编译耦合 flag 模块。
    const prev = process.env.HERMES_COMMENTARY_RELAY;
    process.env.HERMES_COMMENTARY_RELAY = 'off';
    try {
      const observed: unknown[] = [];
      const t = { ...task, onInterimReply: (s: unknown) => observed.push(s) };
      const body = sseStream([
        frame('assistant.commentary', { text: 'hidden segment' }),
        frame('assistant.completed', { content: 'final' }),
        frame('done', {}),
      ]);
      const result = await consumeSessionsSse(body, t as TaskInput);
      expect(observed).toEqual([]);
      expect(result.commentarySegments).toEqual([]);
      expect(result.output).toBe('final');
    } finally {
      if (prev === undefined) delete process.env.HERMES_COMMENTARY_RELAY;
      else process.env.HERMES_COMMENTARY_RELAY = prev;
    }
  });

  it('streams without commentary keep commentarySegments empty and output byte-identical', async () => {
    // 负控③（回归）：不含 commentary 的流，结果与改动前逐字节一致。
    const body = sseStream([
      frame('assistant.delta', { delta: 'hel' }),
      frame('assistant.delta', { delta: 'lo' }),
      frame('assistant.completed', { content: 'hello' }),
      frame('done', {}),
    ]);
    const result = await consumeSessionsSse(body, task);
    expect(result.commentarySegments).toEqual([]);
    expect(result.output).toBe('hello');
  });
});
