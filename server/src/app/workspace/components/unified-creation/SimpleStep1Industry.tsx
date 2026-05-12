'use client';

/**
 * §30 B3.2 — Simple mode Step 1: industry + size picker.
 *
 * 6 industry cards (96×96, glass) + 4 size chips (80×80). Both rendered as
 * radiogroups (arrow keys nav, space/enter select). Presentational only —
 * parent owns selection and re-feeds via initial* props.
 *
 * Animation (spec §2.8.4): stagger 0.04s on enter (springSoft), ring+scale
 * 1.02 on select (springSnap), y -1 micro-rise on hover. 800ms idle hover
 * lazily fades in a caption built from `renderTemplate()` — no tooltips on
 * first render. Reduced motion → 120ms ease-out.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'framer-motion';
import { Code2, Factory, Handshake, Landmark, Microscope, ShoppingBag, type LucideIcon } from 'lucide-react';

import { radius, s, springSnap, springSoft } from '../../lib/design';
import { INDUSTRIES, SIZES } from '../../lib/templates/catalog';
import { renderTemplate } from '../../lib/templates/render';
import type { IndustryKey, SizeKey } from '../../lib/templates/types';

const REDUCED: Transition = { duration: 0.12, ease: 'easeOut' };
const HOVER_CAPTION_DELAY_MS = 800;

const INDUSTRY_KEYS: readonly IndustryKey[] = INDUSTRIES.map((i) => i.key);
const SIZE_KEYS: readonly SizeKey[] = SIZES.map((s) => s.key);

// Emoji icons in pack-*.json read childish; map to lucide line icons for
// elegant flat presentation. Keep catalog.icon (emoji) untouched as SoT —
// other surfaces (e.g. Step 2 review header) may still want the emoji.
const INDUSTRY_ICONS: Record<IndustryKey, LucideIcon> = {
  it_software: Code2,
  retail: ShoppingBag,
  service: Handshake,
  research: Microscope,
  manufacturing: Factory,
  government: Landmark,
};

export interface SimpleStep1IndustryProps {
  isDark: boolean;
  initialIndustry?: IndustryKey;
  initialSize?: SizeKey;
  onSelectionChange: (industry: IndustryKey | null, size: SizeKey | null) => void;
}

function moveSelection<T extends string>(keys: readonly T[], current: T | null, dir: 1 | -1): T {
  if (current === null) return dir === 1 ? keys[0] : keys[keys.length - 1];
  const idx = keys.indexOf(current);
  if (idx < 0) return keys[0];
  return keys[(idx + dir + keys.length) % keys.length];
}

export function SimpleStep1Industry({
  isDark,
  initialIndustry,
  initialSize,
  onSelectionChange,
}: SimpleStep1IndustryProps) {
  const theme = isDark ? 'dark' : 'light';
  const reduce = useReducedMotion() ?? false;
  const tSnap: Transition = reduce ? REDUCED : springSnap;
  const tSoft: Transition = reduce ? REDUCED : springSoft;

  const [industry, setIndustry] = useState<IndustryKey | null>(initialIndustry ?? null);
  const [size, setSize] = useState<SizeKey | null>(initialSize ?? null);

  // Notify parent on actual change — guard against echo loops if parent
  // feeds props back through the initial* slots.
  const lastEmitted = useRef<{ industry: IndustryKey | null; size: SizeKey | null }>({
    industry: initialIndustry ?? null,
    size: initialSize ?? null,
  });
  useEffect(() => {
    if (lastEmitted.current.industry === industry && lastEmitted.current.size === size) return;
    lastEmitted.current = { industry, size };
    onSelectionChange(industry, size);
  }, [industry, size, onSelectionChange]);

  // ── 800ms hover caption ──────────────────────────────────────────
  const [hoveredIndustry, setHoveredIndustry] = useState<IndustryKey | null>(null);
  const [captionFor, setCaptionFor] = useState<IndustryKey | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelHover = useCallback(() => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  const beginHover = useCallback(
    (key: IndustryKey) => {
      setHoveredIndustry(key);
      cancelHover();
      hoverTimer.current = setTimeout(() => setCaptionFor(key), HOVER_CAPTION_DELAY_MS);
    },
    [cancelHover],
  );

  const endHover = useCallback(() => {
    setHoveredIndustry(null);
    setCaptionFor(null);
    cancelHover();
  }, [cancelHover]);

  useEffect(() => () => cancelHover(), [cancelHover]);

  // Lazy caption — only computes when captionFor flips on. Falls back to
  // size A if user hasn't picked size yet, so the preview still shows the
  // archetype roster.
  const captionText = useMemo<string | null>(() => {
    if (!captionFor) return null;
    try {
      const roles = renderTemplate(captionFor, size ?? 'A', 'zh');
      if (roles.length === 0) return null;
      return `典型组成: ${roles
        .slice(0, 3)
        .map((r) => r.displayName)
        .join(' + ')}`;
    } catch {
      return null;
    }
  }, [captionFor, size]);

  const onIndustryKey = useCallback((e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      setIndustry((prev) => moveSelection(INDUSTRY_KEYS, prev, 1));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      setIndustry((prev) => moveSelection(INDUSTRY_KEYS, prev, -1));
    }
  }, []);

  const onSizeKey = useCallback((e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      setSize((prev) => moveSelection(SIZE_KEYS, prev, 1));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      setSize((prev) => moveSelection(SIZE_KEYS, prev, -1));
    }
  }, []);

  const cardSurface = s(theme, 'card');
  const headingClass = `mb-3 text-base font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`;
  const ringIdle = isDark ? 'hover:border-white/[0.14]' : 'hover:border-zinc-300';

  return (
    <div className="flex flex-col gap-7" data-testid="simple-step1-industry">
      <section aria-labelledby="step1-industry-label">
        <h2 id="step1-industry-label" className={headingClass}>
          你的团队来自哪个行业?
        </h2>

        <div role="radiogroup" aria-labelledby="step1-industry-label" className="flex flex-wrap items-start gap-3">
          {INDUSTRIES.map((entry, idx) => {
            const selected = industry === entry.key;
            const hovered = hoveredIndustry === entry.key;
            const Icon = INDUSTRY_ICONS[entry.key];
            const iconColor = selected ? 'text-violet-500' : isDark ? 'text-zinc-400' : 'text-zinc-500';
            return (
              <motion.button
                key={entry.key}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`${entry.name.zh} (${entry.name.en})`}
                tabIndex={selected || (industry === null && idx === 0) ? 0 : -1}
                data-testid={`simple-step1-industry-${entry.key}`}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: hovered && !selected ? -1 : 0, scale: selected ? 1.02 : 1 }}
                transition={reduce ? REDUCED : { ...tSoft, delay: idx * 0.04 }}
                onClick={() => setIndustry(entry.key)}
                onKeyDown={onIndustryKey}
                onMouseEnter={() => beginHover(entry.key)}
                onMouseLeave={endHover}
                onFocus={() => beginHover(entry.key)}
                onBlur={endHover}
                className={`flex h-24 w-24 shrink-0 flex-col items-center justify-center gap-1 border ${radius.card} ${cardSurface} ${
                  selected ? 'ring-2 ring-violet-400/40' : ringIdle
                } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60`}
              >
                <Icon aria-hidden strokeWidth={1.5} className={`h-7 w-7 transition-colors ${iconColor}`} />
                <span
                  className={`text-[11px] font-semibold leading-tight ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}
                >
                  {entry.name.en.split(' / ')[0]}
                </span>
                <span className={`text-[10px] leading-tight ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  {entry.name.zh.split(' / ')[0]}
                </span>
              </motion.button>
            );
          })}
        </div>

        {/* Caption gutter — reserved height prevents layout shift on fade. */}
        <div className="mt-3 h-5">
          <AnimatePresence>
            {captionText ? (
              <motion.p
                key={captionFor ?? 'none'}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={tSnap}
                className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
                data-testid="simple-step1-caption"
              >
                {captionText}
              </motion.p>
            ) : null}
          </AnimatePresence>
        </div>
      </section>

      <section aria-labelledby="step1-size-label">
        <h2 id="step1-size-label" className={headingClass}>
          你的团队规模?
        </h2>

        <div role="radiogroup" aria-labelledby="step1-size-label" className="flex flex-wrap items-start gap-3">
          {SIZES.map((entry, idx) => {
            const selected = size === entry.key;
            return (
              <motion.button
                key={entry.key}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`${entry.name.zh} (${entry.name.en})`}
                tabIndex={selected || (size === null && idx === 0) ? 0 : -1}
                data-testid={`simple-step1-size-${entry.key}`}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0, scale: selected ? 1.02 : 1 }}
                whileHover={!selected ? { y: -1 } : undefined}
                transition={reduce ? REDUCED : { ...tSoft, delay: (INDUSTRIES.length + idx) * 0.04 }}
                onClick={() => setSize(entry.key)}
                onKeyDown={onSizeKey}
                className={`flex h-20 w-20 shrink-0 flex-col items-center justify-center gap-0.5 border ${radius.card} ${cardSurface} ${
                  selected ? 'ring-2 ring-violet-400/40' : ringIdle
                } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60`}
              >
                <span className={`text-lg font-bold leading-none ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                  {entry.rangeLabel}
                </span>
                <span className={`mt-1 text-[10px] leading-tight ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
                  {entry.name.en.split(' ')[0]}
                </span>
              </motion.button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export default SimpleStep1Industry;
