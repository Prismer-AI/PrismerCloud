'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, Layers, RefreshCw } from 'lucide-react';
import { glass } from './helpers';
import { fetchWorkspace, fetchScopes, gentleSpring, type WorkspaceSubTab } from './workspace/shared';
import { ProgressTab } from './workspace/progress-tab';
import { MemoryTab } from './workspace/memory-tab';
import { ProfileTab } from './workspace/profile-tab';
import type { WorkspaceView, WorkspaceSlot } from '@/types/workspace';

interface WorkspaceTabProps {
  isDark: boolean;
}

const TABS: { key: WorkspaceSubTab; label: string }[] = [
  { key: 'progress', label: 'Progress' },
  { key: 'memory', label: 'Memory' },
  { key: 'profile', label: 'Agents' },
];

const SLOTS_BY_TAB: Record<WorkspaceSubTab, WorkspaceSlot[]> = {
  progress: ['genes', 'memory', 'credits'],
  memory: ['memory'],
  profile: ['identity', 'personality', 'credits', 'catalog'],
};

export function WorkspaceTab({ isDark }: WorkspaceTabProps) {
  const [activeTab, setActiveTab] = useState<WorkspaceSubTab>('progress');
  const [scope, setScope] = useState('global');
  const [scopes, setScopes] = useState<string[]>(['global']);
  const [view, setView] = useState<WorkspaceView | null>(null);
  const [loading, setLoading] = useState(true);
  const [prevTabKey, setPrevTabKey] = useState<WorkspaceSubTab>(activeTab);

  const load = useCallback(async (tab: WorkspaceSubTab, s: string) => {
    setLoading(true);
    const [v, sc] = await Promise.all([fetchWorkspace(s, SLOTS_BY_TAB[tab]), fetchScopes()]);
    setView(v);
    setScopes(sc.length > 0 ? sc : ['global']);
    setLoading(false);
  }, []);

  useEffect(() => {
    load(activeTab, scope);
  }, [activeTab, scope, load]);

  // Track direction for slide animation
  const tabIndex = TABS.findIndex((t) => t.key === activeTab);
  const prevIndex = TABS.findIndex((t) => t.key === prevTabKey);
  const direction = tabIndex >= prevIndex ? 1 : -1;

  function switchTab(tab: WorkspaceSubTab) {
    setPrevTabKey(activeTab);
    setActiveTab(tab);
  }

  return (
    <div className="space-y-4">
      {/* Tab Bar + Scope */}
      <div className={`flex items-center justify-between p-1.5 rounded-xl ${glass(isDark)}`}>
        {/* Tabs */}
        <div className="flex gap-0.5">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => switchTab(tab.key)}
              className={`relative px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
                activeTab === tab.key
                  ? isDark
                    ? 'text-white'
                    : 'text-zinc-900'
                  : isDark
                    ? 'text-zinc-500 hover:text-zinc-300'
                    : 'text-zinc-400 hover:text-zinc-600'
              }`}
            >
              {activeTab === tab.key && (
                <motion.div
                  layoutId="workspace-tab-indicator"
                  className={`absolute inset-0 rounded-lg ${isDark ? 'bg-white/[0.06]' : 'bg-zinc-100'}`}
                  transition={gentleSpring}
                />
              )}
              <span className="relative z-10">{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Scope + Refresh */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Layers className={`w-3.5 h-3.5 ${isDark ? 'text-zinc-600' : 'text-zinc-300'}`} />
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className={`text-xs font-medium rounded-md px-2 py-1 border-0 outline-none cursor-pointer ${
                isDark ? 'bg-transparent text-zinc-400' : 'bg-transparent text-zinc-500'
              }`}
            >
              {scopes.map((s) => (
                <option key={s} value={s}>
                  {s === 'global' ? 'Global' : s}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={() => load(activeTab, scope)}
            className={`p-1.5 rounded-md transition-colors ${isDark ? 'hover:bg-white/5 text-zinc-600' : 'hover:bg-zinc-100 text-zinc-300'}`}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className={`p-5 rounded-xl min-h-[400px] ${glass(isDark, 'elevated')}`}>
        {loading ? (
          <div className="flex items-center justify-center py-24">
            {/* Skeleton instead of spinner */}
            <div className="w-full space-y-4 animate-pulse">
              <div className="flex gap-6">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="flex-1 space-y-2">
                    <div className={`h-3 w-16 rounded ${isDark ? 'bg-white/5' : 'bg-zinc-100'}`} />
                    <div className={`h-8 w-20 rounded ${isDark ? 'bg-white/5' : 'bg-zinc-100'}`} />
                  </div>
                ))}
              </div>
              <div className={`h-[200px] rounded-lg ${isDark ? 'bg-white/[0.02]' : 'bg-zinc-50'}`} />
              {[1, 2, 3].map((i) => (
                <div key={i} className={`h-12 rounded-lg ${isDark ? 'bg-white/[0.02]' : 'bg-zinc-50'}`} />
              ))}
            </div>
          </div>
        ) : !view ? (
          <div className="text-center py-24">
            <p className={`text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
              Unable to load workspace. Check your connection.
            </p>
          </div>
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={activeTab}>
              {activeTab === 'progress' && <ProgressTab view={view} isDark={isDark} />}
              {activeTab === 'memory' && <MemoryTab view={view} scope={scope} isDark={isDark} />}
              {activeTab === 'profile' && <ProfileTab view={view} isDark={isDark} />}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}
