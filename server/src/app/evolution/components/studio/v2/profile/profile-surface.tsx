'use client';

/**
 * Profiles surface (release201/28 §4 / doc 13 §3.5) — `spatialGrammar.identityCard`, rose.
 *
 * This surface is the agent **profile viewer + editor** (feedback #7). It reads
 * REAL workspace data, makes the data origin of every block explicit, and is
 * honest about what is editable vs. observed:
 *
 *   ── READ (all real, real-first / mock-fallback) ──────────────────────────────
 *   • `useStudioContext()` → the active workspace + agent roster (resolved once
 *     by the shell, never re-rolled here). The carousel switches the active
 *     agent via `setAgentId` (URL-backed) — or a local mirror when the shell
 *     isn't driving `agentId`.
 *   • `fetchAgentProfile(agentId)` (`GET /api/im/studio/profile`) → identity
 *     {displayName, agentType, status, capabilities}, personality {rigor,
 *     creativity, risk_tolerance, soul}, credits, workspaces[]. These are real
 *     DB fields, not mocked.
 *   • The agent_profiles row (`GET /api/im/agent_profiles?agentId=&workspaceId=`)
 *     → `config.operatingPrinciples` (the one editable field) + the row id +
 *     version the write path needs.
 *   Mock fixtures (MOCK_PROFILES) are used ONLY when STUDIO_MOCK_ENABLED and the
 *   live source is unavailable (offline demo / unseeded), mirroring the shell.
 *
 *   ── WRITE (intentionally narrow — principles only) ───────────────────────────
 *   `updateOperatingPrinciples(workspaceId, agentId, principles)` is the ONLY
 *   write pipe (two-step: resolve row id → PATCH config). personality / identity
 *   / credits / capabilities / memberships are OBSERVED read-only fields — the UI
 *   labels them as such and gives them no fake edit affordance.
 *
 * Quotes `spatialGrammar.identityCard` (40% portrait / 60% bio). Five states:
 * gated (no agent) / loading / error / empty (no profile) / data.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import {
  Building2,
  ChevronLeft,
  ChevronRight,
  Eye,
  ListChecks,
  Lock,
  Pencil,
  Sparkles,
  UserCircle,
  Wallet,
} from 'lucide-react';

import {
  grammarAccentClasses,
  radius,
  s,
  spatialGrammar,
  springHeavy,
  springSoft,
} from '@/app/workspace/lib/design';
import { useApp } from '@/contexts/app-context';
import { useI18n } from '@/contexts/i18n-context';
import { useTheme } from '@/contexts/theme-context';
import { cn } from '@/lib/utils';

import { STUDIO_MOCK_ENABLED } from '../flags';
import { MOCK_PROFILES } from '../mock';
import { SectionPlaceholder } from '../section-placeholder';
import { fetchAgentProfile, updateOperatingPrinciples } from '../data/profile';
import { useStudioContext } from '../data/use-studio-context';
import { getJson } from '../../types';
import type { AgentSummary } from '../types';
import { OrbAvatar } from './orb-avatar';
import { PrinciplesStack } from './principles-stack';

const ACCENT = grammarAccentClasses.rose;
const GRAMMAR = spatialGrammar.identityCard;

export interface ProfileSurfaceProps {
  agentId: string | null;
  /** Shell-provided URL writer (roster pattern). Carousel falls back to local. */
  onSelectAgent?: (agentId: string) => void;
}

/** Unified, view-ready profile (live `StudioProfile` ∪ mock `AgentProfile`). */
interface ProfileView {
  displayName: string;
  agentType: string;
  capabilities: string[];
  personality: { rigor: number; creativity: number; riskTolerance: number } | null;
  credits: { balance: number; totalSpent: number; totalEarned: number } | null;
  workspaces: Array<{ id: string; name: string }>;
  /** operatingPrinciples + the row id/version the write path keys off. */
  principles: string[];
  profileRowId: string | null;
  profileRowVersion: number | null;
  /** True when this view was served from the mock fixtures (no live write). */
  isMock: boolean;
}

interface AgentProfileRow {
  id: string;
  config?: { operatingPrinciples?: unknown } & Record<string, unknown>;
  version: number;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value.trim()) {
    return value
      .split('\n')
      .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
      .filter(Boolean);
  }
  return [];
}

/** Build the mock view for an agent (offline demo fallback only). */
function mockView(agent: Pick<AgentSummary, 'id' | 'handle' | 'type'>): ProfileView {
  const p = MOCK_PROFILES[agent.id];
  return {
    displayName: agent.handle,
    agentType: agent.type,
    capabilities: [],
    personality: p?.personality ?? { rigor: 0.7, creativity: 0.5, riskTolerance: 0.4 },
    credits: null,
    workspaces: [],
    principles: p?.operatingPrinciples ?? [
      'Cite sources before asserting',
      'Prefer reproducible scripts',
      'Fail loud, never silently',
    ],
    profileRowId: null,
    profileRowVersion: null,
    isMock: true,
  };
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function ProfileSurface({ agentId }: ProfileSurfaceProps) {
  const { t } = useI18n();
  const { addToast } = useApp();
  const { resolvedTheme } = useTheme();
  const reduce = useReducedMotion();
  const isDark = resolvedTheme === 'dark';
  const theme = isDark ? 'dark' : 'light';

  // Real workspace + roster, resolved once by the shell (real-first / mock-fallback).
  const {
    workspaceId,
    workspaceName,
    agents,
    agentId: ctxAgentId,
    setAgentId,
    loading: ctxLoading,
    error: ctxError,
  } = useStudioContext();

  // Carousel selection only kicks in when the shell isn't driving the agent id.
  const shellAgentId = agentId ?? ctxAgentId;
  const [localId, setLocalId] = useState<string | null>(null);
  const activeId = shellAgentId ?? localId ?? agents[0]?.id ?? null;
  const activeIndex = useMemo(() => agents.findIndex((a) => a.id === activeId), [agents, activeId]);
  const activeAgent = activeIndex >= 0 ? agents[activeIndex] : agents[0];

  // ── Per-agent profile read (identity / personality / credits / principles) ──
  const [view, setView] = useState<ProfileView | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState(false);
  // Working copy of principles (the only editable field) + save lifecycle.
  const [principles, setPrinciples] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');

  const activeAgentId = activeAgent?.id ?? null;
  const activeHandle = activeAgent?.handle ?? '';
  const activeType = activeAgent?.type ?? '';

  useEffect(() => {
    if (!activeAgentId) return;
    let cancelled = false;
    const agentRef = { id: activeAgentId, handle: activeHandle, type: activeType };

    (async () => {
      // Reset lifecycle inside the async body (not the effect body) so we don't
      // trigger a synchronous cascading render on every agent switch.
      setProfileLoading(true);
      setProfileError(false);
      setSaveState('idle');
      setDirty(false);
      try {
        // identity / personality / credits / workspaces (real BFF)
        const live = await fetchAgentProfile(agentRef.id);
        // operatingPrinciples live in the agent_profiles row config — read it
        // from the same row the write path resolves (so display == edit target).
        let rows: AgentProfileRow[] | null = null;
        if (workspaceId) {
          const params = new URLSearchParams({ agentId: agentRef.id, workspaceId });
          rows = await getJson<AgentProfileRow[]>(`/api/im/agent_profiles?${params.toString()}`);
        }
        if (cancelled) return;

        const row = rows?.[0] ?? null;
        const livePrinciples = asStringArray(row?.config?.operatingPrinciples);

        if (live?.identity || live?.personality || row) {
          const next: ProfileView = {
            displayName: live?.identity?.displayName || agentRef.handle,
            agentType: live?.identity?.agentType || agentRef.type,
            capabilities: live?.identity?.capabilities ?? [],
            personality: live?.personality
              ? {
                  rigor: live.personality.rigor,
                  creativity: live.personality.creativity,
                  riskTolerance: live.personality.risk_tolerance,
                }
              : null,
            credits: live?.credits ?? null,
            workspaces: (live?.workspaces ?? []).map((w) => ({ id: w.workspaceId, name: w.name })),
            principles: livePrinciples,
            profileRowId: row?.id ?? null,
            profileRowVersion: row?.version ?? null,
            isMock: false,
          };
          setView(next);
          setPrinciples(next.principles);
          setProfileLoading(false);
          return;
        }

        // Live unavailable / empty → mock fallback (offline demo) or honest empty.
        if (STUDIO_MOCK_ENABLED) {
          const mv = mockView(agentRef);
          setView(mv);
          setPrinciples(mv.principles);
        } else {
          setView(null);
        }
        setProfileLoading(false);
      } catch {
        if (cancelled) return;
        if (STUDIO_MOCK_ENABLED) {
          const mv = mockView(agentRef);
          setView(mv);
          setPrinciples(mv.principles);
          setProfileError(false);
        } else {
          setProfileError(true);
        }
        setProfileLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeAgentId, activeHandle, activeType, workspaceId]);

  const onReorder = useCallback((next: string[]) => {
    setPrinciples(next);
    setDirty(true);
    setSaveState('idle');
  }, []);
  const onEditPrinciple = useCallback((index: number, value: string) => {
    setPrinciples((prev) => prev.map((p, i) => (i === index ? value : p)));
    setDirty(true);
    setSaveState('idle');
  }, []);

  // ── The ONE write pipe: principles → updateOperatingPrinciples ──
  const canSave = !!workspaceId && !!activeAgent && view?.isMock === false && dirty && saveState !== 'saving';
  const handleSave = useCallback(async () => {
    if (!workspaceId || !activeAgent) return;
    setSaveState('saving');
    try {
      await updateOperatingPrinciples(workspaceId, activeAgent.id, principles);
      setSaveState('saved');
      setDirty(false);
      setView((prev) => (prev ? { ...prev, principles } : prev));
      addToast(t('evolution.common.saved'), 'success');
    } catch (err) {
      setSaveState('error');
      const msg = err instanceof Error ? err.message : t('evolution.studio.lifecycle.configure.saveFailed');
      addToast(msg, 'error');
    }
  }, [workspaceId, activeAgent, principles, addToast, t]);

  const selectIndex = (next: number) => {
    if (agents.length === 0) return;
    const wrapped = (next + agents.length) % agents.length;
    const id = agents[wrapped].id;
    setLocalId(id);
    setAgentId(id);
  };

  // ── State 1: shell still resolving the workspace/roster ──
  if (ctxLoading) {
    return (
      <SectionPlaceholder
        section="profiles"
        icon={UserCircle}
        titleKey="evolution.studio.v2.profiles.title"
        hintKey="evolution.studio.v2.profiles.loading"
      />
    );
  }
  // ── State 2: shell failed to resolve any workspace ──
  if (ctxError) {
    return (
      <SectionPlaceholder
        section="profiles"
        icon={UserCircle}
        titleKey="evolution.studio.v2.profiles.title"
        hintKey="evolution.studio.v2.profiles.error"
      />
    );
  }
  // ── State 3: gated — no agent resolvable in this workspace ──
  if (!activeAgent) {
    return (
      <SectionPlaceholder
        section="profiles"
        icon={UserCircle}
        titleKey="evolution.studio.v2.profiles.title"
        hintKey="evolution.studio.v2.profiles.gated"
      />
    );
  }

  const monogram =
    (view?.displayName ?? activeAgent.handle).replace(/[^a-zA-Z]/g, '').slice(0, 2).toUpperCase() || 'AG';
  const wsCount = view?.workspaces.length || 0;
  const mainWorkspace = view?.workspaces[0]?.name || workspaceName;

  return (
    <div className="flex h-full flex-col gap-4 px-6 py-6">
      {/* Grammar tag + viewer/editor intent + carousel header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={cn('inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium', ACCENT.bg, ACCENT.text)}
            title={GRAMMAR.primaryMetaphor}
          >
            <span className={cn('size-1.5 rounded-full', ACCENT.dot)} aria-hidden />
            {GRAMMAR.primaryMetaphor.split(' — ')[0] || 'identityCard'}
          </span>
          <span className={cn('hidden text-xs sm:inline', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
            {t('evolution.studio.v2.profiles.hint')}
          </span>
          {/* Provenance: make the data source explicit (live BFF vs demo). */}
          {view ? (
            <span
              className={cn(
                'hidden items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium md:inline-flex',
                view.isMock
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-500'
                  : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500',
              )}
              title="GET /api/im/studio/profile"
            >
              <span
                className={cn('size-1.5 rounded-full', view.isMock ? 'bg-amber-400' : 'bg-emerald-400')}
                aria-hidden
              />
              {view.isMock ? t('workspace.stream.offline') : t('workspace.stream.live')}
              <span className="font-mono opacity-60">/studio/profile</span>
            </span>
          ) : null}
        </div>
        {agents.length > 1 ? (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => selectIndex(activeIndex - 1)}
              className={cn('rounded-full border p-1.5 transition-colors', s(theme, 'card'), isDark ? 'text-zinc-300 hover:text-white' : 'text-zinc-600 hover:text-zinc-900')}
              aria-label={t('evolution.common.prev')}
            >
              <ChevronLeft className="size-4" aria-hidden />
            </button>
            <span className={cn('text-xs tabular-nums', isDark ? 'text-zinc-400' : 'text-zinc-500')}>
              {Math.max(activeIndex, 0) + 1}/{agents.length}
            </span>
            <button
              type="button"
              onClick={() => selectIndex(activeIndex + 1)}
              className={cn('rounded-full border p-1.5 transition-colors', s(theme, 'card'), isDark ? 'text-zinc-300 hover:text-white' : 'text-zinc-600 hover:text-zinc-900')}
              aria-label={t('evolution.common.next')}
            >
              <ChevronRight className="size-4" aria-hidden />
            </button>
          </div>
        ) : null}
      </div>

      {/* Identity card — carousel slides the whole card */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeAgent.id}
            initial={reduce ? false : { opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, x: -40 }}
            transition={reduce ? { duration: 0 } : springHeavy}
            // Quotes identityCard (portrait / bio). NOTE: do NOT use the raw
            // `grid-cols-[40%_60%]` grammar string — 40%+60%+gap > 100% overflows
            // the right edge (feedback #2). Fixed-width portrait + a min-w-0 bio
            // column that absorbs the gap and can shrink.
            className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]"
          >
            {/* Portrait pane — siri-orb (observed identity) */}
            <div className={cn('flex flex-col items-center justify-center gap-5 border p-8', radius.pane, s(theme, 'pane'))}>
              <OrbAvatar state={activeAgent.state} monogram={monogram} isDark={isDark} />
              <div className="text-center">
                <h2 className={cn('text-xl font-semibold', isDark ? 'text-zinc-50' : 'text-zinc-900')}>
                  {view?.displayName ?? activeAgent.handle}
                </h2>
                <p className={cn('mt-1 text-sm', isDark ? 'text-zinc-400' : 'text-zinc-600')}>
                  {view?.agentType ?? activeAgent.type}
                </p>
                <span className={cn('mt-3 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs', ACCENT.bg, ACCENT.text)}>
                  <span className={cn('size-1.5 rounded-full', ACCENT.dot)} aria-hidden />
                  {t(`evolution.studio.v2.profiles.state.${activeAgent.state}` as `evolution.${string}`)}
                </span>
              </div>
              {/* Honest provenance: identity is an OBSERVED field */}
              <ObservedTag isDark={isDark} label={t('evolution.studio.v2.profiles.observed')} />
            </div>

            {/* Bio pane */}
            <div className="flex min-w-0 flex-col gap-5">
              {/* Per-agent profile read state inside the bio pane */}
              {profileLoading ? (
                <InlineNotice
                  isDark={isDark}
                  theme={theme}
                  text={t('evolution.studio.v2.profiles.loading')}
                />
              ) : profileError ? (
                <InlineNotice
                  isDark={isDark}
                  theme={theme}
                  text={t('evolution.studio.v2.profiles.error')}
                />
              ) : !view ? (
                <InlineNotice
                  isDark={isDark}
                  theme={theme}
                  text={t('evolution.studio.v2.profiles.empty')}
                />
              ) : (
                <>
                  {/* First-person narrative + trait chips (OBSERVED personality) */}
                  <SectionCard isDark={isDark} theme={theme}>
                    <p className={cn('text-base leading-relaxed', isDark ? 'text-zinc-100' : 'text-zinc-800')}>
                      <span className={ACCENT.text}>“</span>
                      {t('evolution.studio.v2.profiles.narrative', {
                        count: wsCount || 1,
                        main: mainWorkspace || activeAgent.handle,
                      })}
                      <span className={ACCENT.text}>”</span>
                    </p>
                    {view.personality ? (
                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        {(
                          [
                            ['rigor', view.personality.rigor],
                            ['creativity', view.personality.creativity],
                            ['riskTolerance', view.personality.riskTolerance],
                          ] as const
                        ).map(([label, value]) => (
                          <span
                            key={label}
                            className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium', s(theme, 'inset'), isDark ? 'text-zinc-300' : 'text-zinc-700')}
                          >
                            <span className={cn('size-1.5 rounded-full', ACCENT.dot)} aria-hidden />
                            {t(`evolution.studio.v2.profiles.traits.${label}` as `evolution.${string}`)}{' '}
                            {Math.round(value * 100)}%
                          </span>
                        ))}
                        <ObservedTag isDark={isDark} label={t('evolution.studio.v2.profiles.observed')} compact />
                      </div>
                    ) : null}
                  </SectionCard>

                  {/* Operating principles — the ONE editable field */}
                  <SectionCard isDark={isDark} theme={theme}>
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <ListChecks className={cn('size-4', ACCENT.text)} aria-hidden />
                        <h3 className={cn('text-sm font-semibold', isDark ? 'text-zinc-100' : 'text-zinc-900')}>
                          {t('evolution.studio.v2.profiles.operatingPrinciples')}
                        </h3>
                        {/* Honest provenance: this block IS editable config */}
                        <span
                          className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium', ACCENT.bg, ACCENT.text)}
                          title={t('evolution.studio.v2.profiles.editPrincipleHint')}
                        >
                          <Pencil className="size-3" aria-hidden />
                          {t('evolution.studio.v2.profiles.editable')}
                        </span>
                      </div>
                      <SaveButton
                        isDark={isDark}
                        theme={theme}
                        state={saveState}
                        canSave={canSave}
                        isMock={view.isMock}
                        noWorkspace={!workspaceId || !view.profileRowId}
                        onSave={handleSave}
                        t={t}
                      />
                    </div>
                    {principles.length > 0 ? (
                      <PrinciplesStack
                        isDark={isDark}
                        theme={theme}
                        principles={principles}
                        onReorder={onReorder}
                        onEdit={onEditPrinciple}
                      />
                    ) : (
                      <p className={cn('text-sm', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
                        {t('evolution.studio.v2.profiles.empty')}
                      </p>
                    )}
                    {/* Degraded honesty: no editable profile row to write to */}
                    {!view.isMock && !view.profileRowId ? (
                      <p className={cn('mt-3 inline-flex items-center gap-1.5 text-xs', ACCENT.text)}>
                        <Lock className="size-3" aria-hidden />
                        {t('evolution.studio.v2.profiles.error')}
                      </p>
                    ) : null}
                  </SectionCard>

                  {/* Observed summary cards: workspaces / capabilities / credits.
                      All derived from the real /studio/profile payload; no
                      synthetic counts. */}
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    <StatCard
                      isDark={isDark}
                      theme={theme}
                      reduce={!!reduce}
                      icon={Building2}
                      label={t('evolution.studio.v2.groups.workspace')}
                      value={String(view.workspaces.length)}
                      caption={
                        view.workspaces.slice(0, 2).map((w) => w.name).join(' · ') ||
                        mainWorkspace ||
                        ''
                      }
                    />
                    <StatCard
                      isDark={isDark}
                      theme={theme}
                      reduce={!!reduce}
                      icon={Sparkles}
                      label={t('evolution.studio.v2.profiles.capabilities')}
                      value={String(view.capabilities.length)}
                      caption={
                        view.capabilities.slice(0, 2).join(' · ') ||
                        t('evolution.common.skills').toLowerCase()
                      }
                    />
                    {view.credits ? (
                      <StatCard
                        isDark={isDark}
                        theme={theme}
                        reduce={!!reduce}
                        icon={Wallet}
                        label={t('evolution.studio.v2.profiles.credits')}
                        value={Math.round(view.credits.balance).toLocaleString()}
                        caption={t('evolution.studio.v2.profiles.credits').toLowerCase()}
                      />
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

// ── Small presentational helpers (rose grammar, design tokens, no bare strings) ──

function SectionCard({
  isDark,
  theme,
  children,
}: {
  isDark: boolean;
  theme: 'dark' | 'light';
  children: React.ReactNode;
}) {
  void isDark;
  return <div className={cn('border p-5', radius.card, s(theme, 'card'))}>{children}</div>;
}

function InlineNotice({
  isDark,
  theme,
  text,
}: {
  isDark: boolean;
  theme: 'dark' | 'light';
  text: string;
}) {
  return (
    <div className={cn('border p-5 text-sm', radius.card, s(theme, 'card'), isDark ? 'text-zinc-400' : 'text-zinc-600')}>
      {text}
    </div>
  );
}

/** "Observed / read-only" provenance marker for non-editable blocks. */
function ObservedTag({
  isDark,
  label,
  compact = false,
}: {
  isDark: boolean;
  label: string;
  compact?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium',
        compact ? 'text-[10px]' : 'text-xs',
        isDark ? 'border-zinc-700 text-zinc-500' : 'border-zinc-300 text-zinc-500',
      )}
    >
      {compact ? <Eye className="size-3" aria-hidden /> : <Lock className="size-3" aria-hidden />}
      {label}
    </span>
  );
}

function StatCard({
  isDark,
  theme,
  reduce,
  icon: Icon,
  label,
  value,
  caption,
}: {
  isDark: boolean;
  theme: 'dark' | 'light';
  reduce: boolean;
  icon: LucideIcon;
  label: string;
  value: string;
  caption: string;
}) {
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={springSoft}
      className={cn('border p-4', radius.card, s(theme, 'card'))}
    >
      <div className="mb-2 flex items-center gap-2">
        <Icon className={cn('size-4', ACCENT.text)} aria-hidden />
        <span className={cn('text-xs font-semibold uppercase tracking-wider', isDark ? 'text-zinc-400' : 'text-zinc-500')}>
          {label}
        </span>
        <Eye className={cn('ml-auto size-3', isDark ? 'text-zinc-600' : 'text-zinc-400')} aria-hidden />
      </div>
      <p className={cn('truncate text-2xl font-bold tabular-nums', isDark ? 'text-zinc-50' : 'text-zinc-900')} title={value}>{value}</p>
      <p className={cn('truncate text-xs', isDark ? 'text-zinc-500' : 'text-zinc-500')} title={caption}>
        {caption}
      </p>
    </motion.div>
  );
}

function SaveButton({
  isDark,
  theme,
  state,
  canSave,
  isMock,
  noWorkspace,
  onSave,
  t,
}: {
  isDark: boolean;
  theme: 'dark' | 'light';
  state: SaveState;
  canSave: boolean;
  isMock: boolean;
  noWorkspace: boolean;
  onSave: () => void;
  t: (key: `evolution.${string}`, vars?: Record<string, string | number>) => string;
}) {
  // Honest disabled states: mock mode and missing profile row can't write live.
  const disabled = !canSave;
  let label: string;
  if (state === 'saving') label = t('evolution.studio.lifecycle.configure.saving');
  else if (state === 'error') label = t('evolution.studio.lifecycle.configure.saveFailed');
  else if (state === 'saved') label = t('evolution.common.saved');
  else label = t('evolution.studio.v2.installed.configureSave');

  const title = isMock
    ? t('evolution.studio.v2.states.offline', { ago: '—' })
    : noWorkspace
      ? t('evolution.studio.v2.profiles.error')
      : t('evolution.studio.v2.installed.configureSave');

  return (
    <button
      type="button"
      onClick={onSave}
      disabled={disabled}
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        s(theme, 'card'),
        disabled
          ? isDark
            ? 'cursor-not-allowed text-zinc-600'
            : 'cursor-not-allowed text-zinc-400'
          : cn(ACCENT.bg, ACCENT.text, 'hover:opacity-90'),
      )}
    >
      {state === 'error' ? (
        <Lock className="size-3" aria-hidden />
      ) : (
        <Pencil className="size-3" aria-hidden />
      )}
      {label}
    </button>
  );
}
