'use client';

/**
 * Skill Creator — Artifact layer, manifest tree (release201/28 §3.3.2).
 *
 * File status dot: ○ pending → ◉ writing (pulsing) → ● done (springSnap pop).
 * Rows flow in with springLiquid (file "streams in"). Selecting a row drives the
 * preview tabs in the parent canvas. Mirrors the prototype's `#tree` + `.fdot`.
 */

import { motion, useReducedMotion } from 'framer-motion';
import { FileText } from 'lucide-react';

import { grammarAccentClasses, radius, s, springLiquid, springSnap } from '@/app/workspace/lib/design';
import { useTheme } from '@/contexts/theme-context';
import { cn } from '@/lib/utils';

import type { ManifestFile } from '../types';

export interface ManifestTreeProps {
  files: ManifestFile[];
  /** path of the row whose preview is shown; null = none selected. */
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

function splitPath(path: string): { dir: string; base: string } {
  const parts = path.split('/');
  const base = parts.pop() ?? path;
  const dir = parts.length ? `${parts.join('/')}/` : '';
  return { dir, base };
}

function fmtBytes(size: number | null): string {
  if (size == null) return '—';
  if (size < 1024) return `${size} B`;
  return `${(size / 1024).toFixed(1)} KB`;
}

export function ManifestTree({ files, selectedPath, onSelect }: ManifestTreeProps) {
  const { resolvedTheme } = useTheme();
  const reduce = useReducedMotion();
  const isDark = resolvedTheme === 'dark';
  const theme = isDark ? 'dark' : 'light';
  const a = grammarAccentClasses.violet;

  return (
    <div className="flex flex-col gap-1">
      {files.map((f, i) => {
        const { dir, base } = splitPath(f.path);
        const selected = f.path === selectedPath;
        const interactive = f.status !== 'pending';
        return (
          <motion.button
            key={f.path}
            type="button"
            disabled={!interactive}
            onClick={() => interactive && onSelect(f.path)}
            initial={reduce ? false : { opacity: 0, x: -16 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ ...springLiquid, delay: reduce ? 0 : i * 0.04 }}
            className={cn(
              'group flex items-center gap-2.5 border px-3 py-2 text-left text-sm transition-colors',
              radius.small,
              selected ? cn(s(theme, 'card'), a.ring, 'ring-1') : 'border-transparent',
              interactive
                ? isDark
                  ? 'hover:bg-white/[0.04]'
                  : 'hover:bg-zinc-100/70'
                : 'cursor-default opacity-80',
            )}
          >
            <StatusDot status={f.status} reduce={!!reduce} />
            <FileText className={cn('size-4 flex-none', isDark ? 'text-zinc-500' : 'text-zinc-400')} aria-hidden />
            <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
              {dir ? <span className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>{dir}</span> : null}
              <span className={isDark ? 'text-zinc-200' : 'text-zinc-800'}>{base}</span>
            </span>
            <span className={cn('flex-none font-mono text-[11px]', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
              {fmtBytes(f.size)}
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}

function StatusDot({ status, reduce }: { status: ManifestFile['status']; reduce: boolean }) {
  const a = grammarAccentClasses.violet;
  const done = grammarAccentClasses.emerald;

  if (status === 'pending') {
    return <span className="size-2 flex-none rounded-full border border-current text-zinc-500" aria-hidden />;
  }
  if (status === 'writing') {
    return (
      <motion.span
        className={cn('size-2 flex-none rounded-full', a.dot)}
        animate={reduce ? undefined : { scale: [1, 1.5, 1], opacity: [1, 0.5, 1] }}
        transition={reduce ? undefined : { duration: 1, repeat: Infinity, ease: 'easeInOut' }}
        aria-hidden
      />
    );
  }
  return (
    <motion.span
      className={cn('size-2 flex-none rounded-full', done.dot)}
      initial={reduce ? false : { scale: 0 }}
      animate={{ scale: 1 }}
      transition={springSnap}
      aria-hidden
    />
  );
}
