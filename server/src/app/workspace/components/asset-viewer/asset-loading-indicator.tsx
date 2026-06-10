'use client';

/**
 * Asset preview loading indicator — spring-damped, not linear.
 *
 * Two surfaces share this so the "something is loading" feedback is
 * identical whether the preview opens in the inspector (PreviewEmpty) or
 * the chat-side modal (AssetMaxPreview's LoadingBlock):
 *
 *   <DampedProgressBar>      — just the track + bar. Determinate when a
 *                              percent is known (width springs to target
 *                              with elastic catch-up); indeterminate
 *                              otherwise (a pill shuttles left↔right on a
 *                              spring so it eases + overshoots at each end,
 *                              reading as real physical motion rather than
 *                              a constant-velocity CSS keyframe).
 *   <AssetLoadingIndicator>  — centered block (label + progress text +
 *                              DampedProgressBar) for full-pane loaders.
 */

import { motion } from 'framer-motion';

import { springHeavy, springSoft } from '../../lib/design';

export function DampedProgressBar({ isDark, percent }: { isDark: boolean; percent?: number | null }) {
  const determinate = typeof percent === 'number' && Number.isFinite(percent);
  const clamped = determinate ? Math.min(100, Math.max(0, percent as number)) : 0;
  return (
    <div
      className={`relative h-2 w-full overflow-hidden rounded-full ${isDark ? 'bg-white/[0.08]' : 'bg-zinc-200'}`}
    >
      {determinate ? (
        <motion.div
          className="h-full rounded-full bg-violet-500"
          initial={false}
          animate={{ width: `${clamped}%` }}
          transition={springSoft}
        />
      ) : (
        // Indeterminate: a one-third-width pill that springs to the far end
        // and back. The spring (vs. linear translate) overshoots slightly at
        // each turn — the "physical damping" the loader is meant to convey.
        <motion.div
          className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-violet-500"
          initial={{ x: '-110%' }}
          animate={{ x: '320%' }}
          transition={{ ...springHeavy, repeat: Infinity, repeatType: 'reverse', repeatDelay: 0.12 }}
        />
      )}
    </div>
  );
}

export function AssetLoadingIndicator({
  isDark,
  label,
  detail,
  percent,
}: {
  isDark: boolean;
  label?: string;
  detail?: string | null;
  percent?: number | null;
}) {
  return (
    <div
      className={`flex h-full min-h-[200px] flex-col items-center justify-center gap-3 rounded-xl border px-6 ${
        isDark ? 'border-white/[0.06] bg-black/30 text-zinc-400' : 'border-zinc-200 bg-zinc-50 text-zinc-500'
      }`}
    >
      {label ? <p className="text-xs">{label}</p> : null}
      <div className="w-full max-w-[260px]">
        <DampedProgressBar isDark={isDark} percent={percent} />
      </div>
      {detail ? <p className={`text-[11px] tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>{detail}</p> : null}
    </div>
  );
}
