'use client';

import { Database, FileText, MessageSquare } from 'lucide-react';

export type PlaygroundApi = 'context' | 'parse' | 'im';

const TABS: { id: PlaygroundApi; label: string; icon: typeof Database }[] = [
  { id: 'context', label: 'Context', icon: Database },
  { id: 'parse', label: 'Parse', icon: FileText },
  { id: 'im', label: 'IM', icon: MessageSquare },
];

export function ApiTabs({
  activeApi,
  onChange,
  isDark,
}: {
  activeApi: PlaygroundApi;
  onChange: (api: PlaygroundApi) => void;
  isDark: boolean;
}) {
  return (
    <div className="flex gap-1 mb-6">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeApi === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              isActive
                ? isDark
                  ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                  : 'bg-violet-100 text-violet-700 border border-violet-300'
                : isDark
                  ? 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'
                  : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100'
            }`}
          >
            <Icon className="w-4 h-4" />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
