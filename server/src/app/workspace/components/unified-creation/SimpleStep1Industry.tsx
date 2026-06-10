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
import { ModelPicker } from '../model-picker';
import type { ProxyProvider } from '../proxy-provider-select';
import { AdvancedProxyAccordion } from './pro/AdvancedProxyAccordion';

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
  initialOrganizationName?: string;
  /**
   * The workspace's existing organization name (workspace ↔ organization is
   * 1:1 by design). When set, the "组织名称" section renders as a read-only
   * badge and the user can't retype it — they're operating inside an
   * existing org. Renaming the org belongs in a workspace-settings flow,
   * not the device-creation modal.
   */
  lockedOrganizationName?: string | null;
  initialIndustry?: IndustryKey;
  initialSize?: SizeKey;
  model: string;
  /**
   * 2026-05-30 — per-agent LLM proxy provider for every Hermes profile this
   * Simple-mode run mints. Wired to `AdvancedProxyAccordion` underneath the
   * ModelPicker so the choice lives next to its sibling control. Owned by
   * the shell (UnifiedCreationModal) like the model field so it survives
   * Step 0 → 1 navigation.
   */
  proxyProvider: ProxyProvider;
  onOrganizationNameChange: (name: string) => void;
  onModelChange: (model: string) => void;
  onProxyProviderChange: (value: ProxyProvider) => void;
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
  initialOrganizationName,
  lockedOrganizationName,
  initialIndustry,
  initialSize,
  model,
  proxyProvider,
  onOrganizationNameChange,
  onModelChange,
  onProxyProviderChange,
  onSelectionChange,
}: SimpleStep1IndustryProps) {
  const theme = isDark ? 'dark' : 'light';
  const reduce = useReducedMotion() ?? false;
  const tSnap: Transition = reduce ? REDUCED : springSnap;
  const tSoft: Transition = reduce ? REDUCED : springSoft;

  const [industry, setIndustry] = useState<IndustryKey | null>(initialIndustry ?? null);
  const [size, setSize] = useState<SizeKey | null>(initialSize ?? null);
  // When `lockedOrganizationName` is provided, it always wins — the user
  // can't edit, and any stale `initialOrganizationName` (from a previous
  // session draft) is overwritten.
  const isLocked = typeof lockedOrganizationName === 'string' && lockedOrganizationName.trim().length > 0;
  const [organizationName, setOrganizationName] = useState(
    isLocked ? (lockedOrganizationName as string).trim() : (initialOrganizationName ?? ''),
  );

  useEffect(() => {
    if (isLocked) {
      setOrganizationName((lockedOrganizationName as string).trim());
      return;
    }
    setOrganizationName(initialOrganizationName ?? '');
  }, [initialOrganizationName, isLocked, lockedOrganizationName]);

  useEffect(() => {
    onOrganizationNameChange(organizationName);
  }, [organizationName, onOrganizationNameChange]);

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
      <section aria-labelledby="step1-organization-label">
        <label id="step1-organization-label" htmlFor="simple-step1-organization-name" className={headingClass}>
          组织名称
        </label>
        {isLocked ? (
          // Workspace ↔ organization is 1:1 — when the workspace already
          // owns a name, surface it as a locked badge instead of a writable
          // input. Renaming belongs in workspace settings, not here.
          <div
            data-testid="simple-step1-organization-locked"
            className={`flex h-11 items-center gap-2 rounded-xl border px-3 ${
              isDark ? 'border-white/[0.06] bg-zinc-900/40 text-zinc-200' : 'border-zinc-200 bg-zinc-50 text-zinc-800'
            }`}
          >
            <span
              className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-xs font-bold ${
                isDark ? 'bg-violet-500/20 text-violet-200' : 'bg-violet-100 text-violet-700'
              }`}
              aria-hidden
            >
              {organizationName.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{organizationName}</span>
            <span className={`shrink-0 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>当前工作区</span>
          </div>
        ) : (
          <input
            id="simple-step1-organization-name"
            data-testid="simple-step1-organization-name"
            value={organizationName}
            onChange={(e) => setOrganizationName(e.target.value)}
            placeholder="例如: Prism Labs"
            maxLength={64}
            className={`h-11 w-full rounded-xl border px-3 text-sm outline-none transition-colors ${
              isDark
                ? 'border-white/[0.08] bg-zinc-900/70 text-zinc-100 placeholder:text-zinc-600 focus:border-violet-400/60'
                : 'border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400 focus:border-violet-400'
            }`}
          />
        )}
      </section>

      <section aria-labelledby="step1-model-label">
        <label id="step1-model-label" className={headingClass}>
          默认模型
        </label>
        <ModelPicker
          value={model}
          onChange={onModelChange}
          allowCustom
          proxyProvider={proxyProvider}
          className={
            isDark ? 'border-white/[0.08] bg-zinc-900/70 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
          }
        />
        {/*
         * 2026-05-30 — Simple wizard 的 proxyProvider 入口。直接复用 Pro 模式
         * 那边一模一样的 AdvancedProxyAccordion，下半段是 ProxyProviderSelect
         * (radix RadioGroup + design.ts tokens)。默认 collapsed，95% 走
         * `newapi` 不打扰；badge 上始终能看到当前值。
         *
         * 补 8d914c41 漏点：上一轮只接了 NewAgentDialog (Simple) 和 Pro 的
         * ProTileAgent / ProTileProfile；UnifiedCreationModal 的 Simple wizard
         * 是 workspace 首次 bootstrap 用户最常碰的入口，没接等于 99% 用户碰
         * 不到。
         */}
        <div className="mt-3">
          <AdvancedProxyAccordion
            isDark={isDark}
            proxyProvider={proxyProvider}
            onProxyProviderChange={onProxyProviderChange}
            testIdPrefix="simple-step1"
          />
        </div>
      </section>

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
