'use client';

/**
 * Full-screen modal that hosts RoleCardCatalog.
 *
 * One modal serves two use sites:
 *   - Simple Step 2: multi-select with capacity awareness.
 *   - Pro ProTileAgent: single-pick that returns an AgentRoleTemplate
 *     synthesised from the picked API row.
 *
 * The body uses card-grid layout grouped by category — denser to scan than
 * the previous 74 px single-row list and gives the imported agency
 * templates the visual identity (emoji + color) they ship with.
 */

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useState } from 'react';

import { RoleCardCatalog, type CatalogMode } from './RoleCardCatalog';
import { AgentPackCatalog, type AgentPackForkResult } from './AgentPackCatalog';
import type { RoleTemplateBrowserItem, RoleTemplateLoader } from './types';
import type { RenderedRole } from '../../../lib/templates/types';

export interface BrowseAllRolesModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isDark: boolean;
  mode?: CatalogMode;
  selectedSlugs: Set<string>;
  atCapacity?: boolean;
  fallbackRoles?: readonly RenderedRole[];
  recommendedSet?: Set<string>;
  loader?: RoleTemplateLoader;
  onToggle?: (role: RenderedRole) => void;
  onPick?: (item: RoleTemplateBrowserItem) => void;
  onCatalogChange?: (roles: RenderedRole[]) => void;
  targetWorkspaceId?: string;
  onForked?: (result: AgentPackForkResult) => void;
}

export function BrowseAllRolesModal({
  open,
  onOpenChange,
  isDark,
  mode = 'multi',
  selectedSlugs,
  atCapacity = false,
  fallbackRoles = [],
  recommendedSet,
  loader,
  onToggle,
  onPick,
  onCatalogChange,
  targetWorkspaceId,
  onForked,
}: BrowseAllRolesModalProps) {
  const packsEnabled = Boolean(targetWorkspaceId && onForked);
  const [activeTab, setActiveTab] = useState<'templates' | 'packs'>('templates');
  const showingPacks = packsEnabled && activeTab === 'packs';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-3xl"
        data-testid="browse-all-roles-modal"
        aria-describedby={undefined}
      >
        <div className="flex h-[78vh] flex-col gap-3">
          <header className="flex items-baseline justify-between">
            <DialogTitle className={`text-base font-medium ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
              {showingPacks ? 'Fork Agent Pack' : mode === 'single' ? '挑选一个角色' : '浏览全部角色'}
            </DialogTitle>
            {mode === 'multi' && !showingPacks ? (
              <span className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                已选 {selectedSlugs.size}
                {atCapacity ? ' · 容量已满' : ''}
              </span>
            ) : null}
          </header>
          {packsEnabled ? (
            <div
              role="tablist"
              aria-label="创建来源"
              className={`grid grid-cols-2 rounded-lg border p-1 text-xs ${
                isDark ? 'border-white/[0.08] bg-black/20' : 'border-zinc-200 bg-zinc-50'
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'templates'}
                onClick={() => setActiveTab('templates')}
                data-testid="browse-all-tab-templates"
                className={`rounded-md px-3 py-1.5 font-medium ${
                  activeTab === 'templates'
                    ? isDark
                      ? 'bg-white/[0.08] text-zinc-100'
                      : 'bg-white text-zinc-900 shadow-sm'
                    : isDark
                      ? 'text-zinc-400 hover:text-zinc-200'
                      : 'text-zinc-500 hover:text-zinc-800'
                }`}
              >
                模板
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'packs'}
                onClick={() => setActiveTab('packs')}
                data-testid="browse-all-tab-agent-packs"
                className={`rounded-md px-3 py-1.5 font-medium ${
                  activeTab === 'packs'
                    ? isDark
                      ? 'bg-white/[0.08] text-zinc-100'
                      : 'bg-white text-zinc-900 shadow-sm'
                    : isDark
                      ? 'text-zinc-400 hover:text-zinc-200'
                      : 'text-zinc-500 hover:text-zinc-800'
                }`}
              >
                Agent Pack
              </button>
            </div>
          ) : null}
          {showingPacks && targetWorkspaceId && onForked ? (
            <AgentPackCatalog
              isDark={isDark}
              targetWorkspaceId={targetWorkspaceId}
              onForked={(result) => {
                onForked(result);
                onOpenChange(false);
              }}
            />
          ) : (
            <RoleCardCatalog
              isDark={isDark}
              mode={mode}
              selectedSlugs={selectedSlugs}
              recommendedSet={recommendedSet}
              atCapacity={atCapacity}
              fallbackRoles={fallbackRoles}
              loader={loader}
              onToggle={(item) => {
                if (onToggle) onToggle(item.role);
              }}
              onPick={(item) => {
                if (onPick) onPick(item);
                if (mode === 'single') onOpenChange(false);
              }}
              onCatalogChange={onCatalogChange}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
