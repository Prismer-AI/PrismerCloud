'use client';

import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Archive,
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  CloudDownload,
  Folder,
  FolderInput,
  FolderPlus,
  Home,
  Layers,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';

import { getWorkspaceToken, imFetch } from '../lib/im-api';
import { radius, surface } from '../lib/design';
import { useI18n } from '@/contexts/i18n-context';
import { SurfaceHeader } from './surface-header';
import { CardShelf, LayoutToggle, type CardLayoutMode } from './card-shelf';
import {
  AssetCard,
  assetSource,
  assetTitle,
  assetTypeTone,
  isCodeAsset,
  isDataAsset,
  isDocAsset,
  isImageAsset,
} from './asset-card';
import { AssetFilterMenu, type AssetFilter, type AssetFilterOption } from './asset-filter-menu';
import type { AssetDTO, WorkspaceFileDTO } from '../lib/types';
import type { WorkspaceInspector } from './workspace-inspector-dialog';

interface LibraryFilesPanelProps {
  isDark: boolean;
  assets: AssetDTO[];
  files: WorkspaceFileDTO[];
  onUploadAsset: () => void;
  onUploadFiles?: (files: File[]) => void | Promise<void>;
  onOpenInspector: (inspector: WorkspaceInspector) => void;
  /**
   * Wave-9 Phase 3: external folder selection. When set, the library
   * opens with that folder pre-filtered. Pass `null` for "All", or
   * `'__root__'` for the unfoldered root.
   */
  initialFolder?: string | null;
  /** Refresh the parent's asset cache after a folderPath PATCH lands. */
  onAssetsChanged?: () => void | Promise<void>;
  notify?: (message: string, type: 'success' | 'error' | 'info') => void;
}

/**
 * Folder model (release201/09 §9.4a.3 reorganization).
 *
 * folderPath is a free-form string column on im_assets (no folder table).
 * In the UI we encode "root" (folderPath IS NULL) as the sentinel
 * `__root__` so it can key into a Map.
 *
 * 2026-05-26 (D17): the prior `/tasks` and `/sandbox` always-render
 * "auto-managed" branches are RETIRED — task artifacts now live in the
 * task drawer's Artifacts tab and surface in Library only via the explicit
 * "Show task artifacts" toggle. Folders left in this UI are user-created
 * named folders (logical grouping; no longer task-ID spam).
 */
type FolderKey = string;
const ROOT_FOLDER_KEY: FolderKey = '__root__';
// Kept as constants only for the legacy folderPath bytes still in DB
// (backfill writes them, PATCH-move-to is now rejected outside of
// Promote ↑ in the task drawer). buildFolderTree no longer pins them
// as always-render folders.
const TASKS_FOLDER_KEY: FolderKey = '/tasks';
const SANDBOX_FOLDER_KEY: FolderKey = '/sandbox';

interface FolderNode {
  key: FolderKey;
  /** Display label. For `__root__` this is "Root"; for `/tasks/{id}` this is the trailing segment. */
  label: string;
  /** Indent level for the tree rendering. 0 = top-level. */
  depth: number;
  /** Number of assets directly in this folder (not counting descendants). */
  count: number;
  /** True for synthetic top-level branches (Root, /tasks, /sandbox) we always show. */
  pinned: boolean;
}

const FILTERS: AssetFilterOption[] = [
  { key: 'all', label: 'All' },
  { key: 'images', label: 'Images' },
  { key: 'docs', label: 'Docs' },
  { key: 'code', label: 'Code' },
  { key: 'data', label: 'Data' },
  { key: 'other', label: 'Other' },
];

export function LibraryFilesPanel({
  isDark,
  assets,
  files,
  onUploadAsset,
  onUploadFiles,
  onOpenInspector,
  initialFolder,
  onAssetsChanged,
  notify,
}: LibraryFilesPanelProps) {
  const { t } = useI18n();
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AssetFilter>('all');
  const [groupBy, setGroupBy] = useState<GroupBy>('time');
  const [sortBy, setSortBy] = useState<SortBy>('newest');
  // Bulk selection — set of asset ids picked via the per-card checkbox.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // Folder picker open-state for the bulk move-to-folder control.
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [downloadingAssetId, setDownloadingAssetId] = useState<string | null>(null);
  const [menuAssetId, setMenuAssetId] = useState<string | null>(null);
  const [busyAssetId, setBusyAssetId] = useState<string | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [isDraggingAsset, setIsDraggingAsset] = useState(false);
  // CardShelf is controlled — the toggle UI lives in the filter row.
  const [cardLayout, setCardLayout] = useState<CardLayoutMode>('grid');

  // Wave-9 Phase 3 state.
  //
  // currentFolder = null  → show all folders (no filter)
  // currentFolder = key   → show assets whose folderPath matches (or
  //                         starts-with for tree-style branches like
  //                         '/tasks' which expand into '/tasks/<id>')
  const [currentFolder, setCurrentFolder] = useState<FolderKey | null>(initialFolder ?? null);
  const [dragOverFolder, setDragOverFolder] = useState<FolderKey | null>(null);
  const [movingAssetId, setMovingAssetId] = useState<string | null>(null);
  // User-created (empty) folders persist for the session only — backend
  // has no folders table, folderPath becomes "real" once the first asset
  // is moved into it. Refreshing the page drops empty folders, which is
  // expected behavior.
  const [customFolders, setCustomFolders] = useState<string[]>([]);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  // release201/09 §9.4a.3 — opt-in toggle to surface task-bound assets in
  // Library. Default off: Library is the "workspace 资料库" view, agents'
  // task products live in the task drawer's Artifacts tab. Promote ↑
  // (asset.PATCH boundKind='workspace-file') is the path for owner to
  // copy a task product into the workspace catalog.
  const [showTaskArtifacts, setShowTaskArtifacts] = useState(false);

  // Sync external folder selection (e.g. task drawer's "Open in Library" jump).
  useEffect(() => {
    if (initialFolder !== undefined) setCurrentFolder(initialFolder);
  }, [initialFolder]);

  useEffect(() => {
    if (!menuAssetId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuAssetId(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuAssetId]);

  const fileByAssetId = useMemo(() => {
    const map = new Map<string, WorkspaceFileDTO>();
    for (const file of files) map.set(file.assetId, file);
    return map;
  }, [files]);

  /**
   * Defense filter:
   *   - `kind='task-result'` — Wave-9 Phase 3.0 legacy rows the cloud no
   *     longer mints (d3748d90); UI hides them defensively.
   *   - `kind='preview'` — server-side derivative thumbnails (e.g. PDF
   *     first-page WebP). They're attached to the parent asset via its
   *     `thumbnailUrl` / `previewUrls.medium`, so the parent card already
   *     renders the preview inline. Surfacing the derivative as a
   *     standalone asset would clutter the grid + leak into the image
   *     gallery as a phantom image.
   */
  const visibleAssets = useMemo(() => assets.filter((a) => a.kind !== 'task-result' && a.kind !== 'preview'), [assets]);

  // release201/09 §9.4a.3 — partition by boundKind. workspace-file is the
  // default Library Root view; task-bound is opt-in via toggle. Legacy
  // rows (boundKind NULL post-backfill should not exist, but defensively)
  // fall under workspace-file so the user sees them in Root instead of
  // losing them.
  const workspaceFileAssets = useMemo(
    () => visibleAssets.filter((a) => (a.boundKind ?? 'workspace-file') === 'workspace-file'),
    [visibleAssets],
  );
  const taskBoundCount = useMemo(
    () => visibleAssets.filter((a) => a.boundKind === 'task-bound').length,
    [visibleAssets],
  );

  const filteredAssets = useMemo(() => {
    const q = query.trim().toLowerCase();
    // When toggle on, include task-bound assets too — otherwise stay on
    // the default workspace-file subset.
    const base = showTaskArtifacts ? visibleAssets : workspaceFileAssets;
    return base.filter((asset) => {
      const title = assetTitle(asset, fileByAssetId.get(asset.id));
      const memoryText = (asset.memoryPages ?? []).map((page) => `${page.title ?? ''} ${page.path}`).join(' ');
      const matchesQuery =
        !q ||
        title.toLowerCase().includes(q) ||
        asset.contentHash.toLowerCase().includes(q) ||
        asset.kind.toLowerCase().includes(q) ||
        (asset.mime ?? '').toLowerCase().includes(q) ||
        memoryText.toLowerCase().includes(q);
      return matchesQuery && matchesFilter(asset, filter) && matchesFolder(asset, currentFolder);
    });
  }, [visibleAssets, workspaceFileAssets, showTaskArtifacts, fileByAssetId, filter, query, currentFolder]);

  // Folder tree builds from the workspace-file subset by default so the
  // sidebar doesn't get spammed with task-ID prefix folders. Toggle on →
  // include all rows for the tree too.
  const folderTree = useMemo(
    () => buildFolderTree(showTaskArtifacts ? visibleAssets : workspaceFileAssets, customFolders),
    [visibleAssets, workspaceFileAssets, showTaskArtifacts, customFolders],
  );

  // Sort BEFORE grouping so items stay ordered inside each section. The
  // time-group buckets still bucket by createdAt, but within a bucket the
  // chosen sort order is preserved.
  const sortedAssets = useMemo(() => sortAssets(filteredAssets, sortBy, fileByAssetId), [filteredAssets, sortBy, fileByAssetId]);

  const grouped = useMemo(() => groupAssets(sortedAssets, groupBy), [sortedAssets, groupBy]);

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());

  async function bulkDelete() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!window.confirm(t('assetUi.library.confirmBulkDelete', { count: ids.length }))) return;
    const results = await Promise.all(
      ids.map((id) => imFetch(`/assets/${encodeURIComponent(id)}`, { method: 'DELETE' })),
    );
    const failed = results.filter((r) => !r.ok).length;
    clearSelection();
    await onAssetsChanged?.();
    if (failed > 0)
      notify?.(
        t('assetUi.library.bulkDeletePartial', { ok: ids.length - failed, failed }),
        failed === ids.length ? 'error' : 'info',
      );
    else notify?.(t('assetUi.library.bulkDeleted', { count: ids.length }), 'success');
  }

  async function bulkMove(targetKey: FolderKey) {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBulkMoveOpen(false);
    const results = await Promise.all(ids.map((id) => moveAssetToFolder(id, targetKey)));
    const failed = results.filter((r) => !r.ok).length;
    clearSelection();
    await onAssetsChanged?.();
    if (failed > 0)
      notify?.(
        t('assetUi.library.bulkMovePartial', { ok: ids.length - failed, failed }),
        failed === ids.length ? 'error' : 'info',
      );
    else notify?.(t('assetUi.library.bulkMoved', { count: ids.length }), 'success');
  }

  async function downloadAsset(asset: AssetDTO) {
    const token = getWorkspaceToken();
    if (!token) return;
    setDownloadingAssetId(asset.id);
    try {
      const res = await fetch(`/api/im/assets/${encodeURIComponent(asset.id)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        notify?.(t('assetUi.library.downloadFailed'), 'error');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = assetTitle(asset, fileByAssetId.get(asset.id));
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloadingAssetId(null);
    }
  }

  async function renameAsset(asset: AssetDTO) {
    setMenuAssetId(null);
    const currentTitle = assetTitle(asset, fileByAssetId.get(asset.id));
    const nextTitle = window.prompt(t('assetUi.library.renamePrompt'), currentTitle)?.trim();
    if (!nextTitle || nextTitle === currentTitle) return;
    setBusyAssetId(asset.id);
    try {
      const res = await imFetch<AssetDTO>(`/assets/${encodeURIComponent(asset.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ filename: nextTitle }),
      });
      if (!res.ok) {
        notify?.(t('assetUi.library.renameFailed', { message: res.message }), 'error');
        return;
      }
      await onAssetsChanged?.();
      notify?.(t('assetUi.library.renamed', { name: nextTitle }), 'success');
    } finally {
      setBusyAssetId(null);
    }
  }

  async function deleteAsset(asset: AssetDTO) {
    setMenuAssetId(null);
    const title = assetTitle(asset, fileByAssetId.get(asset.id));
    if (!window.confirm(t('assetUi.library.confirmDelete', { name: title }))) return;
    setBusyAssetId(asset.id);
    try {
      const res = await imFetch(`/assets/${encodeURIComponent(asset.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        notify?.(t('assetUi.library.deleteFailed', { message: res.message }), 'error');
        return;
      }
      await onAssetsChanged?.();
      notify?.(t('assetUi.library.deleted', { name: title }), 'success');
    } finally {
      setBusyAssetId(null);
    }
  }

  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (onUploadFiles && hasFileDrag(event)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setDraggingFiles(true);
      return;
    }
    // Accept asset card drags: allow dropping on the grid / empty area to
    // move the dragged asset to the currently-viewed folder (or root).
    if (hasAssetDrag(event)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDraggingFiles(false);
    }
  }

  async function handleDrop(event: DragEvent<HTMLElement>) {
    // File upload drop (from OS)
    if (onUploadFiles) {
      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        setDraggingFiles(false);
        await onUploadFiles(files);
        return;
      }
    }
    // Asset card drop on grid area → move to current folder (or root if "All")
    const draggedAssetId = readDraggedAssetId(event);
    if (draggedAssetId) {
      event.preventDefault();
      try {
        const targetKey = currentFolder ?? ROOT_FOLDER_KEY;
        setMovingAssetId(draggedAssetId);
        const res = await moveAssetToFolder(draggedAssetId, targetKey);
        setMovingAssetId(null);
        if (!res.ok) {
          notify?.(t('assetUi.library.moveFailed', { message: res.message }), 'error');
          return;
        }
        notify?.(t('assetUi.library.moved'), 'success');
        await onAssetsChanged?.();
      } catch {
        /* ignore malformed payload */
      } finally {
        setIsDraggingAsset(false);
        setDraggingFiles(false);
      }
    }
  }

  return (
    <section
      data-launch-tour-anchor="library-panel"
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(event) => void handleDrop(event)}
    >
      <SurfaceHeader
        isDark={isDark}
        title={t('workspace.assets.title')}
        subtitle={t('workspace.assets.subtitle', { count: assets.length })}
        actions={
          <>
            <label
              className={`flex h-9 w-[220px] items-center gap-2 rounded-2xl border px-3 ${
                isDark ? 'border-white/[0.08] bg-white/[0.03] text-zinc-300' : 'border-zinc-200 bg-white text-zinc-700'
              }`}
            >
              <Search className="h-4 w-4 opacity-60" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('workspace.assets.search')}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"
              />
            </label>
            <AssetFilterMenu isDark={isDark} value={filter} options={FILTERS} onChange={setFilter} />
            {/*
              release201/09 §9.4a.3 — "Show task artifacts (N)" toggle.
              Default OFF. ON-state surfaces task-bound IMAsset rows in
              the Library view so reviewers can audit all per-task
              products without opening every task drawer. Count comes
              from the un-filtered workspace asset list (not the search-
              narrowed set) so the number stays stable while the user
              types.
            */}
            <button
              type="button"
              onClick={() => setShowTaskArtifacts((s) => !s)}
              data-testid="library-show-task-artifacts-toggle"
              title={t('assetUi.library.toggleArtifactsTitle')}
              className={`inline-flex h-9 items-center gap-1.5 rounded-2xl px-3 text-xs font-medium ${
                showTaskArtifacts
                  ? isDark
                    ? 'bg-violet-500/20 text-violet-200'
                    : 'bg-violet-100 text-violet-700'
                  : isDark
                    ? 'border border-white/[0.08] text-zinc-300 hover:bg-white/[0.04]'
                    : 'border border-zinc-200 text-zinc-700 hover:bg-zinc-100'
              }`}
            >
              {showTaskArtifacts
                ? t('assetUi.library.hideArtifacts', { count: taskBoundCount })
                : t('assetUi.library.showArtifacts', { count: taskBoundCount })}
            </button>
            {/* Group-by dimension — switch how the grid is sectioned so assets
                aren't all dumped in one undifferentiated "Today" pile. */}
            <div
              className={`inline-flex h-9 items-center gap-0.5 rounded-2xl border p-0.5 ${
                isDark ? 'border-white/[0.08]' : 'border-zinc-200'
              }`}
              title={t('assetUi.library.groupByTitle')}
            >
              <Layers className={`ml-1.5 mr-0.5 h-3.5 w-3.5 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
              {(['time', 'type', 'source'] as GroupBy[]).map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setGroupBy(g)}
                  data-testid={`library-groupby-${g}`}
                  className={`inline-flex h-7 items-center rounded-xl px-2.5 text-xs font-medium ${
                    groupBy === g
                      ? isDark
                        ? 'bg-violet-500/20 text-violet-200'
                        : 'bg-violet-100 text-violet-700'
                      : isDark
                        ? 'text-zinc-400 hover:bg-white/[0.04]'
                        : 'text-zinc-500 hover:bg-zinc-100'
                  }`}
                >
                  {g === 'time'
                    ? t('assetUi.library.groupTime')
                    : g === 'type'
                      ? t('assetUi.library.groupType')
                      : t('assetUi.library.groupSource')}
                </button>
              ))}
            </div>
            {/* Sort dimension — order assets before grouping so each section
                stays internally sorted. */}
            <div
              className={`inline-flex h-9 items-center gap-0.5 rounded-2xl border p-0.5 ${
                isDark ? 'border-white/[0.08]' : 'border-zinc-200'
              }`}
              title={t('assetUi.library.sortByTitle')}
            >
              <ArrowDownUp className={`ml-1.5 mr-0.5 h-3.5 w-3.5 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
              {(['newest', 'oldest', 'name', 'size'] as SortBy[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSortBy(s)}
                  data-testid={`library-sort-${s}`}
                  className={`inline-flex h-7 items-center rounded-xl px-2.5 text-xs font-medium ${
                    sortBy === s
                      ? isDark
                        ? 'bg-violet-500/20 text-violet-200'
                        : 'bg-violet-100 text-violet-700'
                      : isDark
                        ? 'text-zinc-400 hover:bg-white/[0.04]'
                        : 'text-zinc-500 hover:bg-zinc-100'
                  }`}
                >
                  {s === 'newest'
                    ? t('assetUi.library.sortNewest')
                    : s === 'oldest'
                      ? t('assetUi.library.sortOldest')
                      : s === 'name'
                        ? t('assetUi.library.sortName')
                        : t('assetUi.library.sortSize')}
                </button>
              ))}
            </div>
            <LayoutToggle
              isDark={isDark}
              layout={cardLayout}
              onChange={setCardLayout}
              availableLayouts={['list', 'grid']}
            />
            <button
              type="button"
              onClick={onUploadAsset}
              className={`inline-flex h-9 items-center gap-1.5 rounded-2xl px-3 text-xs font-semibold text-white ${
                isDark ? 'bg-violet-500 hover:bg-violet-400' : 'bg-violet-600 hover:bg-violet-700'
              }`}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('workspace.assets.upload')}
            </button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
        <FolderSidebar
          isDark={isDark}
          tree={folderTree}
          current={currentFolder}
          dragOverFolder={dragOverFolder}
          isDraggingAsset={isDraggingAsset}
          onSelect={(key) => setCurrentFolder(key)}
          onDragOverFolder={(key) => setDragOverFolder(key)}
          onDragLeaveFolder={() => setDragOverFolder(null)}
          onDropAsset={async (key, assetId) => {
            setDragOverFolder(null);
            setMovingAssetId(assetId);
            const res = await moveAssetToFolder(assetId, key);
            setMovingAssetId(null);
            if (!res.ok) {
              notify?.(t('assetUi.library.moveFailed', { message: res.message }), 'error');
              return;
            }
            notify?.(t('assetUi.library.moved'), 'success');
            await onAssetsChanged?.();
          }}
          onCreateFolder={() => {
            setNewFolderName('');
            setCreatingFolder(true);
          }}
        />
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {/* Breadcrumb / drop-to-move bar */}
          {isDraggingAsset && currentFolder !== null ? (
            <div
              onDragOver={(event) => {
                if (hasAssetDrag(event)) {
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = 'move';
                }
              }}
              onDrop={async (event) => {
                const draggedAssetId = readDraggedAssetId(event);
                if (!draggedAssetId) return;
                event.preventDefault();
                event.stopPropagation();
                try {
                  setMovingAssetId(draggedAssetId);
                  const targetKey = currentFolder;
                  const res = await moveAssetToFolder(draggedAssetId, targetKey);
                  setMovingAssetId(null);
                  if (!res.ok) {
                    notify?.(t('assetUi.library.moveFailed', { message: res.message }), 'error');
                    return;
                  }
                  notify?.(t('assetUi.library.moved'), 'success');
                  await onAssetsChanged?.();
                } catch {
                  /* ignore */
                } finally {
                  setIsDraggingAsset(false);
                }
              }}
              className={`mb-3 rounded-xl border border-dashed px-3 py-2 text-center text-xs font-medium transition-colors ${
                isDark
                  ? 'border-violet-400/30 bg-violet-500/10 text-violet-200'
                  : 'border-violet-300 bg-violet-50 text-violet-700'
              }`}
            >
              {t('assetUi.library.dropToMove')}{' '}
              <span className="font-semibold">
                {currentFolder === ROOT_FOLDER_KEY ? t('assetUi.library.rootFolder') : currentFolder}
              </span>
            </div>
          ) : isDraggingAsset ? (
            <div
              onDragOver={(event) => {
                if (hasAssetDrag(event)) {
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = 'move';
                }
              }}
              onDrop={async (event) => {
                const draggedAssetId = readDraggedAssetId(event);
                if (!draggedAssetId) return;
                event.preventDefault();
                event.stopPropagation();
                try {
                  setMovingAssetId(draggedAssetId);
                  const res = await moveAssetToFolder(draggedAssetId, ROOT_FOLDER_KEY);
                  setMovingAssetId(null);
                  if (!res.ok) {
                    notify?.(t('assetUi.library.moveFailed', { message: res.message }), 'error');
                    return;
                  }
                  notify?.(t('assetUi.library.moved'), 'success');
                  await onAssetsChanged?.();
                } catch {
                  /* ignore */
                } finally {
                  setIsDraggingAsset(false);
                }
              }}
              className={`mb-3 rounded-xl border border-dashed px-3 py-2 text-center text-xs font-medium transition-colors ${
                isDark
                  ? 'border-violet-400/30 bg-violet-500/10 text-violet-200'
                  : 'border-violet-300 bg-violet-50 text-violet-700'
              }`}
            >
              {t('assetUi.library.dropToMove')}{' '}
              <span className="font-semibold">{t('assetUi.library.allFolder')}</span>
            </div>
          ) : null}
          {selectedIds.size > 0 ? (
            <div
              className={`sticky top-0 z-10 mb-3 flex items-center gap-2 border px-3 py-2 ${radius.card} ${
                isDark
                  ? 'border-violet-400/25 bg-violet-500/12 text-violet-100 backdrop-blur'
                  : 'border-violet-200 bg-violet-50/95 text-violet-800 backdrop-blur'
              }`}
            >
              <span className="text-xs font-semibold">{t('assetUi.library.selected', { count: selectedIds.size })}</span>
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void bulkDelete()}
                  data-testid="library-bulk-delete"
                  className={`inline-flex h-8 items-center gap-1.5 rounded-xl px-3 text-xs font-medium ${
                    isDark
                      ? 'text-red-200 hover:bg-red-500/15'
                      : 'text-red-600 hover:bg-red-50'
                  }`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('assetUi.library.delete')}
                </button>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setBulkMoveOpen((o) => !o)}
                    data-testid="library-bulk-move"
                    className={`inline-flex h-8 items-center gap-1.5 rounded-xl px-3 text-xs font-medium ${
                      isDark ? 'text-zinc-100 hover:bg-white/[0.08]' : 'text-zinc-700 hover:bg-white'
                    }`}
                  >
                    <FolderInput className="h-3.5 w-3.5" />
                    {t('assetUi.library.moveToFolder')}
                    <ChevronDown className="h-3 w-3 opacity-60" />
                  </button>
                  {bulkMoveOpen ? (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setBulkMoveOpen(false)} aria-hidden />
                      <div
                        className={`absolute right-0 top-9 z-20 max-h-72 w-52 overflow-y-auto rounded-2xl border p-1 shadow-2xl ${
                          isDark ? 'border-white/[0.08] bg-zinc-950 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => void bulkMove(ROOT_FOLDER_KEY)}
                          className={`flex h-8 w-full items-center gap-2 rounded-xl px-2.5 text-left text-xs font-medium ${
                            isDark ? 'text-zinc-200 hover:bg-white/[0.06]' : 'text-zinc-700 hover:bg-zinc-100'
                          }`}
                        >
                          <Home className="h-3.5 w-3.5 opacity-70" />
                          {t('assetUi.library.rootFolder')}
                        </button>
                        {folderTree
                          .filter((node) => node.key !== ROOT_FOLDER_KEY)
                          .map((node) => (
                            <button
                              key={node.key}
                              type="button"
                              onClick={() => void bulkMove(node.key)}
                              style={{ paddingLeft: `${10 + node.depth * 12}px` }}
                              className={`flex h-8 w-full items-center gap-2 rounded-xl pr-2.5 text-left text-xs font-medium ${
                                isDark ? 'text-zinc-200 hover:bg-white/[0.06]' : 'text-zinc-700 hover:bg-zinc-100'
                              }`}
                            >
                              <Folder className="h-3.5 w-3.5 opacity-70" />
                              <span className="truncate">{node.label}</span>
                            </button>
                          ))}
                      </div>
                    </>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={clearSelection}
                  data-testid="library-bulk-clear"
                  className={`inline-flex h-8 items-center gap-1.5 rounded-xl px-3 text-xs font-medium ${
                    isDark ? 'text-zinc-300 hover:bg-white/[0.08]' : 'text-zinc-600 hover:bg-white'
                  }`}
                >
                  <X className="h-3.5 w-3.5" />
                  {t('assetUi.library.clear')}
                </button>
              </div>
            </div>
          ) : null}
          {filteredAssets.length === 0 ? (
            <div
              className={`flex min-h-[320px] flex-col items-center justify-center border border-dashed text-center ${radius.pane} ${surface.pane[theme]}`}
            >
              <Archive className={`h-8 w-8 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />
              <p className={`mt-3 text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                {t('workspace.assets.empty')}
              </p>
              <p className={`mt-1 max-w-sm text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                {t('workspace.assets.emptyHint')}
              </p>
              <button
                type="button"
                onClick={onUploadAsset}
                className={`mt-4 rounded-2xl px-3 py-2 text-xs font-semibold text-white ${isDark ? 'bg-violet-500' : 'bg-violet-600'}`}
              >
                {t('workspace.assets.upload')}
              </button>
            </div>
          ) : (
            <CardShelf<AssetDTO>
              isDark={isDark}
              data={grouped}
              getId={(asset) => asset.id}
              layout={cardLayout}
              availableLayouts={['list', 'grid']}
              containerClassName={{
                grid: 'grid grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-3',
              }}
              renderCard={({ item: asset, layout }) => (
                <AssetCard
                  isDark={isDark}
                  layout={layout}
                  asset={asset}
                  file={fileByAssetId.get(asset.id)}
                  busy={busyAssetId === asset.id}
                  downloading={downloadingAssetId === asset.id}
                  menuOpen={menuAssetId === asset.id}
                  selected={selectedIds.has(asset.id)}
                  onToggleSelect={() => toggleSelected(asset.id)}
                  onOpen={() => onOpenInspector({ kind: 'asset', assetId: asset.id })}
                  onDownload={() => void downloadAsset(asset)}
                  onDelete={() => void deleteAsset(asset)}
                  onRename={() => void renameAsset(asset)}
                  onToggleMenu={() => setMenuAssetId((current) => (current === asset.id ? null : asset.id))}
                  onDragStart={(event) => {
                    const payload = {
                      id: asset.id,
                      title: assetTitle(asset, fileByAssetId.get(asset.id)),
                      kind: asset.kind,
                      mime: asset.mime,
                      sizeBytes: asset.sizeBytes,
                      contentHash: asset.contentHash,
                      folderPath: asset.folderPath ?? null,
                    };
                    event.dataTransfer.effectAllowed = 'copyMove';
                    event.dataTransfer.setData('application/x-prismer-asset', JSON.stringify(payload));
                    event.dataTransfer.setData('text/plain', `asset:${asset.id}`);
                    setIsDraggingAsset(true);
                  }}
                  onDragEnd={() => setIsDraggingAsset(false)}
                />
              )}
            />
          )}
        </div>
      </div>
      <AnimatePresence>
        {creatingFolder ? (
          <NewFolderDialog
            isDark={isDark}
            value={newFolderName}
            onChange={setNewFolderName}
            onCancel={() => setCreatingFolder(false)}
            onConfirm={() => {
              const trimmed = newFolderName.trim().replace(/^\/+|\/+$/g, '');
              if (!trimmed) {
                notify?.(t('assetUi.library.folderNameEmpty'), 'error');
                return;
              }
              if (trimmed.startsWith('tasks') || trimmed.startsWith('sandbox')) {
                notify?.(t('assetUi.library.folderNameReserved'), 'error');
                return;
              }
              const path = normalizeFolderPath(`/${trimmed}`);
              setCustomFolders((prev) => (prev.includes(path) ? prev : [...prev, path]));
              setCurrentFolder(path);
              setCreatingFolder(false);
              setNewFolderName('');
            }}
          />
        ) : null}
      </AnimatePresence>
      {/* Reserved for future drag-overlay state polish — keeps the React
          tree shape stable so `movingAssetId` can drive a per-card spinner
          when we add one. */}
      <span data-moving-asset-id={movingAssetId ?? ''} className="hidden" />
      {draggingFiles ? (
        <div
          className={`pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-2xl border border-dashed ${
            isDark
              ? 'border-violet-300/45 bg-violet-500/12 text-violet-100'
              : 'border-violet-400 bg-violet-50/90 text-violet-800'
          }`}
        >
          <div className="rounded-2xl px-5 py-4 text-center backdrop-blur">
            <CloudDownload className="mx-auto h-7 w-7" />
            <p className="mt-2 text-sm font-semibold">{t('workspace.assets.dropUpload')}</p>
          </div>
        </div>
      ) : null}
      {menuAssetId ? <div className="fixed inset-0 z-20" onClick={() => setMenuAssetId(null)} aria-hidden /> : null}
    </section>
  );
}

/**
 * Wave-9 Phase 3.1 — left sidebar folder tree.
 *
 * Compact list (no virtualization needed at expected scales — typical
 * workspaces have a few dozen folders). Pinned top-level branches
 * (Root, Tasks, Sandbox) always render even when empty; user-defined
 * folders render with their counts. Click selects; drop moves the
 * dragged asset there.
 */
function FolderSidebar({
  isDark,
  tree,
  current,
  dragOverFolder,
  isDraggingAsset,
  onSelect,
  onDragOverFolder,
  onDragLeaveFolder,
  onDropAsset,
  onCreateFolder,
}: {
  isDark: boolean;
  tree: FolderNode[];
  current: FolderKey | null;
  dragOverFolder: FolderKey | null;
  isDraggingAsset: boolean;
  onSelect: (key: FolderKey | null) => void;
  onDragOverFolder: (key: FolderKey) => void;
  onDragLeaveFolder: () => void;
  onDropAsset: (key: FolderKey, assetId: string) => void | Promise<void>;
  onCreateFolder: () => void;
}) {
  const { t } = useI18n();
  // 2026-05-20 — Collapsible tree. Previously the sidebar rendered every
  // node as a flat list (indented by `node.depth`), so a workspace with
  // many `/tasks/<id>` or `/sandbox/<run>` branches produced an
  // un-scrollable wall. The buildFolderTree output preserves key prefixes
  // (`/tasks` is the parent of `/tasks/abc`), so we can derive parent
  // relationships purely from the `key` string + sort order. Default
  // state: all expanded — the prior behavior — but each top-level branch
  // (or any node with descendants) now has a chevron toggle.
  const [collapsed, setCollapsed] = useState<Set<FolderKey>>(() => new Set());
  // Compute `hasChildren` per node: is there any later node whose key
  // starts with `<this.key>/` AND has depth = this.depth + 1?
  const hasChildren = useMemo(() => {
    const result = new Map<FolderKey, boolean>();
    for (const node of tree) {
      const prefix = node.key === ROOT_FOLDER_KEY ? null : `${node.key}/`;
      result.set(node.key, prefix !== null && tree.some((other) => other !== node && other.key.startsWith(prefix)));
    }
    return result;
  }, [tree]);
  // A node should be rendered iff NONE of its ancestor keys are in `collapsed`.
  // Walk up the path-prefix chain: `/tasks/abc/def` → check `/tasks/abc`, `/tasks`.
  const isHidden = (key: FolderKey): boolean => {
    if (key === ROOT_FOLDER_KEY || !key.startsWith('/')) return false;
    let cursor = key.lastIndexOf('/');
    while (cursor > 0) {
      const ancestor = key.slice(0, cursor);
      if (collapsed.has(ancestor)) return true;
      cursor = ancestor.lastIndexOf('/');
    }
    return false;
  };
  const toggle = (key: FolderKey) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  return (
    <aside
      className={`hidden w-[200px] shrink-0 overflow-y-auto border-r p-3 lg:block ${
        isDark ? 'border-white/[0.05] bg-white/[0.02]' : 'border-zinc-200/70 bg-zinc-50/50'
      }`}
    >
      <div className="mb-2 flex items-center justify-between">
        <span
          className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
        >
          {t('assetUi.library.folders')}
        </span>
        <button
          type="button"
          onClick={onCreateFolder}
          title={t('assetUi.library.newFolderAria')}
          className={`inline-flex h-6 w-6 items-center justify-center rounded-lg ${
            isDark
              ? 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100'
              : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
          }`}
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </button>
      </div>
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={`mb-1 flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-xs ${
          current == null
            ? isDark
              ? 'bg-violet-500/20 text-violet-100'
              : 'bg-violet-100 text-violet-800'
            : isDark
              ? 'text-zinc-300 hover:bg-white/[0.04]'
              : 'text-zinc-700 hover:bg-zinc-100'
        }`}
      >
        <Archive className="h-3.5 w-3.5 opacity-70" />
        <span className="flex-1 truncate">{t('assetUi.library.allFolder')}</span>
      </button>
      {tree.map((node) => {
        if (isHidden(node.key)) return null;
        const active = current === node.key;
        const dropTarget = dragOverFolder === node.key;
        const Icon = node.key === ROOT_FOLDER_KEY ? Home : Folder;
        const expandable = hasChildren.get(node.key) === true;
        const isCollapsed = collapsed.has(node.key);
        return (
          <button
            key={node.key}
            type="button"
            onClick={() => onSelect(node.key)}
            onDragOver={(event) => {
              if (hasAssetDrag(event)) {
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';
                onDragOverFolder(node.key);
              }
            }}
            onDragLeave={() => {
              if (dragOverFolder === node.key) onDragLeaveFolder();
            }}
            onDrop={(event) => {
              const draggedAssetId = readDraggedAssetId(event);
              if (!draggedAssetId) return;
              event.preventDefault();
              event.stopPropagation();
              void onDropAsset(node.key, draggedAssetId);
            }}
            style={{ paddingLeft: `${8 + node.depth * 12}px` }}
            className={`mb-0.5 flex w-full items-center gap-2 rounded-xl py-1.5 pr-2 text-left text-xs transition-all ${
              active
                ? isDark
                  ? 'bg-violet-500/20 text-violet-100'
                  : 'bg-violet-100 text-violet-800'
                : dropTarget
                  ? isDark
                    ? 'bg-emerald-500/20 text-emerald-100 ring-1 ring-emerald-400/40'
                    : 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300'
                  : isDraggingAsset
                    ? isDark
                      ? 'text-zinc-200 ring-1 ring-white/[0.06]'
                      : 'text-zinc-700 ring-1 ring-zinc-200/60'
                    : isDark
                      ? 'text-zinc-300 hover:bg-white/[0.04]'
                      : 'text-zinc-700 hover:bg-zinc-100'
            }`}
          >
            {expandable ? (
              // Plain span (not <button role>) — nesting `<button>` inside
              // the outer folder `<button>` is invalid HTML. Click only;
              // keyboard expand isn't required because the outer button is
              // the primary affordance (Enter on the folder still selects;
              // the chevron is a discoverability + mouse helper).
              <span
                onClick={(event) => {
                  event.stopPropagation();
                  toggle(node.key);
                }}
                aria-label={isCollapsed ? t('assetUi.library.expandFolder') : t('assetUi.library.collapseFolder')}
                className={`-ml-1 inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded ${
                  isDark ? 'text-zinc-400 hover:bg-white/[0.06]' : 'text-zinc-500 hover:bg-zinc-200/60'
                }`}
              >
                {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </span>
            ) : (
              <span className="-ml-1 inline-block h-4 w-4 shrink-0" aria-hidden="true" />
            )}
            <Icon className="h-3.5 w-3.5 opacity-70" />
            <span className="flex-1 truncate">
              {node.key === ROOT_FOLDER_KEY ? t('assetUi.library.rootFolder') : node.label}
            </span>
            {node.count > 0 ? (
              <span className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>{node.count}</span>
            ) : null}
          </button>
        );
      })}
    </aside>
  );
}

/**
 * Wave-9 Phase 3.4 — new folder dialog. Free-form path entry; we strip
 * leading/trailing slashes and prepend `/`. Reserved names (`tasks`,
 * `sandbox`) reject because they're auto-managed by the daemon side.
 *
 * The folder doesn't hit the backend on create — folderPath is just an
 * im_assets column, so a folder "exists" as soon as one asset is moved
 * into it. Until then it lives in the session's customFolders state.
 */
function NewFolderDialog({
  isDark,
  value,
  onChange,
  onCancel,
  onConfirm,
}: {
  isDark: boolean;
  value: string;
  onChange: (next: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onCancel}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        onClick={(event) => event.stopPropagation()}
        className={`w-[360px] rounded-2xl border p-4 ${
          isDark ? 'border-white/[0.08] bg-zinc-900' : 'border-zinc-200 bg-white'
        }`}
      >
        <h3 className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
          {t('assetUi.library.newFolderTitle')}
        </h3>
        <p className={`mt-1 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {t('assetUi.library.newFolderHint')}
        </p>
        <input
          autoFocus
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onConfirm();
            if (event.key === 'Escape') onCancel();
          }}
          placeholder={t('assetUi.library.newFolderPlaceholder')}
          className={`mt-3 w-full rounded-xl border px-3 py-2 text-sm outline-none ${
            isDark
              ? 'border-white/[0.08] bg-white/[0.03] text-zinc-100 placeholder:text-zinc-500'
              : 'border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400'
          }`}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className={`rounded-xl px-3 py-1.5 text-xs font-medium ${
              isDark ? 'text-zinc-400 hover:bg-white/[0.05]' : 'text-zinc-600 hover:bg-zinc-100'
            }`}
          >
            {t('assetUi.library.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-xl px-3 py-1.5 text-xs font-semibold text-white ${
              isDark ? 'bg-violet-500 hover:bg-violet-400' : 'bg-violet-600 hover:bg-violet-700'
            }`}
          >
            {t('assetUi.library.createFolder')}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function hasFileDrag(event: DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types ?? []).includes('Files');
}

function hasAssetDrag(event: DragEvent<HTMLElement>) {
  const types = Array.from(event.dataTransfer.types ?? []);
  return types.includes('application/x-prismer-asset') || types.includes('text/plain');
}

function readDraggedAssetId(event: DragEvent<HTMLElement>): string | null {
  const raw = event.dataTransfer.getData('application/x-prismer-asset');
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { id?: unknown };
      if (typeof parsed.id === 'string' && parsed.id.trim()) return parsed.id.trim();
    } catch {
      /* fall through to text/plain */
    }
  }
  const text = event.dataTransfer.getData('text/plain');
  const match = /^asset:(.+)$/.exec(text.trim());
  return match?.[1] ? match[1].trim() : null;
}

function matchesFilter(asset: AssetDTO, filter: AssetFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'images':
      return isImageAsset(asset);
    case 'docs':
      return isDocAsset(asset);
    case 'code':
      return isCodeAsset(asset);
    case 'data':
      return isDataAsset(asset);
    case 'other':
      return !isImageAsset(asset) && !isDocAsset(asset) && !isCodeAsset(asset) && !isDataAsset(asset);
  }
}

/**
 * Wave-9 Phase 3 — folder match.
 *
 * `null`              → show all folders (no filter)
 * `__root__`          → show assets with folderPath IS NULL only
 * `/tasks`            → show every asset under `/tasks/...` (top-level
 *                       branch matches all descendants)
 * `/tasks/abc`        → exact match for that one task's folder
 *
 * The starts-with semantics for top-level branches (`/tasks`,
 * `/sandbox`, user-created roots) make the tree feel like a real
 * filesystem — clicking the parent folder shows everything inside.
 */
function matchesFolder(asset: AssetDTO, current: FolderKey | null): boolean {
  if (current == null) return true;
  const folder = asset.folderPath ?? null;
  if (current === ROOT_FOLDER_KEY) return folder == null;
  if (folder == null) return false;
  if (folder === current) return true;
  // Prefix match — '/tasks' includes '/tasks/abc', '/tasks/abc/sub'
  return folder.startsWith(`${current}/`);
}

/**
 * Build the folder tree from the asset list + locally-created empty
 * folders. Top-level branches (Root, /tasks, /sandbox) are always
 * pinned even when empty; user-created folders are pinned only via the
 * `customFolders` session list.
 *
 * Children of /tasks and /sandbox are derived from each asset's
 * folderPath: `/tasks/{taskId}` and `/sandbox/{taskId}` respectively.
 */
function buildFolderTree(assets: AssetDTO[], customFolders: string[]): FolderNode[] {
  // Per-folder direct asset count (no descendant aggregation — clicking
  // a parent uses startsWith, which is "fuzzy" enough for filtering).
  const directCount = new Map<FolderKey, number>();
  const incr = (key: FolderKey) => directCount.set(key, (directCount.get(key) ?? 0) + 1);

  for (const a of assets) {
    incr(a.folderPath ?? ROOT_FOLDER_KEY);
  }

  // Discover the dynamic children of /tasks and /sandbox.
  const taskChildren = new Set<string>();
  const sandboxChildren = new Set<string>();
  // User-defined top-level folders (anything that doesn't begin with /tasks or /sandbox).
  const userTopLevels = new Set<string>();
  // Children under user-defined top-levels.
  const userChildren = new Map<string, Set<string>>();

  for (const a of assets) {
    const fp = a.folderPath;
    if (!fp) continue;
    if (fp === TASKS_FOLDER_KEY || fp.startsWith(`${TASKS_FOLDER_KEY}/`)) {
      const seg = fp.slice(TASKS_FOLDER_KEY.length + 1).split('/')[0];
      if (seg) taskChildren.add(`${TASKS_FOLDER_KEY}/${seg}`);
    } else if (fp === SANDBOX_FOLDER_KEY || fp.startsWith(`${SANDBOX_FOLDER_KEY}/`)) {
      const seg = fp.slice(SANDBOX_FOLDER_KEY.length + 1).split('/')[0];
      if (seg) sandboxChildren.add(`${SANDBOX_FOLDER_KEY}/${seg}`);
    } else {
      // User-defined branch. Collect top-level + children.
      const segs = fp.split('/').filter(Boolean);
      if (segs.length === 0) continue;
      const top = `/${segs[0]}`;
      userTopLevels.add(top);
      if (segs.length > 1) {
        const set = userChildren.get(top) ?? new Set<string>();
        set.add(`/${segs[0]}/${segs.slice(1).join('/')}`);
        userChildren.set(top, set);
      }
    }
  }

  // Folders the user created in this session but haven't put assets in
  // yet. Stored as full paths starting with '/'. Show them as empty
  // top-level branches.
  for (const path of customFolders) {
    userTopLevels.add(path);
  }

  const nodes: FolderNode[] = [];
  // Root (always pinned at the top).
  nodes.push({
    key: ROOT_FOLDER_KEY,
    label: 'Root',
    depth: 0,
    count: directCount.get(ROOT_FOLDER_KEY) ?? 0,
    pinned: true,
  });
  // release201/09 §9.4a.3 — `Tasks/` and `Sandbox/` always-render
  // fixed folders are retired. They previously surfaced one folder per
  // task ID (cmp***) and spammed CEO with workspace artifact noise.
  // Task products now live in task drawer's Artifacts tab; if a user
  // toggles "Show task artifacts" we still build any `/tasks/<id>`
  // children below from existing rows (folderPath bytes are unchanged
  // — only the tree projection differs).
  void TASKS_FOLDER_KEY;
  void SANDBOX_FOLDER_KEY;
  void taskChildren;
  void sandboxChildren;
  // User-defined top-levels (alphabetical).
  for (const top of [...userTopLevels].sort()) {
    nodes.push({
      key: top,
      label: top.slice(1) || '/',
      depth: 0,
      count: directCount.get(top) ?? 0,
      pinned: false,
    });
    const children = userChildren.get(top);
    if (children) {
      for (const child of [...children].sort()) {
        nodes.push({
          key: child,
          label: child.slice(top.length + 1),
          depth: 1,
          count: directCount.get(child) ?? 0,
          pinned: false,
        });
      }
    }
  }
  return nodes;
}

/**
 * PATCH /api/im/assets/:id { folderPath } — used by drag-to-folder.
 *
 * targetKey === '__root__'  → set folderPath to null
 * targetKey === '/tasks' or '/sandbox' → reject (these are auto-tagged
 *                                        branches; users shouldn't move
 *                                        arbitrary assets into them)
 * otherwise the literal path is sent.
 */
async function moveAssetToFolder(
  assetId: string,
  targetKey: FolderKey,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (targetKey === TASKS_FOLDER_KEY || targetKey === SANDBOX_FOLDER_KEY) {
    return {
      ok: false,
      message: `${targetKey} is auto-managed by the daemon — pick a sub-folder or a user-created folder`,
    };
  }
  const folderPath = targetKey === ROOT_FOLDER_KEY ? null : normalizeFolderPath(targetKey);
  const token = getWorkspaceToken();
  if (!token) return { ok: false, message: 'Not authenticated' };
  const res = await fetch(`/api/im/assets/${encodeURIComponent(assetId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath }),
  }).catch((err) => ({ ok: false, status: 0, _err: err }) as const);
  if ('_err' in res) return { ok: false, message: (res._err as Error).message };
  if (!res.ok) {
    const text = await (res as Response).text().catch(() => '');
    return { ok: false, message: `${(res as Response).status} ${text.slice(0, 120)}` };
  }
  return { ok: true };
}

function normalizeFolderPath(raw: string): string {
  const segments = raw
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.length > 0 ? `/${segments.join('/')}` : ROOT_FOLDER_KEY;
}

type GroupBy = 'time' | 'type' | 'source';
type SortBy = 'newest' | 'oldest' | 'name' | 'size';

/**
 * Sort the asset list before grouping so each section is internally ordered.
 *
 * newest/oldest → createdAt (Date.parse; unparseable sorts last)
 * name          → assetTitle localeCompare (uses the filename map for the
 *                 same title the card shows)
 * size          → sizeBytes desc (null treated as 0)
 */
function sortAssets(
  assets: AssetDTO[],
  sortBy: SortBy,
  fileByAssetId: Map<string, WorkspaceFileDTO>,
): AssetDTO[] {
  const next = [...assets];
  const ts = (a: AssetDTO) => {
    const v = Date.parse(a.createdAt);
    return Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;
  };
  switch (sortBy) {
    case 'newest':
      next.sort((a, b) => ts(b) - ts(a));
      break;
    case 'oldest':
      next.sort((a, b) => ts(a) - ts(b));
      break;
    case 'name':
      next.sort((a, b) =>
        assetTitle(a, fileByAssetId.get(a.id)).localeCompare(assetTitle(b, fileByAssetId.get(b.id))),
      );
      break;
    case 'size':
      next.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
      break;
  }
  return next;
}

/** Build sections + per-section counts, dropping empties, preserving the
 *  declared bucket order. */
function bucketize(assets: AssetDTO[], order: string[], keyOf: (a: AssetDTO) => string) {
  const byKey = new Map<string, AssetDTO[]>(order.map((k) => [k, []]));
  for (const asset of assets) {
    const key = keyOf(asset);
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(asset);
  }
  return order
    .map((label) => ({ label: `${label} · ${byKey.get(label)?.length ?? 0}`, items: byKey.get(label) ?? [] }))
    .filter((group) => group.items.length > 0);
}

function groupAssets(assets: AssetDTO[], groupBy: GroupBy) {
  if (groupBy === 'type') {
    const TYPE_LABEL: Record<string, string> = {
      image: 'Images',
      doc: 'Documents',
      pdf: 'PDFs',
      data: 'Data',
      code: 'Code',
      other: 'Other',
    };
    return bucketize(
      assets,
      ['Images', 'Documents', 'PDFs', 'Data', 'Code', 'Other'],
      (a) => TYPE_LABEL[assetTypeTone(a)] ?? 'Other',
    );
  }
  if (groupBy === 'source') {
    const SOURCE_LABEL: Record<string, string> = {
      task: 'From tasks',
      agent: 'Agent output',
      upload: 'Uploaded',
    };
    return bucketize(assets, ['Uploaded', 'From tasks', 'Agent output'], (a) => SOURCE_LABEL[assetSource(a).tone]);
  }
  // time (default)
  const now = Date.now();
  const groups = [
    { label: 'Today', items: [] as AssetDTO[] },
    { label: 'Yesterday', items: [] as AssetDTO[] },
    { label: 'This Week', items: [] as AssetDTO[] },
    { label: 'Earlier', items: [] as AssetDTO[] },
  ];
  for (const asset of assets) {
    const ts = Date.parse(asset.createdAt);
    const age = Number.isFinite(ts) ? now - ts : Number.POSITIVE_INFINITY;
    if (age < 86_400_000) groups[0].items.push(asset);
    else if (age < 172_800_000) groups[1].items.push(asset);
    else if (age < 7 * 86_400_000) groups[2].items.push(asset);
    else groups[3].items.push(asset);
  }
  return groups
    .filter((group) => group.items.length > 0)
    .map((group) => ({ label: `${group.label} · ${group.items.length}`, items: group.items }));
}
