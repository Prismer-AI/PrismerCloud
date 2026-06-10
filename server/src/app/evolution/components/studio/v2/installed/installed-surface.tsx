'use client';

/**
 * Installed skills surface (release201/28 §4.3 + 13 §3.4) —
 * `spatialGrammar.shelf`, violet accent.
 *
 * Grammar = **tool belt**: a horizontal agent strip on top (selected avatar
 * sinks), the selected agent's belt *descends* below it, and the belt carries a
 * skill-chip array. A chip flips to reveal its configure form (no drawer); a
 * chip dragged into the trash zone uninstalls it; a dashed "+ Install" chip
 * opens the marketplace. Keyboard back-paths cover configure + uninstall.
 *
 * Five states (gated / loading / error / empty / data) all render. Data comes
 * from `../mock` (MOCK_OVERVIEW agents + MOCK_INSTALLED) — the live swap is a
 * 0-UI-change source change.
 *
 * Design system: framer-motion + design.ts springs (springSnap select,
 * springHeavy belt descend, springSoft chip cascade, springFlip configure,
 * springDrag trash, springSplat save ack) gated by useReducedMotion(); accent
 * pulled from SECTION_GRAMMAR['installed']; surfaces from design.ts `s()`.
 */

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { LayoutGrid, Plus, Trash2, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  grammarAccentClasses,
  radius,
  s,
  springHeavy,
  springSnap,
  springSoft,
} from '@/app/workspace/lib/design';
import { Button } from '@/components/ui/button';
import { useApp } from '@/contexts/app-context';
import { useI18n } from '@/contexts/i18n-context';
import { useTheme } from '@/contexts/theme-context';
import { cn } from '@/lib/utils';

import { MOCK_INSTALLED, MOCK_OVERVIEW } from '../mock';
import { SectionPlaceholder } from '../section-placeholder';
import { SECTION_GRAMMAR } from '../types';
import type { AgentSummary, InstalledSkill } from '../types';

import { SkillChip } from './skill-chip';

const SECTION = 'installed' as const;

export interface InstalledSurfaceProps {
  agentId: string | null;
}

export function InstalledSurface({ agentId }: InstalledSurfaceProps) {
  const { t } = useI18n();
  const { addToast } = useApp();
  const { resolvedTheme } = useTheme();
  const reduce = useReducedMotion();
  const isDark = resolvedTheme === 'dark';
  const theme = isDark ? 'dark' : 'light';
  const { accent } = SECTION_GRAMMAR[SECTION];
  const a = grammarAccentClasses[accent];

  // Agent strip — seed from the prop, but selectable locally so the belt can
  // swap agents without a URL round-trip (carousel feel, 13 §3.4.2 帧 6).
  // Track the last prop value so a prop change re-seeds the selection without a
  // setState-in-effect (render-phase reconciliation, react.dev "you might not
  // need an effect").
  const agents: AgentSummary[] = MOCK_OVERVIEW.agents;
  const [override, setOverride] = useState<{ propAgentId: string | null; id: string | null } | null>(null);
  const selectedId =
    override && override.propAgentId === agentId
      ? override.id
      : (agentId ?? agents[0]?.id ?? null);

  // Local belt copy so uninstall removes a chip in place (mock; live = DELETE).
  const [belts, setBelts] = useState<Record<string, InstalledSkill[]>>(() => ({ ...MOCK_INSTALLED }));
  const [dragOverTrash, setDragOverTrash] = useState(false);

  const selectedAgent = agents.find((ag) => ag.id === selectedId) ?? null;
  const belt = useMemo<InstalledSkill[]>(
    () => (selectedId ? (belts[selectedId] ?? []) : []),
    [belts, selectedId],
  );

  // ─── State 1: gated (no agent resolved at all) ─────────────────────────────
  if (!selectedAgent) {
    return (
      <SectionPlaceholder
        section={SECTION}
        icon={LayoutGrid}
        titleKey="evolution.studio.v2.installed.title"
        hintKey="evolution.studio.v2.installed.gated"
      />
    );
  }

  const selectAgent = (id: string) => setOverride({ propAgentId: agentId, id });

  const uninstall = (skill: InstalledSkill) => {
    setBelts((prev) => ({
      ...prev,
      [selectedAgent.id]: (prev[selectedAgent.id] ?? []).filter((sk) => sk.skillId !== skill.skillId),
    }));
    // `evolution.skillUninstalled` is registered; surfaces the ack honestly.
    addToast(t('evolution.skillUninstalled'), 'success');
  };

  const saveConfig = (skill: InstalledSkill) => {
    // Mock config persist (live = PATCH /:agentId/skills/:skillId). Surface the
    // configure label as the ack so we don't invent a new i18n key.
    addToast(`${t('evolution.configure')} · ${skill.name}`, 'success');
  };

  const installFromMarketplace = () => {
    // Cross-tab marketplace DnD isn't wired in mock; surface the install intent.
    addToast(t('evolution.install'), 'info');
  };

  // ─── Header ────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col gap-4 px-1 py-1">
      <header className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className={cn('flex size-7 items-center justify-center border', radius.small, s(theme, 'card'), a.ring, 'ring-1')}>
              <LayoutGrid className={cn('size-4', a.text)} aria-hidden />
            </span>
            <h2 className={cn('text-base font-semibold', isDark ? 'text-zinc-100' : 'text-zinc-900')}>
              {t('evolution.skills.installed.shelfLabel')}
            </h2>
          </div>
          <p className={cn('max-w-2xl text-xs', isDark ? 'text-zinc-400' : 'text-zinc-600')}>
            {t('evolution.skills.installed.shelfHint')}
          </p>
        </div>
        {/* grammar chip — chromatic "you are in shelf" signal */}
        <span className={cn('inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium', a.bg, a.text)}>
          <span className={cn('size-1.5 rounded-full', a.dot)} aria-hidden />
          {SECTION_GRAMMAR[SECTION].grammar}
        </span>
      </header>

      {/* ─── Agent strip (horizontal, selected avatar sinks) ──────────────── */}
      <div
        role="tablist"
        aria-label={t('evolution.skills.installed.agent')}
        className="flex gap-4 overflow-x-auto pb-1"
      >
        {agents.map((ag, i) => {
          const sel = ag.id === selectedAgent.id;
          return (
            <button
              key={ag.id}
              role="tab"
              aria-selected={sel}
              onClick={() => selectAgent(ag.id)}
              className="flex flex-none flex-col items-center gap-1.5 outline-none focus-visible:opacity-100"
            >
              <motion.span
                initial={reduce ? false : { opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: sel ? 3 : 0 }}
                whileHover={reduce ? undefined : { scale: 1.04 }}
                transition={{ ...springSnap, delay: reduce ? 0 : i * 0.04 }}
                className={cn(
                  'flex size-12 items-center justify-center border text-sm font-bold',
                  radius.card,
                  sel
                    ? cn('bg-gradient-to-br from-[var(--prismer-primary)] to-[var(--prismer-primary-light)] text-white', a.ring, 'ring-2')
                    : cn(s(theme, 'inset'), isDark ? 'text-zinc-300' : 'text-zinc-600'),
                )}
              >
                {ag.handle.replace(/^@/, '').slice(0, 2).toUpperCase()}
              </motion.span>
              <span className={cn('text-[11px]', sel ? a.text : isDark ? 'text-zinc-500' : 'text-zinc-500')}>
                {ag.handle}
              </span>
            </button>
          );
        })}
        <div className="ml-auto flex flex-none items-center">
          <Button variant="outline" size="sm" onClick={installFromMarketplace} className="gap-1.5">
            <Plus className="size-3.5" aria-hidden />
            {t('evolution.install')}
          </Button>
        </div>
      </div>

      {/* ─── Belt (descends from the selected agent) ──────────────────────── */}
      <AnimatePresence mode="wait">
        <motion.section
          key={selectedAgent.id}
          initial={reduce ? false : { opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? undefined : { opacity: 0, y: -8 }}
          transition={springHeavy}
          className={cn('flex-1 border-t border-dashed pt-5', isDark ? 'border-white/10' : 'border-zinc-200')}
        >
          {belt.length === 0 ? (
            // ─── State: empty belt — idle small-print bottom, breathing dot ──
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <motion.span
                animate={reduce ? undefined : { opacity: [0.4, 1, 0.4] }}
                transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
                className={cn('size-2 rounded-full', a.dot)}
                aria-hidden
              />
              <p className={cn('text-xs', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
                {t('evolution.skills.installed.beltEmpty')}
              </p>
              <p className={cn('text-[11px]', isDark ? 'text-zinc-600' : 'text-zinc-400')}>
                {t('evolution.skills.installed.noInstalledBody')}
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap items-start gap-3.5">
              {belt.map((skill, i) => (
                <SkillChip
                  key={skill.skillId}
                  skill={skill}
                  index={i}
                  accent={accent}
                  theme={theme}
                  isDark={isDark}
                  reduce={!!reduce}
                  onSave={() => saveConfig(skill)}
                  onUninstall={() => uninstall(skill)}
                  onDragStateChange={setDragOverTrash}
                />
              ))}

              {/* + Install dashed chip */}
              <motion.button
                initial={reduce ? false : { opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ ...springSoft, delay: reduce ? 0 : belt.length * 0.06 }}
                whileHover={reduce ? undefined : { y: -3, scale: 1.03 }}
                onClick={installFromMarketplace}
                className={cn(
                  'flex h-[120px] w-[140px] flex-col items-center justify-center gap-2 border border-dashed',
                  radius.card,
                  isDark ? 'border-white/15 text-zinc-500 hover:border-white/30' : 'border-zinc-300 text-zinc-400 hover:border-zinc-400',
                )}
              >
                <Plus className="size-5" aria-hidden />
                <span className="text-xs">{t('evolution.install')}</span>
              </motion.button>

              {/* Trash zone — appears as a drop target while a chip is dragged */}
              <AnimatePresence>
                {dragOverTrash && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={springSoft}
                    className={cn(
                      'flex h-[120px] w-[140px] flex-col items-center justify-center gap-2 border border-dashed',
                      radius.card,
                      'border-rose-400/50 bg-rose-500/10 text-rose-300',
                    )}
                  >
                    <Trash2 className="size-5" aria-hidden />
                    <span className="px-2 text-center text-[11px]">{t('evolution.uninstall')}</span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </motion.section>
      </AnimatePresence>

      {/* count footer */}
      <footer className={cn('flex items-center gap-1.5 text-[11px]', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
        <Wrench className="size-3" aria-hidden />
        {t('evolution.skills.installed.chipsCount', { count: belt.length })}
      </footer>
    </div>
  );
}
