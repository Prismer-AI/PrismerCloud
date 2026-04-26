'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, FileText, AlertTriangle, Clock, X } from 'lucide-react';
import { glass, timeAgo } from '../helpers';
import { spring, fetchWorkspace } from './shared';
import { AnimatedCounter } from './animated-counter';
import { MemoryRow } from './memory-row';
import type { WorkspaceView, WorkspaceMemoryFile } from '@/types/workspace';

interface MemoryTabProps {
  view: WorkspaceView;
  scope: string;
  isDark: boolean;
}

const GROUP_ORDER = ['bootstrap', 'knowledge', 'daily', 'other'] as const;
const BOOTSTRAP_TYPES = new Set(['instructions', 'user', 'tools', 'heartbeat']);
const KNOWLEDGE_TYPES = new Set(['feedback', 'project', 'reference', 'insight']);

function classifyFile(f: WorkspaceMemoryFile): (typeof GROUP_ORDER)[number] {
  const t = f.memoryType || '';
  if (BOOTSTRAP_TYPES.has(t)) return 'bootstrap';
  if (KNOWLEDGE_TYPES.has(t)) return 'knowledge';
  if (t === 'daily') return 'daily';
  return 'other';
}

const GROUP_LABELS: Record<string, { label: string; icon: string }> = {
  bootstrap: { label: 'Bootstrap', icon: '⚙' },
  knowledge: { label: 'Knowledge', icon: '💡' },
  daily: { label: 'Daily Notes', icon: '📅' },
  other: { label: 'Other', icon: '📄' },
};

export function MemoryTab({ view, scope, isDark }: MemoryTabProps) {
  const [query, setQuery] = useState('');
  const [contentCache, setContentCache] = useState<Map<string, string>>(new Map());
  const [searchingContent, setSearchingContent] = useState(false);
  const files = view.memory || [];

  const staleCount = useMemo(() => files.filter((f) => f.stale).length, [files]);
  const lastUpdated = useMemo(() => {
    if (files.length === 0) return null;
    const sorted = [...files].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return sorted[0].updatedAt;
  }, [files]);

  // Fetch all content once for full-text search
  const loadAllContent = useCallback(async () => {
    if (contentCache.size > 0) return;
    setSearchingContent(true);
    const fullView = await fetchWorkspace(scope, ['memory'], true);
    if (fullView?.memory) {
      const map = new Map<string, string>();
      for (const f of fullView.memory) {
        if (f.content) map.set(f.path, f.content);
      }
      setContentCache(map);
    }
    setSearchingContent(false);
  }, [scope, contentCache.size]);

  // Load content on first search input
  useEffect(() => {
    if (query.trim().length > 0 && contentCache.size === 0) {
      loadAllContent();
    }
  }, [query, contentCache.size, loadAllContent]);

  // Filter by search query — searches path + description + memoryType + content
  const filtered = useMemo(() => {
    if (!query.trim()) return files;
    const q = query.toLowerCase();
    return files.filter((f) => {
      if (f.path.toLowerCase().includes(q)) return true;
      if ((f.description || '').toLowerCase().includes(q)) return true;
      if ((f.memoryType || '').toLowerCase().includes(q)) return true;
      const content = contentCache.get(f.path);
      if (content && content.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [files, query, contentCache]);

  // Group
  const groups = useMemo(() => {
    const map: Record<string, WorkspaceMemoryFile[]> = {};
    for (const f of filtered) {
      const group = classifyFile(f);
      if (!map[group]) map[group] = [];
      map[group].push(f);
    }
    if (map.daily) map.daily.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return map;
  }, [filtered]);

  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={spring}
    >
      {/* Hero Strip */}
      <div className="flex items-baseline gap-8">
        <div>
          <p
            className={`text-[11px] font-medium uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
          >
            Files
          </p>
          <div className="flex items-baseline gap-2">
            <AnimatedCounter
              value={files.length}
              className={`text-3xl font-bold tabular-nums ${isDark ? 'text-white' : 'text-zinc-900'}`}
            />
            {staleCount > 0 && (
              <span className="flex items-center gap-1 text-yellow-500 text-xs font-medium">
                <AlertTriangle className="w-3 h-3" />
                {staleCount} stale
              </span>
            )}
          </div>
        </div>

        {lastUpdated && (
          <div>
            <p
              className={`text-[11px] font-medium uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
            >
              Last Updated
            </p>
            <p className={`text-lg font-semibold ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
              {timeAgo(lastUpdated)}
            </p>
          </div>
        )}

        {/* Type distribution mini badges */}
        <div className="flex gap-1.5 ml-auto self-end pb-1">
          {GROUP_ORDER.map((g) => {
            const count = files.filter((f) => classifyFile(f) === g).length;
            if (count === 0) return null;
            return (
              <span
                key={g}
                className={`text-[10px] px-2 py-0.5 rounded-full ${isDark ? 'bg-white/[0.04] text-zinc-400' : 'bg-zinc-100 text-zinc-500'}`}
              >
                {GROUP_LABELS[g].icon} {count}
              </span>
            );
          })}
        </div>
      </div>

      {/* Search */}
      <div className="relative mt-4">
        <Search
          className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by title, description, or content..."
          className={`w-full pl-9 pr-9 py-2.5 rounded-xl text-sm outline-none transition-all ${
            isDark
              ? 'bg-white/[0.03] border border-white/[0.06] text-white placeholder:text-zinc-600 focus:border-violet-500/40 focus:bg-white/[0.05]'
              : 'bg-zinc-50 border border-zinc-200 text-zinc-900 placeholder:text-zinc-400 focus:border-violet-400 focus:bg-white'
          }`}
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            className={`absolute right-3 top-1/2 -translate-y-1/2 ${isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-600'}`}
          >
            <X className="w-4 h-4" />
          </button>
        )}
        {searchingContent && (
          <span
            className={`absolute right-9 top-1/2 -translate-y-1/2 text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
          >
            indexing...
          </span>
        )}
      </div>

      {/* Results summary when searching */}
      {query && (
        <p className={`text-xs mt-2 px-1 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
          {filtered.length} of {files.length} files match &ldquo;{query}&rdquo;
          {contentCache.size > 0 && ' (including content)'}
        </p>
      )}

      {/* Grouped file list */}
      <div className="mt-4 space-y-4">
        {GROUP_ORDER.filter((g) => groups[g]?.length).map((group) => (
          <div key={group}>
            <div className="flex items-center gap-2 px-1 mb-2">
              <span className="text-sm">{GROUP_LABELS[group].icon}</span>
              <h3
                className={`text-[11px] font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
              >
                {GROUP_LABELS[group].label}
              </h3>
              <span className={`text-[10px] tabular-nums ${isDark ? 'text-zinc-600' : 'text-zinc-300'}`}>
                {groups[group].length}
              </span>
            </div>
            <div className={`rounded-xl overflow-hidden ${glass(isDark, 'subtle')}`}>
              {groups[group].map((f, i) => (
                <div key={f.path}>
                  {i > 0 && (
                    <div className={`mx-4 ${isDark ? 'border-t border-white/[0.04]' : 'border-t border-zinc-100'}`} />
                  )}
                  <MemoryRow file={f} scope={scope} isDark={isDark} />
                </div>
              ))}
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="text-center py-16">
            <FileText className={`w-8 h-8 mx-auto mb-3 ${isDark ? 'text-zinc-700' : 'text-zinc-200'}`} />
            <p className={`text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
              {query ? `No memories match "${query}".` : 'No memory files yet.'}
            </p>
          </div>
        )}
      </div>
    </motion.div>
  );
}
