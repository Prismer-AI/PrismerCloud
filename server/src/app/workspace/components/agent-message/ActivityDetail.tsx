'use client';

/**
 * ActivityDetail — 统一 Agent Message 展开后的「过程明细层」。
 *
 * 视觉对齐稿: docs/release201/proto/agent-message.html  #activity 面板
 * 字段契约:   docs/release201/32-unified-agent-message-component.md §3.1
 * 动画词汇:   docs/release201/32-unified-agent-message-component.md §3.2
 *
 * 设计原则（2026-06 精简）：一个步骤只承载三件事 —— 类型 + 状态 + 实际内容。
 *  - 类型：单色 lucide 图标 + tool 名（emoji 全部移除）。
 *  - 状态：完全由 timeline dot 的动画表达（进行中=青色脉冲环 + 行底 indeterminate
 *    shimmer；落定=emerald 实心、shimmer 消失）。不再有 `kind`/`event` 文字 chip。
 *  - 实际内容：该步真正做了什么 —— terminal 的命令 / 文件路径 / url / 命中数。
 *    取代旧的 `▶ payload` JSON（那是调试残留 + 与标题重复）。
 *  - 不渲染进度百分比/进度条 value —— daemon 只报 start/complete，无真实 0..100。
 *  - started→completed 按 `toolCallId` 配对，合并为同一行就地 morph。
 */

import React, { useMemo } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { springSoft, statusAccent } from '../../lib/design';
import { ToolIcon, ReasoningIcon } from './icons';
import type { ActivityDetailProps, ActivityStep, LinkedTask } from './types';

// ─── 相对时间格式化 ────────────────────────────────────────────────────────
function relTime(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 5000) return 'just now';
    if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
    return `${Math.round(diff / 3_600_000)}h ago`;
  } catch {
    return '';
  }
}

/** terminal/bash/shell 的内容是命令，等宽呈现更可读。 */
function isCommandTool(tool: string | undefined): boolean {
  return tool === 'terminal' || tool === 'bash' || tool === 'shell';
}

// ─── 合并后的「显示行」类型 ─────────────────────────────────────────────────
type DisplayRowBase = { key: string };

type ToolDisplayRow = DisplayRowBase & {
  kind: 'tool';
  phase: 'started' | 'settled';
  step: ActivityStep;
  /** settled 时落定的 tool 名（继承自 started）+ 内容摘要。 */
  tool?: string;
  settledSummary?: string;
};

type ReasoningDisplayRow = DisplayRowBase & {
  kind: 'reasoning';
  step: ActivityStep;
};

type PhaseDisplayRow = DisplayRowBase & {
  kind: 'phase';
  phase: string;
  step: ActivityStep;
};

type DisplayRow = ToolDisplayRow | ReasoningDisplayRow | PhaseDisplayRow;

/**
 * ActivityStep[] → 显示行。started/completed 按 toolCallId 配对合并为一行，
 * completed 时就地升级 phase=settled。completed 没带 tool 名时继承 started 的。
 */
function buildDisplayRows(steps: ActivityStep[]): DisplayRow[] {
  const sorted = [...steps].sort((a, b) => a.seq - b.seq);

  // 按 toolCallId 追踪未配对的 started 行；无 toolCallId 时退化用 tool 名。
  const inflight = new Map<string, ToolDisplayRow[]>();
  const rows: DisplayRow[] = [];

  const pairKey = (step: ActivityStep): string =>
    step.toolCallId ?? `name:${step.tool ?? '__unknown__'}`;

  for (const step of sorted) {
    if (step.kind === 'reasoning') {
      if (step.reasoningText && step.reasoningText.trim()) {
        // 真实 thinking 文本（reasoning_chunk）→ reasoning 行
        rows.push({ key: `reasoning-${step.id}`, kind: 'reasoning', step });
      } else if (step.phase) {
        // phase_change → 阶段分隔行（显示阶段名）；去重连续相同阶段，免刷屏
        const last = rows[rows.length - 1];
        if (!(last && last.kind === 'phase' && last.phase === step.phase)) {
          rows.push({ key: `phase-${step.id}`, kind: 'phase', phase: step.phase, step });
        }
      }
      // 既无文本又无 phase 的 reasoning 行 → 跳过（纯噪音）
      continue;
    }
    if (step.kind !== 'tool') continue;

    const key = pairKey(step);

    if (step.event === 'tool.completed') {
      const queue = inflight.get(key);
      if (queue && queue.length > 0) {
        // 就地落定最近未配对的 started 行
        const startedRow = queue.shift()!;
        if (queue.length === 0) inflight.delete(key);
        startedRow.phase = 'settled';
        startedRow.settledSummary = step.summary;
        // tool 名优先保留 started 的（completed 常缺名）
        startedRow.tool = startedRow.tool ?? step.tool;
        continue;
      }
      // 无配对 started（broadcast 只 completed）→ 直接落定行
      rows.push({
        key: `tool-${step.id}`,
        kind: 'tool',
        phase: 'settled',
        step,
        tool: step.tool,
        settledSummary: step.summary,
      });
      continue;
    }

    // tool.started（或缺 event 的 tool 行）→ 飞行态行
    const row: ToolDisplayRow = {
      key: `tool-${step.id}`,
      kind: 'tool',
      phase: 'started',
      step,
      tool: step.tool,
    };
    rows.push(row);
    const queue = inflight.get(key) ?? [];
    queue.push(row);
    inflight.set(key, queue);
  }

  return rows;
}

// ─── 单条工具行 ───────────────────────────────────────────────────────────
function ToolRow({
  row,
  reduce,
  isDark,
}: {
  row: ToolDisplayRow;
  reduce: boolean;
  isDark: boolean;
}): React.ReactElement {
  const settled = row.phase === 'settled';
  const tool = row.tool ?? row.step.tool;
  const content = settled ? (row.settledSummary ?? row.step.summary) : row.step.summary;
  const mono = isCommandTool(tool);

  const dotClass = settled
    ? 'absolute -left-[14px] top-2.5 h-[9px] w-[9px] rounded-full bg-emerald-400 ring-4 ring-white/5'
    : `absolute -left-[14px] top-2.5 h-[9px] w-[9px] rounded-full bg-cyan-400 ring-4 ring-white/5${
        !reduce ? ' animate-[dotPing_1.4s_ease-out_infinite]' : ''
      }`;

  return (
    <motion.li
      layout
      initial={reduce ? { opacity: 1 } : { opacity: 0, x: -10, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      transition={springSoft}
      className="relative rounded-md px-2 py-1.5"
    >
      <span aria-hidden className={dotClass} />

      {/* 标题行：图标 + 类型 + 时间 */}
      <div className="flex items-center gap-1.5">
        <ToolIcon
          tool={tool}
          size={13}
          className={settled ? (isDark ? 'text-zinc-400' : 'text-zinc-500') : 'text-cyan-400'}
          aria-hidden
        />
        <span className={`text-[12.5px] font-medium ${isDark ? 'text-zinc-100' : 'text-zinc-800'}`}>
          {tool ?? '工具'}
        </span>
        <span className={`ml-auto text-[10px] tabular-nums ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
          {relTime(row.step.occurredAt)}
        </span>
      </div>

      {/* 实际内容：命令 / 路径 / url / 摘要（取代旧 payload JSON） */}
      {content ? (
        <div
          className={`mt-0.5 truncate ${
            mono
              ? `font-mono text-[11px] ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`
              : `text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`
          }`}
          title={content}
        >
          {mono ? <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>$ </span> : null}
          {content}
        </div>
      ) : null}

      {/* 行底 indeterminate shimmer —— 仅飞行态 + 非减弱模式（无百分比、无 value 条） */}
      {!settled && !reduce ? (
        <div className={`relative mt-1.5 h-[2px] overflow-hidden rounded-full ${isDark ? 'bg-white/[0.06]' : 'bg-zinc-200'}`}>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 w-[40%] animate-[shimmer_1.1s_linear_infinite]"
            style={{ background: 'linear-gradient(90deg,transparent,rgba(34,211,238,.7),transparent)' }}
          />
        </div>
      ) : null}
    </motion.li>
  );
}

// ─── 单条 reasoning 行 ───────────────────────────────────────────────────
function ReasoningRow({
  row,
  reduce,
  isDark,
}: {
  row: ReasoningDisplayRow;
  reduce: boolean;
  isDark: boolean;
}): React.ReactElement {
  return (
    <motion.li
      layout
      initial={reduce ? { opacity: 1 } : { opacity: 0, x: -10, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      transition={springSoft}
      className="relative px-2 py-1"
    >
      <span
        aria-hidden
        className={`absolute -left-[14px] top-2.5 h-[9px] w-[9px] rounded-full ring-4 ${
          isDark ? 'bg-violet-400 ring-white/5' : 'bg-violet-500 ring-zinc-50'
        }`}
      />
      <div className="flex items-center gap-1.5">
        <ReasoningIcon size={13} className={isDark ? 'text-violet-300' : 'text-violet-600'} aria-hidden />
        <span className={`text-[12.5px] font-medium ${isDark ? 'text-violet-200' : 'text-violet-700'}`}>
          Reasoning
        </span>
      </div>
      {row.step.reasoningText ? (
        <div className={`mt-0.5 line-clamp-2 text-[11px] italic ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
          {row.step.reasoningText}
        </div>
      ) : null}
    </motion.li>
  );
}

// ─── 阶段分隔行（phase_change） ─────────────────────────────────────────────
function PhaseRow({
  row,
  reduce,
  isDark,
}: {
  row: PhaseDisplayRow;
  reduce: boolean;
  isDark: boolean;
}): React.ReactElement {
  return (
    <motion.li
      layout
      initial={reduce ? { opacity: 1 } : { opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={springSoft}
      className="relative px-2 py-0.5"
    >
      <span
        aria-hidden
        className={`absolute -left-[13px] top-2 h-[7px] w-[7px] rounded-full ring-4 ${
          isDark ? 'bg-zinc-600 ring-white/5' : 'bg-zinc-300 ring-zinc-50'
        }`}
      />
      <span className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>{row.phase}</span>
    </motion.li>
  );
}

// ─── Thinking 区块 ────────────────────────────────────────────────────────
function ThinkingBlock({
  reasoning,
  live,
  reduce,
  isDark,
}: {
  reasoning: string;
  live: boolean;
  reduce: boolean;
  isDark: boolean;
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const clamp = !live && !expanded;

  return (
    <div className="mb-2.5">
      <div className="mb-1 flex items-center justify-between">
        <span className={`text-[9px] uppercase tracking-wider ${isDark ? 'text-violet-300/70' : 'text-violet-500'}`}>
          Thinking
        </span>
        {!live && reasoning.length > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className={`text-[9px] ${isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-600'}`}
          >
            {expanded ? '收起 ↑' : '展开 ↓'}
          </button>
        ) : null}
      </div>
      <div className={`overflow-hidden border-l-2 pl-2.5 ${isDark ? 'border-violet-400/30' : 'border-violet-300/50'}`}>
        <p
          className={`text-[11.5px] leading-relaxed italic ${isDark ? 'text-zinc-400' : 'text-zinc-500'} ${
            clamp ? 'line-clamp-3' : ''
          }`}
        >
          {reasoning}
          {live && !reduce ? (
            <span
              aria-hidden
              className={`ml-0.5 animate-[blink_1s_step-end_infinite] ${isDark ? 'text-violet-300' : 'text-violet-500'}`}
            >
              ▍
            </span>
          ) : null}
        </p>
      </div>
    </div>
  );
}

// ─── Task Chip ────────────────────────────────────────────────────────────
function TaskChip({
  task,
  onOpenTask,
  isDark,
}: {
  task: LinkedTask;
  onOpenTask?: (task: LinkedTask) => void;
  isDark: boolean;
}): React.ReactElement {
  const accent = statusAccent[task.status] ?? statusAccent.backlog;
  return (
    <div className="mt-2.5">
      <button
        type="button"
        onClick={() => onOpenTask?.(task)}
        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
          isDark
            ? 'border-violet-400/20 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20'
            : 'border-violet-300/30 bg-violet-50 text-violet-700 hover:bg-violet-100'
        }`}
        style={{ transition: 'all 0.2s cubic-bezier(.3,1.1,.5,1)' }}
      >
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${accent.dot}`} />
        <span className="max-w-[200px] truncate">{task.title}</span>
        <span className={`rounded px-1 text-[9px] ${isDark ? `${accent.bg} ${accent.text}` : 'bg-zinc-100 text-zinc-500'}`}>
          {task.status}
        </span>
      </button>
    </div>
  );
}

// ─── ActivityDetail 主组件 ────────────────────────────────────────────────
export function ActivityDetail({
  reasoning,
  live,
  steps,
  task,
  onOpenTask,
  isDark = false,
}: ActivityDetailProps): React.ReactElement {
  const reduceRaw = useReducedMotion();
  const reduce = reduceRaw ?? false;
  const displayRows = useMemo(() => buildDisplayRows(steps), [steps]);

  const hasThinking = !!reasoning && reasoning.length > 0;
  // 过滤后什么都不剩（纯 phase_change）→ 不渲染空「过程明细」壳。
  if (!hasThinking && displayRows.length === 0 && !task) {
    return <></>;
  }

  return (
    <div
      className={`rounded-[17px] border p-3 ${isDark ? 'border-white/[0.07] bg-zinc-900/40' : 'border-zinc-200/60 bg-white/60'}`}
      style={{ backdropFilter: 'blur(10px)' }}
    >
      <div className="mb-2.5 flex items-center gap-2">
        <span className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
          过程明细
        </span>
      </div>

      {reasoning && reasoning.length > 0 ? (
        <ThinkingBlock reasoning={reasoning} live={live} reduce={reduce} isDark={isDark} />
      ) : null}

      {displayRows.length > 0 ? (
        <>
          <div className={`mb-1.5 text-[9px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
            Event timeline
          </div>
          <ol
            className="relative space-y-1.5 pl-4"
            style={{
              backgroundImage: isDark
                ? 'linear-gradient(to bottom, rgba(34,211,238,.35), rgba(255,255,255,.05))'
                : 'linear-gradient(to bottom, rgba(34,211,238,.25), rgba(0,0,0,.03))',
              backgroundRepeat: 'no-repeat',
              backgroundSize: '1.5px 100%',
              backgroundPosition: '6px 8px',
            }}
          >
            <AnimatePresence initial={false}>
              {displayRows.map((row) =>
                row.kind === 'tool' ? (
                  <ToolRow key={row.key} row={row} reduce={reduce} isDark={isDark} />
                ) : row.kind === 'phase' ? (
                  <PhaseRow key={row.key} row={row} reduce={reduce} isDark={isDark} />
                ) : (
                  <ReasoningRow key={row.key} row={row} reduce={reduce} isDark={isDark} />
                ),
              )}
            </AnimatePresence>
          </ol>
        </>
      ) : null}

      {task ? <TaskChip task={task} onOpenTask={onOpenTask} isDark={isDark} /> : null}
    </div>
  );
}

export default ActivityDetail;
