'use client';

/**
 * AgentMessageContainer — 真实 IM message + task timeline → <AgentMessage>（release201/32 §3.1 · P1）。
 *
 * SoT design: docs/release201/32-unified-agent-message-component.md §3.1。
 *
 * 容器层职责：拿真实数据 → adapter 组装 model → 渲染纯展示组件 <AgentMessage>。
 * **复用既有 hook，不造新 SSE**：
 *   - fetchTaskTimeline（mount hydrate）+ subscribeTaskStep（task-step-bus 上的
 *     `task.step.appended`，由 im-channel 单一 EventSource fan-out）+ useReconciledStream
 *     （去重 / 补洞 / cursor 持久化）。
 *   - 这套 = inline-activity-strip.tsx 的同一数据管线（同源，保证两者行为一致）。
 *
 * 关键契约：
 *   - timeline step 持续 append 进 model.steps，但**不**强制展开——展开与否是
 *     <AgentMessage> 内部 state，容器不管（§3 渐进披露硬约束）。
 *   - 无 dispatchId / 无 runId 时：steps 为空，纯 reply 消息照样渲染（state 走
 *     done/received，由 adapter.deriveState 决定）。
 */

import { useCallback, useEffect, useMemo } from 'react';
import { fetchTaskTimeline, type ActivityTimelineStep } from '../../lib/sync-api';
import { subscribeTaskStep, type TaskStepBusEvent } from '../../lib/task-step-bus';
import { useReconciledStream, type ReconciledItem } from '../../hooks/use-reconciled-stream';
import { AgentMessage } from './AgentMessage';
import {
  decodeTimelineStep,
  messageToModel,
  type AdapterMessageInput,
} from './adapter';
import type { LinkedTask, MessageAsset, MessageSender } from './types';

// ─── ReconciledItem-shaped 包装（照 inline-activity-strip 的 StreamStep） ────
// useReconciledStream 需要 ReconciledItem（id + boundarySeq）。把 timeline step
// 镜像成同形状，复用 hook 的去重 / 补洞，无需改 hook。
interface StreamStep extends ReconciledItem {
  id: string;
  boundarySeq: number;
  seq: number;
  kind: string;
  payloadJson: unknown;
  occurredAt: string;
  durationMs: number | null;
}

function toStreamStep(step: ActivityTimelineStep): StreamStep {
  return {
    id: String(step.seq),
    boundarySeq: step.seq,
    seq: step.seq,
    kind: step.kind,
    payloadJson: step.payloadJson,
    occurredAt: step.occurredAt,
    durationMs: step.durationMs,
  };
}

/** StreamStep → adapter 入口要的 ActivityTimelineStep 形状（同字段）。 */
function toTimelineStep(s: StreamStep): ActivityTimelineStep {
  return {
    id: s.id,
    seq: s.seq,
    kind: s.kind,
    payloadJson: s.payloadJson,
    occurredAt: s.occurredAt,
    durationMs: s.durationMs,
  };
}

// ─── Props ────────────────────────────────────────────────────────────────

export interface AgentMessageContainerProps {
  /** 真实 IM message（结构兼容 im-channel 的 MessageDTO 子集）。 */
  message: AdapterMessageInput;
  /** 会话作用域 —— 跨会话事件隔离（task-step-bus 过滤）。 */
  conversationId: string | null;
  /**
   * 驱动本次执行的 IMTaskRun id（或可 resolve 的 taskId）。来自
   * `message.metadata.taskId`（im-channel ws/handler 写）。可能是 run id，也可能
   * 是 task id —— 后者 resolveLatestTaskRunId 解到最新 run。缺省时不拉 timeline。
   */
  dispatchId?: string | null;
  /** 发送者身份。 */
  sender: MessageSender;
  /** 关联 kanban task。 */
  task?: LinkedTask;
  /** 等待人审（sticky，amber）。 */
  awaitingApproval?: boolean;
  /** 执行失败。 */
  failed?: boolean;
  /** task 已进 terminal phase。 */
  terminalPhase?: boolean;
  /** run 级 token（§3.1 #5 后端缺口，缺省 0）。 */
  tokens?: number;
  /** @-mention 责任链。 */
  mentionChain?: string[];

  // ─── 透传 <AgentMessage> 的 handler / 主题 ───
  isDark?: boolean;
  onCopy?: () => void;
  onForward?: () => void;
  onSaveToMemory?: () => void;
  onQuote?: () => void;
  onOpenAsset?: (asset: MessageAsset) => void;
  onOpenTask?: (task: LinkedTask) => void;
  onApprove?: () => void;
  onReject?: () => void;
  onRetry?: () => void;
  scrollContainer?: React.RefObject<HTMLElement | null>;
  /** 透传 <AgentMessage> 的 reply-body slot（im-channel 注入 <MessagePrismerLinks>）。 */
  bodyExtras?: React.ReactNode;
  /**
   * release201/32 §9 — running 挂载模式。dispatch 执行中、reply 尚未落地时,
   * im-channel 用 `pendingDispatches`（{agentImUserId, dispatchId}）渲染一个
   * 占位的 running 态统一组件,订阅 live timeline。无 reply body 时强制 state=
   * 'running'（否则 deriveState 会给 'received'）。reply 落地后 pendingDispatches
   * 自动去重,占位消失、真实 reply 接管。
   */
  runningPlaceholder?: boolean;
}

export function AgentMessageContainer({
  message,
  conversationId,
  dispatchId,
  sender,
  task,
  awaitingApproval,
  failed,
  terminalPhase,
  tokens,
  mentionChain,
  isDark,
  onCopy,
  onForward,
  onSaveToMemory,
  onQuote,
  onOpenAsset,
  onOpenTask,
  onApprove,
  onReject,
  onRetry,
  scrollContainer,
  bodyExtras,
  runningPlaceholder,
}: AgentMessageContainerProps): React.ReactElement {
  // ─── taskRunId ──
  // dispatchId 在 chat 派发路径上**就是** IMTaskRun.id（ws/handler 把 run id 写进
  // message.metadata.taskId），timeline 端点直接接受它。之前还额外打
  // `resolveLatestTaskRunId` → `GET /tasks/:id`(detail 端点只认 task id)→ 对每条
  // done 卡都 404，造成 404 风暴(release201/32 §9 回归)。直接用 dispatchId 即可。
  const runId = dispatchId ?? '';

  const initialLoader = useCallback(async () => {
    if (!runId) return { items: [] as StreamStep[], lastSeq: 0 };
    const res = await fetchTaskTimeline({ taskRunId: runId, limit: 200 });
    if (!res.ok) return { items: [] as StreamStep[], lastSeq: 0 };
    const items = res.data.steps.map(toStreamStep);
    const lastSeq = items.reduce((acc: number, s: StreamStep) => (s.seq > acc ? s.seq : acc), 0);
    return { items, lastSeq };
  }, [runId]);

  const catchUp = useCallback(
    async (afterSeq: number) => {
      if (!runId) return { items: [] as StreamStep[] };
      const res = await fetchTaskTimeline({ taskRunId: runId, afterSeq, limit: 200 });
      if (!res.ok) return { items: [] as StreamStep[] };
      return { items: res.data.steps.map(toStreamStep) };
    },
    [runId],
  );

  const stream = useReconciledStream<StreamStep>({
    scope: { kind: 'task', id: runId },
    initialLoader,
    catchUp,
    compareItems: useCallback((a: StreamStep, b: StreamStep) => a.seq - b.seq, []),
    // 与 inline-activity-strip 共用 cursor 前缀 —— 同一 taskRun 同一游标，跨组件续读。
    storagePrefix: 'cursor:activity',
  });

  // ─── SSE 订阅（task-step-bus，im-channel fan-out 的 task.step.appended） ───
  useEffect(() => {
    if (!runId) return;
    const off = subscribeTaskStep(runId, conversationId, (event: TaskStepBusEvent) => {
      stream.applyExternal(toStreamStep(event.step));
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, conversationId]);

  // ─── 解码 + 组装 model ───
  const decodedSteps = useMemo(
    () => stream.items.map((s) => decodeTimelineStep(toTimelineStep(s))),
    [stream.items],
  );

  const model = useMemo(() => {
    const m = messageToModel({
      message,
      steps: decodedSteps,
      sender,
      task,
      awaitingApproval,
      failed,
      terminalPhase,
      tokens,
      mentionChain,
    });
    // running 占位:reply 未落地(无 body/附件)时,deriveState 给 'received';
    // 这里强制 'running',让状态卡进入执行态(spinner + 呼吸背光 + live timeline)。
    if (runningPlaceholder && m.state !== 'done' && m.state !== 'failed' && m.state !== 'needs-action') {
      return { ...m, state: 'running' as const };
    }
    return m;
  }, [
    message,
    decodedSteps,
    sender,
    task,
    awaitingApproval,
    failed,
    terminalPhase,
    tokens,
    mentionChain,
    runningPlaceholder,
  ]);

  return (
    <AgentMessage
      model={model}
      isDark={isDark}
      onCopy={onCopy}
      onForward={onForward}
      onSaveToMemory={onSaveToMemory}
      onQuote={onQuote}
      onOpenAsset={onOpenAsset}
      onOpenTask={onOpenTask}
      onApprove={onApprove}
      onReject={onReject}
      onRetry={onRetry}
      scrollContainer={scrollContainer}
      bodyExtras={bodyExtras}
    />
  );
}
