'use client';

import { useState } from 'react';
import { CodeBlock } from '@/components/ui/code-block';
import { useTheme } from '@/contexts/theme-context';

interface CodeTab {
  label: string;
  language: string;
  code: string;
}

export function CodeGroup({ tabs }: { tabs: CodeTab[] }) {
  const [activeIdx, setActiveIdx] = useState(0);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  if (tabs.length === 0) return null;

  return (
    <div
      className={`rounded-xl overflow-hidden ${isDark ? 'border border-white/10 bg-zinc-900/30' : 'border border-zinc-200 bg-white'}`}
    >
      <div className={`flex gap-0 border-b ${isDark ? 'border-white/10' : 'border-zinc-200'}`}>
        {tabs.map((tab, i) => (
          <button
            key={i}
            onClick={() => setActiveIdx(i)}
            className={`px-4 py-2 text-xs font-medium transition-colors ${
              i === activeIdx
                ? isDark
                  ? 'text-white bg-zinc-800/50 border-b-2 border-violet-500'
                  : 'text-zinc-900 bg-zinc-50 border-b-2 border-violet-600'
                : isDark
                  ? 'text-zinc-500 hover:text-zinc-300'
                  : 'text-zinc-400 hover:text-zinc-600'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="p-4">
        <CodeBlock code={tabs[activeIdx].code} language={tabs[activeIdx].language} isDark={isDark} />
      </div>
    </div>
  );
}
