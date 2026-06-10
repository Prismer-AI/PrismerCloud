'use client';

/**
 * Asset filter dropdown — replaces the six inline filter chips that used to
 * eat a full second row in the library header. Same data model, single
 * trigger button + popover menu.
 */

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ListFilter } from 'lucide-react';

import { cn } from '@/lib/utils';

export type AssetFilter = 'all' | 'images' | 'docs' | 'code' | 'data' | 'other';

export interface AssetFilterOption {
  key: AssetFilter;
  label: string;
}

interface AssetFilterMenuProps {
  isDark: boolean;
  value: AssetFilter;
  options: AssetFilterOption[];
  onChange: (next: AssetFilter) => void;
  className?: string;
}

export function AssetFilterMenu({ isDark, value, options, onChange, className }: AssetFilterMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const currentLabel = options.find((o) => o.key === value)?.label ?? options[0]?.label ?? 'All';
  const isActive = value !== 'all';

  // Close on Escape + outside click. Keep listeners attached only while open
  // so we don't pay the cost when the menu is dormant.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (wrapperRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="asset-filter-trigger"
        className={cn(
          'inline-flex h-9 items-center gap-1.5 rounded-2xl border px-3 text-xs font-medium transition-colors',
          isActive
            ? isDark
              ? 'border-violet-400/30 bg-violet-500/15 text-violet-100'
              : 'border-violet-200 bg-violet-50 text-violet-800'
            : isDark
              ? 'border-white/[0.08] bg-white/[0.03] text-zinc-300 hover:bg-white/[0.05]'
              : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50',
        )}
      >
        <ListFilter className="h-3.5 w-3.5" />
        <span>{currentLabel}</span>
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>

      {open ? (
        <div
          role="menu"
          data-testid="asset-filter-menu"
          className={cn(
            'absolute right-0 top-full z-30 mt-1.5 w-44 overflow-hidden rounded-2xl border p-1 shadow-2xl',
            isDark ? 'border-white/[0.08] bg-zinc-950 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900',
          )}
        >
          {options.map((option) => {
            const active = option.key === value;
            return (
              <button
                key={option.key}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onChange(option.key);
                  setOpen(false);
                }}
                className={cn(
                  'flex h-9 w-full items-center gap-2 rounded-xl px-2.5 text-left text-xs font-medium transition-colors',
                  active
                    ? isDark
                      ? 'bg-violet-500/15 text-violet-100'
                      : 'bg-violet-50 text-violet-800'
                    : isDark
                      ? 'text-zinc-200 hover:bg-white/[0.06]'
                      : 'text-zinc-700 hover:bg-zinc-100',
                )}
              >
                <Check className={cn('h-3.5 w-3.5 transition-opacity', active ? 'opacity-100' : 'opacity-0')} />
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
