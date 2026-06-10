'use client';

/**
 * Wave 2 V4 — release201/13 §3.4 + release201/20 §9.2.
 *
 * Real 3D Y-axis card flip for the Installed shelf chip.
 *
 * Front face = the existing skill chip body (badge / version / actions).
 * Back face  = a compact "configuring..." panel with cancel.
 *
 * Why a dedicated component?
 *   The previous V3 implementation only applied a `framer rotate` transform
 *   without `transform-style: preserve-3d` / `perspective` / `backface-
 *   visibility`, so the chip rotated *in 2D* and the "back" never appeared.
 *   V4 fixes that: both faces sit absolutely positioned inside a preserve-3d
 *   wrapper, the parent owns the perspective, and each face hides its
 *   own back via `backfaceVisibility: 'hidden'`.
 *
 * prefers-reduced-motion path:
 *   We bypass the rotateY motion entirely (no animate prop), and instead
 *   swap front/back via `display: 'none'`. Both faces remain `backface-
 *   visibility: hidden` for visual consistency.
 *
 * Scope:
 *   This is purely the *chip-level* flip animation. The full configure form
 *   still lives in <ConfigureModal>; this component is responsible for
 *   driving the visual flip in lockstep with modal open/close (parent
 *   controls `flipped` via the `flipped` prop).
 */

import { motion, useReducedMotion } from 'framer-motion';
import { Loader2, Settings2, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/contexts/i18n-context';
import { springFlip } from '@/app/workspace/lib/design';
import { type InstalledSkill, localizedTimeAgo } from '../types';

type TFn = ReturnType<typeof useI18n>['t'];

interface FlippableChipProps {
  isDark: boolean;
  skill: InstalledSkill;
  accentDot: string;
  /** Controlled flip state — parent toggles when configure starts / modal closes. */
  flipped: boolean;
  /** True while uninstall network call is in-flight (replaces Trash2 with spinner). */
  actionBusy: boolean;
  onConfigureClick: () => void;
  onUninstallClick: () => void;
  /** Cancel button on the back face — flips the chip back without committing. */
  onCancelFlip: () => void;
  /** Optional status badge slot — parent renders <SkillStatusBadge> when not 'active'. */
  statusBadge?: ReactNode;
}

export function FlippableChip({
  isDark,
  skill,
  accentDot,
  flipped,
  actionBusy,
  onConfigureClick,
  onUninstallClick,
  onCancelFlip,
  statusBadge,
}: FlippableChipProps) {
  const { t } = useI18n();
  const prefersReducedMotion = useReducedMotion();

  // Both faces share the same chip footprint. The back face is absolutely
  // positioned on top of the front so they remain in the same flow slot
  // while the parent rotates.
  const baseChipClass = `flex items-center gap-2 rounded-full border px-3 py-1.5 ${
    isDark ? 'border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.08]' : 'border-zinc-200 bg-white hover:bg-zinc-50'
  }`;

  // ── Reduced-motion fallback: swap display, no rotation. ──
  if (prefersReducedMotion) {
    return (
      <div
        data-installed-skill={skill.skillId}
        data-flip-mode="reduced"
        data-flipped={flipped}
        className="group relative"
      >
        <div
          data-face="front"
          style={{ display: flipped ? 'none' : 'flex', backfaceVisibility: 'hidden' }}
          className={baseChipClass}
        >
          <FrontContent
            isDark={isDark}
            skill={skill}
            accentDot={accentDot}
            actionBusy={actionBusy}
            statusBadge={statusBadge}
            onConfigureClick={onConfigureClick}
            onUninstallClick={onUninstallClick}
            t={t}
          />
        </div>
        <div
          data-face="back"
          style={{ display: flipped ? 'flex' : 'none', backfaceVisibility: 'hidden' }}
          className={baseChipClass}
        >
          <BackContent isDark={isDark} onCancelFlip={onCancelFlip} t={t} />
        </div>
      </div>
    );
  }

  // ── Full 3D flip path. ──
  // The outer wrapper owns the perspective; the inner motion.div is the
  // preserve-3d "card" that rotates around Y. Each face is absolutely
  // positioned so they overlap, and each hides its own backface.
  return (
    <div
      data-installed-skill={skill.skillId}
      data-flip-mode="3d"
      data-flipped={flipped}
      className="group relative"
      style={{ perspective: '1000px' }}
    >
      <motion.div
        className="relative"
        style={{ transformStyle: 'preserve-3d' }}
        animate={{ rotateY: flipped ? 180 : 0 }}
        transition={springFlip}
      >
        {/* Front — chip body. Sits in normal flow so the wrapper sizes to it. */}
        <div
          data-face="front"
          style={{ backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden' }}
          className={baseChipClass}
        >
          <FrontContent
            isDark={isDark}
            skill={skill}
            accentDot={accentDot}
            actionBusy={actionBusy}
            statusBadge={statusBadge}
            onConfigureClick={onConfigureClick}
            onUninstallClick={onUninstallClick}
            t={t}
          />
        </div>
        {/* Back — absolutely positioned over the front, pre-rotated 180°
            so the user reads it right-way-up after the parent rotates. */}
        <div
          data-face="back"
          style={{
            position: 'absolute',
            inset: 0,
            transform: 'rotateY(180deg)',
            backfaceVisibility: 'hidden',
            WebkitBackfaceVisibility: 'hidden',
          }}
          className={baseChipClass}
        >
          <BackContent isDark={isDark} onCancelFlip={onCancelFlip} t={t} />
        </div>
      </motion.div>
    </div>
  );
}

// ── Face contents ─────────────────────────────────────────────────────────

interface FrontProps {
  isDark: boolean;
  skill: InstalledSkill;
  accentDot: string;
  actionBusy: boolean;
  statusBadge?: ReactNode;
  onConfigureClick: () => void;
  onUninstallClick: () => void;
  t: TFn;
}

function FrontContent({
  isDark,
  skill,
  accentDot,
  actionBusy,
  statusBadge,
  onConfigureClick,
  onUninstallClick,
  t,
}: FrontProps) {
  return (
    <>
      <span className={`h-1.5 w-1.5 rounded-full ${accentDot}`} aria-hidden />
      <span className={`text-xs font-medium ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{skill.name}</span>
      <span className={`font-mono text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>v{skill.version}</span>
      {statusBadge}
      <span
        className={`ml-1 text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
        title={t('evolution.common.installedLine', {
          installed: localizedTimeAgo(skill.installedAt, t),
          lastUsed: localizedTimeAgo(skill.lastInvokedAt, t),
        })}
      >
        {localizedTimeAgo(skill.lastInvokedAt, t)}
      </span>
      <div className="ml-1 flex items-center gap-0.5 opacity-60 group-hover:opacity-100">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onConfigureClick}
          title={t('evolution.common.configure')}
          aria-label={t('evolution.common.configure')}
          data-testid="installed-configure-button"
        >
          <Settings2 />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onUninstallClick}
          disabled={actionBusy}
          title={t('evolution.common.uninstall')}
          aria-label={t('evolution.common.uninstall')}
        >
          {actionBusy ? <Loader2 className="animate-spin" /> : <Trash2 />}
        </Button>
      </div>
    </>
  );
}

interface BackProps {
  isDark: boolean;
  onCancelFlip: () => void;
  t: TFn;
}

function BackContent({ isDark, onCancelFlip, t }: BackProps) {
  return (
    <>
      <Loader2 className={`h-3 w-3 animate-spin ${isDark ? 'text-violet-300' : 'text-violet-600'}`} aria-hidden />
      <span className={`text-xs font-medium ${isDark ? 'text-violet-200' : 'text-violet-700'}`}>
        {t('evolution.common.configuring')}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onCancelFlip}
        title={t('evolution.common.cancel')}
        aria-label={t('evolution.common.cancel')}
        data-testid="installed-flip-cancel"
        className="ml-1"
      >
        <span aria-hidden className="text-xs">
          ×
        </span>
      </Button>
    </>
  );
}
