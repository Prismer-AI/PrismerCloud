'use client';

/**
 * AgentMessage — 统一 Agent Message 的状态机外壳（superset 主组件）。
 *
 * 一条 agent message 的信息复杂度 ≫ 人类 message：本组件以 agent 全集为超集，
 * 按 `model.state` 状态机决定渲染哪些 slot；human message = 其裁剪子集
 * （关掉 StatusCard / ActivityDetail / metrics，ActionBar 只留 copy/forward/quote）。
 *
 * 解剖（doc 32 §4 slot 矩阵）：
 *   Header        avatar · name · roleBadge · mentionChain · lifecycleDot · time
 *   glowwrap      双色呼吸背光容器，包裹：
 *     ├ StatusCard       折叠态核心卡（glowPhase 驱动背光色）
 *     ├ ActivityDetail   展开后过程明细（默认折叠；append 不触发展开）
 *     └ Reply body       done 态揭示：markdown + @mention 高亮 + 附件卡
 *   ActionBar     hover 浮出（零布局位移：常驻 + opacity）
 *
 * 关键交互契约（doc 32 §3 + HTML 稿 play()）：
 *   - ActivityDetail 默认折叠；`model.steps` 更新 **不** 自动展开；
 *     只有用户点 StatusCard 才 toggle `expanded`。
 *   - 浮动跳转锚点：running 且本消息滚出 scrollContainer 顶沿时浮现，点击回跳。
 *   - hover 操作条用 opacity 切换，绝不用 display（避免布局抖动 / 肌肉记忆错位）。
 *
 * SoT doc：docs/release201/32-unified-agent-message-component.md
 * HTML 对齐稿：docs/release201/proto/agent-message.html
 * 契约：./types.ts（AgentMessageProps / AgentMessageModel / AgentMessageState）
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Copy, Forward, Bookmark, Quote, CheckCircle2, ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import MarkdownRenderer from '@/components/ui/markdown-renderer';
import { springSnap, springSoft, springHeavy } from '../../lib/design';
import { MessageAssetCard, type MessageAsset as CardMessageAsset } from '../message-asset-card';
import { AgentAvatar } from '../agent-avatar';
// release201/32 P2 — multimodal reply parity: reuse the shared ContentBlock renderer.
import { MessageContentBlocks } from '../content-blocks';
import { StatusCard } from './StatusCard';
import { ActivityDetail } from './ActivityDetail';
import type {
  ActivityStep,
  AgentMessageProps,
  AgentMessageModel,
  AgentMessageState,
  GlowPhase,
  MessageAsset,
  MessageSender,
} from './types';

// ─── 过程可渲染性判定（DoneStrip 入口 gate） ─────────────────────────────

/**
 * 时间线是否有「会被 ActivityDetail 渲染成行」的内容 —— 决定完成态是否显示
 * 上方「展开过程」入口（DoneStrip）。必须与 ActivityDetail 的实际渲染对齐：
 *   - tool 行
 *   - 有文本的 reasoning 行（reasoning_chunk → reasoningText）
 *   - phase 分隔行（phase_change → step.phase，思考中/running/调用工具…）
 *   - 整体 reasoning 文本
 * 漏掉 phase 行会让「只思考、没调工具、且 reasoning_chunk 未录制」的纯对话
 * 回复在输出后丢掉展开入口（旧 InlineActivityStrip 只要 stepCount>0 就给入口）。
 */
export function hasRenderableActivity(steps: ActivityStep[], reasoning?: string | null): boolean {
  return (
    steps.some((s) => s.kind === 'tool') ||
    steps.some((s) => s.kind === 'reasoning' && (!!s.reasoningText?.trim() || !!s.phase)) ||
    (reasoning?.trim().length ?? 0) > 0
  );
}

// ─── 状态 → 文案 / 色彩派生 ──────────────────────────────────────────────

/** state → 状态卡 phaseLabel（StatusCard 顶部徽章文案）。running 态再由 current.kind 细分思考/动作。 */
function phaseLabelFor(model: AgentMessageModel): string {
  const state = model.state;
  if (state === 'done') return '完成';
  if (state === 'needs-action') return '等待确认';
  if (state === 'failed') return '执行失败';
  if (state === 'received') return '已接收';
  // running：current.kind 为 reasoning 视为思考态，否则动作态
  if (model.current?.kind === 'reasoning') return '思考中';
  return '调用工具';
}

/**
 * state → 双色呼吸背光阶段（doc 32 §3.3）。
 *   思考态(running + reasoning) → thinking(紫)
 *   动作态(running + tool) → action(青)
 *   done / 其他 → off（熄灭）
 * received 态尚无动态信息，归 off。
 */
function glowPhaseFor(model: AgentMessageModel): GlowPhase {
  if (model.state !== 'running') return 'off';
  return model.current?.kind === 'reasoning' ? 'thinking' : 'action';
}

/** 生命周期 dot 颜色（Header 右侧小圆点）。 */
function lifeDot(state: AgentMessageState): { dot: string; text: string; label: string; breathe: boolean } {
  switch (state) {
    case 'received':
      return { dot: 'bg-cyan-400', text: 'text-cyan-300/80', label: '已接收', breathe: true };
    case 'running':
      return { dot: 'bg-cyan-400', text: 'text-cyan-300/80', label: '执行中', breathe: true };
    case 'needs-action':
      return { dot: 'bg-amber-400', text: 'text-amber-300/80', label: '等待确认', breathe: true };
    case 'failed':
      return { dot: 'bg-rose-400', text: 'text-rose-300/80', label: '执行失败', breathe: false };
    case 'done':
    default:
      return { dot: 'bg-emerald-400', text: 'text-emerald-300/80', label: '完成', breathe: false };
  }
}

// ─── @mention 正文高亮 ───────────────────────────────────────────────────
// 简单实现：把 `@xxx` token 包成彩色 span。在 markdown 渲染外层处理——
// 由于 MarkdownRenderer 接收纯文本，这里把已知 mention 替换成内联 HTML 标记
// 不可行（renderer 会转义），故采用「分段渲染」：mention 命中处单独渲染 chip。
// P0 取简洁路径：正文整体走 MarkdownRenderer，mention chip 另起一行汇总。
// 但为贴合 HTML 稿（mention 内嵌正文），这里对「单段纯文本」做内联高亮，
// 含 markdown 结构时退化为整体 markdown 渲染。

/** 判断 body 是否是可安全内联高亮的「单段纯文本」（无 markdown 块级语法）。 */
function isPlainParagraph(body: string): boolean {
  return !/[#*`>\-\[\]|]|\n\n/.test(body);
}

const MENTION_COLORS: Record<string, string> = {
  // 角色 → chip 配色（与 HTML 稿对齐）
  engineer: 'bg-cyan-500/15 text-cyan-300',
  marketer: 'bg-amber-500/15 text-amber-300',
  ceo: 'bg-violet-500/15 text-violet-300',
  ops: 'bg-emerald-500/15 text-emerald-300',
};

function mentionChipClass(name: string): string {
  return MENTION_COLORS[name.toLowerCase()] ?? 'bg-violet-500/15 text-violet-300';
}

/**
 * role badge 配色 — 每类 agent 角色用不同色系，
 * 让 Header 中的 badge 和 Avatar 配套形成视觉锚点。
 */
const ROLE_BADGE_MAP: Record<string, string> = {
  CEO: 'bg-violet-500/15 text-violet-300 border-violet-400/20',
  CTO: 'bg-indigo-500/15 text-indigo-300 border-indigo-400/20',
  ENGINEER: 'bg-cyan-500/15 text-cyan-300 border-cyan-400/20',
  MARKETER: 'bg-amber-500/15 text-amber-300 border-amber-400/20',
  DESIGNER: 'bg-pink-500/15 text-pink-300 border-pink-400/20',
  OPS: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/20',
  ANALYST: 'bg-sky-500/15 text-sky-300 border-sky-400/20',
  RESEARCHER: 'bg-teal-500/15 text-teal-300 border-teal-400/20',
  WRITER: 'bg-rose-500/15 text-rose-300 border-rose-400/20',
  SALES: 'bg-orange-500/15 text-orange-300 border-orange-400/20',
  SUPPORT: 'bg-lime-500/15 text-lime-300 border-lime-400/20',
  FINANCE: 'bg-yellow-500/15 text-yellow-300 border-yellow-400/20',
  HR: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-400/20',
  LEGAL: 'bg-slate-500/15 text-slate-300 border-slate-400/20',
  PM: 'bg-blue-500/15 text-blue-300 border-blue-400/20',
  QA: 'bg-green-500/15 text-green-300 border-green-400/20',
};

function roleBadgeClass(role: string): string {
  return (
    ROLE_BADGE_MAP[role.toUpperCase()] ??
    ROLE_BADGE_MAP[role] ??
    'bg-violet-500/15 text-violet-300 border-violet-400/20'
  );
}

/** 内联高亮：把纯文本段落里的 `@xxx` 包成彩色 span。 */
function renderPlainWithMentions(body: string, isDark: boolean): React.ReactNode {
  // Align with markdown-renderer: username allows `-`/`.` (so `custom-role-x`
  // chips whole, not just `custom`); lookbehind skips emails / mid-word `@`.
  const parts = body.split(/((?<![A-Za-z0-9])@(?:[A-Za-z0-9._-]+|[一-龥]+))/g);
  return (
    <p className={cn('text-[13.5px] leading-relaxed', isDark ? 'text-zinc-200' : 'text-zinc-800')}>
      {parts.map((part, i) => {
        if (part.startsWith('@')) {
          const name = part.slice(1);
          return (
            <span key={i} className={cn('px-1 rounded', mentionChipClass(name))}>
              {part}
            </span>
          );
        }
        return <React.Fragment key={i}>{part}</React.Fragment>;
      })}
    </p>
  );
}

// ─── Avatar ─────────────────────────────────────────────────────────────
// Delegates to the shared <AgentAvatar> so every surface (session chip /
// member popover / contacts / message stream) resolves the SAME identity:
//   - agents → role icon (Crown/Wrench/Megaphone), username-first; uploaded
//     avatarUrl covers it when set.
//   - humans → uploaded avatarUrl, else initials (NOT a Bot role icon).
// sender.avatarEmoji is preserved as a small overlay when present.
// `size='sm'` (h-7/w-7) is the closest preset to the legacy w-8 slot.

function Avatar({ sender, isDark }: { sender: MessageSender; isDark: boolean }): React.ReactElement {
  const emojiOverlay = sender.avatarEmoji ? (
    <span className="pointer-events-none absolute -bottom-0.5 -right-0.5 text-[11px] leading-none select-none">
      {sender.avatarEmoji}
    </span>
  ) : undefined;

  if (sender.isAgent) {
    return (
      <AgentAvatar
        agent={{
          agentId: sender.id,
          userId: sender.id,
          name: sender.name,
          username: sender.username ?? undefined,
          agentType: sender.role ?? undefined,
        }}
        avatarUrl={sender.avatarUrl}
        size="sm"
        isDark={isDark}
        overlay={emojiOverlay}
      />
    );
  }

  // Human sender — fallback path renders the uploaded avatar or initials
  // (no Bot role icon): no `username`/`roleSlug` is passed.
  return (
    <AgentAvatar
      fallback={{
        seed: sender.avatarSeed,
        label: sender.name,
        avatarUrl: sender.avatarUrl ?? null,
      }}
      size="sm"
      isDark={isDark}
      overlay={emojiOverlay}
    />
  );
}

// ─── Header ─────────────────────────────────────────────────────────────

function Header({ model, isDark }: { model: AgentMessageModel; isDark: boolean }): React.ReactElement {
  const isHuman = model.state === 'human';
  const life = isHuman ? null : lifeDot(model.state as AgentMessageState);
  const time = useMemo(() => {
    try {
      return new Date(model.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }, [model.createdAt]);

  return (
    <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
      <span className={cn('font-semibold text-[13.5px]', isDark ? 'text-zinc-100' : 'text-zinc-900')}>
        {model.sender.name}
      </span>

      {/* role badge — 颜色按角色区分，不同 agent 一眼可辨 */}
      {model.sender.role && (
        <span className={cn('text-[9px] px-1.5 py-0.5 rounded-full border', roleBadgeClass(model.sender.role))}>
          {model.sender.role}
        </span>
      )}

      {/* 责任链 A→B→C（group 场景） */}
      {model.mentionChain && model.mentionChain.length > 1 && (
        <span className="inline-flex items-center gap-0.5 text-[10px] text-zinc-500">
          {model.mentionChain.map((hop, i) => (
            <React.Fragment key={`${hop}-${i}`}>
              {i > 0 && <span className="text-zinc-600">→</span>}
              <span className="text-zinc-400">{hop}</span>
            </React.Fragment>
          ))}
        </span>
      )}

      {/* lifecycle dot + label（human 无） */}
      {life && (
        <>
          <span className={cn('w-1.5 h-1.5 rounded-full', life.dot, life.breathe ? 'motion-safe:animate-pulse' : '')} />
          <span className={cn('text-[10.5px]', life.text)}>{life.label}</span>
        </>
      )}

      <span className="ml-auto text-[10px] text-zinc-500 tabular-nums">{time}</span>
    </div>
  );
}

// ─── ActionBar（hover 浮出，零布局位移） ──────────────────────────────────

function ActionBar({
  subset,
  onCopy,
  onForward,
  onSaveToMemory,
  onQuote,
}: {
  /** human 子集只显示 copy/forward/quote */
  subset: boolean;
  onCopy?: () => void;
  onForward?: () => void;
  onSaveToMemory?: () => void;
  onQuote?: () => void;
}): React.ReactElement {
  const btn = 'px-1.5 py-1 rounded-md hover:bg-white/10 hover:text-zinc-200 text-zinc-500 transition-colors';
  return (
    // 常驻挂载 + opacity 切换：group-hover 控制可见性，绝不 display:none（避免布局抖动）
    <div
      className={cn(
        'flex items-center gap-0.5 mt-1.5',
        'opacity-0 translate-y-0.5 pointer-events-none',
        'group-hover:opacity-100 group-hover:translate-y-0 group-hover:pointer-events-auto',
        'transition-[opacity,transform] duration-200',
      )}
    >
      {/* 仅渲染有真实 handler 的按钮——避免「按了没反应」的死按钮
          (one intent, one visible affordance)。copy 恒可用。 */}
      {onCopy && (
        <button type="button" className={btn} title="复制" onClick={onCopy} aria-label="复制">
          <Copy size={14} />
        </button>
      )}
      {onForward && (
        <button type="button" className={btn} title="转发" onClick={onForward} aria-label="转发">
          <Forward size={14} />
        </button>
      )}
      {!subset && onSaveToMemory && (
        <button type="button" className={btn} title="存入 Memory" onClick={onSaveToMemory} aria-label="存入 Memory">
          <Bookmark size={14} />
        </button>
      )}
      {onQuote && (
        <button type="button" className={btn} title="引用" onClick={onQuote} aria-label="引用">
          <Quote size={14} />
        </button>
      )}
    </div>
  );
}

// ─── Reply body（done 态揭示） ───────────────────────────────────────────

function ReplyBody({
  model,
  isDark,
  reduce,
  onOpenAsset,
  bodyExtras,
}: {
  model: AgentMessageModel;
  isDark: boolean;
  reduce: boolean;
  onOpenAsset?: (asset: MessageAsset) => void;
  bodyExtras?: React.ReactNode;
}): React.ReactElement {
  const plain = isPlainParagraph(model.body);
  return (
    <motion.div
      initial={reduce ? { opacity: 1 } : { opacity: 0, y: 6, height: 0 }}
      animate={{ opacity: 1, y: 0, height: 'auto' }}
      transition={reduce ? { duration: 0 } : springHeavy}
      className="overflow-hidden"
    >
      <div
        className={cn(
          'mt-1.5 rounded-[17px] rounded-tl-sm border px-3.5 py-2.5 backdrop-blur-md',
          isDark ? 'border-white/[0.08] bg-zinc-900/50' : 'border-zinc-200 bg-white/70',
        )}
      >
        {/* 多模态 ContentBlock[] 优先（与 im-channel MessageBubbleBody 对齐）；
            否则回退到 markdown / 纯文本 @mention 高亮。 */}
        {model.contentBlocks && model.contentBlocks.length > 0 ? (
          <MessageContentBlocks blocks={model.contentBlocks} isDark={isDark} />
        ) : (
          model.body &&
          (plain ? (
            renderPlainWithMentions(model.body, isDark)
          ) : (
            <MarkdownRenderer content={model.body} highlightMentions className="text-[13.5px] leading-relaxed" />
          ))
        )}

        {/* prismer:// 资源/任务链接 slot（im-channel 注入 <MessagePrismerLinks>）。 */}
        {bodyExtras}

        {/* 附件：复用 MessageAssetCard */}
        {model.attachments.length > 0 && (
          <div className="mt-2.5 flex flex-col gap-2">
            {model.attachments.map((a) => (
              <MessageAssetCard
                key={a.id}
                asset={a as CardMessageAsset}
                isDark={isDark}
                onPreview={onOpenAsset ? (asset) => onOpenAsset(asset as MessageAsset) : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ─── DoneStrip（done 态：过程缩成顶部一行，让位给结果） ─────────────────────
// 合并重构核心（用户点 5）：消息完结后，动态/过程信息缩到顶上一行，结果气泡
// 成为主体。无过程（0 步且无 reasoning）的纯回复直接不渲染本条 —— 零噪音。
function DoneStrip({
  model,
  expanded,
  onToggle,
  isDark,
}: {
  model: AgentMessageModel;
  expanded: boolean;
  onToggle: () => void;
  isDark: boolean;
}): React.ReactElement | null {
  // 只在「有可渲染过程」时显示条（与 ActivityDetail 实际渲染对齐 —— 见
  // hasRenderableActivity）。漏掉 phase 行曾导致纯思考回复输出后丢掉展开入口。
  if (!hasRenderableActivity(model.steps, model.reasoning)) return null;

  const { steps, elapsedMs, files } = model.metrics;
  const parts: string[] = [];
  if (steps > 0) parts.push(`${steps} 步`);
  if (elapsedMs > 0) parts.push(`${(elapsedMs / 1000).toFixed(1)}s`);
  if (files > 0) parts.push(`${files} 文件`);

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] transition-colors',
        isDark
          ? 'text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300'
          : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600',
      )}
    >
      <CheckCircle2 size={12} className="shrink-0 text-emerald-400/80" aria-hidden />
      <span className={isDark ? 'text-zinc-400' : 'text-zinc-500'}>完成</span>
      {parts.length > 0 && <span className="tabular-nums">· {parts.join(' · ')}</span>}
      <span className="ml-auto inline-flex items-center gap-0.5">
        {expanded ? '收起过程' : '展开过程'}
        <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={springSnap} className="inline-flex">
          <ChevronDown size={11} />
        </motion.span>
      </span>
    </button>
  );
}

// ─── 浮动跳转锚点 ─────────────────────────────────────────────────────────

function useFloatingJump(
  model: AgentMessageModel,
  rootRef: React.RefObject<HTMLDivElement | null>,
  scrollContainer?: React.RefObject<HTMLElement | null>,
): boolean {
  const [above, setAbove] = useState(false);

  const isLive = model.state === 'running';

  useEffect(() => {
    // 非 live / 容器未就绪：不订阅。返回值由 `isLive && above` gate，
    // 残留的 above 状态被 isLive=false ANDed 掉，无需同步 reset（避免
    // effect 内同步 setState 触发级联渲染）。
    if (!isLive || !scrollContainer?.current || !rootRef.current) {
      return;
    }
    const sc = scrollContainer.current;
    const el = rootRef.current;

    const check = () => {
      const scRect = sc.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      // 本消息底沿是否已滚到容器可视顶沿之上（留 40px 余量）
      setAbove(elRect.bottom < scRect.top + 40);
    };

    // 首帧异步测量，避开「effect 内同步 setState」lint 约束
    const raf = requestAnimationFrame(check);
    sc.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    return () => {
      cancelAnimationFrame(raf);
      sc.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
    };
  }, [isLive, scrollContainer, rootRef]);

  return isLive && above;
}

// ─── AgentMessage 主组件 ──────────────────────────────────────────────────

function AgentMessageImpl({
  model,
  isDark = true,
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
}: AgentMessageProps): React.ReactElement {
  const reduceRaw = useReducedMotion();
  const reduce = reduceRaw ?? false;
  const rootRef = useRef<HTMLDivElement | null>(null);

  // ActivityDetail 展开态：默认折叠；append 不触发展开（doc 32 §3 硬约束）
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);

  const isHuman = model.state === 'human';
  const showJump = useFloatingJump(model, rootRef, scrollContainer);

  // ── human 子集：Header + body + attachments + 操作条子集，右对齐 ──
  if (isHuman) {
    return (
      <div ref={rootRef} className="msg group" data-testid={`agent-message-${model.id}`}>
        <div className="flex gap-2.5 flex-row-reverse">
          <Avatar sender={model.sender} isDark={isDark} />
          <div className="flex flex-col items-end min-w-0 max-w-[80%]">
            <div
              className={cn(
                'rounded-[17px] rounded-tr-sm border px-3 py-2',
                isDark ? 'bg-cyan-500/[0.08] border-cyan-400/15' : 'bg-cyan-500/[0.06] border-cyan-400/20',
              )}
            >
              {isPlainParagraph(model.body) ? (
                renderPlainWithMentions(model.body, isDark)
              ) : (
                <MarkdownRenderer content={model.body} highlightMentions className="text-[13.5px] leading-relaxed" />
              )}
              {model.attachments.length > 0 && (
                <div className="mt-2 flex flex-col gap-2">
                  {model.attachments.map((a) => (
                    <MessageAssetCard
                      key={a.id}
                      asset={a as CardMessageAsset}
                      isDark={isDark}
                      inOwnBubble
                      onPreview={onOpenAsset ? (asset) => onOpenAsset(asset as MessageAsset) : undefined}
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="text-[10px] text-zinc-500 mt-1">已读 ✓✓</div>
            {/* 操作条子集 */}
            <ActionBar subset onCopy={onCopy} onForward={onForward} onQuote={onQuote} />
          </div>
        </div>
      </div>
    );
  }

  // ── agent 全集 ──
  const state = model.state as AgentMessageState;
  const phaseLabel = phaseLabelFor(model);
  const glowPhase = glowPhaseFor(model);
  const showReply = state === 'done';
  const live = state === 'running' || state === 'needs-action';

  return (
    <div ref={rootRef} className="msg group" data-testid={`agent-message-${model.id}`}>
      {/* 浮动跳转锚点：fixed-to-container 由父级 scrollContainer 定位；此处用 portal-free
          方案——chip 渲染在组件内但 position 由 scrollContainer 决定。为简洁，
          这里渲染一个 sticky chip 到 scrollContainer 顶沿（demo 容器 relative 定位）。 */}
      <AnimatePresence>
        {showJump && scrollContainer?.current && (
          <FloatingJumpChip
            model={model}
            glowPhase={glowPhase}
            onJump={() => rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          />
        )}
      </AnimatePresence>

      <div className="flex gap-2.5">
        <Avatar sender={model.sender} isDark={isDark} />
        <div className="flex-1 min-w-0">
          <Header model={model} isDark={isDark} />

          {/* 合并组件：单一容器，按 state 切换主次。
              处理中 → 过程面板(StatusCard)为主体；
              完成   → 过程缩成顶部 DoneStrip，结果气泡(ReplyBody)为主体。 */}
          <div className="rounded-[18px]">
            {showReply ? (
              <>
                {/* done：顶部细条（无过程则自动不渲染）→ 展开过程 → 结果主体 */}
                <DoneStrip model={model} expanded={expanded} onToggle={toggleExpanded} isDark={isDark} />

                <AnimatePresence initial={false}>
                  {expanded && (
                    <motion.div
                      initial={reduce ? { opacity: 1, height: 'auto' } : { opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                      transition={reduce ? { duration: 0 } : springSoft}
                      className="overflow-hidden mt-1.5"
                    >
                      <ActivityDetail
                        reasoning={model.reasoning}
                        live={false}
                        steps={model.steps}
                        task={model.task}
                        onOpenTask={onOpenTask}
                        isDark={isDark}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>

                <ReplyBody
                  model={model}
                  isDark={isDark}
                  reduce={reduce}
                  onOpenAsset={onOpenAsset}
                  bodyExtras={bodyExtras}
                />
              </>
            ) : (
              <>
                {/* 处理中/等待/失败：过程面板为主体 */}
                <StatusCard
                  state={state}
                  phaseLabel={phaseLabel}
                  glowPhase={glowPhase}
                  current={model.current}
                  metrics={model.metrics}
                  expanded={expanded}
                  onToggle={toggleExpanded}
                  onApprove={onApprove}
                  onReject={onReject}
                  onRetry={onRetry}
                  isDark={isDark}
                />

                <AnimatePresence initial={false}>
                  {expanded && (
                    <motion.div
                      initial={reduce ? { opacity: 1, height: 'auto' } : { opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                      transition={reduce ? { duration: 0 } : springSoft}
                      className="overflow-hidden mt-1.5"
                    >
                      <ActivityDetail
                        reasoning={model.reasoning}
                        live={live}
                        steps={model.steps}
                        task={model.task}
                        onOpenTask={onOpenTask}
                        isDark={isDark}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </>
            )}
          </div>

          {/* hover 操作条（全集） */}
          <ActionBar
            subset={false}
            onCopy={onCopy}
            onForward={onForward}
            onSaveToMemory={onSaveToMemory}
            onQuote={onQuote}
          />
        </div>
      </div>
    </div>
  );
}

// ─── React.memo（release202/13 L3 — 兄弟消息更新不重渲染无关消息） ──────────
//
// 父列表每帧由 `messageToModel` 重建所有 model（adapter 是纯函数但返回新对象），
// 所以**不能**按 `model` 引用比较——那样等于没 memo。改为比较「会改变这条消息
// 渲染输出」的 model 字段 + 会被组件直接调用的 handler props：
//   - body / state / reasoning / current / metrics —— 流式期间逐 chunk 变的字段，
//     必须让**正在运行的那条消息**继续重渲染（live update 不能被冻结）。
//   - steps / attachments / contentBlocks / task / mentionChain —— 引用变即重渲染
//     （adapter 对未变的消息复用稳定引用；空闲兄弟这些引用不变 → 跳过重渲染）。
//   - id / createdAt / sender —— 同条消息内不变，但换消息时兜底。
// 浅比较即可：adapter 对未变输入产出引用稳定的子对象/数组；逐 chunk 的运行态消息
// 这些字段会变 → 比较失败 → 重渲染（active 消息照常更新）。
function agentMessagePropsEqual(prev: AgentMessageProps, next: AgentMessageProps): boolean {
  const a = prev.model;
  const b = next.model;
  if (
    a.id !== b.id ||
    a.state !== b.state ||
    a.body !== b.body ||
    a.createdAt !== b.createdAt ||
    a.sender !== b.sender ||
    a.reasoning !== b.reasoning ||
    a.current !== b.current ||
    a.metrics !== b.metrics ||
    a.steps !== b.steps ||
    a.attachments !== b.attachments ||
    a.contentBlocks !== b.contentBlocks ||
    a.task !== b.task ||
    a.mentionChain !== b.mentionChain
  ) {
    return false;
  }
  return (
    prev.isDark === next.isDark &&
    prev.onCopy === next.onCopy &&
    prev.onForward === next.onForward &&
    prev.onSaveToMemory === next.onSaveToMemory &&
    prev.onQuote === next.onQuote &&
    prev.onOpenAsset === next.onOpenAsset &&
    prev.onOpenTask === next.onOpenTask &&
    prev.onApprove === next.onApprove &&
    prev.onReject === next.onReject &&
    prev.onRetry === next.onRetry &&
    prev.scrollContainer === next.scrollContainer &&
    prev.bodyExtras === next.bodyExtras
  );
}

export const AgentMessage = React.memo(AgentMessageImpl, agentMessagePropsEqual);

// ─── 浮动跳转 chip ────────────────────────────────────────────────────────

function FloatingJumpChip({
  model,
  glowPhase,
  onJump,
}: {
  model: AgentMessageModel;
  glowPhase: GlowPhase;
  onJump: () => void;
}): React.ReactElement {
  // glow 色：thinking 紫 / action 青
  const glow = glowPhase === 'thinking' ? 'rgba(167,139,250,0.5)' : 'rgba(34,211,238,0.45)';
  const textColor = glowPhase === 'thinking' ? 'text-violet-200' : 'text-cyan-200';

  return (
    <motion.button
      type="button"
      onClick={onJump}
      initial={{ opacity: 0, y: -6, x: '-50%' }}
      animate={{ opacity: 1, y: 0, x: '-50%' }}
      exit={{ opacity: 0, y: -6, x: '-50%' }}
      transition={springSnap}
      // sticky 到 scrollContainer 顶沿（容器为 relative）
      className="sticky top-2 z-20 mx-auto flex w-fit items-center gap-2 rounded-full pl-2 pr-3 py-1 text-[11.5px] font-medium"
      style={{
        left: '50%',
        background: 'rgba(8,12,16,.82)',
        border: `1px solid ${glow}`,
        boxShadow: `0 8px 30px -8px rgba(0,0,0,.6), 0 0 18px -6px ${glow}`,
      }}
    >
      <span
        className="inline-block w-3 h-3 rounded-full border-2 border-cyan-300/30 border-t-cyan-300 motion-safe:animate-spin"
        aria-hidden
      />
      <span className={textColor}>
        {model.sender.name}执行中 · 第 {model.metrics.steps} 步
      </span>
      <span className="text-zinc-500">↑ 跳转</span>
    </motion.button>
  );
}

export default AgentMessage;
