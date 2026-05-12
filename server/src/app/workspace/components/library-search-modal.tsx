'use client';

/**
 * LibrarySearchModal — Memory Line B / B1.
 *
 * ⌘K / Ctrl+K opens a workspace-wide quick-search overlay with two sections:
 *
 *   1. Memory — placeholder in B1; B2 wires `/memory/search`.
 *   2. Files — basic name-substring filter over the existing assets array.
 *
 * The modal lives at the workspace page level so the keybinding works from
 * any surface. Selecting a Files row opens the workspace inspector.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { File, Loader2, Search, Workflow } from 'lucide-react';

import { searchMemory, type MemorySearchResultDTO } from '../lib/memory-api';
import type { AssetDTO } from '../lib/types';
import type { WorkspaceInspector } from './workspace-inspector-dialog';

interface LibrarySearchModalProps {
  isDark: boolean;
  workspaceId: string | null;
  assets: AssetDTO[];
  onOpenInspector: (inspector: WorkspaceInspector) => void;
  /** Jump to a memory page from a search result (B2). */
  onOpenMemoryPage?: (path: string) => void;
}

const FILE_RESULT_LIMIT = 12;
const MEMORY_RESULT_LIMIT = 10;
const MEMORY_DEBOUNCE_MS = 200;

export function LibrarySearchModal({
  isDark,
  workspaceId,
  assets,
  onOpenInspector,
  onOpenMemoryPage,
}: LibrarySearchModalProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [memoryResults, setMemoryResults] = useState<MemorySearchResultDTO[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((prev) => {
          if (prev) {
            setQuery('');
            return false;
          }
          return true;
        });
        return;
      }
      if (event.key === 'Escape') {
        close();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  useEffect(() => {
    if (!open) return undefined;
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  // Debounced memory search when modal is open.
  useEffect(() => {
    const trimmed = query.trim();
    if (!open || !workspaceId || trimmed.length < 2) {
      setMemoryResults([]);
      setMemoryLoading(false);
      setMemoryError(null);
      return undefined;
    }
    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      setMemoryLoading(true);
      setMemoryError(null);
      searchMemory({
        workspaceId,
        q: trimmed,
        kind: 'memory',
        limit: MEMORY_RESULT_LIMIT,
        signal: ac.signal,
      }).then((res) => {
        if (ac.signal.aborted) return;
        if (res.ok) {
          setMemoryResults(res.data?.memory ?? []);
        } else {
          setMemoryResults([]);
          setMemoryError(res.message);
        }
        setMemoryLoading(false);
      });
    }, MEMORY_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [open, workspaceId, query]);

  const fileMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return assets
      .filter((asset) => {
        const filename = asset.filename ?? '';
        return filename.toLowerCase().includes(q) || asset.id.toLowerCase().includes(q);
      })
      .slice(0, FILE_RESULT_LIMIT);
  }, [assets, query]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          data-testid="library-search-modal"
          className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <div
            data-testid="library-search-modal-backdrop"
            onClick={close}
            className={`absolute inset-0 ${isDark ? 'bg-black/60' : 'bg-zinc-900/30'} backdrop-blur-[2px]`}
            aria-hidden
          />
          <motion.div
            role="dialog"
            aria-modal
            aria-label="Search workspace library"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            className={`relative w-full max-w-xl overflow-hidden rounded-2xl border shadow-2xl ${
              isDark ? 'border-white/[0.08] bg-zinc-950/95' : 'border-zinc-200 bg-white/95'
            }`}
          >
            <div
              className={`flex items-center gap-2 border-b px-4 py-3 ${
                isDark ? 'border-white/[0.06]' : 'border-zinc-200'
              }`}
            >
              <Search className={`h-4 w-4 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`} />
              <input
                ref={inputRef}
                data-testid="library-search-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search memory pages or files…"
                className={`flex-1 bg-transparent text-sm outline-none ${
                  isDark ? 'text-zinc-100 placeholder:text-zinc-500' : 'text-zinc-900 placeholder:text-zinc-400'
                }`}
              />
              <kbd
                className={`hidden items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider sm:inline-flex ${
                  isDark ? 'border-white/[0.08] text-zinc-500' : 'border-zinc-200 text-zinc-500'
                }`}
              >
                Esc
              </kbd>
            </div>

            <div className="max-h-[60vh] overflow-y-auto px-2 py-2">
              <SearchSection isDark={isDark} icon={<Workflow className="h-3.5 w-3.5" />} title="Memory">
                <div data-testid="library-search-memory-section">
                  {!workspaceId ? (
                    <div className={`px-3 py-2 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                      Workspace not loaded yet.
                    </div>
                  ) : query.trim().length < 2 ? (
                    <div className={`px-3 py-2 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                      Type at least 2 characters to search workspace memory.
                    </div>
                  ) : memoryLoading ? (
                    <div
                      className={`flex items-center gap-2 px-3 py-2 text-xs ${
                        isDark ? 'text-zinc-500' : 'text-zinc-500'
                      }`}
                    >
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Searching memory…
                    </div>
                  ) : memoryError ? (
                    <div
                      data-testid="library-search-memory-error"
                      className={`px-3 py-2 text-xs ${isDark ? 'text-rose-300' : 'text-rose-600'}`}
                    >
                      {memoryError}
                    </div>
                  ) : memoryResults.length === 0 ? (
                    <div
                      data-testid="library-search-memory-no-results"
                      className={`px-3 py-2 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                    >
                      No memory pages match.
                    </div>
                  ) : (
                    <ul data-testid="library-search-memory-results" className="space-y-0.5">
                      {memoryResults.map((res) => (
                        <li key={res.pageId}>
                          <button
                            type="button"
                            data-testid={`library-search-memory-${res.pageId}`}
                            onClick={() => {
                              if (onOpenMemoryPage) onOpenMemoryPage(res.path);
                              close();
                            }}
                            className={`flex w-full items-start gap-2 rounded-xl px-3 py-2 text-left transition-colors ${
                              isDark ? 'text-zinc-200 hover:bg-white/[0.04]' : 'text-zinc-800 hover:bg-zinc-100'
                            }`}
                          >
                            <Workflow
                              className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                                isDark ? 'text-violet-300' : 'text-violet-600'
                              }`}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-semibold">
                                {res.title ?? res.path.split('/').pop()}
                              </span>
                              <span
                                className={`block truncate text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                              >
                                {res.path} · {res.pageType}
                              </span>
                              {res.snippet ? (
                                <span
                                  className={`mt-0.5 block truncate text-[10px] italic ${
                                    isDark ? 'text-zinc-400' : 'text-zinc-600'
                                  }`}
                                >
                                  {res.snippet}
                                </span>
                              ) : null}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </SearchSection>

              <SearchSection isDark={isDark} icon={<File className="h-3.5 w-3.5" />} title="Files">
                {query.trim() === '' ? (
                  <div
                    data-testid="library-search-files-empty"
                    className={`px-3 py-2 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                  >
                    Type to search across {assets.length} file{assets.length === 1 ? '' : 's'}.
                  </div>
                ) : fileMatches.length === 0 ? (
                  <div
                    data-testid="library-search-files-no-results"
                    className={`px-3 py-2 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                  >
                    No files match &ldquo;{query}&rdquo;.
                  </div>
                ) : (
                  <ul data-testid="library-search-files-results" className="space-y-0.5">
                    {fileMatches.map((asset) => (
                      <li key={asset.id}>
                        <button
                          type="button"
                          data-testid={`library-search-file-${asset.id}`}
                          onClick={() => {
                            onOpenInspector({ kind: 'asset', assetId: asset.id });
                            close();
                          }}
                          className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs transition-colors ${
                            isDark ? 'text-zinc-200 hover:bg-white/[0.04]' : 'text-zinc-800 hover:bg-zinc-100'
                          }`}
                        >
                          <File className={`h-3.5 w-3.5 shrink-0 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`} />
                          <span className="min-w-0 flex-1 truncate">{asset.filename ?? asset.id}</span>
                          <span className={`shrink-0 text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                            {asset.mime ?? 'file'}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </SearchSection>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function SearchSection({
  isDark,
  icon,
  title,
  children,
}: {
  isDark: boolean;
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-1 py-1">
      <div
        className={`flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider ${
          isDark ? 'text-zinc-500' : 'text-zinc-500'
        }`}
      >
        {icon}
        <span>{title}</span>
      </div>
      {children}
    </div>
  );
}
