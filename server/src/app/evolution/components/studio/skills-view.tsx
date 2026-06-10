'use client';

/**
 * Studio · Skills view — 4 sub-tab wrapper (release201/13 §3.2-3.6, S22).
 *
 * Sub-tabs (URL `?subview=`):
 *   - authoring (default) → AuthoringView   (drafts + status filter)
 *   - lifecycle           → LifecycleView   (pipeline rail + 9-section Evidence)
 *   - installed           → InstalledView   (per-agent installed skills + Configure)
 *   - evolution           → EvolutionView   (per-agent capsules + genes)
 *
 * The wrapper is purely structural; each view owns its own data fetches.
 * `subview` change is delegated to the parent (studio-tab → evolution/page)
 * so it can be reflected in `router.replace`.
 */

import { Hammer, ListChecks, Package, Workflow } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useI18n } from '@/contexts/i18n-context';
import { AuthoringView } from './skills/authoring-view';
import { LifecycleView } from './skills/lifecycle-view';
import { InstalledView } from './skills/installed-view';
import { EvolutionView } from './skills/evolution-view';
import { type SkillsSubview } from './types';

interface SkillsViewProps {
  isDark: boolean;
  workspaceId: string | null;
  agentId: string | null;
  draftId: string | null;
  subview: SkillsSubview;
  onSubviewChange: (subview: SkillsSubview) => void;
  onAgentChange: (id: string | null) => void;
  onDraftChange: (id: string | null) => void;
  onHasDraftChange: (has: boolean) => void;
}

export function SkillsView({
  isDark,
  workspaceId,
  agentId,
  draftId,
  subview,
  onSubviewChange,
  onAgentChange,
  onDraftChange,
  onHasDraftChange,
}: SkillsViewProps) {
  const { t } = useI18n();
  return (
    <div className="space-y-4" data-testid="skills-view">
      <Tabs value={subview} onValueChange={(v) => onSubviewChange(v as SkillsSubview)}>
        <TabsList>
          <TabsTrigger value="authoring" data-testid="skills-subtab-authoring">
            <Hammer className="h-3.5 w-3.5" />
            {t('evolution.studio.skills.subtabs.authoring')}
          </TabsTrigger>
          <TabsTrigger value="lifecycle" data-testid="skills-subtab-lifecycle">
            <ListChecks className="h-3.5 w-3.5" />
            {t('evolution.studio.skills.subtabs.lifecycle')}
          </TabsTrigger>
          <TabsTrigger value="installed" data-testid="skills-subtab-installed">
            <Package className="h-3.5 w-3.5" />
            {t('evolution.studio.skills.subtabs.installed')}
          </TabsTrigger>
          <TabsTrigger value="evolution" data-testid="skills-subtab-evolution">
            <Workflow className="h-3.5 w-3.5" />
            {t('evolution.studio.skills.subtabs.evolution')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="authoring" className="mt-4">
          <AuthoringView
            isDark={isDark}
            workspaceId={workspaceId}
            draftId={draftId}
            onDraftChange={onDraftChange}
            onHasDraftChange={onHasDraftChange}
          />
        </TabsContent>

        <TabsContent value="lifecycle" className="mt-4">
          <LifecycleView isDark={isDark} workspaceId={workspaceId} draftId={draftId} onDraftChange={onDraftChange} />
        </TabsContent>

        <TabsContent value="installed" className="mt-4">
          <InstalledView isDark={isDark} agentId={agentId} onAgentChange={onAgentChange} />
        </TabsContent>

        <TabsContent value="evolution" className="mt-4">
          <EvolutionView isDark={isDark} agentId={agentId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
