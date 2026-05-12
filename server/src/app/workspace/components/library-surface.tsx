'use client';

/**
 * LibrarySurface — Memory Line B / B1.
 *
 * Hosts the three Library views (Files / Memory / Graph) behind a segmented
 * control. B1 only wires the Files segment to the existing files panel;
 * Memory and Graph render coming-soon placeholders that B2 / B6 replace.
 *
 * The segmented control sits at the top so the same surface URL can deep-link
 * into any view (downstream milestones add `?view=memory|graph` query-state).
 */

import { useEffect, useState } from 'react';
import { FolderTree, Network, Workflow } from 'lucide-react';

import { LibraryFilesPanel } from './library-files-panel';
import { LibraryGraphPanel } from './library-graph-panel';
import { LibraryMemoryPanel } from './library-memory-panel';
import type { AssetDTO, WorkspaceFileDTO } from '../lib/types';
import type { WorkspaceInspector } from './workspace-inspector-dialog';

export type LibraryView = 'files' | 'memory' | 'graph';

interface LibrarySurfaceProps {
  isDark: boolean;
  workspaceId: string | null;
  assets: AssetDTO[];
  files: WorkspaceFileDTO[];
  onUploadAsset: () => void;
  onOpenInspector: (inspector: WorkspaceInspector) => void;
  initialFolder?: string | null;
  onAssetsChanged?: () => void | Promise<void>;
  notify?: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** Initial segmented-control selection (e.g. 'memory' from external "View as Memory" jump). */
  initialView?: LibraryView;
  /** Memory page path to auto-select after the Memory view loads. */
  memoryJumpPath?: string | null;
  onMemoryJumpHandled?: () => void;
  /** Called when an in-surface jump is needed (e.g. Graph node → Memory view). */
  onMemoryJumpRequest?: (path: string) => void;
  /** B4 mutation context — surfaced from the workspace page. */
  myImUserId?: string | null;
  isOwnerHuman?: boolean;
  activeTaskId?: string | null;
  /** B7 — proposal review entry points. */
  pendingProposalCount?: number;
  onOpenProposalReview?: () => void;
}

const SEGMENTS: Array<{ key: LibraryView; label: string; Icon: typeof FolderTree }> = [
  { key: 'files', label: 'Files', Icon: FolderTree },
  { key: 'memory', label: 'Memory', Icon: Workflow },
  { key: 'graph', label: 'Graph', Icon: Network },
];

export function LibrarySurface({
  isDark,
  workspaceId,
  assets,
  files,
  onUploadAsset,
  onOpenInspector,
  initialFolder,
  onAssetsChanged,
  notify,
  initialView,
  memoryJumpPath,
  onMemoryJumpHandled,
  onMemoryJumpRequest,
  myImUserId,
  isOwnerHuman,
  activeTaskId,
  pendingProposalCount,
  onOpenProposalReview,
}: LibrarySurfaceProps) {
  const [view, setView] = useState<LibraryView>(initialView ?? 'files');

  // External "View as Memory" jumps force the Memory tab on top of selecting a path.
  useEffect(() => {
    if (memoryJumpPath) setView('memory');
  }, [memoryJumpPath]);

  return (
    <div data-testid="library-surface" data-view={view} className="flex h-full min-h-0 flex-col">
      <div
        className={`flex shrink-0 items-center gap-1 border-b px-3 py-2 ${
          isDark ? 'border-white/[0.06] bg-zinc-950/30' : 'border-zinc-200 bg-zinc-50/60'
        }`}
      >
        <div
          role="tablist"
          aria-label="Library view"
          data-testid="library-segmented-control"
          className={`inline-flex rounded-2xl border p-0.5 ${
            isDark ? 'border-white/[0.06] bg-white/[0.02]' : 'border-zinc-200 bg-white/70'
          }`}
        >
          {SEGMENTS.map(({ key, label, Icon }) => {
            const active = view === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`library-segment-${key}`}
                data-active={active ? 'true' : undefined}
                onClick={() => setView(key)}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors ${
                  active
                    ? isDark
                      ? 'bg-violet-500/20 text-violet-100'
                      : 'bg-violet-100/80 text-violet-900'
                    : isDark
                      ? 'text-zinc-400 hover:text-zinc-100'
                      : 'text-zinc-500 hover:text-zinc-900'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {view === 'files' ? (
          <LibraryFilesPanel
            isDark={isDark}
            assets={assets}
            files={files}
            onUploadAsset={onUploadAsset}
            onOpenInspector={onOpenInspector}
            initialFolder={initialFolder}
            onAssetsChanged={onAssetsChanged}
            notify={notify}
          />
        ) : view === 'memory' ? (
          workspaceId ? (
            <LibraryMemoryPanel
              workspaceId={workspaceId}
              isDark={isDark}
              jumpToPath={memoryJumpPath}
              onJumpHandled={onMemoryJumpHandled}
              myImUserId={myImUserId ?? null}
              isOwnerHuman={isOwnerHuman ?? false}
              activeTaskId={activeTaskId ?? null}
              notify={notify}
              pendingProposalCount={pendingProposalCount}
              onOpenProposalReview={onOpenProposalReview}
            />
          ) : (
            <ComingSoonPlaceholder
              isDark={isDark}
              testId="library-memory-no-workspace"
              title="Memory pages"
              description="Workspace not loaded yet — pages will appear once bootstrap completes."
            />
          )
        ) : workspaceId ? (
          <LibraryGraphPanel
            workspaceId={workspaceId}
            isDark={isDark}
            onJumpToMemory={(path) => {
              setView('memory');
              onMemoryJumpRequest?.(path);
            }}
          />
        ) : (
          <ComingSoonPlaceholder
            isDark={isDark}
            testId="library-graph-no-workspace"
            title="Knowledge graph"
            description="Workspace not loaded yet — graph will appear once bootstrap completes."
          />
        )}
      </div>
    </div>
  );
}

function ComingSoonPlaceholder({
  isDark,
  testId,
  title,
  description,
}: {
  isDark: boolean;
  testId: string;
  title: string;
  description: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`flex h-full flex-col items-center justify-center px-6 text-center ${
        isDark ? 'text-zinc-400' : 'text-zinc-600'
      }`}
    >
      <p className={`text-sm font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-900'}`}>{title}</p>
      <p className="mt-2 max-w-sm text-xs leading-relaxed opacity-80">{description}</p>
      <span
        className={`mt-4 inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
          isDark ? 'border-white/[0.08] text-zinc-500' : 'border-zinc-200 text-zinc-500'
        }`}
      >
        Coming soon
      </span>
    </div>
  );
}
