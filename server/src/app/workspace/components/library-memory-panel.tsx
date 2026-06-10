'use client';

/**
 * LibraryMemoryPanel — Memory Line B / B2.
 *
 * Three-pane layout for the workspace memory layer:
 *
 *  - Left  · folder tree derived from `MemoryPageSummaryDTO.path`
 *  - Mid   · pageType-grouped list with filter chips (stale, visibility,
 *            page type) and search
 *  - Right · markdown preview + Source / Backlinks / Provenance / Versions
 *
 * The panel is read-only. Write actions (archive/visibility/promote/
 * soft-delete/stale toggle/save-as-memory) ship in B4 and mount on top of
 * the same detail pane.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Archive,
  ChevronDown,
  Eye,
  Filter,
  FolderTree,
  Inbox,
  Loader2,
  Network,
  RefreshCcw,
  Search,
  Trash2,
  Unlink,
} from 'lucide-react';

import {
  archiveMemoryPage,
  changeMemoryVisibility,
  deleteMemoryPage,
  getMemoryPage,
  getMemoryPageLinks,
  getMemoryPageVersions,
  listMemoryPages,
  type MemoryPageDetailDTO,
  type MemoryPageLinksDTO,
  type MemoryPageSummaryDTO,
  type MemoryPageVersionRowDTO,
} from '../lib/memory-api';
import { LibraryMemoryActions } from './library-memory-actions';
import { LibraryMemoryRecallTrace } from './library-memory-recall-trace';
import { MemoryTextPreview } from './memory-text-preview';

interface LibraryMemoryPanelProps {
  workspaceId: string;
  isDark: boolean;
  /** External jump request (e.g. from ⌘K modal or Asset detail "View as Memory"). */
  jumpToPath?: string | null;
  /** Cleared after the consumer scrolls to the requested page. */
  onJumpHandled?: () => void;
  /** B4 mutation context — current viewer + active task scope. */
  myImUserId?: string | null;
  isOwnerHuman?: boolean;
  activeTaskId?: string | null;
  notify?: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** B7 — number of pending proposals; drives the alert bar. */
  pendingProposalCount?: number;
  /** B7 — invoked when the user clicks the alert bar to open the review modal. */
  onOpenProposalReview?: () => void;
}

const PAGE_TYPE_ORDER = ['hub', 'leaf', 'index', 'dataset', 'decision', 'procedure', 'glossary', 'archive'];

type StaleFilter = 'false' | 'true' | 'all';

export function LibraryMemoryPanel({
  workspaceId,
  isDark,
  jumpToPath,
  onJumpHandled,
  myImUserId = null,
  isOwnerHuman = false,
  activeTaskId = null,
  notify,
  pendingProposalCount = 0,
  onOpenProposalReview,
}: LibraryMemoryPanelProps) {
  const [topView, setTopView] = useState<'pages' | 'recall'>('pages');
  const [pages, setPages] = useState<MemoryPageSummaryDTO[]>([]);
  const [pagesLoading, setPagesLoading] = useState(true);
  const [pagesError, setPagesError] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [pageTypeFilter, setPageTypeFilter] = useState<string | 'all'>('all');
  const [staleFilter, setStaleFilter] = useState<StaleFilter>('false');
  const [query, setQuery] = useState('');
  /** Bumped after a successful mutation so the list refetches. */
  const [refreshTick, setRefreshTick] = useState(0);
  /** B11 — multi-select state for bulk archive / delete / visibility. */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);
  const [bulkConfirmDelete, setBulkConfirmDelete] = useState(false);

  // Detail state.
  const [detail, setDetail] = useState<MemoryPageDetailDTO | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [links, setLinks] = useState<MemoryPageLinksDTO | null>(null);
  const [linksLoading, setLinksLoading] = useState(false);
  const [versions, setVersions] = useState<MemoryPageVersionRowDTO[] | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);

  // Initial + filter-driven page list refresh.
  useEffect(() => {
    if (!workspaceId) return;
    const ac = new AbortController();
    setPagesLoading(true);
    setPagesError(null);
    listMemoryPages({
      workspaceId,
      stale: staleFilter,
      pageType: pageTypeFilter === 'all' ? undefined : pageTypeFilter,
      limit: 200,
      signal: ac.signal,
    }).then((res) => {
      if (ac.signal.aborted) return;
      if (res.ok) {
        setPages(res.data ?? []);
      } else {
        setPagesError(res.message);
      }
      setPagesLoading(false);
    });
    return () => ac.abort();
  }, [workspaceId, staleFilter, pageTypeFilter, refreshTick]);

  // Honor external jump-to-path requests by selecting the matching page id.
  useEffect(() => {
    if (!jumpToPath || pages.length === 0) return;
    const match = pages.find((p) => p.path === jumpToPath || p.id === jumpToPath);
    if (match) {
      setSelectedFolder(folderForPath(match.path));
      setSelectedPageId(match.id);
      onJumpHandled?.();
    }
  }, [jumpToPath, pages, onJumpHandled]);

  // Detail load.
  useEffect(() => {
    if (!selectedPageId || !workspaceId) {
      setDetail(null);
      setLinks(null);
      setVersions(null);
      return;
    }
    const ac = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    setLinks(null);
    setVersions(null);
    getMemoryPage(selectedPageId, workspaceId, ac.signal).then((res) => {
      if (ac.signal.aborted) return;
      if (res.ok) {
        setDetail(res.data ?? null);
      } else {
        setDetailError(res.message);
      }
      setDetailLoading(false);
    });

    setLinksLoading(true);
    getMemoryPageLinks(selectedPageId, workspaceId, ac.signal).then((res) => {
      if (ac.signal.aborted) return;
      if (res.ok) setLinks(res.data ?? null);
      setLinksLoading(false);
    });

    setVersionsLoading(true);
    getMemoryPageVersions(selectedPageId, workspaceId, ac.signal).then((res) => {
      if (ac.signal.aborted) return;
      if (res.ok) setVersions(res.data?.versions ?? []);
      setVersionsLoading(false);
    });

    return () => ac.abort();
  }, [selectedPageId, workspaceId, refreshTick]);

  // Derive folder tree from page paths (e.g. `memory/decisions/q4-cogs.md`).
  const folderTree = useMemo(() => buildFolderTree(pages), [pages]);

  // Search + filter list.
  const filteredPages = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pages
      .filter((p) => {
        if (selectedFolder && !p.path.startsWith(selectedFolder)) return false;
        if (q) {
          const haystack = `${p.path} ${p.title ?? ''}`.toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const ai = PAGE_TYPE_ORDER.indexOf(a.pageType);
        const bi = PAGE_TYPE_ORDER.indexOf(b.pageType);
        const an = ai === -1 ? PAGE_TYPE_ORDER.length : ai;
        const bn = bi === -1 ? PAGE_TYPE_ORDER.length : bi;
        if (an !== bn) return an - bn;
        return a.path.localeCompare(b.path);
      });
  }, [pages, selectedFolder, query]);

  // Group by pageType for the section headers.
  const grouped = useMemo(() => {
    const acc: Record<string, MemoryPageSummaryDTO[]> = {};
    for (const p of filteredPages) {
      (acc[p.pageType] ??= []).push(p);
    }
    return acc;
  }, [filteredPages]);

  // Drop selections that filtered out (e.g. user toggled stale filter).
  const filteredIdSet = useMemo(() => new Set(filteredPages.map((p) => p.id)), [filteredPages]);
  useEffect(() => {
    setSelectedIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) if (filteredIdSet.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [filteredIdSet]);

  const allFilteredSelected = filteredPages.length > 0 && filteredPages.every((p) => selectedIds.has(p.id));
  const toggleSelectAll = () =>
    setSelectedIds((prev) => {
      if (prev.size === filteredPages.length) return new Set();
      return new Set(filteredPages.map((p) => p.id));
    });
  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  type BulkResult = { ok: number; fails: Array<{ id: string; message: string }> };

  async function runBulk(
    label: string,
    op: (id: string) => Promise<{ ok: true } | { ok: false; status: number; message: string }>,
  ): Promise<BulkResult> {
    setBulkBusy(label);
    const ids = Array.from(selectedIds);
    let ok = 0;
    const fails: Array<{ id: string; message: string }> = [];
    for (const id of ids) {
      try {
        const res = await op(id);
        if (res.ok) ok += 1;
        else fails.push({ id, message: res.message });
      } catch (err) {
        fails.push({ id, message: err instanceof Error ? err.message : String(err) });
      }
    }
    setBulkBusy(null);
    setRefreshTick((tick) => tick + 1);
    setSelectedIds(new Set());
    if (fails.length === 0) {
      notify?.(`${label}: ${ok} page${ok === 1 ? '' : 's'} succeeded`, 'success');
    } else {
      notify?.(
        `${label}: ${ok} succeeded · ${fails.length} failed (${fails[0]?.message ?? ''})`,
        fails.length === ids.length ? 'error' : 'info',
      );
    }
    return { ok, fails };
  }

  const handleBulkArchive = () => runBulk('Bulk archive', (id) => archiveMemoryPage(id, workspaceId));
  const handleBulkDelete = () => runBulk('Bulk soft-delete', (id) => deleteMemoryPage(id, workspaceId));
  const handleBulkVisibility = (target: string) => {
    const expanded =
      target === 'human:self' && myImUserId
        ? `human:${myImUserId}`
        : target === 'task:current' && activeTaskId
          ? `task:${activeTaskId}`
          : target;
    return runBulk('Bulk visibility', (id) => {
      const page = pages.find((p) => p.id === id);
      return changeMemoryVisibility(id, { workspaceId, visibility: expanded }, page?.version);
    });
  };

  return (
    <div data-testid="library-memory-panel" className="flex h-full min-h-0 flex-col">
      <div
        className={`flex shrink-0 items-center gap-2 border-b px-3 py-1.5 ${
          isDark ? 'border-white/[0.06] bg-zinc-950/40' : 'border-zinc-200 bg-zinc-50/40'
        }`}
      >
        <div
          role="tablist"
          aria-label="Memory view"
          className={`inline-flex rounded-2xl border p-0.5 ${
            isDark ? 'border-white/[0.06] bg-white/[0.02]' : 'border-zinc-200 bg-white/70'
          }`}
        >
          <TopViewTab
            isDark={isDark}
            active={topView === 'pages'}
            onClick={() => setTopView('pages')}
            testId="library-memory-tab-pages"
            icon={<FolderTree className="h-3.5 w-3.5" />}
            label="Memory pages"
          />
          <TopViewTab
            isDark={isDark}
            active={topView === 'recall'}
            onClick={() => setTopView('recall')}
            testId="library-memory-tab-recall"
            icon={<Activity className="h-3.5 w-3.5" />}
            label="Recall trace"
          />
        </div>
        {pendingProposalCount > 0 && onOpenProposalReview ? (
          <button
            type="button"
            data-testid="library-memory-proposal-alert"
            onClick={onOpenProposalReview}
            className={`ml-auto inline-flex items-center gap-1.5 rounded-2xl border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
              isDark
                ? 'border-violet-400/40 bg-violet-500/15 text-violet-100 hover:bg-violet-500/25'
                : 'border-violet-200 bg-violet-50 text-violet-900 hover:bg-violet-100'
            }`}
          >
            <Inbox className="h-3.5 w-3.5" />
            {pendingProposalCount} proposal{pendingProposalCount === 1 ? '' : 's'} waiting review
          </button>
        ) : null}
      </div>

      {topView === 'recall' ? (
        <LibraryMemoryRecallTrace workspaceId={workspaceId} isDark={isDark} />
      ) : (
        <PagesLayout
          isDark={isDark}
          pagesLoading={pagesLoading}
          pagesError={pagesError}
          pages={pages}
          folderTree={folderTree}
          selectedFolder={selectedFolder}
          setSelectedFolder={setSelectedFolder}
          query={query}
          setQuery={setQuery}
          staleFilter={staleFilter}
          setStaleFilter={setStaleFilter}
          pageTypeFilter={pageTypeFilter}
          setPageTypeFilter={setPageTypeFilter}
          filteredPages={filteredPages}
          grouped={grouped}
          selectedPageId={selectedPageId}
          setSelectedPageId={setSelectedPageId}
          workspaceId={workspaceId}
          detail={detail}
          detailLoading={detailLoading}
          detailError={detailError}
          links={links}
          linksLoading={linksLoading}
          versions={versions}
          versionsLoading={versionsLoading}
          myImUserId={myImUserId}
          isOwnerHuman={isOwnerHuman}
          activeTaskId={activeTaskId}
          notify={notify}
          setRefreshTick={setRefreshTick}
          selectedIds={selectedIds}
          toggleSelect={toggleSelect}
          allFilteredSelected={allFilteredSelected}
          toggleSelectAll={toggleSelectAll}
          bulkBusy={bulkBusy}
          bulkConfirmDelete={bulkConfirmDelete}
          setBulkConfirmDelete={setBulkConfirmDelete}
          onBulkArchive={handleBulkArchive}
          onBulkDelete={handleBulkDelete}
          onBulkVisibility={handleBulkVisibility}
        />
      )}
    </div>
  );
}

function TopViewTab({
  isDark,
  active,
  onClick,
  testId,
  icon,
  label,
}: {
  isDark: boolean;
  active: boolean;
  onClick: () => void;
  testId: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active ? 'true' : undefined}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1 text-xs font-semibold transition-colors ${
        active
          ? isDark
            ? 'bg-violet-500/20 text-violet-100'
            : 'bg-violet-100/80 text-violet-900'
          : isDark
            ? 'text-zinc-400 hover:text-zinc-100'
            : 'text-zinc-500 hover:text-zinc-900'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

interface PagesLayoutProps {
  isDark: boolean;
  pagesLoading: boolean;
  pagesError: string | null;
  pages: MemoryPageSummaryDTO[];
  folderTree: FolderNode[];
  selectedFolder: string | null;
  setSelectedFolder: (folder: string | null) => void;
  query: string;
  setQuery: (q: string) => void;
  staleFilter: StaleFilter;
  setStaleFilter: (s: StaleFilter) => void;
  pageTypeFilter: string | 'all';
  setPageTypeFilter: (p: string | 'all') => void;
  filteredPages: MemoryPageSummaryDTO[];
  grouped: Record<string, MemoryPageSummaryDTO[]>;
  selectedPageId: string | null;
  setSelectedPageId: (id: string | null) => void;
  workspaceId: string;
  detail: MemoryPageDetailDTO | null;
  detailLoading: boolean;
  detailError: string | null;
  links: MemoryPageLinksDTO | null;
  linksLoading: boolean;
  versions: MemoryPageVersionRowDTO[] | null;
  versionsLoading: boolean;
  myImUserId: string | null;
  isOwnerHuman: boolean;
  activeTaskId: string | null;
  notify?: (message: string, type?: 'success' | 'error' | 'info') => void;
  setRefreshTick: (updater: (tick: number) => number) => void;
  // ─── B11 bulk multi-select ────────────────────────────────────────────
  selectedIds: Set<string>;
  toggleSelect: (id: string) => void;
  allFilteredSelected: boolean;
  toggleSelectAll: () => void;
  bulkBusy: string | null;
  bulkConfirmDelete: boolean;
  setBulkConfirmDelete: (open: boolean) => void;
  onBulkArchive: () => Promise<{ ok: number; fails: Array<{ id: string; message: string }> }>;
  onBulkDelete: () => Promise<{ ok: number; fails: Array<{ id: string; message: string }> }>;
  onBulkVisibility: (target: string) => Promise<{ ok: number; fails: Array<{ id: string; message: string }> }>;
}

function PagesLayout({
  isDark,
  pagesLoading,
  pagesError,
  pages,
  folderTree,
  selectedFolder,
  setSelectedFolder,
  query,
  setQuery,
  staleFilter,
  setStaleFilter,
  pageTypeFilter,
  setPageTypeFilter,
  filteredPages,
  grouped,
  selectedPageId,
  setSelectedPageId,
  workspaceId,
  detail,
  detailLoading,
  detailError,
  links,
  linksLoading,
  versions,
  versionsLoading,
  myImUserId,
  isOwnerHuman,
  activeTaskId,
  notify,
  setRefreshTick,
  selectedIds,
  toggleSelect,
  allFilteredSelected,
  toggleSelectAll,
  bulkBusy,
  bulkConfirmDelete,
  setBulkConfirmDelete,
  onBulkArchive,
  onBulkDelete,
  onBulkVisibility,
}: PagesLayoutProps) {
  const visibilityMenuRef = useRef<HTMLDivElement | null>(null);
  const [visibilityMenuOpen, setVisibilityMenuOpen] = useState(false);
  useEffect(() => {
    if (!visibilityMenuOpen) return undefined;
    function onClick(event: MouseEvent) {
      if (!visibilityMenuRef.current) return;
      if (!visibilityMenuRef.current.contains(event.target as Node)) {
        setVisibilityMenuOpen(false);
      }
    }
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [visibilityMenuOpen]);
  return (
    <div data-testid="library-memory-pages-layout" className="flex flex-1 min-h-0">
      <aside
        data-testid="library-memory-tree"
        className={`hidden w-56 shrink-0 flex-col overflow-y-auto border-r p-3 md:flex ${
          isDark ? 'border-white/[0.06] bg-zinc-950/30' : 'border-zinc-200 bg-zinc-50/60'
        }`}
      >
        <div className="mb-2 flex items-center gap-1.5">
          <FolderTree className={`h-3.5 w-3.5 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`} />
          <p className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            Tree
          </p>
        </div>
        <button
          type="button"
          data-testid="library-memory-tree-all"
          onClick={() => setSelectedFolder(null)}
          className={`mb-1 rounded-lg px-2 py-1 text-left text-xs ${
            selectedFolder === null
              ? isDark
                ? 'bg-violet-500/16 text-violet-100'
                : 'bg-violet-100/80 text-violet-900'
              : isDark
                ? 'text-zinc-300 hover:bg-white/[0.04]'
                : 'text-zinc-700 hover:bg-zinc-100'
          }`}
        >
          All pages ({pages.length})
        </button>
        {folderTree.map((node) => (
          <FolderRow
            key={node.path}
            node={node}
            depth={0}
            isDark={isDark}
            selected={selectedFolder}
            onSelect={setSelectedFolder}
          />
        ))}
      </aside>

      <section
        data-testid="library-memory-list"
        className={`flex w-full max-w-md min-w-0 shrink-0 flex-col border-r ${
          isDark ? 'border-white/[0.06]' : 'border-zinc-200'
        } md:w-[24rem]`}
      >
        <div
          className={`flex items-center gap-2 border-b px-3 py-2 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
        >
          <input
            type="checkbox"
            data-testid="library-memory-bulk-select-all"
            data-checked={allFilteredSelected ? 'true' : undefined}
            checked={allFilteredSelected}
            onChange={toggleSelectAll}
            disabled={filteredPages.length === 0}
            className="h-3.5 w-3.5 cursor-pointer accent-violet-500"
            aria-label="Select all filtered pages"
          />
          <Search className={`h-3.5 w-3.5 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`} />
          <input
            data-testid="library-memory-list-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by path or title…"
            className={`flex-1 bg-transparent text-xs outline-none ${
              isDark ? 'text-zinc-200 placeholder:text-zinc-500' : 'text-zinc-800 placeholder:text-zinc-400'
            }`}
          />
        </div>
        {selectedIds.size > 0 ? (
          <div
            data-testid="library-memory-bulk-toolbar"
            data-selected-count={selectedIds.size}
            className={`flex flex-wrap items-center gap-1.5 border-b px-3 py-2 text-[11px] ${
              isDark ? 'border-white/[0.06] bg-violet-500/10' : 'border-zinc-200 bg-violet-50/70'
            }`}
          >
            <span className={`font-semibold ${isDark ? 'text-violet-100' : 'text-violet-900'}`}>
              {selectedIds.size} selected
            </span>
            <span className="ml-auto" />
            <button
              type="button"
              data-testid="library-memory-bulk-archive"
              disabled={bulkBusy !== null}
              onClick={() => void onBulkArchive()}
              className={`inline-flex items-center gap-1 rounded-xl border px-2 py-1 text-[10px] font-semibold ${
                bulkBusy !== null
                  ? 'cursor-wait opacity-60'
                  : isDark
                    ? 'border-white/[0.06] bg-white/[0.04] text-zinc-200 hover:bg-white/[0.08]'
                    : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'
              }`}
            >
              {bulkBusy === 'Bulk archive' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Archive className="h-3 w-3" />
              )}
              Archive
            </button>
            <div ref={visibilityMenuRef} className="relative">
              <button
                type="button"
                data-testid="library-memory-bulk-visibility"
                disabled={bulkBusy !== null}
                onClick={() => setVisibilityMenuOpen((prev) => !prev)}
                className={`inline-flex items-center gap-1 rounded-xl border px-2 py-1 text-[10px] font-semibold ${
                  bulkBusy !== null
                    ? 'cursor-wait opacity-60'
                    : isDark
                      ? 'border-white/[0.06] bg-white/[0.04] text-zinc-200 hover:bg-white/[0.08]'
                      : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'
                }`}
              >
                {bulkBusy === 'Bulk visibility' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Eye className="h-3 w-3" />
                )}
                Visibility
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
              {visibilityMenuOpen ? (
                <div
                  data-testid="library-memory-bulk-visibility-menu"
                  className={`absolute right-0 top-full z-20 mt-1 w-48 rounded-2xl border p-1 shadow-2xl ${
                    isDark ? 'border-white/[0.08] bg-zinc-950/95' : 'border-zinc-200 bg-white/95'
                  }`}
                >
                  {(['workspace', 'human:self', 'task:current', 'secret-ref'] as const).map((preset) => {
                    const disabled =
                      (preset === 'task:current' && !activeTaskId) ||
                      (preset === 'human:self' && (!myImUserId || !isOwnerHuman)) ||
                      (preset === 'secret-ref' && !isOwnerHuman);
                    return (
                      <button
                        key={preset}
                        type="button"
                        data-testid={`library-memory-bulk-visibility-${preset}`}
                        onClick={() => {
                          setVisibilityMenuOpen(false);
                          void onBulkVisibility(preset);
                        }}
                        disabled={disabled}
                        className={`flex w-full items-center gap-1 rounded-xl px-2.5 py-1.5 text-left text-[11px] ${
                          disabled
                            ? isDark
                              ? 'cursor-not-allowed text-zinc-600'
                              : 'cursor-not-allowed text-zinc-300'
                            : isDark
                              ? 'text-zinc-200 hover:bg-white/[0.05]'
                              : 'text-zinc-800 hover:bg-zinc-100'
                        }`}
                      >
                        {preset}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
            {bulkConfirmDelete ? (
              <>
                <span className={`font-semibold ${isDark ? 'text-rose-300' : 'text-rose-700'}`}>
                  Delete {selectedIds.size}? recoverable for 30 days.
                </span>
                <button
                  type="button"
                  data-testid="library-memory-bulk-delete-cancel"
                  onClick={() => setBulkConfirmDelete(false)}
                  className={`rounded-xl px-2 py-1 text-[10px] font-semibold ${
                    isDark ? 'text-zinc-300 hover:bg-white/[0.05]' : 'text-zinc-600 hover:bg-zinc-100'
                  }`}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="library-memory-bulk-delete-confirm"
                  onClick={() => {
                    setBulkConfirmDelete(false);
                    void onBulkDelete();
                  }}
                  className={`rounded-xl px-2 py-1 text-[10px] font-semibold ${
                    isDark
                      ? 'bg-rose-500/30 text-rose-100 hover:bg-rose-500/40'
                      : 'bg-rose-100 text-rose-900 hover:bg-rose-200'
                  }`}
                >
                  Delete
                </button>
              </>
            ) : (
              <button
                type="button"
                data-testid="library-memory-bulk-delete"
                disabled={bulkBusy !== null}
                onClick={() => setBulkConfirmDelete(true)}
                className={`inline-flex items-center gap-1 rounded-xl border px-2 py-1 text-[10px] font-semibold ${
                  bulkBusy !== null
                    ? 'cursor-wait opacity-60'
                    : isDark
                      ? 'border-rose-500/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'
                      : 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
                }`}
              >
                {bulkBusy === 'Bulk soft-delete' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Trash2 className="h-3 w-3" />
                )}
                Delete
              </button>
            )}
          </div>
        ) : null}
        <div
          className={`flex flex-wrap gap-1.5 border-b px-3 py-2 text-[10px] ${
            isDark ? 'border-white/[0.06]' : 'border-zinc-200'
          }`}
        >
          <FilterChip
            isDark={isDark}
            active={staleFilter === 'false'}
            onClick={() => setStaleFilter('false')}
            testId="library-memory-filter-stale-fresh"
            label="Fresh"
          />
          <FilterChip
            isDark={isDark}
            active={staleFilter === 'all'}
            onClick={() => setStaleFilter('all')}
            testId="library-memory-filter-stale-all"
            label="Include stale"
          />
          <span className={`mx-1 ${isDark ? 'text-zinc-700' : 'text-zinc-300'}`}>|</span>
          <FilterChip
            isDark={isDark}
            active={pageTypeFilter === 'all'}
            onClick={() => setPageTypeFilter('all')}
            testId="library-memory-filter-pageType-all"
            label="Any type"
          />
          {PAGE_TYPE_ORDER.map((pt) => (
            <FilterChip
              key={pt}
              isDark={isDark}
              active={pageTypeFilter === pt}
              onClick={() => setPageTypeFilter(pt)}
              testId={`library-memory-filter-pageType-${pt}`}
              label={pt}
            />
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {pagesLoading ? (
            <ListLoading isDark={isDark} />
          ) : pagesError ? (
            <ErrorRow isDark={isDark} message={pagesError} testId="library-memory-list-error" />
          ) : filteredPages.length === 0 ? (
            <EmptyRow isDark={isDark} testId="library-memory-list-empty" />
          ) : (
            PAGE_TYPE_ORDER.filter((pt) => grouped[pt]?.length).map((pt) => (
              <div key={pt} className="mb-3" data-testid={`library-memory-list-section-${pt}`}>
                <p
                  className={`mb-1 px-2 text-[10px] font-bold uppercase tracking-wider ${
                    isDark ? 'text-zinc-500' : 'text-zinc-500'
                  }`}
                >
                  {pt} · {grouped[pt].length}
                </p>
                {grouped[pt].map((p) => (
                  <PageRow
                    key={p.id}
                    page={p}
                    selected={p.id === selectedPageId}
                    isDark={isDark}
                    onClick={() => setSelectedPageId(p.id)}
                    checked={selectedIds.has(p.id)}
                    onToggleSelect={() => toggleSelect(p.id)}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      </section>

      <section
        data-testid="library-memory-detail"
        data-page-id={selectedPageId ?? undefined}
        className="flex min-w-0 flex-1 flex-col"
      >
        {selectedPageId === null ? (
          <EmptyDetail isDark={isDark} />
        ) : (
          <DetailView
            workspaceId={workspaceId}
            isDark={isDark}
            detail={detail}
            detailLoading={detailLoading}
            detailError={detailError}
            links={links}
            linksLoading={linksLoading}
            versions={versions}
            versionsLoading={versionsLoading}
            myImUserId={myImUserId}
            isOwnerHuman={isOwnerHuman}
            activeTaskId={activeTaskId}
            notify={notify}
            onMutated={() => setRefreshTick((tick) => tick + 1)}
            onDeleted={() => {
              setSelectedPageId(null);
              setRefreshTick((tick) => tick + 1);
            }}
            onJumpToMemory={(path) => {
              const target = pages.find((p) => p.path === path || p.path.endsWith(`/${path}`));
              if (target) setSelectedPageId(target.id);
            }}
          />
        )}
      </section>
    </div>
  );
}

interface FolderNode {
  label: string;
  path: string;
  count: number;
  children: FolderNode[];
}

function buildFolderTree(pages: MemoryPageSummaryDTO[]): FolderNode[] {
  const root: FolderNode = { label: 'memory', path: 'memory', count: 0, children: [] };
  for (const page of pages) {
    const segments = page.path.split('/').slice(0, -1);
    let cursor = root;
    let acc = '';
    cursor.count += 1;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      acc = acc ? `${acc}/${seg}` : seg;
      let child = cursor.children.find((c) => c.label === seg);
      if (!child) {
        child = { label: seg, path: acc, count: 0, children: [] };
        cursor.children.push(child);
      }
      child.count += 1;
      cursor = child;
    }
  }
  // Sort each level alphabetically.
  function sortRec(n: FolderNode) {
    n.children.sort((a, b) => a.label.localeCompare(b.label));
    n.children.forEach(sortRec);
  }
  sortRec(root);
  return root.children;
}

function folderForPath(path: string): string | null {
  const segments = path.split('/');
  if (segments.length <= 1) return null;
  return segments.slice(0, -1).join('/');
}

function FolderRow({
  node,
  depth,
  isDark,
  selected,
  onSelect,
}: {
  node: FolderNode;
  depth: number;
  isDark: boolean;
  selected: string | null;
  onSelect: (folder: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const isSelected = selected === node.path;
  return (
    <div data-testid={`library-memory-tree-folder-${node.path}`} className="text-xs">
      <button
        type="button"
        onClick={() => {
          setExpanded((prev) => !prev);
          onSelect(node.path);
        }}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        className={`flex w-full items-center gap-1 rounded-lg py-1 pr-2 text-left transition-colors ${
          isSelected
            ? isDark
              ? 'bg-violet-500/16 text-violet-100'
              : 'bg-violet-100/80 text-violet-900'
            : isDark
              ? 'text-zinc-300 hover:bg-white/[0.04]'
              : 'text-zinc-700 hover:bg-zinc-100'
        }`}
      >
        <span className={`text-[9px] ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>{expanded ? '▾' : '▸'}</span>
        <span className="min-w-0 flex-1 truncate">{node.label}</span>
        <span className={`text-[9px] tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{node.count}</span>
      </button>
      {expanded
        ? node.children.map((child) => (
            <FolderRow
              key={child.path}
              node={child}
              depth={depth + 1}
              isDark={isDark}
              selected={selected}
              onSelect={onSelect}
            />
          ))
        : null}
    </div>
  );
}

function FilterChip({
  isDark,
  active,
  onClick,
  testId,
  label,
}: {
  isDark: boolean;
  active: boolean;
  onClick: () => void;
  testId: string;
  label: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active ? 'true' : undefined}
      onClick={onClick}
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
        active
          ? isDark
            ? 'bg-violet-500/20 text-violet-100'
            : 'bg-violet-100/80 text-violet-900'
          : isDark
            ? 'bg-white/[0.04] text-zinc-400 hover:text-zinc-100'
            : 'bg-zinc-100 text-zinc-500 hover:text-zinc-900'
      }`}
    >
      {label}
    </button>
  );
}

/**
 * Wave 5 F5 — derive the 🔓 / 🔒 scope badge for the memory list.
 * Prefers the server-supplied `scope` field (see `memory-read.service.ts`
 * `deriveScopeFromVisibility`); falls back to the same rule against
 * `visibility` for older API builds; legacy null → `workspace-shared` (🔓).
 */
function pageScope(page: MemoryPageSummaryDTO): 'workspace-shared' | 'agent-private' {
  if (page.scope === 'workspace-shared' || page.scope === 'agent-private') return page.scope;
  const v = page.visibility;
  if (!v || v === 'workspace') return 'workspace-shared';
  return 'agent-private';
}

function ScopeBadge({ scope, isDark }: { scope: 'workspace-shared' | 'agent-private'; isDark: boolean }) {
  const isShared = scope === 'workspace-shared';
  const title = isShared
    ? 'Workspace-shared — readable + writable by every agent in this workspace'
    : 'Agent-private — readable + writable only by the owning agent / scope';
  const colour = isShared
    ? isDark
      ? 'bg-emerald-500/15 text-emerald-200'
      : 'bg-emerald-50 text-emerald-700'
    : isDark
      ? 'bg-amber-500/15 text-amber-200'
      : 'bg-amber-50 text-amber-700';
  return (
    <span
      data-testid="library-memory-page-scope-badge"
      data-scope={scope}
      title={title}
      aria-label={title}
      className={`inline-flex shrink-0 items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] ${colour}`}
    >
      {isShared ? '🔓' : '🔒'}
    </span>
  );
}

function PageRow({
  page,
  selected,
  isDark,
  onClick,
  checked,
  onToggleSelect,
}: {
  page: MemoryPageSummaryDTO;
  selected: boolean;
  isDark: boolean;
  onClick: () => void;
  checked: boolean;
  onToggleSelect: () => void;
}) {
  const archived = Boolean(page.archivedAt);
  const scope = pageScope(page);
  return (
    <div
      className={`mb-1 flex w-full items-stretch gap-2 rounded-2xl px-2 py-2 transition-colors ${
        selected
          ? isDark
            ? 'bg-violet-500/14 ring-1 ring-violet-400/40'
            : 'bg-violet-100/70 ring-1 ring-violet-300/70'
          : isDark
            ? 'hover:bg-white/[0.04]'
            : 'hover:bg-zinc-100'
      }`}
    >
      <input
        type="checkbox"
        data-testid={`library-memory-page-checkbox-${page.id}`}
        checked={checked}
        onChange={onToggleSelect}
        onClick={(event) => event.stopPropagation()}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-violet-500"
        aria-label={`Select ${page.path}`}
      />
      <button
        type="button"
        data-testid={`library-memory-page-${page.id}`}
        data-page-type={page.pageType}
        data-stale={page.stale ? 'true' : undefined}
        data-archived={archived ? 'true' : undefined}
        data-checked={checked ? 'true' : undefined}
        data-scope={scope}
        onClick={onClick}
        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
      >
        <div className="flex items-center gap-1.5">
          <ScopeBadge scope={scope} isDark={isDark} />
          <span
            className={`min-w-0 flex-1 truncate text-xs font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}
          >
            {page.title ?? page.path.split('/').pop()}
          </span>
          {page.stale ? <Badge isDark={isDark} tone="amber" label="stale" /> : null}
          {archived ? <Badge isDark={isDark} tone="zinc" label="archived" /> : null}
        </div>
        <div className={`flex items-center justify-between text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          <span className="truncate">{page.path}</span>
          <span className="ml-2 shrink-0 tabular-nums">v{page.version}</span>
        </div>
      </button>
    </div>
  );
}

function Badge({ isDark, tone, label }: { isDark: boolean; tone: 'amber' | 'zinc'; label: string }) {
  const color =
    tone === 'amber'
      ? isDark
        ? 'bg-amber-500/20 text-amber-200'
        : 'bg-amber-100 text-amber-700'
      : isDark
        ? 'bg-white/[0.05] text-zinc-400'
        : 'bg-zinc-200 text-zinc-600';
  return (
    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${color}`}>
      {label}
    </span>
  );
}

function ListLoading({ isDark }: { isDark: boolean }) {
  return (
    <div
      data-testid="library-memory-list-loading"
      className={`flex items-center gap-2 px-3 py-4 text-[11px] ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
    >
      <Loader2 className="h-3 w-3 animate-spin" />
      Loading memory pages…
    </div>
  );
}

function EmptyRow({ isDark, testId }: { isDark: boolean; testId: string }) {
  return (
    <p data-testid={testId} className={`px-3 py-4 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
      No memory pages match your filter.
    </p>
  );
}

function ErrorRow({ isDark, message, testId }: { isDark: boolean; message: string; testId: string }) {
  return (
    <div data-testid={testId} className={`px-3 py-4 text-[11px] ${isDark ? 'text-rose-300' : 'text-rose-600'}`}>
      <p className="font-semibold">Failed to load.</p>
      <p className="mt-1 opacity-80">{message}</p>
    </div>
  );
}

function EmptyDetail({ isDark }: { isDark: boolean }) {
  return (
    <div
      data-testid="library-memory-detail-empty"
      className={`flex h-full flex-col items-center justify-center px-6 text-center ${
        isDark ? 'text-zinc-400' : 'text-zinc-600'
      }`}
    >
      <p className="text-sm font-semibold">No memory page selected</p>
      <p className="mt-1 max-w-sm text-xs opacity-80">
        Pick a page from the list to read its content, source, backlinks, provenance, and version history.
      </p>
    </div>
  );
}

function DetailView({
  workspaceId,
  isDark,
  detail,
  detailLoading,
  detailError,
  links,
  linksLoading,
  versions,
  versionsLoading,
  myImUserId,
  isOwnerHuman,
  activeTaskId,
  notify,
  onMutated,
  onDeleted,
  onJumpToMemory,
}: {
  workspaceId: string;
  isDark: boolean;
  detail: MemoryPageDetailDTO | null;
  detailLoading: boolean;
  detailError: string | null;
  links: MemoryPageLinksDTO | null;
  linksLoading: boolean;
  versions: MemoryPageVersionRowDTO[] | null;
  versionsLoading: boolean;
  myImUserId: string | null;
  isOwnerHuman: boolean;
  activeTaskId: string | null;
  notify?: (message: string, type?: 'success' | 'error' | 'info') => void;
  onMutated: () => void;
  onDeleted: () => void;
  onJumpToMemory: (path: string) => void;
}) {
  void workspaceId; // page itself carries workspaceId
  if (detailLoading) {
    return (
      <div
        data-testid="library-memory-detail-loading"
        className={`flex h-full items-center justify-center text-[11px] ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
      >
        <Loader2 className="mr-2 h-3 w-3 animate-spin" />
        Loading…
      </div>
    );
  }
  if (detailError) {
    return (
      <div
        data-testid="library-memory-detail-error"
        className={`flex h-full flex-col items-center justify-center px-6 text-center ${
          isDark ? 'text-rose-300' : 'text-rose-600'
        }`}
      >
        <p className="text-sm font-semibold">Failed to load memory page.</p>
        <p className="mt-2 max-w-md text-xs opacity-80">{detailError}</p>
      </div>
    );
  }
  if (!detail) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={`flex flex-wrap items-center gap-2 border-b px-4 py-3 ${
          isDark ? 'border-white/[0.06]' : 'border-zinc-200'
        }`}
      >
        <div className="min-w-0 flex-1">
          <p
            data-testid="library-memory-detail-title"
            className={`truncate text-sm font-bold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}
          >
            {detail.title ?? detail.path.split('/').pop()}
          </p>
          <p className={`truncate text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{detail.path}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider">
          <Badge isDark={isDark} tone="zinc" label={detail.pageType} />
          <Badge isDark={isDark} tone="zinc" label={`v${detail.version}`} />
          {detail.stale ? <Badge isDark={isDark} tone="amber" label="stale" /> : null}
          {detail.archivedAt ? <Badge isDark={isDark} tone="zinc" label="archived" /> : null}
          {detail.visibility ? (
            <span
              className={`rounded-full px-1.5 py-0.5 text-[9px] ${
                isDark ? 'bg-white/[0.06] text-zinc-400' : 'bg-zinc-100 text-zinc-600'
              }`}
            >
              {detail.visibility}
            </span>
          ) : null}
        </div>
      </div>

      <LibraryMemoryActions
        isDark={isDark}
        page={detail}
        myImUserId={myImUserId}
        isOwnerHuman={isOwnerHuman}
        activeTaskId={activeTaskId}
        onMutated={onMutated}
        onDeleted={onDeleted}
        notify={notify}
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
        <article className="min-h-0 overflow-y-auto px-4 py-3">
          <MemoryDetailBody detail={detail} isDark={isDark} onJumpToMemory={onJumpToMemory} />
        </article>
        <aside
          data-testid="library-memory-detail-side"
          className={`min-h-0 overflow-y-auto border-l px-3 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
        >
          <SidePanel
            isDark={isDark}
            title="Source"
            icon={<Filter className="h-3 w-3" />}
            testId="library-memory-detail-source"
          >
            {linksLoading ? (
              <SidePanelLoading isDark={isDark} />
            ) : links?.knowledge?.length ? (
              <ul className="space-y-1">
                {links.knowledge.map((kn) => (
                  <li
                    key={kn.id}
                    className={`rounded-lg border px-2 py-1.5 text-[10px] ${
                      isDark ? 'border-white/[0.06] bg-white/[0.02]' : 'border-zinc-200 bg-white/60'
                    }`}
                  >
                    <p className={`font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                      {kn.sourceType}:{kn.sourceId}
                    </p>
                    <p className={`mt-0.5 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                      → {kn.targetType}:{kn.targetId} · {kn.relation}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <SidePanelEmpty isDark={isDark} text="No source links recorded." />
            )}
          </SidePanel>

          <SidePanel
            isDark={isDark}
            title="Backlinks"
            icon={<Network className="h-3 w-3" />}
            testId="library-memory-detail-backlinks"
          >
            {linksLoading ? (
              <SidePanelLoading isDark={isDark} />
            ) : links?.backlinks?.length ? (
              <ul className="space-y-1">
                {links.backlinks.map((bl) => (
                  <li
                    key={bl.id}
                    className={`rounded-lg border px-2 py-1.5 text-[10px] ${
                      isDark ? 'border-white/[0.06] bg-white/[0.02]' : 'border-zinc-200 bg-white/60'
                    }`}
                  >
                    <p className={`font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                      {bl.sourceUri ?? bl.sourcePageId}
                    </p>
                    <p
                      className={`mt-0.5 inline-flex items-center gap-1 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                    >
                      <span>relation · {bl.relation}</span>
                      {bl.broken ? (
                        <span className="inline-flex items-center gap-0.5 text-rose-400">
                          · <Unlink className="h-3 w-3" strokeWidth={1.5} /> broken
                        </span>
                      ) : null}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <SidePanelEmpty isDark={isDark} text="No incoming references yet." />
            )}
          </SidePanel>

          <SidePanel
            isDark={isDark}
            title="Provenance"
            icon={<RefreshCcw className="h-3 w-3" />}
            testId="library-memory-detail-provenance"
          >
            {Array.isArray(detail.provenance) && detail.provenance.length > 0 ? (
              <ol className="space-y-1">
                {detail.provenance.map((entry, idx) => (
                  <li
                    key={idx}
                    className={`rounded-lg border px-2 py-1.5 text-[10px] ${
                      isDark ? 'border-white/[0.06] bg-white/[0.02]' : 'border-zinc-200 bg-white/60'
                    }`}
                  >
                    <code className={`whitespace-pre-wrap ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                      {JSON.stringify(entry, null, 2)}
                    </code>
                  </li>
                ))}
              </ol>
            ) : (
              <SidePanelEmpty isDark={isDark} text="No provenance entries." />
            )}
          </SidePanel>

          <SidePanel
            isDark={isDark}
            title={`Versions${versions ? ` · ${versions.length}` : ''}`}
            icon={<RefreshCcw className="h-3 w-3" />}
            testId="library-memory-detail-versions"
          >
            {versionsLoading ? (
              <SidePanelLoading isDark={isDark} />
            ) : versions && versions.length > 0 ? (
              <ul className="space-y-1">
                {versions.map((v) => (
                  <li
                    key={v.id}
                    className={`rounded-lg border px-2 py-1.5 text-[10px] ${
                      isDark ? 'border-white/[0.06] bg-white/[0.02]' : 'border-zinc-200 bg-white/60'
                    }`}
                  >
                    <p className={`font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                      v{v.version} {v.parentVersion ? `← v${v.parentVersion}` : ''}
                    </p>
                    {v.changeSummary ? (
                      <p className={`mt-0.5 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{v.changeSummary}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <SidePanelEmpty isDark={isDark} text="No earlier versions." />
            )}
          </SidePanel>
        </aside>
      </div>
    </div>
  );
}

function SidePanel({
  isDark,
  title,
  icon,
  testId,
  children,
}: {
  isDark: boolean;
  title: string;
  icon: React.ReactNode;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section data-testid={testId} className="mb-4">
      <header
        className={`mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider ${
          isDark ? 'text-zinc-500' : 'text-zinc-500'
        }`}
      >
        {icon}
        <span>{title}</span>
      </header>
      {children}
    </section>
  );
}

function SidePanelLoading({ isDark }: { isDark: boolean }) {
  return (
    <p className={`flex items-center gap-1 px-2 py-1 text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
      <Loader2 className="h-3 w-3 animate-spin" />
      Loading…
    </p>
  );
}

function SidePanelEmpty({ isDark, text }: { isDark: boolean; text: string }) {
  return <p className={`px-2 py-1 text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{text}</p>;
}

/**
 * D1 (doc 25 rev 5 §4): contentHtml is an INDEPENDENT source from `content`
 * (markdown), not a derivation. When both fields are present we render the
 * HTML — it's the structured source authored by the rich-text editor or
 * supplied by an ingest pipeline. Markdown is the fallback for legacy rows
 * where the backfill cron hasn't populated HTML yet.
 *
 * Trust boundary: the cloud-side write path runs HTML through
 * markdown-render.ts (remark + rehype-sanitize, GitHub-flavored schema)
 * before persisting it for both contentHtmlVersion=0 (user/agent supplied)
 * and >=1 (backfill-derived). By the time this component receives the
 * field, it has already been sanitized server-side and is safe to inject.
 * If a script ever executes here, the cloud sanitizer has regressed — file
 * the bug against Line A; do not patch on the client.
 *
 * The codebase already uses dangerouslySetInnerHTML for similar pre-sanitized
 * markdown rendering — see src/components/ui/markdown-renderer.tsx.
 */
function MemoryDetailBody({
  detail,
  isDark,
  onJumpToMemory,
}: {
  detail: MemoryPageDetailDTO;
  isDark: boolean;
  onJumpToMemory: (path: string) => void;
}) {
  const hasHtml = typeof detail.contentHtml === 'string' && detail.contentHtml.trim().length > 0;
  const hasMarkdown = typeof detail.content === 'string' && detail.content.trim().length > 0;
  const [showMarkdownSource, setShowMarkdownSource] = useState(false);

  const renderingHtml = hasHtml && !showMarkdownSource;
  const canToggle = hasHtml && hasMarkdown;

  if (!hasHtml && !hasMarkdown) {
    return (
      <p
        data-testid="library-memory-detail-body-empty"
        className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
      >
        This page has no body yet.
      </p>
    );
  }

  const htmlClassNames = `max-w-none text-[13px] leading-7 ${
    isDark
      ? 'text-zinc-200 [&_a]:text-cyan-300 [&_code]:bg-white/[0.06]'
      : 'text-zinc-800 [&_a]:text-cyan-700 [&_code]:bg-zinc-100'
  } [&_a]:underline [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px] [&_h1]:mb-2 [&_h1]:mt-3 [&_h1]:text-base [&_h1]:font-bold [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-sm [&_h2]:font-bold [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-[13px] [&_h3]:font-bold [&_li]:mb-0.5 [&_li]:ml-4 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mb-2 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:p-2 [&_pre]:text-[11px] [&_table]:border-collapse [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1`;

  return (
    <div className="flex flex-col gap-2">
      {canToggle ? (
        <button
          type="button"
          data-testid="library-memory-detail-source-toggle"
          onClick={() => setShowMarkdownSource((prev) => !prev)}
          className={`self-start rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
            isDark
              ? 'bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200'
              : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 hover:text-zinc-800'
          }`}
        >
          {renderingHtml ? 'View markdown source' : 'View HTML'}
        </button>
      ) : null}
      {renderingHtml ? (
        <div
          data-testid="library-memory-detail-html"
          className={htmlClassNames}
          // Server-sanitized — see component docstring.
          dangerouslySetInnerHTML={{ __html: detail.contentHtml as string }}
        />
      ) : (
        <MemoryTextPreview content={detail.content ?? ''} isDark={isDark} onJumpToMemory={onJumpToMemory} />
      )}
    </div>
  );
}
