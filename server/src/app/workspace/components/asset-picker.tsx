'use client';

/**
 * Inline #filename autocomplete for the message composer.
 *
 * Follows the exact pattern of MentionPicker — ref API (move/commit),
 * framer-motion glass surface, absolute-positioned above the textarea.
 *
 * Core differences from @mention:
 *   - Remote fetch (GET /api/im/assets?q=...) with 150ms debounce + AbortController
 *   - Recent files from localStorage when filter is empty
 *   - MIME-type icons instead of avatar gradients
 *   - Shows filename + folderPath + human-readable size
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  BracesIcon,
  FileDigitIcon,
  FileTextIcon,
  ImageIcon,
  MusicIcon,
  PaperclipIcon,
  VideoIcon,
} from 'lucide-react';
import { radius, springSnap, springSoft, surface } from '../lib/design';

interface AssetAutocompleteItem {
  id: string;
  contentHash: string;
  filename: string | null;
  folderPath: string | null;
  mime: string;
  kind: string;
  sizeBytes: number;
}

interface AssetPickerProps {
  isDark: boolean;
  workspaceId: string;
  /** Current filter token AFTER the leading '#'. Empty = show recent. */
  filter: string;
  onSelect: (item: AssetAutocompleteItem) => void;
  onClose: () => void;
}

export interface AssetPickerHandle {
  /** Move the highlighted row. Wraps around top/bottom. */
  move: (delta: number) => void;
  /** Commit the highlighted row. Returns false if there's nothing to commit. */
  commit: () => boolean;
}

// ─── MIME → icon ─────────────────────────────────────────────────────────

function mimeIcon(mime: string) {
  if (mime.startsWith('image/')) return ImageIcon;
  if (mime.startsWith('text/')) return FileTextIcon;
  if (mime === 'application/pdf') return FileDigitIcon;
  if (mime === 'application/json') return BracesIcon;
  if (mime.startsWith('video/')) return VideoIcon;
  if (mime.startsWith('audio/')) return MusicIcon;
  return PaperclipIcon;
}

// ─── Human-readable bytes ───────────────────────────────────────────────

function humanBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / Math.pow(1024, i);
  if (i === 0) return `${bytes} B`;
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[i]}`;
}

// ─── Recent files localStorage helpers ──────────────────────────────────

function recentKey(workspaceId: string) {
  return `prismer_recent_assets_${workspaceId}`;
}

function loadRecent(workspaceId: string): AssetAutocompleteItem[] {
  try {
    const raw = localStorage.getItem(recentKey(workspaceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as AssetAutocompleteItem[];
  } catch {
    return [];
  }
}

function saveRecent(workspaceId: string, item: AssetAutocompleteItem) {
  try {
    const prev = loadRecent(workspaceId);
    const next = [item, ...prev.filter((p) => p.id !== item.id)].slice(0, 20);
    localStorage.setItem(recentKey(workspaceId), JSON.stringify(next));
  } catch {
    /* quota exceeded — silently ignore */
  }
}

async function fetchAssets(
  workspaceId: string,
  q: string,
  limit: number,
  signal: AbortSignal,
): Promise<AssetAutocompleteItem[]> {
  let token = '';
  try {
    const raw = localStorage.getItem('prismer_auth');
    token = raw ? (JSON.parse(raw)?.token || '') : '';
  } catch { return []; }
  if (!token) return [];
  const params = new URLSearchParams({ workspaceId, q, limit: String(limit) });
  const res = await fetch(`/api/im/assets?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!res.ok) return [];
  const body = await res.json();
  if (!body?.ok || !Array.isArray(body?.data)) return [];
  return body.data as AssetAutocompleteItem[];
}

export const AssetPicker = forwardRef<AssetPickerHandle, AssetPickerProps>(function AssetPicker(
  { isDark, workspaceId, filter, onSelect, onClose },
  ref,
) {
  const [results, setResults] = useState<AssetAutocompleteItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);

  // ─── Debounced fetch with AbortController ───────────────────────────
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Cancel any in-flight request + pending debounce
    if (debounceRef.current) clearTimeout(debounceRef.current);
    ctrlRef.current?.abort();

    const q = filter.trim();
    if (!q) {
      // Show recent files
      setResults(loadRecent(workspaceId));
      setLoading(false);
      return;
    }

    setLoading(true);
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;

    debounceRef.current = setTimeout(async () => {
      if (ctrl.signal.aborted) return;
      try {
        const items = await fetchAssets(workspaceId, q, 8, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setResults(items);
      } catch {
        /* fetch aborted or network error */
      }
      if (!ctrl.signal.aborted) {
        setLoading(false);
      }
    }, 150);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      ctrl.abort();
    };
  }, [filter, workspaceId]);

  // Reset highlight to top when results change
  useEffect(() => {
    setActive(0);
  }, [results]);

  // Clamp when list shrinks past the current index
  useEffect(() => {
    setActive((prev) => (prev >= results.length ? Math.max(0, results.length - 1) : prev));
  }, [results.length]);

  // Stable refs for the imperative handle
  const resultsRef = useRef(results);
  const activeRef = useRef(active);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    resultsRef.current = results;
  }, [results]);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useImperativeHandle(
    ref,
    () => ({
      move: (delta) => {
        setActive((curr) => {
          const len = resultsRef.current.length;
          if (len === 0) return 0;
          return (curr + delta + len) % len;
        });
      },
      commit: () => {
        const list = resultsRef.current;
        const item = list[activeRef.current];
        if (!item) return false;
        // Persist to recent before calling onSelect
        saveRecent(workspaceId, item);
        onSelectRef.current(item);
        return true;
      },
    }),
    [workspaceId],
  );

  // Close on Escape (window-level listener since composer keeps focus)
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Scoped scroll: keep the highlighted row inside the picker's overflow window
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    const container = listRef.current;
    const el = itemRefs.current[active];
    if (!container || !el) return;
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    if (eRect.top < cRect.top) {
      container.scrollTop += eRect.top - cRect.top;
    } else if (eRect.bottom > cRect.bottom) {
      container.scrollTop += eRect.bottom - cRect.bottom;
    }
  }, [active]);

  if (results.length === 0 && !loading) return null;

  return (
    <motion.div
      ref={listRef}
      data-testid="asset-picker"
      role="listbox"
      initial={{ opacity: 0, y: 8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={springSoft}
      style={{ transformOrigin: 'bottom left' }}
      className={`absolute bottom-full left-2 mb-2 w-80 max-h-60 overflow-y-auto overflow-x-hidden border p-1.5 ${
        surface.modal[isDark ? 'dark' : 'light']
      } ${radius.card}`}
    >
      <div
        className={`flex items-center justify-between px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
          isDark ? 'text-zinc-500' : 'text-zinc-400'
        }`}
      >
        <span>{filter.trim() ? 'Assets' : 'Recent'}</span>
        <span className={`font-mono normal-case tracking-normal ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
          ↑↓ ⏎
        </span>
      </div>
      {loading && results.length === 0 ? (
        <div className={`px-2 py-3 text-center text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
          Searching...
        </div>
      ) : (
        results.map((item, idx) => {
          const Icon = mimeIcon(item.mime);
          const isActive = idx === active;
          return (
            <motion.button
              key={item.id}
              ref={(node) => {
                itemRefs.current[idx] = node;
              }}
              type="button"
              role="option"
              aria-selected={isActive}
              data-testid={`asset-option-${item.filename ?? item.id}`}
              onMouseDown={(e) => {
                // Prevent the textarea from losing focus before we insert.
                e.preventDefault();
                saveRecent(workspaceId, item);
                onSelect(item);
              }}
              onMouseEnter={() => setActive(idx)}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ ...springSoft, delay: 0.02 * idx }}
              whileTap={{ scale: 0.97 }}
              className={`group relative flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-sm transition-colors ${
                isActive
                  ? isDark
                    ? 'bg-white/[0.07] text-zinc-100'
                    : 'bg-zinc-900/[0.05] text-zinc-900'
                  : isDark
                    ? 'text-zinc-200 hover:bg-white/[0.04]'
                    : 'text-zinc-800 hover:bg-zinc-900/[0.03]'
              }`}
            >
              {isActive ? (
                <motion.span
                  layoutId="asset-active-rail"
                  transition={springSnap}
                  className={`absolute inset-y-1 left-0 w-[2px] rounded-full ${
                    isDark ? 'bg-violet-400/70' : 'bg-violet-500/80'
                  }`}
                />
              ) : null}
              <span
                className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                  isDark ? 'bg-white/[0.06] text-zinc-300' : 'bg-zinc-900/[0.05] text-zinc-600'
                }`}
                aria-hidden="true"
              >
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block truncate font-mono text-[12px] ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                  {item.filename || 'Untitled'}
                </span>
                <span className={`block truncate text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  {item.folderPath || 'Root'} &middot; {humanBytes(item.sizeBytes)}
                </span>
              </span>
              <span
                className={`shrink-0 text-[10px] font-medium transition-opacity ${
                  isActive ? 'opacity-60' : 'opacity-0 group-hover:opacity-50'
                } ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
              >
                ⏎
              </span>
            </motion.button>
          );
        })
      )}
    </motion.div>
  );
});
