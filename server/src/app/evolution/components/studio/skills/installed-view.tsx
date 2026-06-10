'use client';

/**
 * Skills · Installed sub-tab — release201/13 §3.4 (S22).
 *
 * Per-agent installed skill list with Configure modal (dynamic form from
 * IMSkill.executableJson.configSchema). Mirrors the MyAgentsView Installed
 * section but adds:
 *   - Configure button → opens dynamic config dialog (PATCH endpoint)
 *   - Uninstall confirm (already in MyAgentsView; re-stated here for sub-tab)
 *   - Agent selector when the workspace has multiple agents
 *
 * Auth: GET /api/im/studio/installed?agentId= → list of installed skills
 *       PATCH /api/im/agents/:agentId/skills/:skillId → update config
 */

import { useCallback, useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Loader2, Package } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useI18n } from '@/contexts/i18n-context';
import { glass } from '../../helpers';
import { ConfigureModal } from '../lifecycle/configure-modal';
import { type InstalledSkill, fetchInstalled, uninstallSkill } from '../types';
import { grammarAccentClasses, motionPreset, motionReduced, spatialGrammar } from '@/app/workspace/lib/design';
import { FlippableChip } from './flippable-chip';

interface InstalledViewProps {
  isDark: boolean;
  agentId: string | null;
  onAgentChange: (id: string | null) => void;
}

export function InstalledView({ isDark, agentId, onAgentChange }: InstalledViewProps) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<InstalledSkill[]>([]);
  const [agents, setAgents] = useState<Array<{ agentId: string; displayName: string }>>([]);
  const [resolvedAgentId, setResolvedAgentId] = useState<string | null>(agentId);
  const [loading, setLoading] = useState(true);
  const [pendingUninstall, setPendingUninstall] = useState<InstalledSkill | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [configuringSkill, setConfiguringSkill] = useState<InstalledSkill | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchInstalled(agentId);
    setSkills(data?.skills ?? []);
    // BFF returns the active agent + agent list; we keep the parent in sync
    // so URL state can persist `agentId`.
    if (data?.activeAgentId && data.activeAgentId !== agentId) {
      onAgentChange(data.activeAgentId);
    }
    setResolvedAgentId(data?.activeAgentId ?? agentId);
    setAgents(data?.agents ?? []);
    setLoading(false);
  }, [agentId, onAgentChange]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const confirmUninstall = async () => {
    if (!pendingUninstall || !resolvedAgentId) return;
    setActionBusy(pendingUninstall.skillId);
    const ok = await uninstallSkill(resolvedAgentId, pendingUninstall.skillId);
    setActionBusy(null);
    setPendingUninstall(null);
    if (ok) await reload();
  };

  // ── Shelf grammar (doc 13 §3.4 — agent row × chip array) ──
  const grammar = spatialGrammar.shelf;
  const accent = grammarAccentClasses[grammar.accentColor];
  const prefersReducedMotion = useReducedMotion();
  const pickMotion = prefersReducedMotion ? motionReduced : motionPreset.pickFromShelf;

  return (
    <>
      <div data-spatial-grammar="shelf" data-grammar-accent={grammar.accentColor} className={grammar.layout}>
        <div className={`flex items-center justify-between gap-2 rounded-2xl border px-4 py-3 backdrop-blur-md ${accent.bg}`}>
          <div className="min-w-0">
            <p className={`text-[10px] font-semibold uppercase tracking-wider ${accent.text}`}>
              {t('evolution.studio.skills.installed.shelfLabel')}
            </p>
            <p className={`mt-0.5 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              {t('evolution.studio.skills.installed.shelfHint')}
            </p>
          </div>
          {agents.length > 1 && (
            <select
              value={resolvedAgentId ?? ''}
              onChange={(e) => onAgentChange(e.target.value || null)}
              data-testid="installed-agent-selector"
              className={`min-w-0 max-w-[200px] rounded-md border px-2 py-1.5 text-xs ${
                isDark ? 'border-white/[0.06] bg-white/[0.04] text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
              }`}
            >
              {agents.map((a) => (
                <option key={a.agentId} value={a.agentId}>
                  {a.displayName}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Shelf — one agent row with a horizontal scroll chip array */}
        <div
          data-pane="agent-row"
          data-testid="installed-shelf"
          className={`rounded-2xl border ring-1 ${glass(isDark, 'base')} ${accent.ring}`}
        >
          <div
            className={`flex items-center gap-3 border-b px-5 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
          >
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ${accent.bg}`}
              aria-hidden
            >
              <Package className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                {agents.find((a) => a.agentId === resolvedAgentId)?.displayName ??
                  t('evolution.studio.skills.installed.agent')}
              </p>
              <p className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                {!loading && skills.length > 0
                  ? t('evolution.studio.skills.installed.chipsCount', { count: skills.length })
                  : t('evolution.studio.skills.installed.beltEmpty')}
              </p>
            </div>
          </div>

          {loading ? (
            <div className={`px-5 py-6 text-center text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              <Loader2 className="mx-auto h-4 w-4 animate-spin" />
            </div>
          ) : skills.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <p className={`animate-idle-breathing text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                {t('evolution.studio.myAgents.noInstalledTitle')}
              </p>
              <p className={`mt-1 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                {t('evolution.studio.skills.installed.noInstalledBody')}
              </p>
            </div>
          ) : (
            <ul
              data-pane="belt"
              className="flex flex-wrap gap-2 px-5 py-4"
              aria-label={t('evolution.studio.skills.installed.shelfLabel')}
            >
              {skills.map((skill) => (
                <motion.li
                  key={skill.skillId}
                  initial={pickMotion.initial}
                  animate={pickMotion.animate}
                  transition={pickMotion.transition}
                  whileHover={prefersReducedMotion ? undefined : { y: -2 }}
                  className="transition-colors"
                >
                  <FlippableChip
                    isDark={isDark}
                    skill={skill}
                    accentDot={accent.dot}
                    flipped={configuringSkill?.skillId === skill.skillId}
                    actionBusy={actionBusy === skill.skillId}
                    onConfigureClick={() => setConfiguringSkill(skill)}
                    onUninstallClick={() => setPendingUninstall(skill)}
                    onCancelFlip={() => setConfiguringSkill(null)}
                    statusBadge={<SkillStatusBadge status={skill.status} />}
                  />
                </motion.li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <AlertDialog
        open={pendingUninstall !== null}
        onOpenChange={(open) => {
          if (!open) setPendingUninstall(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('evolution.studio.myAgents.uninstallTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('evolution.studio.myAgents.uninstallDescriptionThisAgent', {
                skill: pendingUninstall?.name ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmUninstall()}>
              {t('evolution.common.uninstall')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ConfigureModal
        isDark={isDark}
        open={configuringSkill !== null}
        onOpenChange={(open) => {
          if (!open) setConfiguringSkill(null);
        }}
        agentId={resolvedAgentId}
        skillId={configuringSkill?.skillId ?? null}
        skillName={configuringSkill?.name ?? null}
        onSaved={() => {
          setConfiguringSkill(null);
          void reload();
        }}
      />
    </>
  );
}

function SkillStatusBadge({ status }: { status: string }) {
  if (status === 'active') return null;
  const variant = status === 'needs-sync' ? 'secondary' : 'destructive';
  return (
    <Badge variant={variant} className="text-[10px] uppercase tracking-wider">
      {status}
    </Badge>
  );
}
