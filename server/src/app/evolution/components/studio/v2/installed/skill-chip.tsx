'use client';

/**
 * Installed → SkillChip (release201/28 §4.3 + 13 §3.4.3).
 *
 * A single chip on the tool belt. Front face = skill icon + name + version +
 * status dot (● ok / ⚠ warn). Two direct manipulations:
 *   - flip (Space / Configure button) → reverse face shows the configure form
 *     (inputs live on the chip back, NOT a drawer — 13 §3.4.4 anti-pattern).
 *   - drag down past a threshold (or Del / Uninstall button) → uninstall.
 *
 * Keyboard back-paths are mandatory (the spec forbids click-count toggles and
 * hidden state): every direct manipulation also has a visible button path.
 *
 * Motion: springSnap hover, springFlip rotateY, springDrag follow, springSplat
 * save ack — all gated by `reduce`.
 */

import { motion, useReducedMotion } from 'framer-motion';
import { RotateCcw, Save, Trash2, Wrench } from 'lucide-react';
import { useRef, useState } from 'react';

import {
  grammarAccentClasses,
  radius,
  s,
  springDrag,
  springFlip,
  springSnap,
  springSoft,
  springSplat,
} from '@/app/workspace/lib/design';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/contexts/i18n-context';
import { cn } from '@/lib/utils';

import type { GrammarAccent } from '@/app/workspace/lib/design';
import type { InstalledSkill } from '../types';

const UNINSTALL_THRESHOLD = 90; // px dragged-down before release = uninstall

export interface SkillChipProps {
  skill: InstalledSkill;
  index: number;
  accent: GrammarAccent;
  theme: 'dark' | 'light';
  isDark: boolean;
  reduce: boolean;
  onSave: () => void;
  onUninstall: () => void;
  /** Notify the parent so it can render the trash drop-zone while dragging. */
  onDragStateChange: (dragging: boolean) => void;
}

export function SkillChip({
  skill,
  index,
  accent,
  theme,
  isDark,
  reduce,
  onSave,
  onUninstall,
  onDragStateChange,
}: SkillChipProps) {
  const { t } = useI18n();
  const reduceMotion = useReducedMotion() || reduce;
  const a = grammarAccentClasses[accent];
  const [flipped, setFlipped] = useState(false);
  const [acked, setAcked] = useState(false);
  const savedRef = useRef(false);

  const dotClass = skill.health === 'ok' ? 'bg-emerald-400' : 'bg-amber-400';

  const handleSave = () => {
    savedRef.current = true;
    onSave();
    setAcked(true);
    setFlipped(false);
    window.setTimeout(() => setAcked(false), 600);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      setFlipped((f) => !f);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onUninstall();
    }
  };

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={acked && !reduceMotion ? { opacity: 1, y: 0, scale: [1, 1.06, 1] } : { opacity: 1, y: 0 }}
      transition={acked ? springSplat : { ...springSoft, delay: reduceMotion ? 0 : index * 0.06 }}
      className="relative"
      style={{ perspective: 800 }}
    >
      <motion.div
        // The flip wrapper. Dragging is disabled on the back face so the form
        // is usable; the front face drags down to the trash zone.
        drag={flipped || reduceMotion ? false : 'y'}
        dragConstraints={{ top: 0, bottom: UNINSTALL_THRESHOLD + 40 }}
        dragElastic={0.3}
        dragSnapToOrigin
        onDragStart={() => onDragStateChange(true)}
        onDrag={(_e, info) => onDragStateChange(info.offset.y > UNINSTALL_THRESHOLD * 0.5)}
        onDragEnd={(_e, info) => {
          onDragStateChange(false);
          if (info.offset.y > UNINSTALL_THRESHOLD) onUninstall();
        }}
        dragTransition={{ bounceStiffness: springDrag.stiffness as number, bounceDamping: springDrag.damping as number }}
        whileHover={reduceMotion || flipped ? undefined : { y: -3, scale: 1.04, transition: springSnap }}
        animate={reduceMotion ? undefined : { rotateY: flipped ? 180 : 0 }}
        transition={springFlip}
        className="relative h-[120px] w-[140px]"
        style={{ transformStyle: 'preserve-3d' }}
      >
        {/* ── Front face ─────────────────────────────────────────────────── */}
        <div
          tabIndex={0}
          role="button"
          aria-label={skill.name}
          onKeyDown={handleKey}
          onDoubleClick={() => setFlipped(true)}
          className={cn(
            'absolute inset-0 flex cursor-grab flex-col border p-3.5 outline-none focus-visible:ring-2 active:cursor-grabbing',
            radius.card,
            s(theme, 'card'),
            a.ring,
            'focus-visible:ring-2',
          )}
          style={{ backfaceVisibility: 'hidden' }}
        >
          <span
            className={cn('absolute right-3 top-3 size-2 rounded-full', dotClass)}
            aria-label={t('evolution.statusAria', { status: skill.health })}
          />
          <span className={cn('mb-2.5 flex size-9 items-center justify-center', radius.small, a.bg, a.text)}>
            <Wrench className="size-4" aria-hidden />
          </span>
          <span className={cn('text-[13px] font-semibold leading-tight', isDark ? 'text-zinc-100' : 'text-zinc-900')}>
            {skill.name}
          </span>
          <span className={cn('mt-0.5 font-mono text-[11px]', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
            {skill.version}
          </span>
          <button
            onClick={() => setFlipped(true)}
            className={cn('mt-auto text-left text-[11px] underline-offset-2 hover:underline', a.text)}
          >
            {t('evolution.configure')}
          </button>
        </div>

        {/* ── Back face (configure form — inputs live here, not a drawer) ─── */}
        <div
          className={cn(
            'absolute inset-0 flex flex-col gap-2 border p-3',
            radius.card,
            s(theme, 'modal'),
            a.ring,
            'ring-1',
          )}
          style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
          aria-hidden={!flipped}
        >
          <span className={cn('text-[11px] font-semibold', a.text)}>{t('evolution.configure')}</span>
          {/* Mock config field — live schema comes from skill.json configSchema */}
          <input
            type="text"
            aria-label={skill.slug}
            placeholder={skill.slug}
            className={cn(
              'w-full border px-2 py-1 text-[11px] outline-none',
              radius.small,
              s(theme, 'inset'),
              isDark ? 'text-zinc-200 placeholder:text-zinc-600' : 'text-zinc-800 placeholder:text-zinc-400',
            )}
          />
          <div className="mt-auto flex items-center gap-1.5">
            <Button size="xs" variant="default" onClick={handleSave} className="gap-1">
              <Save className="size-3" aria-hidden />
              {t('common.save')}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setFlipped(false)} className="gap-1">
              <RotateCcw className="size-3" aria-hidden />
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      </motion.div>

      {/* Uninstall button — visible keyboard/click back-path for the drag */}
      {!flipped && (
        <button
          onClick={onUninstall}
          aria-label={`${t('evolution.uninstall')} ${skill.name}`}
          className={cn(
            'absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100',
            isDark ? 'border-white/15 bg-zinc-900 text-zinc-400' : 'border-zinc-200 bg-white text-zinc-500',
            'group-hover:opacity-100',
          )}
          tabIndex={-1}
        >
          <Trash2 className="size-2.5" aria-hidden />
        </button>
      )}
    </motion.div>
  );
}
