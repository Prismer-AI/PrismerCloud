'use client';

/**
 * §30 B3.3 — Simple mode Step 2: team review.
 *
 * Recommended team from `renderTemplate(industry, size)` as a checkbox list
 * + "+ 添加其他角色" popover for the full role universe. Capacity enforced
 * at the device level (Solo Cloud Device = 3 agents). Title shows live
 * counter (`N/M agents 已选`) animated with springSnap. At capacity,
 * unchecked rows disable (gray + tooltip) — physical limit, not error.
 *
 * Animation (spec §2.8.4): stagger enter index*0.04 (springSoft), row hover
 * y -1 (springSnap), uncheck opacity 1→0.45 (no height collapse), counter
 * springSnap on change. Reduced motion → 120ms ease-out.
 *
 * Slug editor (Discord-2023 lesson — Task 3): each row exposes an inline
 * `@handle` input pre-filled with `suggestUsernameSeed(displayName)` (no
 * random suffix). The user sees + edits it before commit. Provisioning
 * surfaces server-side 409s back via `slugErrors[role.slug]`.
 */

import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'framer-motion';
import { ChevronDown, Cloud, Laptop, Plus, Server } from 'lucide-react';

import { radius, s, springSnap, springSoft } from '../../lib/design';
import { imFetch } from '../../lib/im-api';
import { useDeviceSelector, useWorkspaceId } from './context';
import { getAvailableRoles, renderTemplate } from '../../lib/templates/render';
import type { IndustryKey, RenderedRole, SizeKey } from '../../lib/templates/types';
import type { RuntimeInstallationDTO } from '../../lib/types';
import { validateSlug } from '../../lib/agent-rename';
import { getRoleIcon } from './role-icons';
import { BrowseAllRolesModal } from './template-browser';

// ───────────────────────── Public API ─────────────────────────

interface DeviceOption {
  id: string;
  label: string;
  daemonId: string;
  kind: 'docker' | 'k8s';
  spare: number;
  maxAgents: number;
}

export interface SimpleStep2TeamProps {
  isDark: boolean;
  industry: IndustryKey;
  size: SizeKey;
  /** Roles selected so far (controlled by parent). */
  selectedSlugs: Set<string>;
  /** Called when user toggles a role checkbox or adds via popover. */
  onSelectionChange: (slugs: Set<string>) => void;
  /** Capacity from current device — default 3 for v1, but accept dynamic value. */
  deviceMaxAgents?: number;
  /**
   * Per-role @handle draft (keyed by role.slug). Optional — when omitted the
   * row shows a read-only slug preview. The rename UX proper lives on the
   * agent card (pencil) + Settings → Team per Q2; this in-step edit is a
   * nice-to-have for users who want to claim a handle pre-provision.
   */
  slugDrafts?: Record<string, string>;
  /** Per-role inline error (set by Step 3 on 409 collision, cleared on edit). */
  slugErrors?: Record<string, string | null>;
  /** Called when the user types in a row's slug input. */
  onSlugChange?: (roleSlug: string, nextDraft: string) => void;
  /** Optional merged role catalog from the template browser for Step 3 planning. */
  onRoleCatalogChange?: (roles: RenderedRole[]) => void;
}

// ───────────────────────── Internals ─────────────────────────

const REDUCED: Transition = { duration: 0.12, ease: 'easeOut' };

/**
 * Animated integer — uses framer's spring on a count change so the title
 * counter snaps with subtle bounce instead of dead-jumping.
 */
function AnimatedInteger({ value, transition }: { value: number; transition: Transition }) {
  return (
    <motion.span
      key={value}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
      className="inline-block tabular-nums"
    >
      {value}
    </motion.span>
  );
}

// ───────────────────────── Component ─────────────────────────

export function SimpleStep2Team({
  isDark,
  industry,
  size,
  selectedSlugs,
  onSelectionChange,
  deviceMaxAgents = 10,
  slugDrafts = {},
  slugErrors = {},
  onSlugChange,
  onRoleCatalogChange,
}: SimpleStep2TeamProps) {
  const workspaceId = useWorkspaceId();
  const theme = isDark ? 'dark' : 'light';
  const reduce = useReducedMotion() ?? false;
  const tSnap: Transition = reduce ? REDUCED : springSnap;
  const tSoft: Transition = reduce ? REDUCED : springSoft;
  const onDeviceSelected = useDeviceSelector();

  // Recommended roles (the checkbox list rows) + the full universe (popover).
  const recommended = useMemo<RenderedRole[]>(() => renderTemplate(industry, size, 'zh'), [industry, size]);
  const universe = useMemo<RenderedRole[]>(() => getAvailableRoles(industry, size, 'zh'), [industry, size]);

  // Roles that have been added via the popover but aren't part of the
  // recommended set — appended below the recommended rows.
  const recommendedSet = useMemo(() => new Set(recommended.map((r) => r.slug)), [recommended]);
  const extraRoles = useMemo<RenderedRole[]>(
    () => universe.filter((r) => !recommendedSet.has(r.slug) && selectedSlugs.has(r.slug)),
    [universe, recommendedSet, selectedSlugs],
  );

  // ── Device picker: fetch eligible devices when workspaceId is provided ──
  const [devOpts, setDevOpts] = useState<DeviceOption[]>([]);
  const [devIdx, setDevIdx] = useState(0);
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await imFetch<RuntimeInstallationDTO[]>(
          `/api/workspace/runtime-installations?workspaceId=${encodeURIComponent(workspaceId)}`,
        );
        if (cancelled || !res.ok || !Array.isArray(res.data)) return;
        const allDevices = res.data
          .filter((r) => r.phase === 'online' || r.phase === 'provisioning')
          .map((r) => ({
            id: r.id,
            label: (r.podName ?? '').replace(/^daemon:/, '').slice(0, 48) || r.runtimeInstanceId,
            daemonId: r.daemonId,
            kind: (r.runtimeKind ?? 'docker') as 'docker' | 'k8s',
            spare: Math.max(0, r.maxAgents - (r.hostedAgentSummary?.declared ?? 0)),
            maxAgents: r.maxAgents,
          }))
          // Show devices with spare capacity first, full devices after
          .sort((a, b) => (b.spare > 0 ? 1 : 0) - (a.spare > 0 ? 1 : 0));
        if (cancelled) return;
        setDevOpts(allDevices);
        // Default to first device with spare capacity
        const firstAvail = allDevices.findIndex((d) => d.spare > 0);
        const defaultIdx = firstAvail >= 0 ? firstAvail : 0;
        setDevIdx(defaultIdx);
        if (allDevices.length > 0 && onDeviceSelected) {
          const d = allDevices[defaultIdx];
          onDeviceSelected(d.id, d.daemonId, d.maxAgents);
        }
      } catch {
        /* swallow */
      }
    })();
    return () => {
      cancelled = true;
    };
    // Only re-fetch when workspaceId changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const handleDeviceChange = useCallback(
    (idx: number) => {
      setDevIdx(idx);
      const opt = devOpts[idx];
      if (opt && onDeviceSelected) onDeviceSelected(opt.id, opt.daemonId, opt.maxAgents);
    },
    [devOpts, onDeviceSelected],
  );

  // Capacity bookkeeping: use selected device's spare if available.
  const selectedDevice = devOpts[devIdx] ?? null;
  const capacityLimit = selectedDevice ? selectedDevice.spare : deviceMaxAgents;
  const displayMax = selectedDevice ? selectedDevice.maxAgents : deviceMaxAgents;
  const selectedCount = selectedSlugs.size;
  const atCapacity = selectedCount >= capacityLimit;

  const toggleRole = useCallback(
    (slug: string) => {
      const next = new Set(selectedSlugs);
      if (next.has(slug)) {
        next.delete(slug);
      } else {
        if (next.size >= capacityLimit) return; // capacity hit — silent ignore
        next.add(slug);
      }
      onSelectionChange(next);
    },
    [selectedSlugs, capacityLimit, onSelectionChange],
  );

  // ── Browse-all modal state ────────────────────────────────────
  // Friction-first surface for the 200+ agency templates.
  // Default Step 2 view stays at the curated recommendation; modal is opt-in.
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browserRoles, setBrowserRoles] = useState<RenderedRole[]>([]);

  const handleBrowseOpenChange = useCallback((next: boolean) => {
    setBrowseOpen(next);
  }, []);

  const handleBrowserCatalogChange = useCallback(
    (roles: RenderedRole[]) => {
      setBrowserRoles(roles);
      onRoleCatalogChange?.(roles);
    },
    [onRoleCatalogChange],
  );

  // The "rows" displayed in the checkbox list: recommended first, then any
  // popover-added extras. We render in a stable order so React can keyframe
  // opacity without recycling motion nodes.
  const allRows: RenderedRole[] = useMemo(() => {
    const selectedExtraBrowserRoles = browserRoles.filter(
      (role) =>
        !recommendedSet.has(role.slug) &&
        !extraRoles.some((item) => item.slug === role.slug) &&
        selectedSlugs.has(role.slug),
    );
    return [...recommended, ...extraRoles, ...selectedExtraBrowserRoles];
  }, [browserRoles, extraRoles, recommended, recommendedSet, selectedSlugs]);

  const headingClass = `text-base font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`;
  const cardSurface = s(theme, 'card');
  const insetSurface = s(theme, 'inset');

  return (
    <div className="flex flex-col gap-4" data-testid="simple-step2-team">
      {/* ─── Title with live capacity counter ────────────────────── */}
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="step2-team-label" className={headingClass}>
          推荐你的团队
        </h2>
        <p
          aria-live="polite"
          aria-atomic="true"
          className={`text-xs tabular-nums ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
          data-testid="simple-step2-capacity"
        >
          (
          <AnimatePresence mode="popLayout" initial={false}>
            <AnimatedInteger key={selectedCount} value={selectedCount} transition={tSnap} />
          </AnimatePresence>
          /{displayMax} agents 已选)
        </p>
      </div>

      {/* ─── Recommended + extra role rows ───────────────────────── */}
      <div role="group" aria-labelledby="step2-team-label" className="flex flex-col gap-2">
        {allRows.map((role, idx) => {
          const selected = selectedSlugs.has(role.slug);
          const disabled = !selected && atCapacity;
          return (
            <RoleRow
              key={role.slug}
              role={role}
              isDark={isDark}
              cardSurface={cardSurface}
              selected={selected}
              disabled={disabled}
              index={idx}
              tSoft={tSoft}
              tSnap={tSnap}
              reduce={reduce}
              onToggle={() => toggleRole(role.slug)}
              slugDraft={slugDrafts?.[role.slug] ?? role.slug}
              slugError={slugErrors?.[role.slug] ?? null}
              onSlugChange={onSlugChange ? (next) => onSlugChange(role.slug, next) : undefined}
            />
          );
        })}
      </div>

      {/* ─── Browse all roles: full-width dashed CTA card. The legacy outline
          button (textbook compact) was visually indistinguishable from
          the "+ row" form-help affordance and users missed it. Made it a
          full-row card with accent palette so it scans as a peer to the
          recommended-team rows above. */}
      <button
        type="button"
        data-testid="simple-step2-browse-all-roles"
        onClick={() => setBrowseOpen(true)}
        className={[
          'group flex w-full items-center justify-between gap-3 rounded-xl border border-dashed px-4 py-3 text-left transition',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60',
          isDark
            ? 'border-violet-400/40 bg-violet-500/[0.06] hover:border-violet-300/70 hover:bg-violet-500/[0.10]'
            : 'border-violet-300 bg-violet-50/40 hover:border-violet-400 hover:bg-violet-50',
        ].join(' ')}
      >
        <span className="flex items-center gap-3">
          <span
            aria-hidden
            className={[
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
              isDark ? 'bg-violet-500/20 text-violet-200' : 'bg-violet-100 text-violet-700',
            ].join(' ')}
          >
            <Plus className="h-4 w-4" strokeWidth={2} />
          </span>
          <span className="flex flex-col gap-0.5">
            <span className={`text-sm font-medium ${isDark ? 'text-violet-100' : 'text-violet-900'}`}>
              浏览全部角色
            </span>
            <span className={`text-[11px] ${isDark ? 'text-violet-300/80' : 'text-violet-700/80'}`}>
              从 225 个模板中按领域 / 关键词挑选，找你真正需要的那一位
            </span>
          </span>
        </span>
        <span
          aria-hidden
          className={[
            'shrink-0 text-xs transition-transform group-hover:translate-x-0.5',
            isDark ? 'text-violet-200' : 'text-violet-700',
          ].join(' ')}
        >
          →
        </span>
      </button>
      <BrowseAllRolesModal
        open={browseOpen}
        onOpenChange={handleBrowseOpenChange}
        isDark={isDark}
        selectedSlugs={selectedSlugs}
        fallbackRoles={universe}
        recommendedSet={recommendedSet}
        atCapacity={atCapacity}
        onToggle={(role) => toggleRole(role.slug)}
        onCatalogChange={handleBrowserCatalogChange}
      />

      {/* ─── Device picker ───────────────────────────────────────── */}
      <div
        data-testid="simple-step2-device-row"
        className={`mt-1 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${insetSurface} ${
          isDark ? 'text-zinc-400' : 'text-zinc-600'
        }`}
      >
        {devOpts.length > 0 ? (
          <div className="relative flex w-full items-center gap-2">
            {(devOpts[devIdx]?.kind ?? 'docker') === 'k8s' ? (
              <Server aria-hidden className="h-4 w-4 shrink-0" strokeWidth={1.5} />
            ) : (
              <Laptop aria-hidden className="h-4 w-4 shrink-0" strokeWidth={1.5} />
            )}
            <select
              data-testid="simple-step2-device-select"
              value={devIdx}
              onChange={(e) => handleDeviceChange(Number(e.target.value))}
              className={`flex-1 bg-transparent text-xs font-medium outline-none ${
                isDark ? 'text-zinc-200' : 'text-zinc-800'
              }`}
            >
              {devOpts.map((opt, i) => (
                <option key={opt.id} value={i}>
                  {opt.label} · {opt.spare > 0 ? `空闲${opt.spare}` : '已满'}/{opt.maxAgents} ·{' '}
                  {opt.kind === 'k8s' ? '云端' : '本地'}
                </option>
              ))}
            </select>
            <ChevronDown aria-hidden className="h-3 w-3 shrink-0 opacity-50" />
            <span className="shrink-0 text-[10px] opacity-60">
              {selectedCount}/{displayMax} agents 已选
            </span>
          </div>
        ) : (
          <>
            <Cloud aria-hidden className="h-4 w-4 shrink-0" strokeWidth={1.5} />
            <span>
              设备: 1 × Cloud Device ({deviceMaxAgents} agents 容量, 你将用 {selectedCount})
            </span>
          </>
        )}
      </div>
    </div>
  );
}

export default SimpleStep2Team;

// ───────────────────────── Sub-components ─────────────────────────

interface RoleRowProps {
  role: RenderedRole;
  isDark: boolean;
  cardSurface: string;
  selected: boolean;
  disabled: boolean;
  index: number;
  tSoft: Transition;
  tSnap: Transition;
  reduce: boolean;
  onToggle: () => void;
  slugDraft: string;
  slugError: string | null;
  /** Optional — when omitted the slug shows as read-only text (no inline input). */
  onSlugChange?: (next: string) => void;
}

function RoleRow({
  role,
  isDark,
  cardSurface,
  selected,
  disabled,
  index,
  tSoft,
  tSnap,
  reduce,
  onToggle,
  slugDraft,
  slugError,
  onSlugChange,
}: RoleRowProps) {
  const ringIdle = isDark ? 'hover:border-white/[0.14]' : 'hover:border-zinc-300';
  const targetOpacity = selected ? 1 : disabled ? 0.4 : 0.45;
  const slugEditable = selected && !disabled && !!onSlugChange;

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (disabled && !selected) return;
      // Only toggle on Space/Enter when focus isn't inside the inline input.
      const target = e.target as HTMLElement | null;
      if (target && target.tagName === 'INPUT') return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        onToggle();
      }
    },
    [disabled, selected, onToggle],
  );

  const handleSlugInput = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      onSlugChange?.(e.target.value.trim().toLowerCase());
    },
    [onSlugChange],
  );

  // §30 Q2 — slug is platform-globally unique (im_users.username UNIQUE).
  // Surface a tiny hint when the slug input is focused so callers don't
  // discover the constraint via a 409 round-trip. Stays hidden until focus
  // to avoid bloating the row density (we have N rows; persistent hint
  // text would dominate).
  const [slugFocused, setSlugFocused] = useState(false);
  const onSlugFocus = useCallback(() => setSlugFocused(true), []);
  const onSlugBlur = useCallback(() => setSlugFocused(false), []);

  // Live validation against the shared slug regex (Task 2 generalized it).
  // `slugError` (from the parent) takes precedence — server-side 409s.
  const localValidation = slugEditable ? validateSlug(slugDraft) : null;
  const showLocalError = slugEditable && localValidation && !localValidation.valid && slugDraft.length > 0;
  const inlineError = slugError ?? (showLocalError && localValidation ? localValidation.reason : null);

  const inputBorder = inlineError
    ? isDark
      ? 'border-rose-400/60'
      : 'border-rose-400'
    : isDark
      ? 'border-white/[0.06] focus:border-violet-400/60'
      : 'border-zinc-200 focus:border-violet-400/60';

  return (
    <motion.div
      role="checkbox"
      tabIndex={disabled ? -1 : 0}
      aria-checked={selected}
      aria-disabled={disabled || undefined}
      aria-label={`${role.displayName} — ${role.rationale}`}
      title={disabled ? 'Solo 模板上限 / 容量已满' : undefined}
      data-testid={`simple-step2-role-${role.slug}`}
      onClick={(e) => {
        if (disabled) return;
        // Don't toggle when clicks originate from the slug input itself.
        const target = e.target as HTMLElement | null;
        if (target && target.tagName === 'INPUT') return;
        onToggle();
      }}
      onKeyDown={onKeyDown}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: targetOpacity, y: 0 }}
      whileHover={!disabled ? { y: -1 } : undefined}
      transition={reduce ? REDUCED : { ...tSoft, delay: index * 0.04 }}
      className={`group flex w-full items-start gap-3 border px-3 py-2.5 text-left ${radius.card} ${cardSurface} ${
        selected ? 'border-violet-400/40' : ringIdle
      } ${disabled ? 'cursor-default' : 'cursor-pointer'} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60`}
    >
      <CheckboxGlyph selected={selected} disabled={disabled} isDark={isDark} transition={tSnap} />
      {(() => {
        const Icon = getRoleIcon(role.slug);
        return (
          <Icon
            aria-hidden
            className={`mt-0.5 h-5 w-5 shrink-0 transition-colors ${
              selected ? 'text-violet-500' : isDark ? 'text-zinc-400' : 'text-zinc-500'
            }`}
            strokeWidth={1.5}
          />
        );
      })()}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2">
          <span className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
            {role.displayName}
            {role.primary ? <span className={`ml-1 text-xs font-normal opacity-70`}>(你)</span> : null}
          </span>
        </span>
        <span className={`mt-0.5 truncate text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
          {role.rationale}
        </span>
        <span className="mt-1 flex flex-col gap-0.5">
          <span className="inline-flex items-center gap-1 text-xs text-zinc-500">
            <span aria-hidden>@</span>
            <input
              type="text"
              spellCheck={false}
              autoComplete="off"
              aria-label={`Username for ${role.displayName}`}
              aria-invalid={inlineError ? true : undefined}
              aria-describedby={inlineError ? `simple-step2-slug-error-${role.slug}` : undefined}
              data-testid={`simple-step2-slug-${role.slug}`}
              value={slugDraft}
              onChange={handleSlugInput}
              onFocus={onSlugFocus}
              onBlur={onSlugBlur}
              onClick={(e) => e.stopPropagation()}
              disabled={!slugEditable}
              maxLength={31}
              className={`border bg-transparent px-1.5 py-0.5 text-xs tabular-nums outline-none transition focus:bg-white/[0.04] ${radius.button} ${inputBorder} ${
                isDark ? 'text-zinc-200' : 'text-zinc-700'
              } ${slugEditable ? '' : 'opacity-60'}`}
              style={{ width: `${Math.max(8, Math.min(slugDraft.length + 2, 32))}ch` }}
            />
          </span>
          {inlineError ? (
            <span
              id={`simple-step2-slug-error-${role.slug}`}
              role="alert"
              className={`text-[10px] ${isDark ? 'text-rose-300' : 'text-rose-600'}`}
            >
              {inlineError}
            </span>
          ) : slugFocused && slugEditable ? (
            // §30 Q2 — global uniqueness hint. Only shown on focus (and only
            // when the slug is actually editable) to avoid permanent visual
            // noise on every row. Soft muted color so it does NOT compete
            // with the error styling above.
            <span
              data-testid={`simple-step2-slug-hint-${role.slug}`}
              className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
            >
              slug 全平台唯一,不能跨 workspace 复用
            </span>
          ) : null}
        </span>
      </span>
    </motion.div>
  );
}

function CheckboxGlyph({
  selected,
  disabled,
  isDark,
  transition,
}: {
  selected: boolean;
  disabled: boolean;
  isDark: boolean;
  transition: Transition;
}) {
  // Visual: 16px square box. Filled violet when selected; outline otherwise.
  // When disabled-and-unselected the box dims.
  const base = 'mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border';
  const stateClass = selected
    ? 'border-violet-400 bg-violet-500/90'
    : disabled
      ? isDark
        ? 'border-white/[0.08] bg-transparent'
        : 'border-zinc-200 bg-transparent'
      : isDark
        ? 'border-white/[0.18] bg-zinc-900/40'
        : 'border-zinc-300 bg-white';
  return (
    <span aria-hidden className={`${base} ${stateClass}`}>
      <AnimatePresence initial={false}>
        {selected ? (
          <motion.svg
            key="check"
            viewBox="0 0 10 10"
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.6, opacity: 0 }}
            transition={transition}
            className="h-2.5 w-2.5"
            fill="none"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M1.5 5.2 L4 7.5 L8.5 2.5" />
          </motion.svg>
        ) : null}
      </AnimatePresence>
    </span>
  );
}
