'use client';

import { Search } from 'lucide-react';

export function SearchTrigger({ placeholder }: { placeholder: string }) {
  const handleClick = () => {
    // Dispatch Cmd+K to open SearchCommand
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
  };

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-zinc-800/50 text-zinc-400 dark:text-zinc-500 text-xs hover:border-violet-300 dark:hover:border-violet-500/30 transition-colors min-w-[200px]"
    >
      <Search className="w-3.5 h-3.5" />
      <span className="flex-1 text-left">{placeholder}</span>
      <kbd className="hidden sm:inline px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-700 text-[10px] font-mono text-zinc-400">
        ⌘K
      </kbd>
    </button>
  );
}
