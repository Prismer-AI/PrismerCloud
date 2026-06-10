'use client';

/**
 * Studio "My agents" — collapsed Profile + Installed views.
 *
 * One screen owns:
 *   1. Header — agent display name, type chip, status dot
 *   2. Personality / Operating principles
 *   3. Installed skills table with Configure / Uninstall row actions
 *
 * Uses shadcn `Badge` / `Button` / `AlertDialog` primitives and evolution
 * `glass()` surface tokens — the only ad-hoc styling is the personality
 * progress bar which has no shared primitive.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Loader2, Package, Settings2, Trash2, UserCircle2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { SiriOrb } from '@/components/ui/siri-orb';
import { useI18n } from '@/contexts/i18n-context';
import { glass } from '../helpers';
import {
  type AgentIdentity,
  type AgentPersonality,
  type InstalledSkill,
  fetchInstalled,
  fetchProfile,
  localizedTimeAgo,
  uninstallSkill,
} from './types';
import { grammarAccentClasses, motionPreset, motionReduced, spatialGrammar } from '@/app/workspace/lib/design';

/**
 * Subset of /api/im/studio/installed.agents[] consumed by the view.
 *
 * Y3 fix (2026-05-28): studio-tab already fetches this list (X2 fix) to derive
 * `hasAgent` for onboarding; we re-use it as the fallback source of truth when
 * the caller has no own agent identity (human orchestrator viewing a workspace
 * with bound agents).
 */
export interface WorkspaceAgentSummary {
  agentId: string;
  displayName: string;
}

interface MyAgentsViewProps {
  isDark: boolean;
  agentId: string | null;
  onAgentChange: (id: string | null) => void;
  onHasAgentChange: (has: boolean) => void;
  onHasInstalledChange: (has: boolean) => void;
  /**
   * Workspace agents discovered by studio-tab (parent). When the caller's own
   * `fetchProfile` returns identity=null (e.g. human orchestrator), we fall
   * back to `workspaceAgents[0]` so the view shows that agent's IdentityCard
   * instead of NoAgentCard. Optional for callers that don't have the list
   * (e.g. unit tests for spatial grammar).
   */
  workspaceAgents?: WorkspaceAgentSummary[];
}

export function MyAgentsView({
  isDark,
  agentId,
  onAgentChange,
  onHasAgentChange,
  onHasInstalledChange,
  workspaceAgents: workspaceAgentsProp,
}: MyAgentsViewProps) {
  const { t } = useI18n();
  // Y3: stabilise the list by content so the reload callback identity doesn't
  // churn when the parent re-renders with a fresh array literal (e.g. an
  // unrelated state change in studio-tab would otherwise re-trigger our
  // useEffect → infinite loading loop). Key on a string join of agent ids.
  const workspaceAgentsKey = workspaceAgentsProp ? workspaceAgentsProp.map((a) => a.agentId).join('|') : '';
  const workspaceAgents = useMemo(
    () => workspaceAgentsProp ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceAgentsKey],
  );
  const [identity, setIdentity] = useState<AgentIdentity | null>(null);
  const [personality, setPersonality] = useState<AgentPersonality | null>(null);
  const [skills, setSkills] = useState<InstalledSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingUninstall, setPendingUninstall] = useState<InstalledSkill | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  // ── Identity-card grammar (doc 13 §3.5 — siri-orb + card-stack) ──
  // Hooks must run unconditionally before any early-return branch.
  const grammar = spatialGrammar.identityCard;
  const accent = grammarAccentClasses[grammar.accentColor];
  const prefersReducedMotion = useReducedMotion();

  const reload = useCallback(async () => {
    setLoading(true);
    let effectiveAgentId: string | null = agentId;
    let profile = await fetchProfile(effectiveAgentId);

    // Y3 fix (release201 v2.0.8, 2026-05-28): human callers have no own
    // identity (`fetchProfile(null)` → identity=null), but the workspace
    // they're inspecting may have bound agents. Before this fallback we
    // rendered <NoAgentCard> for every human user, regardless of how many
    // agents the workspace had — the user-facing bug was "我的 Agent" tab
    // showing "还没有配对 Agent" even though Devices already paired CEO /
    // Eng / Mkt.
    //
    // Source of truth for the fallback agent: studio-tab's `workspaceAgents`
    // prop (sourced from /api/im/studio/installed.agents, which is itself
    // the same list X2 introduced for onboarding). When the caller did NOT
    // already pick an agentId AND has no identity of their own, default to
    // workspaceAgents[0] and re-query its profile for the real identity
    // card. Empty workspaceAgents → NoAgentCard still renders (correct).
    if (!profile?.identity?.agentId && !agentId && workspaceAgents.length > 0) {
      effectiveAgentId = workspaceAgents[0].agentId;
      profile = await fetchProfile(effectiveAgentId);
      if (profile?.identity?.agentId) {
        onAgentChange(profile.identity.agentId);
      }
    } else if (profile?.identity?.agentId && !agentId) {
      onAgentChange(profile.identity.agentId);
    }

    setIdentity(profile?.identity ?? null);
    setPersonality(profile?.personality ?? null);
    // X2 (release201 v2.0.8): do NOT flip parent's hasAgent based on
    // caller's own identity here. parent (studio-tab) derives hasAgent from
    // workspace-level /studio/installed.agents — overwriting with
    // profile?.identity erroneously sets hasAgent=false for human callers
    // (their identity.agentId is null even when the workspace has agents).
    // mutations that change workspace agent count happen elsewhere (pair
    // flow) and will re-trigger studio-tab's effect on next mount.

    const installed = await fetchInstalled(profile?.identity?.agentId ?? effectiveAgentId);
    setSkills(installed?.skills ?? []);
    onHasInstalledChange((installed?.skills?.length ?? 0) > 0);
    setLoading(false);
  }, [agentId, onAgentChange, onHasInstalledChange, workspaceAgents]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const confirmUninstall = async () => {
    if (!pendingUninstall || !identity?.agentId) return;
    setActionBusy(pendingUninstall.skillId);
    const ok = await uninstallSkill(identity.agentId, pendingUninstall.skillId);
    setActionBusy(null);
    setPendingUninstall(null);
    if (ok) await reload();
  };

  if (loading && !identity) {
    return (
      <div
        className={`flex items-center justify-center rounded-2xl p-8 text-xs ${glass(isDark, 'base')} ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
      >
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t('evolution.studio.myAgents.loading')}
      </div>
    );
  }

  if (!identity) {
    return <NoAgentCard isDark={isDark} />;
  }

  return (
    <>
      {/* release201/24 §UX — was a 40%/60% grid whose left 40% was a giant
          empty column with a floating orb (the "空腔" + width-misalignment
          the user flagged). Now: one full-width identity hero (orb anchored
          inline) + personality + installed all at the SAME width, aligned with
          the breadcrumb/onboarding above. */}
      <div data-spatial-grammar="identityCard" data-grammar-accent={grammar.accentColor} className="space-y-4">
        <IdentityHero
          isDark={isDark}
          identity={identity}
          accent={accent}
          reducedMotion={prefersReducedMotion ?? false}
        />
        {personality && <PersonalityCard isDark={isDark} personality={personality} accent={accent} />}
        <InstalledSkillsCard
          isDark={isDark}
          skills={skills}
          loading={loading}
          actionBusy={actionBusy}
          onUninstall={(s) => setPendingUninstall(s)}
          accent={accent}
        />
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
              {t('evolution.studio.myAgents.uninstallDescription', {
                skill: pendingUninstall?.name ?? '',
                agent: identity.displayName,
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
    </>
  );
}

// ─── Cards ────────────────────────────────────────────────────────────

function NoAgentCard({ isDark }: { isDark: boolean }) {
  const { t } = useI18n();
  return (
    <div className={`rounded-2xl p-8 text-center ${glass(isDark, 'base')}`}>
      <UserCircle2 className={`mx-auto mb-2 h-8 w-8 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />
      <p className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
        {t('evolution.studio.myAgents.noAgentTitle')}
      </p>
      <p className={`mt-1 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
        {t('evolution.studio.myAgents.noAgentBody')}
      </p>
    </div>
  );
}

type AccentClasses = (typeof grammarAccentClasses)[keyof typeof grammarAccentClasses];

function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return trimmed.slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * release201/24 §UX — full-width identity hero. Orb anchored inline on the
 * left (compact, breathing) with name / status / type / DID / capabilities on
 * the right. Replaces the old 40%-wide floating-orb column + separate identity
 * card (which produced the empty-column + width-misalignment).
 */
function IdentityHero({
  isDark,
  identity,
  accent,
  reducedMotion,
}: {
  isDark: boolean;
  identity: AgentIdentity;
  accent: AccentClasses;
  reducedMotion: boolean;
}) {
  const m = reducedMotion ? motionReduced : motionPreset.cardFlip;
  return (
    <motion.div
      key={`identity-${identity.agentId}`}
      initial={m.initial}
      animate={m.animate}
      transition={m.transition}
      style={{ transformPerspective: 1000 }}
      className={`flex items-center gap-5 rounded-2xl border p-5 ring-1 ${glass(isDark, 'elevated')} ${accent.ring}`}
    >
      {/* compact anchored orb */}
      <div className="relative shrink-0 animate-idle-breathing" data-testid="profile-siri-orb">
        <SiriOrb size="92px" />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="text-xl font-bold text-white" style={{ textShadow: '0 0 12px rgba(0,0,0,0.35)' }}>
            {initialsOf(identity.displayName)}
          </span>
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className={`truncate text-lg font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            {identity.displayName}
          </h3>
          <StatusDot status={identity.status} />
          <Badge variant="outline" className={`text-[10px] uppercase tracking-wider ${accent.text}`}>
            {identity.agentType}
          </Badge>
        </div>
        {identity.did && (
          <p className={`mt-1 truncate text-[11px] font-mono ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
            {identity.did}
          </p>
        )}
        {identity.capabilities.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {identity.capabilities.slice(0, 12).map((cap) => (
              <Badge key={cap} variant="secondary" className="font-mono text-[10px]">
                {cap}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function PersonalityCard({
  isDark,
  personality,
  accent,
}: {
  isDark: boolean;
  personality: AgentPersonality;
  accent: AccentClasses;
}) {
  const { t } = useI18n();
  return (
    <div className={`rounded-2xl border p-5 ring-1 ${glass(isDark, 'base')} ${accent.ring}`}>
      <h4
        className={`mb-3 text-xs font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
      >
        {t('evolution.studio.myAgents.personality')}
      </h4>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Bar label={t('evolution.studio.myAgents.rigor')} value={personality.rigor} isDark={isDark} />
        <Bar label={t('evolution.studio.myAgents.creativity')} value={personality.creativity} isDark={isDark} />
        <Bar label={t('evolution.studio.myAgents.riskTolerance')} value={personality.risk_tolerance} isDark={isDark} />
      </div>
      {personality.soul && (
        <div
          className={`mt-4 rounded-xl border p-3 ${
            isDark ? 'border-white/[0.04] bg-white/[0.02]' : 'border-zinc-200 bg-zinc-50'
          }`}
        >
          <p className={`mb-1.5 text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {t('evolution.studio.myAgents.operatingPrinciples')}
          </p>
          <p className={`whitespace-pre-wrap text-xs leading-relaxed ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
            {personality.soul}
          </p>
        </div>
      )}
    </div>
  );
}

function InstalledSkillsCard({
  isDark,
  skills,
  loading,
  actionBusy,
  onUninstall,
  accent,
}: {
  isDark: boolean;
  skills: InstalledSkill[];
  loading: boolean;
  actionBusy: string | null;
  onUninstall: (s: InstalledSkill) => void;
  accent: AccentClasses;
}) {
  const { t } = useI18n();
  return (
    <div className={`rounded-2xl border ring-1 ${glass(isDark, 'base')} ${accent.ring}`}>
      <div
        className={`flex items-center gap-2 border-b px-5 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
      >
        <Package className={`h-3.5 w-3.5 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`} />
        <h4 className={`text-xs font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}>
          {t('evolution.studio.myAgents.installedSkills')}
        </h4>
        {!loading && skills.length > 0 && (
          <span className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>· {skills.length}</span>
        )}
      </div>
      {loading ? (
        <div className={`px-5 py-6 text-center text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {t('evolution.studio.myAgents.loadingShort')}
        </div>
      ) : skills.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <p className={`text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
            {t('evolution.studio.myAgents.noInstalledTitle')}
          </p>
          <p className={`mt-1 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {t('evolution.studio.myAgents.noInstalledBody')}
          </p>
        </div>
      ) : (
        <ul>
          {skills.map((skill, i) => (
            <li
              key={skill.skillId}
              className={`flex items-center gap-3 px-5 py-3 ${
                i < skills.length - 1 ? (isDark ? 'border-b border-white/[0.04]' : 'border-b border-zinc-100') : ''
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className={`text-sm font-medium ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                    {skill.name}
                  </span>
                  <span className={`text-[10px] font-mono ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    v{skill.version}
                  </span>
                  <SkillStatusBadge status={skill.status} />
                </div>
                <p className={`mt-0.5 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  {t('evolution.common.installedLine', {
                    installed: localizedTimeAgo(skill.installedAt, t),
                    lastUsed: localizedTimeAgo(skill.lastInvokedAt, t),
                  })}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled
                  title={t('evolution.common.configureComingSoon')}
                  aria-label={t('evolution.common.configure')}
                >
                  <Settings2 />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onUninstall(skill)}
                  disabled={actionBusy === skill.skillId}
                  title={t('evolution.common.uninstall')}
                  aria-label={t('evolution.common.uninstall')}
                >
                  {actionBusy === skill.skillId ? <Loader2 className="animate-spin" /> : <Trash2 />}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const { t } = useI18n();
  const tone: Record<string, string> = {
    online: 'bg-emerald-500',
    busy: 'bg-amber-500',
    idle: 'bg-blue-500',
    offline: 'bg-zinc-500',
  };
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${tone[status] ?? 'bg-zinc-500'}`}
      title={status}
      aria-label={t('evolution.common.statusAria', { status })}
    />
  );
}

function Bar({ label, value, isDark }: { label: string; value: number; isDark: boolean }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>{label}</p>
        <span className={`text-[11px] font-mono ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{pct}</span>
      </div>
      <div className={`h-1.5 w-full overflow-hidden rounded-full ${isDark ? 'bg-white/[0.06]' : 'bg-zinc-100'}`}>
        <div
          className="h-full bg-gradient-to-r from-violet-500 via-cyan-500 to-emerald-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
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

// (Avatar / hashGradient removed — S42 replaced with SiriOrb-based PortraitOrb)
