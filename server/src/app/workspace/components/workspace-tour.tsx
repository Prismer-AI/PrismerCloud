'use client';

import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bot, MessageSquare, Send, Sparkles, X } from 'lucide-react';

import { radius, springSnap, surface } from '../lib/design';

const STORAGE_KEY = 'prismer.workspaceTourSeen.v1';

interface TourStep {
  anchor: string | null; // CSS selector via [data-tour-anchor="..."]; null = centered welcome
  title: string;
  body: string;
  icon?: React.ComponentType<{ className?: string }>;
}

const STEPS: TourStep[] = [
  {
    anchor: null,
    title: 'Welcome to your workspace',
    body: 'Quick 3-step tour: where to find your workspace, the setup checklist, and how to take your first action. Press Skip anytime.',
    icon: Sparkles,
  },
  {
    anchor: '[data-tour-anchor="workspace-badge"]',
    title: 'Your workspace',
    body: 'Each workspace is an isolated home for agents, sessions, tasks, and assets. The badge shows which one you are in.',
    icon: Bot,
  },
  {
    anchor: '[data-tour-anchor="setup-progress"]',
    title: 'Setup progress',
    body: 'Tracks your first 4 milestones — agent, session, task, asset. The badge in the bottom-right fills as you complete each step.',
    icon: MessageSquare,
  },
  {
    anchor: '[data-tour-anchor="setup-cta"]',
    title: 'Take the next action',
    body: 'This is your launch button — pick an industry + team size and your AI team is live in 30 seconds. You can revisit the checklist anytime from the right rail.',
    icon: Send,
  },
];

const TOOLTIP_W = 320;
const TOOLTIP_GAP = 16;

interface AnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface WorkspaceTourProps {
  /** Show the tour. Caller owns the gating (e.g. only when not seen + not bootstrapping). */
  open: boolean;
  isDark: boolean;
  onDone: () => void;
}

export function WorkspaceTour({ open, isDark, onDone }: WorkspaceTourProps) {
  const [stepIdx, setStepIdx] = useState(0);
  const [rect, setRect] = useState<AnchorRect | null>(null);
  const [winSize, setWinSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  const step = STEPS[stepIdx];

  // Track viewport size + anchor rect for the active step.
  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    setWinSize({ w: window.innerWidth, h: window.innerHeight });
    const onResize = () => setWinSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const updateRect = () => {
      if (!step.anchor) {
        setRect(null);
        return;
      }
      const el = document.querySelector(step.anchor);
      if (!el) {
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      // Skip anchors that are off-screen (e.g. setup-progress hidden < lg breakpoint)
      if (r.width === 0 || r.height === 0) {
        setRect(null);
        return;
      }
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    updateRect();
    // Re-measure on scroll/resize for resilience.
    window.addEventListener('scroll', updateRect, true);
    window.addEventListener('resize', updateRect);
    const interval = window.setInterval(updateRect, 500); // catch layout settle
    return () => {
      window.removeEventListener('scroll', updateRect, true);
      window.removeEventListener('resize', updateRect);
      clearInterval(interval);
    };
  }, [open, stepIdx, step.anchor]);

  const finish = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch {
      /* private browsing / quota */
    }
    setStepIdx(0);
    onDone();
  }, [onDone]);

  const advance = useCallback(() => {
    if (stepIdx >= STEPS.length - 1) {
      finish();
    } else {
      setStepIdx((i) => i + 1);
    }
  }, [stepIdx, finish]);

  if (!open) return null;

  // Compute tooltip position. Centered if no anchor or anchor not on-screen.
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
    // Try below; if not enough room, try above; if too wide on left/right, clamp.
    const spaceBelow = winSize.h - (cutout.y + cutout.h);
    const spaceAbove = cutout.y;
    if (spaceBelow >= 200) tooltipPlacement = 'below';
    else if (spaceAbove >= 200) tooltipPlacement = 'above';
    else tooltipPlacement = 'right';

    if (tooltipPlacement === 'below') {
      tooltipStyle = {
        top: cutout.y + cutout.h + TOOLTIP_GAP,
        left: Math.min(Math.max(8, cutout.x + cutout.w / 2 - TOOLTIP_W / 2), winSize.w - TOOLTIP_W - 8),
        width: TOOLTIP_W,
      };
    } else if (tooltipPlacement === 'above') {
      tooltipStyle = {
        bottom: winSize.h - cutout.y + TOOLTIP_GAP,
        left: Math.min(Math.max(8, cutout.x + cutout.w / 2 - TOOLTIP_W / 2), winSize.w - TOOLTIP_W - 8),
        width: TOOLTIP_W,
      };
    } else {
      tooltipStyle = {
        top: Math.max(8, Math.min(cutout.y, winSize.h - 220)),
        left: Math.min(cutout.x + cutout.w + TOOLTIP_GAP, winSize.w - TOOLTIP_W - 8),
        width: TOOLTIP_W,
      };
    }
  }

  const Icon = step.icon ?? Sparkles;
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';

  return (
    <div className="fixed inset-0 z-[200] pointer-events-none">
      {/* Dim overlay with cutout. SVG mask gives a clean rounded cutout
          without compositing tricks. Pointer events on the overlay capture
          clicks (close on outside click). */}
      <svg
        className="absolute inset-0 h-full w-full pointer-events-auto"
        onClick={() => finish()}
        style={{ cursor: 'pointer' }}
      >
        <defs>
          <mask id="workspace-tour-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {cutout ? (
              <rect x={cutout.x} y={cutout.y} width={cutout.w} height={cutout.h} rx={12} ry={12} fill="black" />
            ) : null}
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill={isDark ? 'rgba(0,0,0,0.72)' : 'rgba(15,15,30,0.55)'}
          mask="url(#workspace-tour-mask)"
        />
        {cutout ? (
          <rect
            x={cutout.x}
            y={cutout.y}
            width={cutout.w}
            height={cutout.h}
            rx={12}
            ry={12}
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
          className={`absolute pointer-events-auto rounded-2xl border shadow-2xl ${surface.pane[theme]}`}
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
                <Icon className="w-4.5 h-4.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div
                  className={`text-[10px] font-semibold uppercase tracking-wider mb-0.5 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                >
                  Step {stepIdx + 1} of {STEPS.length}
                </div>
                <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>{step.title}</h3>
              </div>
              <button
                type="button"
                onClick={finish}
                className={`shrink-0 -mr-1 -mt-1 p-1.5 rounded-lg transition-colors ${
                  isDark ? 'hover:bg-zinc-800 text-zinc-500' : 'hover:bg-zinc-100 text-zinc-400'
                }`}
                aria-label="Skip tour"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className={`text-sm leading-relaxed mb-4 ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}>{step.body}</p>
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
                {stepIdx >= STEPS.length - 1 ? 'Done' : 'Next →'}
              </motion.button>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** Returns true if the tour has been completed/skipped on this device. */
export function hasSeenWorkspaceTour(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return Boolean(localStorage.getItem(STORAGE_KEY));
  } catch {
    return true; // private browsing — don't loop
  }
}
