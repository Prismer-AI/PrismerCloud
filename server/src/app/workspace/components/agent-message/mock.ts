'use client';

/**
 * mock.ts — 统一 Agent Message 的 mock 模型 + 生命周期驱动。
 *
 * 还原 HTML 对齐稿 play() 的节奏（docs/release201/proto/agent-message.html）：
 *   received → running(逐步 push steps + 更新 metrics/current) → done。
 *
 * mock-first（与 Evolution Studio v2 同策略，memory project_evolution_studio_v2）：
 * P0 纯前端驱动，字段名 mirror 真实 wire 形状，P1 wiring 时换成真实 SSE 流即可。
 *
 * 2026-06 精简：去 emoji；started/completed 带 toolCallId 配对；current 用语义
 * kind/tool（非 emoji icon）。
 *
 * 场景：工程师生成产品介绍 PDF（PDF 排版 → 拉能力 → 渲染 → 校验 → 上传 → 广播）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ActivityStep,
  AgentMessageModel,
  MessageSender,
  RunMetrics,
} from './types';

// ─── 静态身份 ────────────────────────────────────────────────────────────

const ENGINEER: MessageSender = {
  id: 'agent-engineer',
  name: '工程师',
  role: 'ENGINEER',
  isAgent: true,
  avatarSeed: 'engineer',
  // 头像走 avatarInitials（名字首字母）+ 渐变底色，不注入 emoji。
};

const HUMAN: MessageSender = {
  id: 'user-you',
  name: '你',
  isAgent: false,
  avatarSeed: 'you',
};

const THINK =
  '确认 PDF 排版库就绪 → 用 product-brief skill 拉七大能力 → 渲染 2 页(封面+目录) → 校验中文断行 → 导出上传 asset 广播群成员。封面走品牌渐变，目录锚到各章节。';

const ACTOR = 'hrrk36v4v9';

// ─── 事件脚本（started/completed 成对，按 callId 配对） ──────────────────────

interface EventScript {
  /** 同一次调用的 started + completed 共享 callId（配对键）。 */
  callId: string;
  tool: string;
  event: 'tool.started' | 'tool.completed';
  /** 该步实际内容：命令 / 路径 / url / 结果摘要。 */
  summary: string;
}

const EVENT_SCRIPT: EventScript[] = [
  { callId: 'c1', tool: 'terminal', event: 'tool.started', summary: 'pnpm -v && ls docs' },
  { callId: 'c1', tool: 'terminal', event: 'tool.completed', summary: '退出码 0' },
  { callId: 'c2', tool: 'search_files', event: 'tool.started', summary: 'README*' },
  { callId: 'c2', tool: 'search_files', event: 'tool.completed', summary: '命中 12' },
  { callId: 'c3', tool: 'search_files', event: 'tool.started', summary: 'prismer' },
  { callId: 'c3', tool: 'search_files', event: 'tool.completed', summary: '命中 31' },
  { callId: 'c4', tool: 'browser_navigate', event: 'tool.started', summary: 'https://prismer.cloud' },
  { callId: 'c4', tool: 'browser_navigate', event: 'tool.completed', summary: '200 · 抓取完成' },
  { callId: 'c5', tool: 'write_file', event: 'tool.started', summary: 'product.pdf · 2 pages' },
  { callId: 'c5', tool: 'write_file', event: 'tool.completed', summary: '80.6 KB' },
  { callId: 'c6', tool: 'asset_upload', event: 'tool.started', summary: '→ im_assets' },
  { callId: 'c6', tool: 'asset_upload', event: 'tool.completed', summary: 'asset_8f3 · 80.6 KB' },
  { callId: 'c7', tool: 'broadcast', event: 'tool.completed', summary: '3 members' },
];

// ─── PDF 附件 ────────────────────────────────────────────────────────────

const PDF_ASSET: AgentMessageModel['attachments'][number] = {
  id: 'asset_8f3',
  mime: 'application/pdf',
  sizeBytes: 82534, // ~80.6 KB
  filename: 'Prismer_Cloud_产品介绍.pdf',
};

// ─── 工具：把 EventScript 转成 ActivityStep ──────────────────────────────

function scriptToStep(ev: EventScript, seq: number, ts: string): ActivityStep {
  return {
    id: `step-${seq}`,
    seq,
    kind: 'tool',
    event: ev.event,
    toolCallId: ev.callId,
    tool: ev.tool,
    actor: ACTOR,
    summary: ev.summary,
    payloadJson: { actor: ACTOR, tool: ev.tool, args: ev.summary },
    occurredAt: ts,
  };
}

const ZERO_METRICS: RunMetrics = { steps: 0, tokens: 0, elapsedMs: 0, files: 0 };

// ─── 静态模型工厂（4 态展示用） ──────────────────────────────────────────

/** 构造一个完整 done 态模型（含全部 steps + reasoning + task + 附件）。 */
export function buildDoneModel(): AgentMessageModel {
  const now = Date.now();
  const steps = EVENT_SCRIPT.map((ev, i) =>
    scriptToStep(ev, i, new Date(now - (EVENT_SCRIPT.length - i) * 1500).toISOString()),
  );
  return {
    id: 'mock-agent-done',
    sender: ENGINEER,
    state: 'done',
    createdAt: new Date(now).toISOString(),
    body: 'PDF 已经生成并发送到群里了，共 2 页。大家可直接下载。@engineer @marketer 有问题随时提。',
    attachments: [PDF_ASSET],
    reasoning: THINK,
    steps,
    metrics: { steps: 7, tokens: 1400, elapsedMs: 18400, files: 1 },
    task: { id: 'task-pdf', title: '生成产品介绍 PDF', status: 'review' },
    current: { kind: 'tool', tool: 'broadcast', title: '生成产品介绍 PDF', summary: '2 文件 · 已广播' },
    mentions: ['engineer', 'marketer'],
    mentionChain: ['CEO', 'engineer'],
  };
}

/** running 态快照（执行到一半）。 */
export function buildRunningModel(): AgentMessageModel {
  const now = Date.now();
  const partial = EVENT_SCRIPT.slice(0, 8).map((ev, i) =>
    scriptToStep(ev, i, new Date(now - (8 - i) * 1500).toISOString()),
  );
  return {
    id: 'mock-agent-running',
    sender: ENGINEER,
    state: 'running',
    createdAt: new Date(now).toISOString(),
    body: '',
    attachments: [],
    reasoning: THINK,
    steps: partial,
    metrics: { steps: 4, tokens: 620, elapsedMs: 9200, files: 0 },
    task: { id: 'task-pdf', title: '生成产品介绍 PDF', status: 'in_progress' },
    current: { kind: 'tool', tool: 'browser_navigate', title: 'browser_navigate', summary: 'https://prismer.cloud' },
    mentionChain: ['CEO', 'engineer'],
  };
}

/** needs-action 态快照。 */
export function buildNeedsActionModel(): AgentMessageModel {
  const base = buildRunningModel();
  return {
    ...base,
    id: 'mock-agent-needs-action',
    state: 'needs-action',
    current: { kind: 'tool', tool: 'asset_upload', title: 'asset_upload', summary: '等待批准上传到群' },
    metrics: { steps: 6, tokens: 1100, elapsedMs: 14200, files: 1 },
  };
}

/** failed 态快照。 */
export function buildFailedModel(): AgentMessageModel {
  const base = buildRunningModel();
  return {
    ...base,
    id: 'mock-agent-failed',
    state: 'failed',
    current: { kind: 'tool', tool: 'write_file', title: 'write_file', summary: 'EACCES: 权限不足' },
    metrics: { steps: 5, tokens: 880, elapsedMs: 11300, files: 0 },
  };
}

/** human trigger 消息（触发本次执行的人类指令）。 */
export function buildHumanModel(): AgentMessageModel {
  return {
    id: 'mock-human-trigger',
    sender: HUMAN,
    state: 'human',
    createdAt: new Date(Date.now() - 30_000).toISOString(),
    body: '把产品介绍整理成 PDF 发群里，@engineer 你来。',
    attachments: [],
    steps: [],
    metrics: ZERO_METRICS,
  };
}

// ─── useMockLifecycle — 时间推进驱动 ──────────────────────────────────────

export interface MockLifecycleOptions {
  /** 播放速度倍率（1 / 2 / 4），默认 2。 */
  speed?: number;
  /** 是否自动开播（默认 true）。 */
  autoPlay?: boolean;
}

export interface MockLifecycleHandle {
  model: AgentMessageModel;
  /** 是否正在播放。 */
  playing: boolean;
  /** 重放（从 received 重新开始）。 */
  replay: () => void;
}

/**
 * 模拟 received → running → done 的时间推进，逐步 push steps + 更新
 * metrics/current，返回当前 AgentMessageModel。还原 HTML play() 节奏。
 */
export function useMockLifecycle(options: MockLifecycleOptions = {}): MockLifecycleHandle {
  const { speed = 2, autoPlay = true } = options;
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const [model, setModel] = useState<AgentMessageModel>(() => initialReceived());
  const [playing, setPlaying] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<number>(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const run = useCallback(() => {
    clearTimer();
    setPlaying(true);
    startRef.current = Date.now();

    // received → running 起步（thinking）
    setModel(() => ({
      ...initialReceived(),
      state: 'running',
      reasoning: THINK,
      task: { id: 'task-pdf', title: '生成产品介绍 PDF', status: 'in_progress' },
      current: { kind: 'reasoning', title: '分析任务', summary: '理解需求与约束' },
    }));

    let idx = 0;
    let tokens = 0;
    let completed = 0;
    const accumulated: ActivityStep[] = [];

    const step = () => {
      if (idx >= EVENT_SCRIPT.length) {
        const elapsed = Date.now() - startRef.current;
        setModel((prev) => ({
          ...prev,
          state: 'done',
          body: 'PDF 已经生成并发送到群里了，共 2 页。大家可直接下载。@engineer @marketer 有问题随时提。',
          attachments: [PDF_ASSET],
          metrics: { steps: completed, tokens: 1400, elapsedMs: elapsed, files: 1 },
          task: { id: 'task-pdf', title: '生成产品介绍 PDF', status: 'review' },
          current: { kind: 'tool', tool: 'broadcast', title: '生成产品介绍 PDF', summary: '2 文件 · 已广播' },
          mentions: ['engineer', 'marketer'],
        }));
        setPlaying(false);
        return;
      }

      const ev = EVENT_SCRIPT[idx];
      const isStart = ev.event === 'tool.started';
      const seq = accumulated.length;
      accumulated.push(scriptToStep(ev, seq, new Date().toISOString()));

      if (!isStart) {
        completed += 1;
        tokens += 100;
      }

      const elapsed = Date.now() - startRef.current;
      const snapshot = [...accumulated];

      setModel((prev) => ({
        ...prev,
        state: 'running',
        steps: snapshot,
        metrics: {
          steps: completed,
          tokens,
          elapsedMs: elapsed,
          files: ev.tool === 'asset_upload' && !isStart ? 1 : prev.metrics.files,
        },
        current: { kind: 'tool', tool: ev.tool, title: ev.tool, summary: ev.summary },
        task: { id: 'task-pdf', title: '生成产品介绍 PDF', status: 'in_progress' },
        reasoning: THINK,
      }));

      idx += 1;
      const gap = isStart ? 360 : 520;
      timerRef.current = setTimeout(step, gap / speedRef.current);
    };

    timerRef.current = setTimeout(step, 900 / speedRef.current);
  }, [clearTimer]);

  const replay = useCallback(() => {
    clearTimer();
    setModel(initialReceived());
    setTimeout(run, 60);
  }, [clearTimer, run]);

  useEffect(() => {
    if (autoPlay) {
      const t = setTimeout(run, 400);
      return () => {
        clearTimeout(t);
        clearTimer();
      };
    }
    return clearTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { model, playing, replay };
}

/** received 态初始模型。 */
function initialReceived(): AgentMessageModel {
  return {
    id: 'mock-agent-live',
    sender: ENGINEER,
    state: 'received',
    createdAt: new Date().toISOString(),
    body: '',
    attachments: [],
    reasoning: '',
    steps: [],
    metrics: { ...ZERO_METRICS },
    current: { kind: 'reasoning', title: '分析任务', summary: '' },
    mentionChain: ['CEO', 'engineer'],
  };
}
