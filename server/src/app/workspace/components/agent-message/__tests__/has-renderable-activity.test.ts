/**
 * Regression: DoneStrip (完成后「展开过程」入口) visibility gate.
 *
 * Bug: 迁到统一 AgentMessage 组件后，纯思考回复（只有 phase_change 步、没 tool、
 * reasoning_chunk 未录制）在输出后丢掉了上方「展开过程」入口 —— 因为旧 gate 只认
 * tool 步和有文本的 reasoning 步，漏了 phase 行。ActivityDetail 本来就会把 phase
 * 渲染成阶段分隔行，所以 phase 步必须计入「有可渲染过程」。
 *
 * Run: npx vitest run src/app/workspace/components/agent-message/__tests__/has-renderable-activity.test.ts
 */

import { describe, expect, it } from 'vitest';
import { hasRenderableActivity } from '../AgentMessage';
import type { ActivityStep } from '../types';

const TS = '2026-06-05T00:00:00.000Z';
const phaseStep = (phase: string, seq = 1): ActivityStep => ({
  id: `p${seq}`,
  seq,
  kind: 'reasoning',
  phase,
  occurredAt: TS,
});
const toolStep = (seq = 1): ActivityStep => ({
  id: `t${seq}`,
  seq,
  kind: 'tool',
  tool: 'skills_list',
  occurredAt: TS,
});
const reasoningTextStep = (text: string, seq = 1): ActivityStep => ({
  id: `r${seq}`,
  seq,
  kind: 'reasoning',
  reasoningText: text,
  occurredAt: TS,
});

describe('hasRenderableActivity — DoneStrip 入口 gate', () => {
  it('纯 phase_change（思考中/running）→ true（回归：之前误判 false 丢入口）', () => {
    expect(hasRenderableActivity([phaseStep('思考中', 1), phaseStep('running', 2)])).toBe(true);
  });

  it('有 tool 步 → true', () => {
    expect(hasRenderableActivity([toolStep()])).toBe(true);
  });

  it('有文本的 reasoning 步 → true', () => {
    expect(hasRenderableActivity([reasoningTextStep('thinking about X')])).toBe(true);
  });

  it('整体 reasoning 文本 → true', () => {
    expect(hasRenderableActivity([], '我先看一下需求')).toBe(true);
  });

  it('完全空（无步、无 reasoning）→ false（不挂空壳，避免噪音）', () => {
    expect(hasRenderableActivity([])).toBe(false);
  });

  it('reasoning 步既无文本又无 phase（纯噪音）→ false', () => {
    expect(hasRenderableActivity([{ id: 'x', seq: 1, kind: 'reasoning', occurredAt: TS }])).toBe(false);
  });
});
