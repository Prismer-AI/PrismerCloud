'use client';

/**
 * Roster surface (release201/28 §4.1) — `spatialGrammar.map`, indigo.
 *
 * Workspace fleet home. Every agent renders as an identity card in a responsive
 * grid (orb avatar · handle · type · live state pill · 3 facet counts:
 * skills / genes / snapshots). Clicking a card sets `?agentId=` and jumps to the
 * agent's first per-agent face (Installed) via buildStudioUrl + router — quoting
 * the `map` grammar (6-zone canvas → here a card grid; force-float deferred to
 * v2.1 per doc 28 §4.1).
 *
 * Mirrors `card-shelf.tsx` grid/motion rhythm (springSoft + stagger) without
 * re-rolling its render-prop machinery, since each card is a bespoke identity
 * tile. Five states (empty / loading / error / gated / data) all rendered and
 * i18n-driven; dark/light via useTheme; motion gated by useReducedMotion.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import { Camera, Dna, Sparkles, Users } from 'lucide-react';

import {
  grammarAccentClasses,
  radius,
  s,
  springSnap,
  springSoft,
} from '@/app/workspace/lib/design';
import { useI18n } from '@/contexts/i18n-context';
import { useTheme } from '@/contexts/theme-context';
import { cn } from '@/lib/utils';

import { fetchInstalled, fetchStudioGenes, getJson } from '../../types';
import { useStudioContext } from '../data/use-studio-context';
import { SectionPlaceholder } from '../section-placeholder';
import {
  PER_AGENT_SECTIONS,
  SECTION_GRAMMAR,
  type AgentRuntimeState,
  type AgentSummary,
} from '../types';
import { buildStudioUrl } from '../url';

export interface RosterSurfaceProps {
  agentId: string | null;
  onSelectAgent: (agentId: string) => void;
}

/** First per-agent face a roster card click drills into (doc 28 §4.1). */
const ROSTER_TARGET_SECTION = PER_AGENT_SECTIONS[0] ?? 'installed';

const { accent, grammar } = SECTION_GRAMMAR.roster;

/** State pill colour family (doc 28 §4.1 — idle/thinking/busy live state). */
const STATE_PILL: Record<
  AgentRuntimeState,
  { dot: string; text: string; bg: string; pulse: boolean }
> = {
  idle: { dot: 'bg-zinc-400', text: 'text-zinc-500', bg: 'bg-zinc-500/10 border-zinc-500/20', pulse: false },
  thinking: { dot: 'bg-amber-400', text: 'text-amber-500', bg: 'bg-amber-500/10 border-amber-500/20', pulse: true },
  busy: { dot: 'bg-cyan-400', text: 'text-cyan-500', bg: 'bg-cyan-500/10 border-cyan-500/20', pulse: true },
  offline: { dot: 'bg-zinc-500', text: 'text-zinc-500', bg: 'bg-zinc-500/10 border-zinc-500/20', pulse: false },
};

// NOTE: there is no registered i18n key set for the agent runtime-state words
// (idle / thinking / busy / offline) under `evolution.studio.v2.*`, and the
// task bars editing i18n.ts. So the live-state pill is rendered DOT-ONLY (colour
// + pulse encode the state, the prototype's coloured pill), with no untranslated
// label. The accessible name reuses the registered roster hint context. See the
// i18n gap reported back to the dispatcher.
function StatePill({ state }: { state: AgentRuntimeState }) {
  const reduce = useReducedMotion();
  const p = STATE_PILL[state];
  return (
    <span
      className={cn(
        'ml-auto inline-flex items-center justify-center rounded-full border p-1.5',
        p.bg,
      )}
    >
      <motion.span
        className={cn('size-2 rounded-full', p.dot)}
        aria-hidden
        animate={p.pulse && !reduce ? { opacity: [1, 0.35, 1] } : { opacity: 1 }}
        transition={p.pulse && !reduce ? { duration: 1.6, repeat: Infinity, ease: 'easeInOut' } : undefined}
      />
    </span>
  );
}

function Facet({
  icon: Icon,
  value,
  label,
  isDark,
}: {
  icon: typeof Sparkles;
  value: number;
  label: string;
  isDark: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 border px-2 py-1 text-[11.5px]',
        radius.small,
        isDark ? 'border-white/[0.06] bg-white/[0.02] text-zinc-400' : 'border-zinc-200 bg-zinc-50/80 text-zinc-600',
      )}
    >
      <Icon className="size-3 opacity-70" aria-hidden />
      <b className={cn('font-semibold', isDark ? 'text-zinc-100' : 'text-zinc-900')}>{value}</b>
      {label}
    </span>
  );
}

function AgentCard({
  agent,
  index,
  isDark,
  theme,
  active,
  reduce,
  onOpen,
  facetLabels,
  facets,
}: {
  agent: AgentSummary;
  index: number;
  isDark: boolean;
  theme: 'dark' | 'light';
  active: boolean;
  reduce: boolean;
  onOpen: () => void;
  facetLabels: { skills: string; genes: string; snapshots: string };
  facets?: { skills: number; genes: number; snapshots: number };
}) {
  const a = grammarAccentClasses[accent];
  const initials = agent.handle.replace(/^@/, '').slice(0, 2).toUpperCase();

  return (
    <motion.button
      type="button"
      onClick={onOpen}
      initial={reduce ? false : { opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={reduce ? { duration: 0 } : { ...springSoft, delay: index * 0.05 }}
      whileHover={reduce ? undefined : { y: -3, transition: springSnap }}
      className={cn(
        'group flex flex-col gap-4 border p-5 text-left transition-colors',
        radius.card,
        s(theme, 'card'),
        active ? cn('ring-1', a.ring) : isDark ? 'hover:border-white/15' : 'hover:border-zinc-300',
      )}
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'flex size-[46px] items-center justify-center text-[15px] font-bold text-white',
            radius.small,
            'bg-gradient-to-br from-[var(--grad-from)] to-[var(--grad-to)] shadow-lg',
          )}
          aria-hidden
        >
          {initials}
        </span>
        <div className="min-w-0">
          <div className={cn('truncate text-[15px] font-semibold', isDark ? 'text-zinc-100' : 'text-zinc-900')}>
            {agent.handle}
          </div>
          <div className={cn('truncate text-xs', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
            {agent.type}
          </div>
        </div>
        <StatePill state={agent.state} />
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Facet icon={Sparkles} value={facets?.skills ?? agent.skills} label={facetLabels.skills} isDark={isDark} />
        <Facet icon={Dna} value={facets?.genes ?? agent.genes} label={facetLabels.genes} isDark={isDark} />
        <Facet icon={Camera} value={facets?.snapshots ?? agent.snapshots} label={facetLabels.snapshots} isDark={isDark} />
      </div>
    </motion.button>
  );
}

type RosterPhase = 'data' | 'loading' | 'error' | 'empty' | 'gated';

export function RosterSurface({ agentId, onSelectAgent }: RosterSurfaceProps) {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const reduce = useReducedMotion();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isDark = resolvedTheme === 'dark';
  const theme = isDark ? 'dark' : 'light';

  // Real-first via the shared studio context (resolved once in the shell):
  // authed + non-empty → live agents; STUDIO_MOCK_ENABLED + unavailable → mock
  // fixtures (the context handles that fallback). `phase` derives from the
  // context's loading / error / data signals.
  const { agents: ctxAgents, loading, error } = useStudioContext();
  const agents = useMemo<AgentSummary[]>(() => ctxAgents, [ctxAgents]);
  const phase: RosterPhase = error ? 'error' : loading ? 'loading' : agents.length === 0 ? 'empty' : 'data';

  // Real per-agent facet counts (skills / genes / snapshots). The shared
  // /studio/installed roster payload does NOT carry per-agent counts, so the
  // context hands every card 0 — which read as "no data came through" (feedback).
  // Fetch the real counts per agent in parallel (small N) and merge them in;
  // each source is defensive (404 / forbidden → keep 0, never fabricate).
  const agentIdsKey = useMemo(() => agents.map((a) => a.id).join(','), [agents]);
  const [counts, setCounts] = useState<Record<string, { skills: number; genes: number; snapshots: number }>>({});
  useEffect(() => {
    if (agents.length === 0) return;
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        agents.map(async (a) => {
          const [inst, genes, snaps] = await Promise.all([
            fetchInstalled(a.id).catch(() => null),
            fetchStudioGenes(a.id).catch(() => null),
            getJson<{ snapshots?: unknown[] } | unknown[]>(
              `/api/im/agents/${encodeURIComponent(a.id)}/snapshots`,
            ).catch(() => null),
          ]);
          const snapArr = Array.isArray(snaps) ? snaps : (snaps?.snapshots ?? []);
          return [
            a.id,
            {
              skills: inst?.skills?.length ?? a.skills ?? 0,
              genes: genes?.genes?.length ?? a.genes ?? 0,
              snapshots: snapArr.length || (a.snapshots ?? 0),
            },
          ] as const;
        }),
      );
      if (!cancelled) setCounts(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentIdsKey]);

  const facetLabels = useMemo(
    () => ({
      skills: t('evolution.studio.v2.sections.installed').toLowerCase(),
      genes: t('evolution.studio.v2.sections.genes').toLowerCase(),
      snapshots: t('evolution.studio.v2.sections.snapshots').toLowerCase(),
    }),
    [t],
  );

  const openAgent = (id: string) => {
    // Quote the map grammar's drill: set ?agentId= AND jump to the agent's first
    // per-agent face. Single router.replace is authoritative (the page derives
    // section + agentId from the URL), so we do not also fire onSelectAgent and
    // race two writes. onSelectAgent stays in the props contract for the shell.
    void onSelectAgent;
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    const studio = buildStudioUrl(ROSTER_TARGET_SECTION, { agentId: id });
    // Preserve unrelated params (e.g. theme) the page may carry.
    for (const [k, v] of new URLSearchParams(studio)) params.set(k, v);
    params.delete('view');
    params.delete('subview');
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  if (phase !== 'data' || agents.length === 0) {
    const key = phase === 'data' ? 'empty' : phase;
    return (
      <SectionPlaceholder
        section="roster"
        icon={Users}
        titleKey="evolution.studio.v2.roster.title"
        hintKey={`evolution.studio.v2.roster.${key}` as `evolution.${string}`}
      />
    );
  }

  return (
    <div className="flex h-full flex-col gap-5 px-6 py-6">
      {/* grammar header — quotes `map` (indigo) so the chromatic identity reads */}
      <div className="flex items-start gap-3">
        <div className="min-w-0">
          <h2 className={cn('text-lg font-semibold', isDark ? 'text-zinc-100' : 'text-zinc-900')}>
            {t('evolution.studio.v2.roster.title')}
          </h2>
          <p className={cn('mt-0.5 max-w-2xl text-sm', isDark ? 'text-zinc-400' : 'text-zinc-600')}>
            {t('evolution.studio.v2.roster.hint')}
          </p>
        </div>
        <span
          className={cn(
            'ml-auto inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium',
            grammarAccentClasses[accent].bg,
            grammarAccentClasses[accent].text,
          )}
        >
          <span className={cn('size-1.5 rounded-full', grammarAccentClasses[accent].dot)} aria-hidden />
          {grammar}
        </span>
      </div>

      <div className="grid min-h-0 flex-1 content-start gap-4 overflow-auto sm:grid-cols-2 xl:grid-cols-3">
        {agents.map((agent, i) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            index={i}
            isDark={isDark}
            theme={theme}
            active={agent.id === agentId}
            reduce={!!reduce}
            onOpen={() => openAgent(agent.id)}
            facetLabels={facetLabels}
            facets={counts[agent.id]}
          />
        ))}
      </div>
    </div>
  );
}
