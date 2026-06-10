'use client';

/**
 * Evolution Studio v2 — shell (release201/28 §2 + §5.1).
 *
 * Top bar (crumb "Evolution › Studio · <section>" + agent context picker +
 * To Workspace) + left rail + section content area. Owns URL <-> section state
 * (query-string persisted via ./url so refresh / cross-device keeps context).
 * Mirrors the workspace `top-bar.tsx` / `left-rail.tsx` grid rhythm; uses
 * design.ts tokens + src/components/ui primitives only.
 *
 * The shared workspace/agent data is resolved ONCE here via
 * <StudioContextProvider> (real-first, mock fallback) and fanned out to every
 * surface via useStudioContext(). Section bodies are the stub surfaces under
 * ./<section>/; the P1-P5 surface agents replace each stub body without
 * touching this shell.
 *
 * Height: the shell fits the evolution page's tab-content viewport so the whole
 * page does not grow a vertical scrollbar (matching the Map tab's "fills the
 * fold" feel). The page chrome above the studio mount — the global navbar
 * (88px main padding) + the evolution page header + the 4-tab bar + page
 * vertical padding — totals ≈ 18rem, deducted from 100vh below. Each section
 * scrolls internally (overflow-y-auto), the shell itself never overflows.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, ChevronsUpDown, ExternalLink } from 'lucide-react';

import { radius, s } from '@/app/workspace/lib/design';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/contexts/i18n-context';
import { useTheme } from '@/contexts/theme-context';
import type { TranslationKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { CreatorSurface } from './creator/creator-surface';
import { StudioContextProvider, useStudioContext } from './data/use-studio-context';
import { GenesSurface } from './genes/genes-surface';
import { InstalledSurface } from './installed/installed-surface';
import { LifecycleSurface } from './lifecycle/lifecycle-surface';
import { ProfileSurface } from './profile/profile-surface';
import { RosterSurface } from './roster/roster-surface';
import { SnapshotsSurface } from './snapshots/snapshots-surface';
import { TemplatesSurface } from './templates/templates-surface';
import { StudioRail } from './studio-rail';
import { STUDIO_SECTIONS, type AgentSummary, type StudioSection } from './types';

const SECTION_CRUMB_KEY: Record<StudioSection, TranslationKey> = {
  roster: 'evolution.studio.v2.sections.roster',
  create: 'evolution.studio.v2.sections.create',
  lifecycle: 'evolution.studio.v2.sections.lifecycle',
  installed: 'evolution.studio.v2.sections.installed',
  genes: 'evolution.studio.v2.sections.genes',
  profiles: 'evolution.studio.v2.sections.profiles',
  snapshots: 'evolution.studio.v2.sections.snapshots',
  templates: 'evolution.studio.v2.sections.templates',
};

function isSection(v: string | null | undefined): v is StudioSection {
  return !!v && (STUDIO_SECTIONS as string[]).includes(v);
}

export interface StudioShellV2Props {
  /** Initial section (resolved by the caller via parseStudioUrl / normalizeLegacyView). */
  initialSection: StudioSection;
  initialAgentId?: string | null;
  initialDraftId?: string | null;
  /** Persist section change to the URL (page owns the router). */
  onSectionChange?: (section: StudioSection) => void;
  /** Persist agent change to the URL. */
  onAgentChange?: (agentId: string | null) => void;
  /** Navigate back to /workspace. */
  onToWorkspace?: () => void;
}

/**
 * Agent context picker — self-contained popover mirroring the workspace
 * `ProjectChip` (no @radix-ui). Lists every workspace agent from the shared
 * studio context; selecting one writes `?agentId=` so all per-agent surfaces
 * follow. Falls back to a static chip when there is 0 or 1 agent.
 */
function AgentContextPicker({
  isDark,
  agents,
  activeAgentId,
  onSelect,
}: {
  isDark: boolean;
  agents: AgentSummary[];
  activeAgentId: string | null;
  onSelect: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const active =
    agents.find((a) => a.id === activeAgentId) ?? agents.find((a) => a.isOrchestrator) ?? agents[0] ?? null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!active) return null;

  const initials = active.handle.replace(/^@/, '').slice(0, 2).toUpperCase();
  const multiple = agents.length > 1;

  const chip = (
    <>
      <span className="flex size-[22px] items-center justify-center rounded-[7px] bg-gradient-to-br from-[var(--grad-from)] to-[var(--grad-to)] text-[10px] font-bold text-white">
        {initials}
      </span>
      {active.handle}
      {multiple && <ChevronsUpDown className="size-3 opacity-60" aria-hidden />}
    </>
  );

  const chipClasses = cn(
    'ml-1.5 flex items-center gap-2 rounded-full border py-1 pl-1.5 pr-2.5 text-[12.5px] transition-colors',
    isDark ? 'border-white/10 text-zinc-300 hover:bg-white/[0.04]' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-500/5',
  );

  if (!multiple) {
    return (
      <span className={chipClasses} aria-label={active.handle}>
        {chip}
      </span>
    );
  }

  const panelClasses = isDark
    ? 'border-white/[0.08] bg-zinc-950/95 text-zinc-100 shadow-[0_18px_48px_-32px_rgba(0,0,0,0.85)]'
    : 'border-zinc-200 bg-white text-zinc-800 shadow-[0_18px_48px_-32px_rgba(0,0,0,0.18)]';

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('evolution.studio.v2.agentPicker.label')}
        className={chipClasses}
      >
        {chip}
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label={t('evolution.studio.v2.agentPicker.label')}
          className={cn('absolute left-0 top-full z-30 mt-1 w-[240px] overflow-y-auto py-1', radius.card, 'max-h-80 border', panelClasses)}
        >
          {agents.map((agent) => {
            const isActive = agent.id === active.id;
            const ini = agent.handle.replace(/^@/, '').slice(0, 2).toUpperCase();
            return (
              <button
                key={agent.id}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => {
                  onSelect(agent.id);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors',
                  isActive
                    ? isDark
                      ? 'bg-white/[0.06] text-zinc-100'
                      : 'bg-violet-50 text-violet-900'
                    : isDark
                      ? 'text-zinc-300 hover:bg-white/[0.04]'
                      : 'text-zinc-700 hover:bg-zinc-50',
                )}
              >
                <span className="flex size-[24px] shrink-0 items-center justify-center rounded-[7px] bg-gradient-to-br from-[var(--grad-from)] to-[var(--grad-to)] text-[10px] font-bold text-white">
                  {ini}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{agent.handle}</span>
                  <span className={cn('block truncate text-[11px]', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
                    {agent.type}
                  </span>
                </span>
                {isActive ? <Check className="size-3.5 shrink-0 text-[var(--prismer-primary)]" aria-hidden /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function StudioShellInner({
  initialSection,
  initialDraftId = null,
  onSectionChange,
  onToWorkspace,
}: Pick<StudioShellV2Props, 'initialSection' | 'initialDraftId' | 'onSectionChange' | 'onToWorkspace'>) {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const theme = isDark ? 'dark' : 'light';

  const { workspaceName, agents, agentId, setAgentId } = useStudioContext();

  // Controlled by the page: `section` derives straight from props. The page
  // persists section changes to the URL and re-derives on its next render, so
  // the single source of truth is the URL — no local mirror state.
  const section: StudioSection = isSection(initialSection) ? initialSection : 'roster';

  // Effective agent: URL-derived agentId, else orchestrator, else first.
  const effectiveAgentId =
    agentId ?? agents.find((a) => a.isOrchestrator)?.id ?? agents[0]?.id ?? null;

  const selectSection = useCallback(
    (next: StudioSection) => {
      onSectionChange?.(next);
    },
    [onSectionChange],
  );

  const selectAgent = useCallback(
    (next: string) => {
      setAgentId(next);
    },
    [setAgentId],
  );

  const counts: Partial<Record<StudioSection, number>> = {
    roster: agents.length,
  };

  const renderSection = () => {
    switch (section) {
      case 'create':
        return <CreatorSurface agentId={effectiveAgentId} draftId={initialDraftId} />;
      case 'roster':
        return <RosterSurface agentId={effectiveAgentId} onSelectAgent={selectAgent} />;
      case 'lifecycle':
        return <LifecycleSurface draftId={initialDraftId} />;
      case 'installed':
        return <InstalledSurface agentId={effectiveAgentId} />;
      case 'genes':
        return <GenesSurface agentId={effectiveAgentId} />;
      case 'profiles':
        return <ProfileSurface agentId={effectiveAgentId} />;
      case 'snapshots':
        return <SnapshotsSurface agentId={effectiveAgentId} />;
      case 'templates':
        return <TemplatesSurface agentId={effectiveAgentId} />;
      default:
        return <RosterSurface agentId={effectiveAgentId} onSelectAgent={selectAgent} />;
    }
  };

  // Layout architecture (feedback #3): a big recessed rounded frame WRAPS three
  // independent raised rounded cards — rail · top bar · content — separated by
  // gaps so they read as "floating" (外包上浮). No flat border-r / border-b
  // dividers (which produced the "rounded top, straight bottom" look).
  const cardCn = cn(radius.card, s(theme, 'card'), 'shadow-sm');

  return (
    <div
      className={cn(
        'flex h-[calc(100vh-18rem)] min-h-[560px] gap-2.5 p-2.5',
        'rounded-[26px]',
        s(theme, 'inset'),
      )}
    >
      <StudioRail
        activeSection={section}
        onSelect={selectSection}
        counts={counts}
        workspaceName={workspaceName}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {/* top bar — its own floating rounded card. `relative z-20` lifts its
            stacking context above the content card below (whose backdrop-blur
            creates its own context) so the agent picker dropdown is not occluded. */}
        <header className={cn('relative z-20 flex shrink-0 items-center gap-3.5 px-5 py-3', cardCn)}>
          <div className="flex min-w-0 items-center gap-2 text-[13px] text-zinc-500">
            <b className={cn('shrink-0 font-semibold', isDark ? 'text-zinc-100' : 'text-zinc-900')}>
              {t('evolution.studio.v2.title')}
            </b>
            <ChevronRight className="size-3.5 shrink-0 opacity-50" aria-hidden />
            <span className={cn('truncate', isDark ? 'text-zinc-300' : 'text-zinc-700')}>
              {t(SECTION_CRUMB_KEY[section])}
            </span>
          </div>

          <AgentContextPicker
            isDark={isDark}
            agents={agents}
            activeAgentId={effectiveAgentId}
            onSelect={selectAgent}
          />

          <div className="ml-auto flex items-center gap-2.5">
            <Button variant="outline" size="sm" onClick={onToWorkspace} className="gap-1.5">
              <ExternalLink className="size-3.5" aria-hidden />
              {t('evolution.studio.v2.toWorkspace')}
            </Button>
          </div>
        </header>

        {/* section content — its own floating rounded card; scrolls internally */}
        <main className={cn('relative min-h-0 flex-1 overflow-hidden', cardCn)}>{renderSection()}</main>
      </div>
    </div>
  );
}

export function StudioShellV2({
  initialSection,
  initialAgentId = null,
  initialDraftId = null,
  onSectionChange,
  onAgentChange,
  onToWorkspace,
}: StudioShellV2Props) {
  const handleAgentChange = useCallback(
    (next: string | null) => {
      onAgentChange?.(next);
    },
    [onAgentChange],
  );

  return (
    <StudioContextProvider agentId={initialAgentId} onAgentChange={handleAgentChange}>
      <StudioShellInner
        initialSection={initialSection}
        initialDraftId={initialDraftId}
        onSectionChange={onSectionChange}
        onToWorkspace={onToWorkspace}
      />
    </StudioContextProvider>
  );
}
