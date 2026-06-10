'use client';

/**
 * LibrarySurface — thin shell over `LibraryFilesPanel`.
 *
 * The Asset surface is **deliberately asset-only**. Earlier iterations
 * embedded a Skills quick-view and Memory/Graph sub-panels here. Both were
 * removed:
 *
 *   • Skills quick-view — assets and skills don't share a user mental model;
 *     deep skill operations live in `/evolution?tab=studio` and shouldn't
 *     leak a second entry point into the Asset surface. The embedded view
 *     also broke layout when a workspace had >10 drafts (flex-1 vs natural
 *     height collision against LibraryFilesPanel).
 *   • Memory / Graph — the long-term memory model hasn't converged yet
 *     (see [[project_im_long_context_optimization]]); exposing it as a
 *     user-facing surface is premature.
 *
 * Re-exposure prerequisites:
 *   • Skills: nothing planned. If a future need surfaces, it lives inside
 *     an asset's contextual menu ("this asset is referenced by skill X"),
 *     not as a sibling panel.
 *   • Memory: needs the doc 25 long-context redesign to land first. When
 *     restoring, bring back `LibraryMemoryPanel` (./library-memory-panel),
 *     `LibraryGraphPanel` (./library-graph-panel), and the
 *     `ComingSoonPlaceholder` fallback alongside the segmented control.
 *     The `initialView`, `memoryJumpPath`, `onMemoryJumpHandled`,
 *     `onMemoryJumpRequest`, `pendingProposalCount`, `onOpenProposalReview`,
 *     `myImUserId`, `isOwnerHuman`, `activeTaskId`, and `workspaceId`
 *     props are still threaded through and ignored — they remain in the
 *     type so callers (page.tsx) don't break and re-exposure is just
 *     rewiring this file.
 *
 * Block-quoted history preserved in `git log -- library-surface.tsx`.
 */

import { LibraryFilesPanel } from './library-files-panel';
import type { AssetDTO, WorkspaceFileDTO } from '../lib/types';
import type { WorkspaceInspector } from './workspace-inspector-dialog';

export type LibraryView = 'files' | 'memory' | 'graph';

interface LibrarySurfaceProps {
  isDark: boolean;
  /** @deprecated Skills quick-view removed — see top docstring. */
  workspaceId?: string | null;
  assets: AssetDTO[];
  files: WorkspaceFileDTO[];
  onUploadAsset: () => void;
  onUploadFiles?: (files: File[]) => void | Promise<void>;
  onOpenInspector: (inspector: WorkspaceInspector) => void;
  initialFolder?: string | null;
  onAssetsChanged?: () => void | Promise<void>;
  notify?: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** @deprecated Memory/Graph entry disabled — see top docstring. */
  initialView?: LibraryView;
  /** @deprecated Memory/Graph entry disabled — see top docstring. */
  memoryJumpPath?: string | null;
  /** @deprecated Memory/Graph entry disabled — see top docstring. */
  onMemoryJumpHandled?: () => void;
  /** @deprecated Memory/Graph entry disabled — see top docstring. */
  onMemoryJumpRequest?: (path: string) => void;
  /** @deprecated Memory/Graph entry disabled — see top docstring. */
  myImUserId?: string | null;
  /** @deprecated Memory/Graph entry disabled — see top docstring. */
  isOwnerHuman?: boolean;
  /** @deprecated Memory/Graph entry disabled — see top docstring. */
  activeTaskId?: string | null;
  /** @deprecated Memory/Graph entry disabled — see top docstring. */
  pendingProposalCount?: number;
  /** @deprecated Memory/Graph entry disabled — see top docstring. */
  onOpenProposalReview?: () => void;
}

export function LibrarySurface({
  isDark,
  assets,
  files,
  onUploadAsset,
  onUploadFiles,
  onOpenInspector,
  initialFolder,
  onAssetsChanged,
  notify,
  // Below: accepted from page.tsx but currently ignored because both the
  // Skills quick-view and Memory/Graph views are intentionally hidden.
  // Restore wiring when re-exposing — see top docstring.
  workspaceId: _workspaceId,
  initialView: _initialView,
  memoryJumpPath: _memoryJumpPath,
  onMemoryJumpHandled: _onMemoryJumpHandled,
  onMemoryJumpRequest: _onMemoryJumpRequest,
  myImUserId: _myImUserId,
  isOwnerHuman: _isOwnerHuman,
  activeTaskId: _activeTaskId,
  pendingProposalCount: _pendingProposalCount,
  onOpenProposalReview: _onOpenProposalReview,
}: LibrarySurfaceProps) {
  return (
    <div data-testid="library-surface" data-view="files" className="flex h-full min-h-0 flex-col">
      <LibraryFilesPanel
        isDark={isDark}
        assets={assets}
        files={files}
        onUploadAsset={onUploadAsset}
        onUploadFiles={onUploadFiles}
        onOpenInspector={onOpenInspector}
        initialFolder={initialFolder}
        onAssetsChanged={onAssetsChanged}
        notify={notify}
      />
    </div>
  );
}
