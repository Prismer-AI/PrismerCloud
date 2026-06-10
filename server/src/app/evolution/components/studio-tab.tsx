'use client';

/**
 * Skill Studio — operational surface for skill authoring + agent management.
 *
 * Three views (collapsed from doc 13's 6-domain split):
 *   • my-agents — agent identity + personality + installed skills
 *   • skills    — 4 sub-tab wrapper (authoring / lifecycle / installed / evolution)
 *   • metrics   — per-workspace dashboard consuming /api/im/metrics/aggregate
 *
 * Visual contract:
 *   - shadcn `Tabs` (matches gene-detail-drawer, marketplace, leaderboard)
 *   - evolution `glass()` for surface panes
 *   - No phase / "Phase 2 (S9)" / Coming soon labels in production UI
 */

import { useCallback, useEffect, useState } from 'react';
import { BarChart3, Brain, Package, Sparkles, Wrench } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/contexts/i18n-context';
import { glass } from './helpers';
import { MyAgentsView, type WorkspaceAgentSummary } from './studio/my-agents-view';
import { SkillsView } from './studio/skills-view';
import { MetricsView } from './studio/metrics-view';
import { SessionMemoryDrawer } from './studio/session-memory-drawer';
import { StudioOnboarding } from './studio/onboarding';
import {
  type SkillsSubview,
  type StudioView,
  STUDIO_VIEWS,
  fetchDrafts,
  fetchInstalled,
  normalizeLegacyView,
  readActiveWorkspaceId,
  resolveWorkspaceIdFromBackend,
} from './studio/types';
import { listProjects } from '@/app/workspace/lib/projects-api';

export type { SkillsSubview, StudioView } from './studio/types';
export { normalizeLegacyView, normalizeSkillsSubview, legacyViewToSubview } from './studio/types';

interface StudioTabProps {
  isDark: boolean;
  view: StudioView;
  subview: SkillsSubview;
  agentId: string | null;
  draftId: string | null;
  onViewChange: (view: StudioView) => void;
  onSubviewChange: (subview: SkillsSubview) => void;
  onAgentChange: (agentId: string | null) => void;
  onDraftChange: (draftId: string | null) => void;
}

export function StudioTab({
  isDark,
  view,
  subview,
  agentId,
  draftId,
  onViewChange,
  onSubviewChange,
  onAgentChange,
  onDraftChange,
}: StudioTabProps) {
  const { t } = useI18n();
  const safeView: StudioView = STUDIO_VIEWS.includes(view) ? view : normalizeLegacyView(view);
  const [workspaceId, setWorkspaceId] = useState<string | null>(() => readActiveWorkspaceId());
  const [hasAgent, setHasAgent] = useState(false);
  const [hasInstalled, setHasInstalled] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  // release201 v2.0.8 F-bug — project 抽象引导. studio 引导需要知道当前
  // workspace 是否已有项目, 决定显隐 "create a project" step.
  const [hasProject, setHasProject] = useState(false);
  // release201/26 Phase 3 — Session memory admin drawer (operator tool, not a
  // per-workspace view tab). One self-contained affordance in the breadcrumb
  // bar; RBAC is enforced server-side and surfaced as a 403 state in-drawer.
  const [memoryOpen, setMemoryOpen] = useState(false);
  // Y3 (2026-05-28): workspace 内全部 agents — 已经在下面的 onboarding
  // useEffect 里拿到 (X2 fix), 这里 lift 到组件 state 是为了把列表传给
  // MyAgentsView 让它在 caller=human (无自身 identity) 时 fallback 到
  // workspaceAgents[0] 而不是显示 NoAgentCard.
  const [workspaceAgents, setWorkspaceAgents] = useState<WorkspaceAgentSummary[]>([]);

  useEffect(() => {
    if (workspaceId) return;
    void resolveWorkspaceIdFromBackend().then((id) => {
      if (id) setWorkspaceId(id);
    });
  }, [workspaceId]);

  // release201 v2.0.8 F-bug — fetch project count for studio onboarding step.
  // 失败时 fallback 为 false (引导显示 "create a project" step), 这样比错误
  // 隐藏更好 (false negative 不会骚扰已经有项目的用户太久 — 下次进入会重试).
  useEffect(() => {
    if (!workspaceId) return;
    const ac = new AbortController();
    void listProjects({ workspaceId, limit: 1, signal: ac.signal })
      .then((res) => {
        if (ac.signal.aborted) return;
        setHasProject(res.ok && (res.data?.total ?? 0) > 0);
      })
      .catch(() => {
        if (!ac.signal.aborted) setHasProject(false);
      });
    return () => ac.abort();
  }, [workspaceId]);

  // release201 v2.0.8 hotfix A4 + X2 — onboarding 状态必须独立于当前 view 同步.
  // 旧版依赖 my-agents-view / authoring-view 子组件回调 setHasAgent /
  // setHasInstalled / setHasDraft, 但用户进 studio 落在 Skills tab (而非 my-agents)
  // 时, my-agents-view 不 render, callback 永远不触发, onboarding panel 永远显示.
  //
  // X2 (2026-05-28): A4 的 fetchProfile(null) 拿的是 caller 自己的 agent identity
  // (tomwinshare 是 human → agentId=null → hasAgent 永远 false), 与 onboarding
  // 的语义 "workspace 内是否有 agent" 不符. 改用 /api/im/studio/installed —
  // 该 BFF 同时返回 workspace 内所有 agents 和 active agent 的 installed skills,
  // hasAgent / hasInstalled 都从这一次 RPC 推导, 不再依赖 caller 自身 identity.
  //
  // 子组件的 onHasXChange callback 仍保留, 用于 mutation 后的 in-place 同步 (例:
  // my-agents 内卸载 skill 后 setHasInstalled, authoring 内新建 draft 后
  // setHasDraft) — 比 reload 整个 studio 更轻量.
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void (async () => {
      // /api/im/studio/installed BFF 行为 (src/im/api/studio.ts L224-337):
      //   1. resolveWorkspaceId → 找 workspace 内所有 IMAgentCard.
      //   2. agents: 全部 workspace agents (不论 caller 是 human 还是 agent).
      //   3. activeAgentId: requested → 否则 agents[0]?.agentId.
      //   4. skills: activeAgentId 的 installed skills (没 active 返 []).
      // 必须传 workspaceId — 否则 BFF 回退到 caller 第一个 owned workspace,
      // 当用户在另一个 workspace 时会拿错数据.
      const installed = await fetchInstalled(null, workspaceId);
      if (cancelled) return;
      const agents = installed?.agents ?? [];
      setHasAgent(agents.length > 0);
      setHasInstalled((installed?.skills?.length ?? 0) > 0);
      // Y3: keep just the fields MyAgentsView needs (agentId + displayName);
      // identity/personality/skills come from a fresh fetchProfile call once
      // we know which agent to query, so we don't carry the heavy fields.
      setWorkspaceAgents(agents.map((a) => ({ agentId: a.agentId, displayName: a.displayName })));
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Draft 状态独立于 Skills tab 是否 active. workspaceId 没解出来前不查
  // (fetchDrafts 自带 null 短路, 返回 []).
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void (async () => {
      const drafts = await fetchDrafts(workspaceId);
      if (cancelled) return;
      setHasDraft(drafts.length > 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const goToSkills = useCallback(() => onViewChange('skills'), [onViewChange]);

  const showOnboarding = safeView === 'my-agents' && (!hasAgent || !hasProject || !hasInstalled || !hasDraft);

  // release201/24 §Phase3 — collapse the redundant header layers into a single
  // location-aware breadcrumb so the user always sees "where am I" with real
  // signal (Studio › <view> [› <subview>]) instead of a static repeated title.
  const viewLabel =
    safeView === 'my-agents'
      ? t('evolution.studio.views.myAgents')
      : safeView === 'skills'
        ? t('evolution.studio.views.skills')
        : t('evolution.studio.views.metrics');
  const subviewLabel =
    safeView !== 'skills'
      ? null
      : subview === 'lifecycle'
        ? t('evolution.studio.skills.subtabs.lifecycle')
        : subview === 'installed'
          ? t('evolution.studio.skills.subtabs.installed')
          : subview === 'evolution'
            ? t('evolution.studio.skills.subtabs.evolution')
            : t('evolution.studio.skills.subtabs.authoring');

  return (
    <div className="space-y-4">
      {/* release201/24 §UX — single compact breadcrumb bar (was a tall card
          with a big "工作室" h2 + a separate subtitle that duplicated the tab
          strip). One "where am I" line, view tabs on the right. */}
      <div
        className={`flex flex-col gap-3 rounded-2xl px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between ${glass(isDark, 'base')}`}
      >
        <div
          className={`flex min-w-0 items-center gap-1.5 text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
          data-testid="studio-breadcrumb"
        >
          <Wrench className={`h-4 w-4 shrink-0 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} aria-hidden />
          <span>{t('evolution.studio.title')}</span>
          <span className={isDark ? 'text-zinc-700' : 'text-zinc-300'}>›</span>
          <span className={`font-semibold ${subviewLabel ? '' : isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
            {viewLabel}
          </span>
          {subviewLabel && (
            <>
              <span className={isDark ? 'text-zinc-700' : 'text-zinc-300'}>›</span>
              <span className={`font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{subviewLabel}</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Tabs value={safeView} onValueChange={(v) => onViewChange(v as StudioView)}>
            <TabsList>
              <TabsTrigger value="my-agents">
                <Package className="h-3.5 w-3.5" />
                {t('evolution.studio.views.myAgents')}
              </TabsTrigger>
              <TabsTrigger value="skills">
                <Sparkles className="h-3.5 w-3.5" />
                {t('evolution.studio.views.skills')}
              </TabsTrigger>
              <TabsTrigger value="metrics">
                <BarChart3 className="h-3.5 w-3.5" />
                {t('evolution.studio.views.metrics')}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            variant="ghost"
            size="sm"
            data-testid="studio-session-memory-trigger"
            onClick={() => setMemoryOpen(true)}
            title={t('evolution.studio.sessionMemory.navLabel')}
          >
            <Brain className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t('evolution.studio.sessionMemory.navLabel')}</span>
          </Button>
        </div>
      </div>

      <SessionMemoryDrawer isDark={isDark} open={memoryOpen} onOpenChange={setMemoryOpen} />

      <Tabs value={safeView} onValueChange={(v) => onViewChange(v as StudioView)}>
        <TabsContent value="my-agents" className="mt-0 space-y-4">
          {showOnboarding && (
            <StudioOnboarding
              isDark={isDark}
              state={{ hasAgent, hasInstalledSkill: hasInstalled, hasDraft, hasProject }}
              onNewSkill={goToSkills}
            />
          )}
          <MyAgentsView
            isDark={isDark}
            agentId={agentId}
            onAgentChange={onAgentChange}
            onHasAgentChange={setHasAgent}
            onHasInstalledChange={setHasInstalled}
            workspaceAgents={workspaceAgents}
          />
        </TabsContent>

        <TabsContent value="skills" className="mt-0">
          <SkillsView
            isDark={isDark}
            workspaceId={workspaceId}
            agentId={agentId}
            draftId={draftId}
            subview={subview}
            onSubviewChange={onSubviewChange}
            onAgentChange={onAgentChange}
            onDraftChange={onDraftChange}
            onHasDraftChange={setHasDraft}
          />
        </TabsContent>

        <TabsContent value="metrics" className="mt-0">
          <MetricsView isDark={isDark} workspaceId={workspaceId} agentId={agentId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
