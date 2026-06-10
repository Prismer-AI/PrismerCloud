'use client';

/**
 * Post-creation Launch Tour — fires after Simple-Mode team provisioning
 * succeeds. Walks the fresh user through the 5 workspace surfaces in
 * narrative order:
 *
 *   1. tasks      — show the seeded demo task on the kanban
 *   2. library    — show the seeded product-intro markdown asset
 *   3. chats      — show People inside Chats for the newly-created AI colleagues
 *   4. runtime    — show where the team's daemons run
 *   5. chat       — return to the group session to read welcome + dispatch
 *
 * Each step:
 *   • switches `activeSurface` via `onSetSurface` (or opens the conversation
 *     for the final step)
 *   • polls for the per-step anchor element (up to ~2s) so the surface has
 *     time to mount
 *   • auto-advances after 6s (8s on the final chat step), or via Next/Skip
 *   • falls back to a centered tooltip if the anchor never resolves
 *
 * This component is INDEPENDENT of `WorkspaceTour`. The original tour is
 * still mounted for manual replay; the parent gates which one runs.
 */

import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { KanbanSquare, Library, Smartphone, MessageSquare, X } from 'lucide-react';

import { radius, springSnap, surface } from '../lib/design';
import type { LaunchTourSeed } from '../lib/mutations';
import type { WorkspaceSurface } from './left-rail';

// ─── Step definitions ────────────────────────────────────────────────

interface LaunchTourStep {
  key: 'tasks' | 'library' | 'people' | 'runtime' | 'chat';
  surface: WorkspaceSurface | null;
  /** undefined = leave conversation untouched; null = clear; string = open */
  conversationToOpen?: string | null | undefined;
  anchorSelector: (seed: LaunchTourSeed | null) => string | null;
  title: string;
  body: string;
  icon: ComponentType<{ className?: string }>;
  autoAdvanceMs: number;
}

const STEPS: LaunchTourStep[] = [
  {
    key: 'tasks',
    surface: 'tasks',
    anchorSelector: (seed) =>
      seed?.demoTaskId ? `[data-task-id="${seed.demoTaskId}"]` : '[data-launch-tour-anchor="task-board"]',
    title: '看板 — 你的任务在这',
    body: '刚刚为你建了一个 demo 任务，看看 agent 如何接手。每个 agent 都会在看板上认领、协作、交付。',
    icon: KanbanSquare,
    autoAdvanceMs: 6000,
  },
  {
    key: 'library',
    surface: 'library',
    anchorSelector: (seed) =>
      seed?.sampleAssetId ? `[data-asset-id="${seed.sampleAssetId}"]` : '[data-launch-tour-anchor="library-panel"]',
    title: '资产 — 团队的知识库',
    body: '已经预置了一份产品介绍 markdown。你可以拖入任何 PDF/PPTX/图片，agent 自动获得上下文。',
    icon: Library,
    autoAdvanceMs: 6000,
  },
  {
    key: 'people',
    surface: 'chats',
    anchorSelector: (seed) => {
      const firstAgent = seed?.agentIds?.[0];
      return firstAgent
        ? `[data-contact-agent-id="${firstAgent}"]`
        : '[data-testid="people-directory"], [data-testid="workspace-chats-surface"]';
    },
    title: 'People — 你的 AI 同事',
    body: '刚招的几位 agent 会收进 Chats 里的 People。点头像可以打开 1:1 私聊。',
    icon: MessageSquare,
    autoAdvanceMs: 6000,
  },
  {
    key: 'runtime',
    surface: 'runtime',
    // Multi-fallback: if a device was provisioned, point at its row; if
    // none yet, use the empty-state CTA; finally fall back to the panel
    // root. document.querySelector returns the first match, so ordering
    // matters — most specific first.
    anchorSelector: () =>
      '[data-testid="device-empty-create-cta"], [data-testid="device-workbench"] [data-device-id], [data-launch-tour-anchor="runtime-panel"]',
    title: '设备 — 团队在哪运行',
    body: '团队会在你的本地或云端计算机上运行。这里可以新建设备、查看在线状态、重启设备。',
    icon: Smartphone,
    autoAdvanceMs: 6000,
  },
  {
    key: 'chat',
    surface: 'chats',
    // Resolved per-render against seed.conversationId.
    anchorSelector: () =>
      '[data-testid="im-channel-panel"], [data-testid="workspace-chats-surface"], [data-launch-tour-anchor="chat-panel"]',
    title: '回到群聊看看',
    body: '群里已经有了 CEO 的欢迎消息和 demo 任务的派发。你可以随时 @ 任何 agent 接着聊。',
    icon: MessageSquare,
    autoAdvanceMs: 8000,
  },
];

const TOOLTIP_W = 340;
const TOOLTIP_GAP = 16;

interface AnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

// ─── Props ───────────────────────────────────────────────────────────

interface LaunchTourProps {
  open: boolean;
  seed: LaunchTourSeed | null;
  isDark: boolean;
  onSetSurface: (surface: WorkspaceSurface) => void;
  onSelectConversation: (id: string | null) => void;
  onDone: () => void;
}

// ─── Component ───────────────────────────────────────────────────────

export function LaunchTour({ open, seed, isDark, onSetSurface, onSelectConversation, onDone }: LaunchTourProps) {
  const [stepIdx, setStepIdx] = useState(0);
  const [rect, setRect] = useState<AnchorRect | null>(null);
  const [winSize, setWinSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Track viewport size for tooltip clamping.
  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    setWinSize({ w: window.innerWidth, h: window.innerHeight });
    const onResize = () => setWinSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

  // Reset to step 0 each time the tour opens (e.g. dev replay).
  useEffect(() => {
    if (open) setStepIdx(0);
  }, [open]);

  // Per-step: fire onEnter (surface switch + conversation open), then poll
  // for the anchor element to appear. Falls back to a centered tooltip if
  // the anchor never resolves within `maxMs`.
  useEffect(() => {
    if (!open) return;
    const step = STEPS[stepIdx];
    if (!step) return;

    // 1. onEnter — surface switch + (final step) conversation open.
    if (step.surface) onSetSurface(step.surface);
    if (step.key === 'chat') {
      // Resolve at the moment of entry so seed updates between renders
      // (rare, but the helper is fire-and-forget upstream).
      onSelectConversation(seed?.conversationId ?? null);
    }

    // Clear stale rect so the tooltip animates from a known state.
    setRect(null);

    // 2. Poll for the anchor. The new surface needs a tick to mount.
    let cancelled = false;
    let timer: number | null = null;
    let elapsed = 0;
    const pollMs = 100;
    const maxMs = 2000;
    const tick = () => {
      if (cancelled) return;
      const selector = step.anchorSelector(seed);
      const el = selector ? document.querySelector(selector) : null;
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
          // Bring the anchor into view — `scrollIntoView` on a smooth
          // behaviour is gentle enough not to clash with the tooltip
          // positioning that runs on the next frame.
          try {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          } catch {
            /* older browsers ignore options */
          }
          return;
        }
      }
      elapsed += pollMs;
      if (elapsed < maxMs) {
        timer = window.setTimeout(tick, pollMs);
      } else {
        // Anchor never appeared — leave rect null so the tooltip falls
        // back to centered placement. Still informative.
        setRect(null);
      }
    };
    tick();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [open, stepIdx, seed, onSetSurface, onSelectConversation]);

  // Re-measure anchor rect on scroll/resize between polls (covers slow
  // layout settle on the runtime/devices surface, where the workbench
  // grid reflows after data loads).
  useEffect(() => {
    if (!open || !rect) return;
    const step = STEPS[stepIdx];
    if (!step) return;
    const remeasure = () => {
      const selector = step.anchorSelector(seed);
      if (!selector) return;
      const el = document.querySelector(selector);
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    window.addEventListener('scroll', remeasure, true);
    window.addEventListener('resize', remeasure);
    const interval = window.setInterval(remeasure, 500);
    return () => {
      window.removeEventListener('scroll', remeasure, true);
      window.removeEventListener('resize', remeasure);
      window.clearInterval(interval);
    };
  }, [open, stepIdx, seed, rect]);

  const finish = useCallback(() => {
    setStepIdx(0);
    onDone();
  }, [onDone]);

  const advance = useCallback(() => {
    if (stepIdx >= STEPS.length - 1) finish();
    else setStepIdx((i) => i + 1);
  }, [stepIdx, finish]);

  // Auto-advance after the per-step dwell window.
  useEffect(() => {
    if (!open) return;
    const step = STEPS[stepIdx];
    if (!step) return;
    const timer = window.setTimeout(() => {
      advance();
    }, step.autoAdvanceMs);
    return () => window.clearTimeout(timer);
  }, [open, stepIdx, advance]);

  if (!open) return null;
  const step = STEPS[stepIdx];
  if (!step) return null;

  // Compute tooltip placement. Mirrors WorkspaceTour: below > above >
  // right, then clamp to viewport. Centered when no anchor.
  const padding = 8;
  const cutout = rect
    ? {
        x: Math.max(0, rect.left - padding),
        y: Math.max(0, rect.top - padding),
        w: rect.width + padding * 2,
        h: rect.height + padding * 2,
      }
    : null;

  let tooltipStyle: React.CSSProperties = {};
  let tooltipPlacement: 'centered' | 'below' | 'right' | 'above' = 'centered';
  if (cutout) {
    const spaceBelow = winSize.h - (cutout.y + cutout.h);
    const spaceAbove = cutout.y;
    if (spaceBelow >= 220) tooltipPlacement = 'below';
    else if (spaceAbove >= 220) tooltipPlacement = 'above';
    else tooltipPlacement = 'right';

    if (tooltipPlacement === 'below') {
      tooltipStyle = {
        top: cutout.y + cutout.h + TOOLTIP_GAP,
        left: Math.min(Math.max(8, cutout.x + cutout.w / 2 - TOOLTIP_W / 2), Math.max(8, winSize.w - TOOLTIP_W - 8)),
        width: TOOLTIP_W,
      };
    } else if (tooltipPlacement === 'above') {
      tooltipStyle = {
        bottom: winSize.h - cutout.y + TOOLTIP_GAP,
        left: Math.min(Math.max(8, cutout.x + cutout.w / 2 - TOOLTIP_W / 2), Math.max(8, winSize.w - TOOLTIP_W - 8)),
        width: TOOLTIP_W,
      };
    } else {
      // right: clamp to the right edge but never overlap the cutout.
      tooltipStyle = {
        top: Math.max(8, Math.min(cutout.y, winSize.h - 240)),
        left: Math.min(cutout.x + cutout.w + TOOLTIP_GAP, Math.max(8, winSize.w - TOOLTIP_W - 8)),
        width: TOOLTIP_W,
      };
    }
  }

  const Icon = step.icon;
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  const stepNumber = stepIdx + 1;
  const totalSteps = STEPS.length;

  return (
    <div className="fixed inset-0 z-[200] pointer-events-none">
      {/* Dim overlay with cutout. Clicking the dim area skips the tour
          entirely — matches WorkspaceTour's affordance so the gesture
          stays consistent across both flows. */}
      <svg
        className="absolute inset-0 h-full w-full pointer-events-auto"
        onClick={() => finish()}
        style={{ cursor: 'pointer' }}
      >
        <defs>
          <mask id="launch-tour-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {cutout ? (
              <rect x={cutout.x} y={cutout.y} width={cutout.w} height={cutout.h} rx={14} ry={14} fill="black" />
            ) : null}
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill={isDark ? 'rgba(0,0,0,0.72)' : 'rgba(15,15,30,0.55)'}
          mask="url(#launch-tour-mask)"
        />
        {cutout ? (
          <rect
            x={cutout.x}
            y={cutout.y}
            width={cutout.w}
            height={cutout.h}
            rx={14}
            ry={14}
            fill="none"
            stroke="rgb(167,139,250)"
            strokeWidth={2}
            className="animate-pulse"
          />
        ) : null}
      </svg>

      {/* Tooltip card */}
      <AnimatePresence mode="wait">
        <motion.div
          key={stepIdx}
          initial={{ opacity: 0, y: 10, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.98 }}
          transition={springSnap}
          className={`absolute pointer-events-auto border shadow-2xl ${radius.card} ${surface.pane[theme]}`}
          style={
            tooltipPlacement === 'centered'
              ? {
                  width: TOOLTIP_W,
                  top: '50%',
                  left: '50%',
                  transform: 'translate(-50%, -50%)',
                }
              : tooltipStyle
          }
        >
          <div className="p-5">
            <div className="flex items-start gap-3 mb-3">
              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                  isDark ? 'bg-violet-500/20 text-violet-300' : 'bg-violet-100 text-violet-700'
                }`}
              >
                <Icon className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div
                  className={`text-[10px] font-semibold uppercase tracking-wider mb-0.5 ${
                    isDark ? 'text-zinc-500' : 'text-zinc-500'
                  }`}
                >
                  Step {stepNumber} of {totalSteps}
                </div>
                <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>{step.title}</h3>
              </div>
              <button
                type="button"
                onClick={finish}
                className={`shrink-0 -mr-1 -mt-1 p-1.5 rounded-lg transition-colors ${
                  isDark ? 'hover:bg-zinc-800 text-zinc-500' : 'hover:bg-zinc-100 text-zinc-400'
                }`}
                aria-label="Skip launch tour"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className={`text-sm leading-relaxed mb-4 ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}>{step.body}</p>

            {/* Progress dots — one per step, current pill-shaped */}
            <div className="flex items-center gap-1.5 mb-4">
              {STEPS.map((s, i) => (
                <span
                  key={s.key}
                  className={`h-1.5 rounded-full transition-all ${
                    i === stepIdx
                      ? isDark
                        ? 'w-6 bg-violet-400'
                        : 'w-6 bg-violet-500'
                      : i < stepIdx
                        ? isDark
                          ? 'w-1.5 bg-violet-500/40'
                          : 'w-1.5 bg-violet-400/60'
                        : isDark
                          ? 'w-1.5 bg-zinc-700'
                          : 'w-1.5 bg-zinc-300'
                  }`}
                  aria-hidden
                />
              ))}
            </div>

            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={finish}
                className={`text-xs font-medium transition-colors ${
                  isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-500 hover:text-zinc-700'
                }`}
              >
                Skip
              </button>
              <motion.button
                type="button"
                whileTap={{ scale: 0.95 }}
                onClick={advance}
                className={`px-4 py-1.5 text-xs font-semibold text-white ${radius.button} bg-gradient-to-br from-violet-500 to-cyan-500`}
              >
                {stepIdx >= STEPS.length - 1 ? '完成' : '下一步 →'}
              </motion.button>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
