'use client';

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  Boxes,
  ClipboardCheck,
  FileText,
  Folder,
  ImageIcon,
  ListChecks,
  PanelRightClose,
  Paperclip,
  Sparkles,
} from 'lucide-react';

import { friendlyType, formatBytes, relativeTime, assetTitle, AssetThumb } from './asset-card';
import { DeliveryProgressIndicator } from './message-asset-card';
import { deriveAssetDeliveryProgress } from '../lib/delivery-progress';
import { cn } from '@/lib/utils';
import { useI18n } from '@/contexts/i18n-context';
import { radius, statusAccent, surface } from '../lib/design';
import type { AssetDTO, TaskDTO } from '../lib/types';

/**
 * Unified delivery progress for a right-rail asset row — drives the SAME
 * "Preparing preview… / Delivery failed" affordance the message bubble uses,
 * off the coarse signals already on the DTO (no per-asset poll hook here).
 */
function assetDeliveryProgress(asset: AssetDTO) {
  const hasThumbnail = Boolean(
    asset.thumbnailUrl || asset.previewUrls?.medium || asset.previewUrls?.small,
  );
  return deriveAssetDeliveryProgress({
    mime: asset.mime,
    kind: asset.kind,
    ingestStatus: asset.ingestStatus,
    hasThumbnail,
  });
}

/**
 * release201/12 §8c.1 — session context sidebar extensions for the
 * skillDev / acceptance / project-scope SOPs. Each tab is rendered only
 * when its data dependency is present, so chats without any of these
 * concerns still see the canonical 4-tab layout.
 */
export interface SessionSkillSopContext {
  skillId: string;
  stage: string | null;
  state: 'started' | 'in_progress' | 'completed' | 'failed' | null;
  draftId?: string | null;
}

export interface SessionAcceptanceContext {
  taskId: string;
  acceptanceStatus: 'none' | 'pending' | 'partial' | 'passed' | 'failed';
  passedCount?: number;
  totalCount?: number;
}

export interface SessionProjectScopeContext {
  projectId: string;
  projectName: string;
  members: Array<{ id: string; displayName: string; avatarUrl?: string | null }>;
}

export interface SessionContextSidebarProps {
  isDark: boolean;
  open: boolean;
  tasks: TaskDTO[];
  assets: AssetDTO[];
  onToggleOpen: () => void;
  onOpenTask?: (taskId: string) => void;
  onOpenAsset?: (assetId: string) => void;
  /** release201/12 §8c.1 — only set when conversation.metadata.skillDev exists. */
  skillSop?: SessionSkillSopContext | null;
  /** release201/12 §8c.1 — only set when a task is linked to the conversation. */
  acceptance?: SessionAcceptanceContext | null;
  /** release201/12 §8c.1 — only set when conversation.projectId exists. */
  projectScope?: SessionProjectScopeContext | null;
  /**
   * release201 S12 — Insights moved from a separate /workspace/insights
   * route to an in-shell surface. The "Open project insights" affordance
   * in the project-scope tab dispatches to the parent, which flips
   * `activeSurface` to `'insights'` and syncs URL params.
   */
  onOpenProjectInsights?: (projectId: string) => void;
}

type AssetIntent = 'vision_input' | 'file_attachment' | 'artifact';
type ContextTab = 'tasks' | 'artifacts' | 'imageInputs' | 'fileImages' | 'skillSop' | 'acceptance' | 'projectScope';

function assetIntent(asset: AssetDTO): AssetIntent {
  const meta = readAssetMetadata(asset);
  const explicit =
    typeof meta.intent === 'string' ? meta.intent : typeof meta.inputIntent === 'string' ? meta.inputIntent : null;
  if (explicit === 'vision_input' || explicit === 'image_input') return 'vision_input';
  if (explicit === 'file_attachment' || explicit === 'attachment') return 'file_attachment';
  return 'artifact';
}

function readAssetMetadata(asset: AssetDTO): Record<string, unknown> {
  if (asset.metadata && typeof asset.metadata === 'object') return asset.metadata;
  const raw = asset.metadata as unknown;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function taskTone(status: string): keyof typeof statusAccent {
  if (status === 'running' || status === 'assigned' || status === 'in_progress') return 'in_progress';
  if (status === 'review' || status === 'awaiting_approval') return 'review';
  if (status === 'blocked' || status === 'stuck') return 'blocked';
  if (status === 'failed' || status === 'errored') return 'failed';
  if (status === 'completed' || status === 'done') return 'completed';
  return 'todo';
}

export function SessionContextSidebar({
  isDark,
  open,
  tasks,
  assets,
  onToggleOpen,
  onOpenTask,
  onOpenAsset,
  skillSop,
  acceptance,
  projectScope,
  onOpenProjectInsights,
}: SessionContextSidebarProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<ContextTab>('tasks');
  const grouped = useMemo(() => {
    const imageInputs: AssetDTO[] = [];
    const fileImages: AssetDTO[] = [];
    const artifacts: AssetDTO[] = [];

    for (const asset of assets) {
      const intent = assetIntent(asset);
      const isImage = asset.kind === 'image' || (asset.mime ?? '').startsWith('image/');
      if (intent === 'vision_input') {
        imageInputs.push(asset);
      } else if (intent === 'file_attachment' && isImage) {
        fileImages.push(asset);
      } else {
        artifacts.push(asset);
      }
    }

    return { imageInputs, fileImages, artifacts };
  }, [assets]);
  const baseTabs: Array<{
    id: ContextTab;
    label: string;
    title: string;
    icon: ReactNode;
    count: number;
  }> = [
    {
      id: 'tasks',
      label: t('workspace.sessionContext.tasks'),
      title: t('workspace.sessionContext.linkedTasks'),
      icon: <ListChecks className="h-3.5 w-3.5" />,
      count: tasks.length,
    },
    {
      id: 'artifacts',
      label: t('workspace.sessionContext.artifacts'),
      title: t('workspace.sessionContext.sessionArtifacts'),
      icon: <Boxes className="h-3.5 w-3.5" />,
      count: grouped.artifacts.length,
    },
    {
      id: 'imageInputs',
      label: t('workspace.sessionContext.inputs'),
      title: t('workspace.sessionContext.imageInputs'),
      icon: <ImageIcon className="h-3.5 w-3.5" />,
      count: grouped.imageInputs.length,
    },
    {
      id: 'fileImages',
      label: t('workspace.sessionContext.files'),
      title: t('workspace.sessionContext.imageFiles'),
      icon: <Paperclip className="h-3.5 w-3.5" />,
      count: grouped.fileImages.length,
    },
  ];
  // release201/12 §8c.1 — conditional SOP tabs.
  if (skillSop) {
    baseTabs.push({
      id: 'skillSop',
      label: 'Skill',
      title: 'Skill SOP',
      icon: <Sparkles className="h-3.5 w-3.5" />,
      count: 1,
    });
  }
  if (acceptance) {
    baseTabs.push({
      id: 'acceptance',
      label: 'Accept',
      title: 'Acceptance criteria',
      icon: <ClipboardCheck className="h-3.5 w-3.5" />,
      count: acceptance.totalCount ?? 1,
    });
  }
  if (projectScope) {
    baseTabs.push({
      id: 'projectScope',
      label: 'Project',
      title: 'Project scope',
      icon: <Folder className="h-3.5 w-3.5" />,
      count: projectScope.members.length,
    });
  }
  const tabs = baseTabs;
  const activeTabMeta = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];
  const totalCount = tasks.length + assets.length;

  const tabContent = (() => {
    if (activeTab === 'tasks') {
      return tasks.length > 0 ? (
        <div className="space-y-2">
          {tasks.map((task) => {
            const accent = statusAccent[taskTone(task.status)] ?? statusAccent.todo;
            return (
              <button
                key={task.id}
                type="button"
                onClick={() => onOpenTask?.(task.id)}
                className={`w-full rounded-2xl border px-3 py-2 text-left transition-colors ${
                  isDark ? `${accent.bg} hover:bg-white/[0.06]` : 'border-zinc-200 bg-white/75 hover:bg-zinc-50'
                }`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${accent.dot}`} />
                  <span className={`truncate text-xs font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                    {task.title}
                  </span>
                </div>
                <p className={`mt-1 truncate text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  {task.status}
                  {task.progress != null ? ` · ${task.progress}%` : ''}
                </p>
              </button>
            );
          })}
        </div>
      ) : (
        <EmptyHint isDark={isDark} text={t('workspace.sessionContext.noTaskLinked')} />
      );
    }
    if (activeTab === 'skillSop' && skillSop) {
      return (
        <div className="space-y-2">
          <div
            className={`rounded-2xl border p-3 ${
              isDark ? 'border-white/[0.06] bg-zinc-950/40' : 'border-zinc-200 bg-white/85'
            }`}
          >
            <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              Skill
            </p>
            <p className={`mt-0.5 truncate text-xs font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
              {skillSop.skillId}
            </p>
            <p className={`mt-1 text-[11px] ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              stage: {skillSop.stage ?? '—'}
              {skillSop.state ? ` · ${skillSop.state}` : ''}
            </p>
          </div>
          <Link
            href={`/evolution?tab=studio&skillId=${encodeURIComponent(skillSop.skillId)}${
              skillSop.draftId ? `&draftId=${encodeURIComponent(skillSop.draftId)}` : ''
            }`}
            className={`inline-flex w-full items-center justify-center rounded-2xl border px-3 py-2 text-xs font-medium ${
              isDark
                ? 'border-violet-400/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/15'
                : 'border-violet-200 bg-violet-50 text-violet-800 hover:bg-violet-100'
            }`}
          >
            Open Skill Studio
          </Link>
        </div>
      );
    }
    if (activeTab === 'acceptance' && acceptance) {
      return (
        <div className="space-y-2">
          <div
            className={`rounded-2xl border p-3 ${
              isDark ? 'border-white/[0.06] bg-zinc-950/40' : 'border-zinc-200 bg-white/85'
            }`}
          >
            <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              Acceptance
            </p>
            <p className={`mt-0.5 text-xs font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
              {acceptance.acceptanceStatus}
            </p>
            {acceptance.totalCount != null ? (
              <p className={`mt-1 text-[11px] ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                {acceptance.passedCount ?? 0} of {acceptance.totalCount} criteria passed
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => onOpenTask?.(acceptance.taskId)}
            className={`inline-flex w-full items-center justify-center rounded-2xl border px-3 py-2 text-xs font-medium ${
              isDark
                ? 'border-cyan-400/30 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/15'
                : 'border-cyan-200 bg-cyan-50 text-cyan-800 hover:bg-cyan-100'
            }`}
          >
            Open task
          </button>
        </div>
      );
    }
    if (activeTab === 'projectScope' && projectScope) {
      return (
        <div className="space-y-2">
          <div
            className={`rounded-2xl border p-3 ${
              isDark ? 'border-white/[0.06] bg-zinc-950/40' : 'border-zinc-200 bg-white/85'
            }`}
          >
            <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              Project
            </p>
            <p className={`mt-0.5 truncate text-xs font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
              {projectScope.projectName}
            </p>
            <p className={`mt-1 text-[11px] ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              {projectScope.members.length} members
            </p>
            <div className="mt-2 flex flex-wrap gap-1">
              {projectScope.members.slice(0, 8).map((m) => (
                <div
                  key={m.id}
                  title={m.displayName}
                  className={`flex h-6 w-6 items-center justify-center overflow-hidden rounded-full text-[10px] font-semibold ${
                    isDark ? 'bg-white/[0.05] text-zinc-300' : 'bg-zinc-200 text-zinc-700'
                  }`}
                >
                  {m.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={m.avatarUrl} alt={m.displayName} className="h-full w-full object-cover" />
                  ) : (
                    m.displayName.slice(0, 1).toUpperCase()
                  )}
                </div>
              ))}
            </div>
          </div>
          <button
            type="button"
            data-testid="session-context-open-project-insights"
            onClick={() => onOpenProjectInsights?.(projectScope.projectId)}
            disabled={!onOpenProjectInsights}
            className={`inline-flex w-full items-center justify-center rounded-2xl border px-3 py-2 text-xs font-medium transition-colors disabled:opacity-50 ${
              isDark
                ? 'border-white/[0.08] bg-white/[0.04] text-zinc-200 hover:bg-white/[0.08]'
                : 'border-zinc-200 bg-zinc-50 text-zinc-800 hover:bg-zinc-100'
            }`}
          >
            Open project insights
          </button>
        </div>
      );
    }
    if (activeTab === 'artifacts') {
      return (
        <AssetList
          isDark={isDark}
          assets={grouped.artifacts}
          onOpenAsset={onOpenAsset}
          empty={t('workspace.sessionContext.noArtifacts')}
          variant="large"
        />
      );
    }
    if (activeTab === 'imageInputs') {
      return (
        <AssetList
          isDark={isDark}
          assets={grouped.imageInputs}
          onOpenAsset={onOpenAsset}
          empty={t('workspace.sessionContext.noImageInputs')}
          variant="grid"
        />
      );
    }
    return (
      <AssetList
        isDark={isDark}
        assets={grouped.fileImages}
        onOpenAsset={onOpenAsset}
        empty={t('workspace.sessionContext.noImageFiles')}
        variant="grid"
      />
    );
  })();

  // 2026-05-30 (A2) — sidebar is now an in-flow push-in panel, not an
  // absolute-positioned overlay. The parent container (chats-surface) uses
  // flex so width transitions on this <aside> compress / expand ImChannel.
  // Closed state collapses width to 0 instead of translating off-screen,
  // so no backdrop is needed.
  return (
    <aside
      data-testid="session-context-sidebar"
      data-open={open ? 'true' : 'false'}
      aria-hidden={!open ? true : undefined}
      inert={open ? undefined : true}
      className={cn(
        'relative flex min-h-0 shrink-0 flex-col overflow-hidden border transition-[width,opacity,margin] duration-300 ease-out',
        radius.card,
        open
          ? 'ml-3 w-[min(336px,calc(100vw-32px))] opacity-100'
          : 'pointer-events-none ml-0 w-0 border-transparent opacity-0',
        isDark ? surface.card.dark : surface.card.light,
      )}
    >
        <div
          className={`flex h-14 shrink-0 items-center gap-2 border-b px-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200/80'}`}
        >
          <div className="min-w-0 flex-1">
            <p
              className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
            >
              {t('workspace.sessionContext.session')}
            </p>
            <h3 className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-950'}`}>
              {t('workspace.sessionContext.context')}
              <span className={`ml-2 text-[10px] font-medium ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                {t('workspace.sessionContext.linkedCount', { count: totalCount })}
              </span>
            </h3>
          </div>
          <button
            type="button"
            onClick={onToggleOpen}
            aria-label={t('workspace.sessionContext.collapse')}
            title={t('workspace.sessionContext.collapse')}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-xl transition-colors ${
              isDark
                ? 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100'
                : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
            }`}
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
        </div>

        <div
          className={`shrink-0 flex flex-wrap gap-1 border-b p-2 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200/80'}`}
        >
          {tabs.map((tab) => (
            <ContextTabButton
              key={tab.id}
              isDark={isDark}
              active={activeTab === tab.id}
              icon={tab.icon}
              label={tab.label}
              title={tab.title}
              count={tab.count}
              onClick={() => setActiveTab(tab.id)}
            />
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="mb-3 flex min-w-0 items-center gap-2">
            <span
              className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-xl ${
                isDark ? 'bg-white/[0.05] text-zinc-300' : 'bg-zinc-100 text-zinc-700'
              }`}
            >
              {activeTabMeta.icon}
            </span>
            <h4
              className={`min-w-0 flex-1 truncate text-xs font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}
            >
              {activeTabMeta.title}
            </h4>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                isDark ? 'bg-white/[0.05] text-zinc-400' : 'bg-zinc-100 text-zinc-500'
              }`}
            >
              {activeTabMeta.count}
            </span>
          </div>
          {tabContent}
        </div>
    </aside>
  );
}

function ContextTabButton({
  isDark,
  active,
  icon,
  label,
  title,
  count,
  onClick,
}: {
  isDark: boolean;
  active: boolean;
  icon: ReactNode;
  label: string;
  title: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'relative flex w-[64px] min-w-0 flex-col items-center gap-1 rounded-xl border px-1.5 py-1.5 text-center transition-colors',
        active
          ? isDark
            ? 'border-cyan-300/30 bg-cyan-400/10 text-cyan-100'
            : 'border-cyan-200 bg-cyan-50 text-cyan-800'
          : isDark
            ? 'border-white/[0.06] bg-white/[0.025] text-zinc-400 hover:bg-white/[0.055] hover:text-zinc-200'
            : 'border-zinc-200 bg-white/70 text-zinc-500 hover:bg-zinc-50 hover:text-zinc-800',
      )}
    >
      <span className="flex h-5 items-center justify-center">{icon}</span>
      <span className="max-w-full truncate text-[10px] font-semibold leading-none">{label}</span>
      <span
        className={cn(
          'absolute -right-1 -top-1 min-w-4 rounded-full px-1 text-[9px] font-bold leading-4',
          active
            ? isDark
              ? 'bg-cyan-300 text-zinc-950'
              : 'bg-cyan-600 text-white'
            : isDark
              ? 'bg-white/[0.08] text-zinc-400'
              : 'bg-zinc-200 text-zinc-600',
        )}
      >
        {count > 99 ? '99+' : count}
      </span>
    </button>
  );
}

function AssetList({
  isDark,
  assets,
  onOpenAsset,
  empty = 'No artifacts for this session yet.',
  variant = 'list',
}: {
  isDark: boolean;
  assets: AssetDTO[];
  onOpenAsset?: (assetId: string) => void;
  empty?: string;
  variant?: 'list' | 'large' | 'grid';
}) {
  if (assets.length === 0) return <EmptyHint isDark={isDark} text={empty} />;

  if (variant === 'grid') {
    return (
      <div className="grid grid-cols-2 gap-2">
        {assets.map((asset) => {
          const delivery = assetDeliveryProgress(asset);
          const showDelivery = delivery.inFlight || delivery.stage === 'failed';
          return (
            <button
              key={asset.id}
              type="button"
              onClick={() => onOpenAsset?.(asset.id)}
              className={cn(
                'group overflow-hidden rounded-2xl border text-left transition-colors',
                isDark
                  ? 'border-white/[0.06] bg-white/[0.025] hover:bg-white/[0.055]'
                  : 'border-zinc-200 bg-white/80 hover:bg-zinc-50',
              )}
            >
              <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden">
                <AssetThumb asset={asset} isDark={isDark} size="md" />
                {showDelivery ? (
                  <span className="absolute bottom-1 left-1 right-1 flex justify-start">
                    <DeliveryProgressIndicator progress={delivery} isDark={isDark} compact />
                  </span>
                ) : null}
              </div>
              <div className="px-2 py-1.5">
                <p className={cn('truncate text-[11px] font-semibold', isDark ? 'text-zinc-100' : 'text-zinc-900')}>
                  {assetTitle(asset)}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {assets.map((asset) => {
        const delivery = assetDeliveryProgress(asset);
        const showDelivery = delivery.inFlight || delivery.stage === 'failed';
        return (
          <button
            key={asset.id}
            type="button"
            onClick={() => onOpenAsset?.(asset.id)}
            className={cn(
              'flex w-full items-center gap-2 rounded-2xl border p-2 text-left transition-colors',
              variant === 'large' && 'items-start',
              isDark
                ? 'border-white/[0.06] bg-white/[0.025] hover:bg-white/[0.055]'
                : 'border-zinc-200 bg-white/80 hover:bg-zinc-50',
            )}
          >
            <div className={cn('shrink-0 overflow-hidden rounded-xl', variant === 'large' ? 'h-16 w-16' : 'h-12 w-12')}>
              <AssetThumb asset={asset} isDark={isDark} size={variant === 'large' ? 'md' : 'sm'} />
            </div>
            <div className="min-w-0 flex-1">
              <p className={`truncate text-xs font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                {assetTitle(asset)}
              </p>
              {showDelivery ? (
                <span className="mt-1 flex">
                  <DeliveryProgressIndicator progress={delivery} isDark={isDark} compact />
                </span>
              ) : (
                <p
                  className={`mt-1 truncate text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                  title={new Date(asset.createdAt).toLocaleString()}
                >
                  {friendlyType(asset)} · {formatBytes(asset.sizeBytes)} · {relativeTime(asset.createdAt)}
                </p>
              )}
            </div>
            <FileText className={`h-3.5 w-3.5 shrink-0 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />
          </button>
        );
      })}
    </div>
  );
}

function EmptyHint({ isDark, text }: { isDark: boolean; text: string }) {
  return (
    <p
      className={`rounded-2xl border border-dashed px-3 py-3 text-xs ${
        isDark ? 'border-white/[0.06] text-zinc-500' : 'border-zinc-200 text-zinc-500'
      }`}
    >
      {text}
    </p>
  );
}
