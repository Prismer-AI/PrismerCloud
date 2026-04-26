'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, X, BookOpen, Code2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { SearchEntry } from '../_lib/search-index';

interface Props {
  entries: SearchEntry[];
  placeholder: string;
}

export function SearchCommand({ entries, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const filtered = query.trim()
    ? entries.filter(
        (e) =>
          e.title.toLowerCase().includes(query.toLowerCase()) || e.subtitle.toLowerCase().includes(query.toLowerCase()),
      )
    : entries.slice(0, 10);

  const navigate = useCallback(
    (entry: SearchEntry) => {
      setOpen(false);
      router.push(entry.href);
    },
    [router],
  );

  const cookbooks = filtered.filter((e) => e.type === 'cookbook');
  const endpoints = filtered.filter((e) => e.type === 'endpoint');
  const renderedEndpoints = endpoints.slice(0, 20);
  const allRendered = [...cookbooks, ...renderedEndpoints];

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, allRendered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && allRendered[selectedIdx]) {
      navigate(allRendered[selectedIdx]);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]" onClick={() => setOpen(false)}>
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-lg rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-900 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 p-4 border-b border-zinc-200 dark:border-white/10">
          <Search className="w-4 h-4 text-zinc-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIdx(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="flex-1 bg-transparent text-sm text-zinc-900 dark:text-white outline-none placeholder-zinc-500"
          />
          <button onClick={() => setOpen(false)} className="text-zinc-500 hover:text-zinc-900 dark:hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="max-h-80 overflow-y-auto p-2">
          {cookbooks.length > 0 && (
            <div className="mb-2">
              <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Cookbooks</div>
              {cookbooks.map((entry, i) => {
                const renderedIdx = i;
                return (
                  <button
                    key={i}
                    onClick={() => navigate(entry)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm transition-colors ${
                      renderedIdx === selectedIdx
                        ? 'bg-violet-500/10 text-zinc-900 dark:text-white'
                        : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-white/5'
                    }`}
                  >
                    <BookOpen className="w-4 h-4 shrink-0 text-violet-400" />
                    <div>
                      <div className="font-medium">{entry.title}</div>
                      <div className="text-xs text-zinc-500">{entry.subtitle}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          {endpoints.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                API Endpoints
              </div>
              {renderedEndpoints.map((entry, i) => {
                const renderedIdx = cookbooks.length + i;
                return (
                  <button
                    key={i}
                    onClick={() => navigate(entry)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm transition-colors ${
                      renderedIdx === selectedIdx
                        ? 'bg-violet-500/10 text-zinc-900 dark:text-white'
                        : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-white/5'
                    }`}
                  >
                    <Code2 className="w-4 h-4 shrink-0 text-emerald-400" />
                    <div>
                      <div className="font-medium font-mono text-xs">{entry.title}</div>
                      <div className="text-xs text-zinc-500">{entry.subtitle}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          {filtered.length === 0 && <div className="px-3 py-8 text-center text-sm text-zinc-500">No results found</div>}
        </div>
      </div>
    </div>
  );
}
