'use client';

import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Archive,
  CheckCircle2,
  CloudDownload,
  Edit3,
  Eye,
  FileCode2,
  FileText,
  Folder,
  FolderPlus,
  Home,
  ImageIcon,
  Loader2,
  MoreVertical,
  Plus,
  Search,
  Table2,
  Trash2,
} from 'lucide-react';

import { getWorkspaceToken, imFetch } from '../lib/im-api';
import { radius, surface } from '../lib/design';
import { useI18n } from '@/contexts/i18n-context';
import { SurfaceHeader } from './surface-header';
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
 * Wave-9 Phase 3 folder model.
 *
 * folderPath is a free-form string column on im_assets (no folder table).
 * In the UI we encode "root" (folderPath IS NULL) as the sentinel
 * `__root__` so it can key into a Map. Two top-level branches are
 * auto-populated by the daemon side: `/tasks/{taskId}` for chat-mention
 * agent outputs and `/sandbox/{taskId}` for container artifacts. User
 * uploads default to NULL (root) per design review decision ③.
 */
type FolderKey = string;
const ROOT_FOLDER_KEY: FolderKey = '__root__';
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

type AssetFilter = 'all' | 'images' | 'docs' | 'code' | 'data' | 'other';

const FILTERS: Array<{ key: AssetFilter; label: string }> = [
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
  const [downloadingAssetId, setDownloadingAssetId] = useState<string | null>(null);
  const [menuAssetId, setMenuAssetId] = useState<string | null>(null);
  const [busyAssetId, setBusyAssetId] = useState<string | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);

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
   * Defense filter (Wave-9 Phase 3.0): hide kind='task-result' even if
   * migration 310 was missed or a stale dev-cache compiled chunk
   * accidentally writes them. Cloud no longer creates these (d3748d90),
   * but the UI guarantees they don't surface regardless.
   */
  const visibleAssets = useMemo(() => assets.filter((a) => a.kind !== 'task-result'), [assets]);

  const filteredAssets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return visibleAssets.filter((asset) => {
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
  }, [visibleAssets, fileByAssetId, filter, query, currentFolder]);

  const folderTree = useMemo(() => buildFolderTree(visibleAssets, customFolders), [visibleAssets, customFolders]);

  const grouped = useMemo(() => groupAssets(filteredAssets), [filteredAssets]);

  async function downloadAsset(asset: AssetDTO) {
    const token = getWorkspaceToken();
    if (!token) return;
    setDownloadingAssetId(asset.id);
    try {
      const res = await fetch(`/api/im/assets/${encodeURIComponent(asset.id)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        notify?.('Download failed.', 'error');
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
    const nextTitle = window.prompt('Rename asset', currentTitle)?.trim();
    if (!nextTitle || nextTitle === currentTitle) return;
    setBusyAssetId(asset.id);
    try {
      const res = await imFetch<AssetDTO>(`/assets/${encodeURIComponent(asset.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ filename: nextTitle }),
      });
      if (!res.ok) {
        notify?.(`Rename failed: ${res.message}`, 'error');
        return;
      }
      await onAssetsChanged?.();
      notify?.(`Renamed to "${nextTitle}".`, 'success');
    } finally {
      setBusyAssetId(null);
    }
  }

  async function deleteAsset(asset: AssetDTO) {
    setMenuAssetId(null);
    const title = assetTitle(asset, fileByAssetId.get(asset.id));
    if (!window.confirm(`Delete "${title}"?`)) return;
    setBusyAssetId(asset.id);
    try {
      const res = await imFetch(`/assets/${encodeURIComponent(asset.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        notify?.(`Delete failed: ${res.message}`, 'error');
        return;
      }
      await onAssetsChanged?.();
      notify?.(`Deleted "${title}".`, 'success');
    } finally {
      setBusyAssetId(null);
    }
  }

  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (!onUploadFiles || !hasFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDraggingFiles(true);
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDraggingFiles(false);
    }
  }

  async function handleDrop(event: DragEvent<HTMLElement>) {
    if (!onUploadFiles) return;
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    setDraggingFiles(false);
    await onUploadFiles(files);
  }

  return (
    <section
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
              className={`flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-2xl border px-3 xl:max-w-sm ${
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
      >
        <div className="flex gap-2 overflow-x-auto pb-1">
          {FILTERS.map((item) => {
            const active = filter === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setFilter(item.key)}
                className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? isDark
                      ? 'border-violet-400/30 bg-violet-500/20 text-violet-100'
                      : 'border-violet-200 bg-violet-100 text-violet-800'
                    : isDark
                      ? 'border-white/[0.07] text-zinc-400 hover:bg-white/[0.04]'
                      : 'border-zinc-200 text-zinc-600 hover:bg-zinc-100'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </SurfaceHeader>

      <div className="flex min-h-0 flex-1">
        <FolderSidebar
          isDark={isDark}
          tree={folderTree}
          current={currentFolder}
          dragOverFolder={dragOverFolder}
          onSelect={(key) => setCurrentFolder(key)}
          onDragOverFolder={(key) => setDragOverFolder(key)}
          onDragLeaveFolder={() => setDragOverFolder(null)}
          onDropAsset={async (key, assetId) => {
            setDragOverFolder(null);
            setMovingAssetId(assetId);
            const res = await moveAssetToFolder(assetId, key);
            setMovingAssetId(null);
            if (!res.ok) {
              notify?.(`Move failed: ${res.message}`, 'error');
              return;
            }
            notify?.('Moved.', 'success');
            await onAssetsChanged?.();
          }}
          onCreateFolder={() => {
            setNewFolderName('');
            setCreatingFolder(true);
          }}
        />
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
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
            <div className="space-y-6">
              {grouped.map((group) => (
                <section key={group.label}>
                  <h3
                    className={`mb-2 text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                  >
                    {group.label}
                  </h3>
                  <div className="grid grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-3">
                    {group.items.map((asset, index) => {
                      const file = fileByAssetId.get(asset.id);
                      return (
                        <motion.div
                          key={asset.id}
                          draggable
                          onDragStartCapture={(event: DragEvent<HTMLDivElement>) => {
                            const payload = {
                              id: asset.id,
                              title: assetTitle(asset, file),
                              kind: asset.kind,
                              mime: asset.mime,
                              sizeBytes: asset.sizeBytes,
                              contentHash: asset.contentHash,
                            };
                            event.dataTransfer.effectAllowed = 'copy';
                            event.dataTransfer.setData('application/x-prismer-asset', JSON.stringify(payload));
                            event.dataTransfer.setData('text/plain', `asset:${asset.id}`);
                          }}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ type: 'spring', stiffness: 320, damping: 28, delay: index * 0.03 }}
                          className={`group relative flex min-h-[136px] cursor-grab flex-col justify-between border p-3 transition-colors active:cursor-grabbing ${radius.card} ${surface.card[theme]} ${
                            isDark ? 'hover:bg-white/[0.055]' : 'hover:bg-white'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => onOpenInspector({ kind: 'asset', assetId: asset.id })}
                            className="flex min-w-0 flex-1 items-start gap-3 text-left"
                          >
                            <AssetThumb asset={asset} isDark={isDark} />
                            <span className="min-w-0 flex-1">
                              <span
                                className={`block truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}
                              >
                                {assetTitle(asset, file)}
                              </span>
                              <span
                                className={`mt-0.5 block truncate text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                              >
                                {assetMeta(asset)} · {new Date(asset.createdAt).toLocaleString()}
                              </span>
                              {asset.description && asset.description.trim().length > 0 ? (
                                <span
                                  data-testid={`library-files-asset-description-${asset.id}`}
                                  className={`mt-1 block text-[11px] leading-snug ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}
                                  // Two-line clamp keeps card height predictable when descriptions
                                  // approach the 500-char limit.
                                  style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                                >
                                  {asset.description}
                                </span>
                              ) : null}
                              <span className="mt-2 flex flex-wrap gap-1.5">
                                <StatusBadge status={asset.ingestStatus ?? 'synced'} isDark={isDark} />
                                {(asset.memoryPages?.length ?? 0) > 0 ? (
                                  <span
                                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-medium ${
                                      isDark
                                        ? 'border-cyan-400/20 bg-cyan-500/10 text-cyan-100'
                                        : 'border-cyan-200 bg-cyan-50 text-cyan-700'
                                    }`}
                                  >
                                    <FileText className="h-3 w-3" />
                                    {asset.memoryPages!.length} memory page{asset.memoryPages!.length === 1 ? '' : 's'}
                                  </span>
                                ) : null}
                              </span>
                            </span>
                          </button>
                          <div className="mt-3 flex items-center justify-between gap-2">
                            <span
                              className={`truncate font-mono text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                            >
                              {asset.contentHash.slice(0, 12)}
                            </span>
                            <div className="flex shrink-0 items-center gap-1">
                              <AssetIconButton
                                isDark={isDark}
                                title="Download"
                                disabled={downloadingAssetId === asset.id || busyAssetId === asset.id}
                                onClick={() => void downloadAsset(asset)}
                              >
                                {downloadingAssetId === asset.id ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <CloudDownload className="h-4 w-4" />
                                )}
                              </AssetIconButton>
                              <AssetIconButton
                                isDark={isDark}
                                title="Asset actions"
                                disabled={busyAssetId === asset.id}
                                onClick={() => setMenuAssetId((current) => (current === asset.id ? null : asset.id))}
                              >
                                {busyAssetId === asset.id ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <MoreVertical className="h-4 w-4" />
                                )}
                              </AssetIconButton>
                            </div>
                          </div>
                          {menuAssetId === asset.id ? (
                            <AssetCardMenu
                              isDark={isDark}
                              onOpen={() => {
                                setMenuAssetId(null);
                                onOpenInspector({ kind: 'asset', assetId: asset.id });
                              }}
                              onRename={() => void renameAsset(asset)}
                              onDownload={() => {
                                setMenuAssetId(null);
                                void downloadAsset(asset);
                              }}
                              onDelete={() => void deleteAsset(asset)}
                            />
                          ) : null}
                        </motion.div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
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
                notify?.('Folder name cannot be empty.', 'error');
                return;
              }
              if (trimmed.startsWith('tasks') || trimmed.startsWith('sandbox')) {
                notify?.('`tasks` and `sandbox` are reserved for daemon-managed folders.', 'error');
                return;
              }
              const path = `/${trimmed}`;
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
  onSelect: (key: FolderKey | null) => void;
  onDragOverFolder: (key: FolderKey) => void;
  onDragLeaveFolder: () => void;
  onDropAsset: (key: FolderKey, assetId: string) => void | Promise<void>;
  onCreateFolder: () => void;
}) {
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
          Folders
        </span>
        <button
          type="button"
          onClick={onCreateFolder}
          title="New folder"
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
        <span className="flex-1 truncate">All</span>
      </button>
      {tree.map((node) => {
        const active = current === node.key;
        const dropTarget = dragOverFolder === node.key;
        const Icon = node.key === ROOT_FOLDER_KEY ? Home : Folder;
        return (
          <button
            key={node.key}
            type="button"
            onClick={() => onSelect(node.key)}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes('application/x-prismer-asset')) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                onDragOverFolder(node.key);
              }
            }}
            onDragLeave={() => {
              if (dragOverFolder === node.key) onDragLeaveFolder();
            }}
            onDrop={(event) => {
              const raw = event.dataTransfer.getData('application/x-prismer-asset');
              if (!raw) return;
              event.preventDefault();
              try {
                const parsed = JSON.parse(raw) as { id?: string };
                if (parsed?.id) void onDropAsset(node.key, parsed.id);
              } catch {
                /* ignore malformed payload */
              }
            }}
            style={{ paddingLeft: `${8 + node.depth * 12}px` }}
            className={`mb-0.5 flex w-full items-center gap-2 rounded-xl py-1.5 pr-2 text-left text-xs transition-colors ${
              active
                ? isDark
                  ? 'bg-violet-500/20 text-violet-100'
                  : 'bg-violet-100 text-violet-800'
                : dropTarget
                  ? isDark
                    ? 'bg-emerald-500/20 text-emerald-100 ring-1 ring-emerald-400/40'
                    : 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300'
                  : isDark
                    ? 'text-zinc-300 hover:bg-white/[0.04]'
                    : 'text-zinc-700 hover:bg-zinc-100'
            }`}
          >
            <Icon className="h-3.5 w-3.5 opacity-70" />
            <span className="flex-1 truncate">{node.label}</span>
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
        <h3 className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>New folder</h3>
        <p className={`mt-1 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          Free-form path. Leading slash optional. `tasks` and `sandbox` are reserved.
        </p>
        <input
          autoFocus
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onConfirm();
            if (event.key === 'Escape') onCancel();
          }}
          placeholder="my-references"
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
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-xl px-3 py-1.5 text-xs font-semibold text-white ${
              isDark ? 'bg-violet-500 hover:bg-violet-400' : 'bg-violet-600 hover:bg-violet-700'
            }`}
          >
            Create
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function hasFileDrag(event: DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types ?? []).includes('Files');
}

function AssetIconButton({
  isDark,
  title,
  disabled,
  onClick,
  children,
}: {
  isDark: boolean;
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      title={title}
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl disabled:cursor-not-allowed disabled:opacity-50 ${
        isDark
          ? 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100'
          : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
      }`}
    >
      {children}
    </button>
  );
}

function AssetCardMenu({
  isDark,
  onOpen,
  onRename,
  onDownload,
  onDelete,
}: {
  isDark: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDownload: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`absolute bottom-12 right-3 z-30 w-44 overflow-hidden rounded-2xl border p-1 shadow-2xl ${
        isDark ? 'border-white/[0.08] bg-zinc-950 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
      }`}
      onClick={(event) => event.stopPropagation()}
    >
      <AssetMenuItem isDark={isDark} icon={<Eye className="h-3.5 w-3.5" />} label="Open" onClick={onOpen} />
      <AssetMenuItem isDark={isDark} icon={<Edit3 className="h-3.5 w-3.5" />} label="Rename" onClick={onRename} />
      <AssetMenuItem
        isDark={isDark}
        icon={<CloudDownload className="h-3.5 w-3.5" />}
        label="Download"
        onClick={onDownload}
      />
      <div className={`my-1 h-px ${isDark ? 'bg-white/[0.07]' : 'bg-zinc-100'}`} />
      <AssetMenuItem
        isDark={isDark}
        danger
        icon={<Trash2 className="h-3.5 w-3.5" />}
        label="Delete"
        onClick={onDelete}
      />
    </div>
  );
}

function AssetMenuItem({
  isDark,
  danger,
  icon,
  label,
  onClick,
}: {
  isDark: boolean;
  danger?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      className={`flex h-9 w-full items-center gap-2 rounded-xl px-2.5 text-left text-xs font-medium ${
        danger
          ? isDark
            ? 'text-red-200 hover:bg-red-500/10'
            : 'text-red-700 hover:bg-red-50'
          : isDark
            ? 'text-zinc-200 hover:bg-white/[0.06]'
            : 'text-zinc-700 hover:bg-zinc-100'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function AssetThumb({ asset, isDark }: { asset: AssetDTO; isDark: boolean }) {
  return (
    <span
      className={`flex h-[60px] w-[60px] shrink-0 items-center justify-center rounded-2xl ${
        isDark ? 'bg-violet-500/12 text-violet-200' : 'bg-violet-50 text-violet-700'
      }`}
    >
      {renderAssetIcon(asset)}
    </span>
  );
}

function StatusBadge({ status, isDark }: { status: string; isDark: boolean }) {
  const normalized = status || 'synced';
  const ready = normalized === 'memory-ready' || normalized === 'indexed' || normalized === 'synced';
  const failed = normalized === 'failed';
  const className = failed
    ? isDark
      ? 'border-red-400/20 bg-red-500/10 text-red-200'
      : 'border-red-200 bg-red-50 text-red-700'
    : ready
      ? isDark
        ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200'
        : 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : isDark
        ? 'border-amber-400/20 bg-amber-500/10 text-amber-100'
        : 'border-amber-200 bg-amber-50 text-amber-700';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-medium ${className}`}
    >
      <CheckCircle2 className="h-3 w-3" />
      {statusLabel(normalized)}
    </span>
  );
}

function statusLabel(status: string) {
  switch (status) {
    case 'memory-ready':
      return 'Memory ready';
    case 'asset-only':
      return 'Asset only';
    case 'pending':
      return 'Pending ingest';
    case 'failed':
      return 'Ingest failed';
    case 'indexed':
      return 'Indexed';
    default:
      return 'Synced';
  }
}

function renderAssetIcon(asset: AssetDTO): ReactNode {
  const mime = asset.mime ?? '';
  if (isImageAsset(asset)) return <ImageIcon className="h-6 w-6" />;
  if (isDataAsset(asset)) return <Table2 className="h-6 w-6" />;
  if (isCodeAsset(asset)) return <FileCode2 className="h-6 w-6" />;
  if (mime) return <FileText className="h-6 w-6" />;
  return <Archive className="h-6 w-6" />;
}

function isImageAsset(asset: AssetDTO): boolean {
  return (asset.mime ?? '').startsWith('image/');
}

function isDocAsset(asset: AssetDTO): boolean {
  const mime = asset.mime ?? '';
  return mime.includes('pdf') || mime.includes('text') || asset.kind.includes('document');
}

function isCodeAsset(asset: AssetDTO): boolean {
  const mime = asset.mime ?? '';
  return (
    mime.includes('javascript') || mime.includes('typescript') || mime.includes('python') || asset.kind.includes('code')
  );
}

function isDataAsset(asset: AssetDTO): boolean {
  const mime = asset.mime ?? '';
  return mime.includes('json') || mime.includes('csv') || asset.kind.includes('dataset');
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
  // /tasks branch.
  nodes.push({
    key: TASKS_FOLDER_KEY,
    label: 'Tasks',
    depth: 0,
    count: directCount.get(TASKS_FOLDER_KEY) ?? 0,
    pinned: true,
  });
  for (const child of [...taskChildren].sort()) {
    nodes.push({
      key: child,
      label: child.slice(TASKS_FOLDER_KEY.length + 1),
      depth: 1,
      count: directCount.get(child) ?? 0,
      pinned: false,
    });
  }
  // /sandbox branch.
  nodes.push({
    key: SANDBOX_FOLDER_KEY,
    label: 'Sandbox',
    depth: 0,
    count: directCount.get(SANDBOX_FOLDER_KEY) ?? 0,
    pinned: true,
  });
  for (const child of [...sandboxChildren].sort()) {
    nodes.push({
      key: child,
      label: child.slice(SANDBOX_FOLDER_KEY.length + 1),
      depth: 1,
      count: directCount.get(child) ?? 0,
      pinned: false,
    });
  }
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
  const folderPath = targetKey === ROOT_FOLDER_KEY ? null : targetKey;
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

function groupAssets(assets: AssetDTO[]) {
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
  return groups.filter((group) => group.items.length > 0);
}

function assetTitle(asset: AssetDTO, file?: WorkspaceFileDTO) {
  if (asset.filename) return asset.filename;
  const title = asset.metadata?.title;
  if (typeof title === 'string' && title.trim()) return title;
  if (file?.path) return file.path;
  return asset.contentHash.slice(0, 16);
}

function assetMeta(asset: AssetDTO) {
  const derived = asset.derivationKind ? `${asset.derivationKind}` : null;
  const parts = [derived ?? asset.kind, asset.mime ?? 'unknown', formatBytes(asset.sizeBytes)];
  return parts.join(' · ');
}

function formatBytes(bytes: number | null) {
  if (bytes == null) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
