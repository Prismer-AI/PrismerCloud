'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, Save, Trash2, AlertTriangle } from 'lucide-react';
import { glass, timeAgo } from '../helpers';
import { spring, fetchWorkspace } from './shared';
import type { WorkspaceMemoryFile } from '@/types/workspace';

interface MemoryRowProps {
  file: WorkspaceMemoryFile;
  scope: string;
  isDark: boolean;
}

const TYPE_BADGE: Record<string, { label: string; dark: string; light: string }> = {
  instructions: { label: 'Instructions', dark: 'bg-blue-500/15 text-blue-300', light: 'bg-blue-50 text-blue-600' },
  soul: { label: 'Soul', dark: 'bg-violet-500/15 text-violet-300', light: 'bg-violet-50 text-violet-600' },
  user: { label: 'User', dark: 'bg-cyan-500/15 text-cyan-300', light: 'bg-cyan-50 text-cyan-600' },
  tools: { label: 'Tools', dark: 'bg-amber-500/15 text-amber-300', light: 'bg-amber-50 text-amber-600' },
  heartbeat: {
    label: 'Heartbeat',
    dark: 'bg-emerald-500/15 text-emerald-300',
    light: 'bg-emerald-50 text-emerald-600',
  },
  daily: { label: 'Daily', dark: 'bg-pink-500/15 text-pink-300', light: 'bg-pink-50 text-pink-600' },
  feedback: { label: 'Feedback', dark: 'bg-orange-500/15 text-orange-300', light: 'bg-orange-50 text-orange-600' },
  project: { label: 'Project', dark: 'bg-indigo-500/15 text-indigo-300', light: 'bg-indigo-50 text-indigo-600' },
  reference: { label: 'Reference', dark: 'bg-teal-500/15 text-teal-300', light: 'bg-teal-50 text-teal-600' },
  insight: { label: 'Insight', dark: 'bg-rose-500/15 text-rose-300', light: 'bg-rose-50 text-rose-600' },
};

export function MemoryRow({ file, scope, isDark }: MemoryRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<string | null>(file.content ?? null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [loadingContent, setLoadingContent] = useState(false);

  const badge = TYPE_BADGE[file.memoryType || ''] || {
    label: file.memoryType || 'General',
    dark: 'bg-zinc-700/60 text-zinc-400',
    light: 'bg-zinc-100 text-zinc-500',
  };

  async function handleExpand() {
    if (expanded) {
      setExpanded(false);
      setEditing(false);
      return;
    }
    setExpanded(true);
    if (content === null) {
      setLoadingContent(true);
      const view = await fetchWorkspace(scope, ['memory'], true);
      const found = view?.memory?.find((m) => m.path === file.path);
      setContent(found?.content ?? '(empty)');
      setLoadingContent(false);
    }
  }

  function startEdit() {
    setDraft(content || '');
    setEditing(true);
  }

  async function saveEdit() {
    try {
      const token = JSON.parse(localStorage.getItem('prismer_auth') || '{}')?.token;
      if (!token) return;
      await fetch('/api/im/memory/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ path: file.path, content: draft, scope, memoryType: file.memoryType }),
      });
      setContent(draft);
      setEditing(false);
    } catch {
      // silent
    }
  }

  return (
    <motion.div layout transition={spring} className="overflow-hidden">
      <motion.button
        onClick={handleExpand}
        className={`w-full text-left px-4 py-3 transition-colors flex items-center gap-3 ${
          file.stale ? (isDark ? 'border-l-2 border-yellow-500/60' : 'border-l-2 border-yellow-400') : ''
        } ${isDark ? 'hover:bg-white/[0.03]' : 'hover:bg-zinc-50/80'}`}
      >
        {/* Type badge */}
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${isDark ? badge.dark : badge.light}`}
        >
          {badge.label}
        </span>

        {/* Path + description */}
        <div className="min-w-0 flex-1">
          <span className={`text-sm font-medium ${isDark ? 'text-white' : 'text-zinc-900'}`}>{file.path}</span>
          {file.description && (
            <p className={`text-[11px] truncate ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>{file.description}</p>
          )}
        </div>

        {/* Stale indicator */}
        {file.stale && <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 shrink-0" />}

        {/* Time */}
        <span className={`text-[11px] shrink-0 ${isDark ? 'text-zinc-600' : 'text-zinc-300'}`}>
          {timeAgo(file.updatedAt)}
        </span>

        {/* Chevron */}
        <motion.span
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={spring}
          className={isDark ? 'text-zinc-600' : 'text-zinc-300'}
        >
          <ChevronRight className="w-4 h-4" />
        </motion.span>
      </motion.button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={spring}
            className="overflow-hidden"
          >
            <div className={`mx-4 mb-3 mt-1 p-4 rounded-lg ${glass(isDark, 'subtle')}`}>
              {loadingContent ? (
                <div className={`h-20 rounded animate-pulse ${isDark ? 'bg-white/5' : 'bg-zinc-100'}`} />
              ) : editing ? (
                <div className="space-y-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={8}
                    className={`w-full text-sm font-mono rounded-md p-3 resize-y outline-none ${
                      isDark
                        ? 'bg-zinc-900 text-zinc-200 border border-white/10'
                        : 'bg-zinc-50 text-zinc-900 border border-zinc-200'
                    }`}
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={saveEdit}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-violet-600 text-white hover:bg-violet-500 transition-colors"
                    >
                      <Save className="w-3.5 h-3.5" /> Save
                    </button>
                    <button
                      onClick={() => setEditing(false)}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${isDark ? 'text-zinc-400 hover:bg-white/5' : 'text-zinc-500 hover:bg-zinc-100'}`}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <pre
                    className={`text-xs font-mono whitespace-pre-wrap max-h-60 overflow-auto leading-relaxed ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}
                  >
                    {content}
                  </pre>
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={startEdit}
                      className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${isDark ? 'text-zinc-400 hover:bg-white/5' : 'text-zinc-500 hover:bg-zinc-100'}`}
                    >
                      Edit
                    </button>
                    <button
                      className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${isDark ? 'text-red-400 hover:bg-red-500/10' : 'text-red-500 hover:bg-red-50'}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
