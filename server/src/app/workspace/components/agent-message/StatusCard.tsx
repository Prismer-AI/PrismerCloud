'use client';

/**
 * StatusCard — 统一 Agent Message 「处理中」态的过程主面板。
 *
 * 2026-06 合并重构后职责收窄：只服务 **非 done** 态（received / running /
 * needs-action / failed）——此时过程信息是单一组件的主体。done 态由
 * AgentMessage 渲染轻量 DoneStrip + 结果气泡，不再走本组件。
 *
 * 三处刻意精简（对齐用户反馈）：
 *   1. 去掉假进度百分比 + 满进度条 —— daemon 只报 start/complete，无真实
 *      0..100；running 用 indeterminate shimmer 表达「在动」，不撒假数字。
 *   2. 全 0 的 metrics（0 步 · 0 tok · 0.0s · 0 文件）整块隐藏 —— 零信息。
 *   3. 当前动作图标用 lucide（toolGlyph / reasoningGlyph），不用 emoji。
 *
 * SoT doc：docs/release201/32-unified-agent-message-component.md §3.3/§3.4/§4
 * Props 契约：./types.ts StatusCardProps
 */

import { useMemo } from 'react';
import { motion, useReducedMotion, AnimatePresence } from 'framer-motion';
import { Loader2, AlertTriangle, XCircle, ChevronDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { surface, radius, springSoft, springSnap } from '../../lib/design';
import { ToolIcon, ReasoningIcon } from './icons';
import type { StatusCardProps } from './types';

type GlowPhase = 'thinking' | 'action' | 'off';

function formatElapsed(ms: number): string {
  return (ms / 1000).toFixed(1) + 's';
}
function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function deriveGlowPhase(state: StatusCardProps['state'], phaseLabel: string): GlowPhase {
  if (state !== 'running') return 'off';
  if (phaseLabel.includes('思考')) return 'thinking';
  return 'action';
}

// ─── 背光 box-shadow ────────────────────────────────────────────────────────
// dark / light 必须分别调参：dark 底用低 alpha 柔光即可；白底会把低 alpha 完全
// 冲掉（用户实测 light 看不到呼吸），所以 light 用更高 alpha + 更实的彩色描边 +
// 更紧的扩散，保证白底上肉眼可见的呼吸。
const GLOW = {
  dark: {
    off: '0 0 0 1px rgba(255,255,255,0.06)',
    thinkingLow: '0 0 0 1px rgba(167,139,250,0.18), 0 0 22px -10px rgba(167,139,250,0.32)',
    thinkingMid: '0 0 0 1px rgba(167,139,250,0.22), 0 0 36px -4px rgba(167,139,250,0.40)',
    thinkingHigh: '0 0 0 1px rgba(167,139,250,0.26), 0 0 52px 2px rgba(167,139,250,0.48)',
    actionLow: '0 0 0 1px rgba(34,211,238,0.16), 0 0 22px -10px rgba(34,211,238,0.30)',
    actionMid: '0 0 0 1px rgba(34,211,238,0.20), 0 0 36px -4px rgba(34,211,238,0.38)',
    actionHigh: '0 0 0 1px rgba(34,211,238,0.24), 0 0 52px 2px rgba(34,211,238,0.45)',
    amber: '0 0 0 1px rgba(251,191,36,0.20), 0 0 18px -8px rgba(251,191,36,0.30)',
  },
  light: {
    off: '0 0 0 1px rgba(0,0,0,0.08)',
    thinkingLow: '0 0 0 1.5px rgba(139,92,246,0.35), 0 0 16px -6px rgba(139,92,246,0.45)',
    thinkingMid: '0 0 0 1.5px rgba(139,92,246,0.45), 0 0 26px -4px rgba(139,92,246,0.60)',
    thinkingHigh: '0 0 0 1.5px rgba(139,92,246,0.55), 0 0 38px 0px rgba(139,92,246,0.72)',
    actionLow: '0 0 0 1.5px rgba(8,145,178,0.30), 0 0 16px -6px rgba(6,182,212,0.45)',
    actionMid: '0 0 0 1.5px rgba(8,145,178,0.42), 0 0 26px -4px rgba(6,182,212,0.60)',
    actionHigh: '0 0 0 1.5px rgba(8,145,178,0.52), 0 0 38px 0px rgba(6,182,212,0.72)',
    amber: '0 0 0 1.5px rgba(217,119,6,0.40), 0 0 16px -6px rgba(245,158,11,0.55)',
  },
} as const;

function getCardVariant(state: StatusCardProps['state'], isDark = true): { border: string; bg: string } {
  switch (state) {
    case 'running':
      return { border: isDark ? 'border-cyan-400/20' : 'border-cyan-600/30', bg: isDark ? 'bg-cyan-500/[0.04]' : 'bg-cyan-50/80' };
    case 'needs-action':
      return { border: isDark ? 'border-amber-400/25' : 'border-amber-400/40', bg: isDark ? 'bg-amber-500/[0.06]' : 'bg-amber-50/80' };
    case 'failed':
      return { border: isDark ? 'border-rose-400/25' : 'border-rose-400/40', bg: isDark ? 'bg-rose-500/[0.06]' : 'bg-rose-50/80' };
    default:
      return { border: isDark ? 'border-white/[0.08]' : 'border-zinc-200', bg: isDark ? 'bg-zinc-900/60' : 'bg-white/80' };
  }
}

function getPhaseBadgeClass(state: StatusCardProps['state'], phaseLabel: string, isDark = true): string {
  if (isDark) {
    if (state === 'needs-action') return 'bg-amber-500/15 text-amber-200 border border-amber-400/20';
    if (state === 'failed') return 'bg-rose-500/15 text-rose-200 border border-rose-400/20';
    if (phaseLabel.includes('思考')) return 'bg-violet-500/15 text-violet-200 border border-violet-400/20';
    return 'bg-cyan-500/15 text-cyan-200 border border-cyan-400/20';
  }
  if (state === 'needs-action') return 'bg-amber-100 text-amber-800 border border-amber-300';
  if (state === 'failed') return 'bg-rose-100 text-rose-700 border border-rose-300';
  if (phaseLabel.includes('思考')) return 'bg-violet-100 text-violet-800 border border-violet-300';
  return 'bg-cyan-100 text-cyan-800 border border-cyan-300';
}

// ─── StatusCard ─────────────────────────────────────────────────────────────
export function StatusCard({
  state,
  phaseLabel,
  glowPhase: glowPhaseProp,
  current,
  metrics,
  expanded,
  onToggle,
  onApprove,
  onReject,
  onRetry,
  onViewLog,
  isDark = true,
}: StatusCardProps) {
  const prefersReduced = useReducedMotion();

  const glowPhase = useMemo<GlowPhase>(
    () => glowPhaseProp ?? deriveGlowPhase(state, phaseLabel),
    [glowPhaseProp, state, phaseLabel],
  );

  const glowAnimate = useMemo(() => {
    const g = isDark ? GLOW.dark : GLOW.light;
    if (state === 'needs-action') return { boxShadow: g.amber };
    if (glowPhase === 'off') return { boxShadow: g.off };
    if (prefersReduced) return { boxShadow: glowPhase === 'thinking' ? g.thinkingLow : g.actionLow };
    if (glowPhase === 'thinking') {
      return { boxShadow: [g.thinkingLow, g.thinkingMid, g.thinkingHigh, g.thinkingMid, g.thinkingLow] };
    }
    return { boxShadow: [g.actionLow, g.actionMid, g.actionHigh, g.actionMid, g.actionLow] };
  }, [glowPhase, state, prefersReduced, isDark]);

  const glowTransition = useMemo(() => {
    if (prefersReduced || glowPhase === 'off' || state === 'needs-action') return { duration: 0.4 };
    const duration = glowPhase === 'thinking' ? 2.4 : 1.8;
    return { duration, repeat: Infinity, repeatType: 'loop' as const, ease: 'easeInOut' as const };
  }, [glowPhase, state, prefersReduced]);

  const { border, bg } = getCardVariant(state, isDark);
  const theme = isDark ? 'dark' : 'light';
  const surfaceClass = surface.card[theme];

  // metrics 全 0 → 隐藏整块（零信息）。只展示非零项。
  const hasMetrics = metrics.steps > 0 || metrics.tokens > 0 || metrics.elapsedMs > 0 || metrics.files > 0;

  const running = state === 'running';

  return (
    <motion.div animate={glowAnimate} transition={glowTransition} style={{ borderRadius: 18 }} className="w-full">
      <motion.div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        initial={{ opacity: 0, y: 6, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={springSoft}
        whileHover={{ scale: 1.005 }}
        className={cn(
          surfaceClass,
          radius.card,
          'border backdrop-blur-md cursor-pointer select-none p-3.5 w-full',
          border,
          bg,
          isDark ? 'hover:brightness-110' : 'hover:brightness-95',
          'transition-[background-color,border-color] duration-300',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/50',
        )}
      >
        {/* row 1: status icon + phaseBadge + metrics(非零才显示) */}
        <div className="mb-2.5 flex items-center gap-2">
          <AnimatePresence mode="wait">
            {running && (
              <motion.span
                key="spinner"
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6 }}
                transition={springSnap}
                className="shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                <Loader2
                  size={15}
                  className={cn(
                    'animate-spin',
                    isDark
                      ? phaseLabel.includes('思考')
                        ? 'text-violet-300/70'
                        : 'text-cyan-300/70'
                      : phaseLabel.includes('思考')
                        ? 'text-violet-600'
                        : 'text-cyan-600',
                  )}
                  aria-label="执行中"
                />
              </motion.span>
            )}
            {state === 'needs-action' && (
              <motion.span key="action-icon" initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }} transition={springSnap} className="shrink-0">
                <AlertTriangle size={15} className="text-amber-400" aria-label="等待确认" />
              </motion.span>
            )}
            {state === 'failed' && (
              <motion.span key="fail-icon" initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }} transition={springSnap} className="shrink-0">
                <XCircle size={15} className="text-rose-400" aria-label="执行失败" />
              </motion.span>
            )}
          </AnimatePresence>

          <span className={cn('inline-flex items-center text-[11px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap', getPhaseBadgeClass(state, phaseLabel, isDark))}>
            {phaseLabel}
          </span>

          {hasMetrics && (
            <div className="ml-auto flex items-center gap-1.5 text-[11px] tabular-nums" onClick={(e) => e.stopPropagation()}>
              {metrics.steps > 0 && (
                <>
                  <span className={isDark ? 'text-zinc-200' : 'text-zinc-700'}>{metrics.steps}</span>
                  <span className={isDark ? 'text-zinc-600' : 'text-zinc-500'}>步</span>
                </>
              )}
              {metrics.elapsedMs > 0 && (
                <>
                  {metrics.steps > 0 && <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>·</span>}
                  <span className={isDark ? 'text-zinc-200' : 'text-zinc-700'}>{formatElapsed(metrics.elapsedMs)}</span>
                </>
              )}
              {metrics.files > 0 && (
                <>
                  <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>·</span>
                  <span className={isDark ? 'text-zinc-200' : 'text-zinc-700'}>{metrics.files}</span>
                  <span className={isDark ? 'text-zinc-600' : 'text-zinc-500'}>文件</span>
                </>
              )}
              {metrics.tokens > 0 && (
                <>
                  <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>·</span>
                  <span className={isDark ? 'text-zinc-200' : 'text-zinc-700'}>{formatTokens(metrics.tokens)}</span>
                  <span className={isDark ? 'text-zinc-600' : 'text-zinc-500'}>tok</span>
                </>
              )}
            </div>
          )}
        </div>

        {/* row 2: 当前动作（lucide 图标 + 类型 + 实际内容），无百分比 */}
        {current && (
          <div className="mb-2.5 flex items-center gap-2 min-h-[20px]">
            {current.kind === 'reasoning' ? (
              <ReasoningIcon size={15} className={cn('shrink-0', isDark ? 'text-zinc-300' : 'text-zinc-600')} aria-hidden />
            ) : (
              <ToolIcon tool={current.tool} size={15} className={cn('shrink-0', isDark ? 'text-zinc-300' : 'text-zinc-600')} aria-hidden />
            )}
            <AnimatePresence mode="wait">
              <motion.span
                key={current.title}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 4 }}
                transition={springSnap}
                className={cn('text-[14px] font-medium shrink-0 max-w-[180px] truncate', isDark ? 'text-zinc-100' : 'text-zinc-900')}
              >
                {current.title}
              </motion.span>
            </AnimatePresence>
            {current.summary && (
              <span className={cn('text-[12px] italic truncate flex-1 min-w-0', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
                {current.summary}
              </span>
            )}
          </div>
        )}

        {/* row 3: indeterminate shimmer（仅 running）+ 展开 caret / 动作按钮 */}
        <div className="flex items-center gap-3">
          <div className={cn('relative flex-1 h-[3px] rounded-full overflow-hidden', isDark ? 'bg-white/[0.07]' : 'bg-zinc-200')}>
            {running && !prefersReduced ? (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 w-[40%] animate-[shimmer_1.1s_linear_infinite]"
                style={{
                  background: phaseLabel.includes('思考')
                    ? 'linear-gradient(90deg,transparent,rgba(167,139,250,.7),transparent)'
                    : 'linear-gradient(90deg,transparent,rgba(34,211,238,.7),transparent)',
                }}
              />
            ) : null}
          </div>

          <div className="shrink-0 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            {state === 'needs-action' && (
              <>
                <Button size="xs" variant="ghost" className={cn('text-[11px] px-2 py-0.5 h-auto rounded-lg font-medium border', isDark ? 'text-amber-200 bg-amber-500/10 hover:bg-amber-500/20 border-amber-400/20' : 'text-amber-800 bg-amber-100 hover:bg-amber-200 border-amber-300')} onClick={onApprove} aria-label="批准">
                  批准
                </Button>
                <Button size="xs" variant="ghost" className={cn('text-[11px] px-2 py-0.5 h-auto rounded-lg border', isDark ? 'text-zinc-400 hover:text-rose-300 hover:bg-rose-500/10 border-white/10' : 'text-zinc-600 hover:text-rose-700 hover:bg-rose-50 border-zinc-200')} onClick={onReject} aria-label="拒绝">
                  拒绝
                </Button>
              </>
            )}
            {state === 'failed' && (
              <>
                <Button size="xs" variant="ghost" className={cn('text-[11px] px-2 py-0.5 h-auto rounded-lg font-medium border', isDark ? 'text-rose-200 bg-rose-500/10 hover:bg-rose-500/20 border-rose-400/20' : 'text-rose-800 bg-rose-100 hover:bg-rose-200 border-rose-300')} onClick={onRetry} aria-label="重试">
                  重试
                </Button>
                <Button size="xs" variant="ghost" className={cn('text-[11px] px-2 py-0.5 h-auto rounded-lg border', isDark ? 'text-zinc-400 hover:text-zinc-200 border-white/10' : 'text-zinc-600 hover:text-zinc-900 border-zinc-200')} onClick={onViewLog} aria-label="查看日志">
                  日志
                </Button>
              </>
            )}
            <button
              className={cn('flex items-center gap-1 text-[11px] transition-colors', isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-500 hover:text-zinc-800')}
              onClick={onToggle}
              aria-label={expanded ? '收起过程' : '展开过程'}
            >
              {expanded ? '收起过程' : '展开过程'}
              <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={springSnap} className="inline-flex">
                <ChevronDown size={11} />
              </motion.span>
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

export default StatusCard;
