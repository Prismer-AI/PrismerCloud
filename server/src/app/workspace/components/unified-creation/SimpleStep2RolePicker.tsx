'use client';

/**
 * §30 B3.3 — SimpleStep2Team's "+ 添加其他角色" popover body.
 *
 * Search box + scrollable role list (multi-select via checkboxes). Splits
 * out of SimpleStep2Team.tsx so the main file stays under the 400-line
 * budget per task spec. Pure presentational — owner state (selection,
 * search, capacity) lives in SimpleStep2Team.
 */

import { useMemo } from 'react';
import { Search } from 'lucide-react';

import type { RenderedRole } from '../../lib/templates/types';
import { getRoleIcon } from './role-icons';

export interface SimpleStep2RolePickerProps {
  isDark: boolean;
  roles: readonly RenderedRole[];
  selectedSlugs: Set<string>;
  recommendedSet: Set<string>;
  atCapacity: boolean;
  search: string;
  onSearchChange: (next: string) => void;
  onToggle: (slug: string) => void;
}

export function SimpleStep2RolePicker({
  isDark,
  roles,
  selectedSlugs,
  recommendedSet,
  atCapacity,
  search,
  onSearchChange,
  onToggle,
}: SimpleStep2RolePickerProps) {
  // Order: not-yet-selected at top, already-selected (locked) below — gives
  // the user the additions panel they actually want.
  const ordered = useMemo(() => {
    const head = roles.filter((r) => !selectedSlugs.has(r.slug));
    const tail = roles.filter((r) => selectedSlugs.has(r.slug));
    return [...head, ...tail];
  }, [roles, selectedSlugs]);

  return (
    <div className="flex flex-col gap-2" data-testid="simple-step2-role-picker">
      <label className="relative">
        <Search
          aria-hidden
          className={`pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 ${
            isDark ? 'text-zinc-500' : 'text-zinc-400'
          }`}
        />
        <input
          type="text"
          autoFocus
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="搜索角色…"
          aria-label="搜索角色"
          data-testid="simple-step2-role-search"
          className={`w-full rounded-lg border bg-transparent py-1.5 pl-8 pr-2 text-xs outline-none focus:ring-2 focus:ring-violet-400/60 ${
            isDark
              ? 'border-white/[0.08] text-zinc-200 placeholder:text-zinc-500'
              : 'border-zinc-200 text-zinc-800 placeholder:text-zinc-400'
          }`}
        />
      </label>

      <ul className="max-h-64 overflow-y-auto pr-0.5" role="listbox" aria-label="可添加的角色">
        {ordered.length === 0 ? (
          <li className={`px-2 py-3 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>没有匹配的角色</li>
        ) : (
          ordered.map((role) => {
            const selected = selectedSlugs.has(role.slug);
            const recommended = recommendedSet.has(role.slug);
            // Lock rule: already-selected rows are pre-checked & disabled
            // (per spec), and at capacity unchecked rows are also disabled.
            const locked = selected || (atCapacity && !selected);
            return (
              <li key={role.slug}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-disabled={locked || undefined}
                  onClick={() => !locked && onToggle(role.slug)}
                  data-testid={`simple-step2-picker-${role.slug}`}
                  title={atCapacity && !selected ? 'Solo 模板上限 / 容量已满' : undefined}
                  className={`group flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left ${
                    locked
                      ? 'cursor-default opacity-60'
                      : isDark
                        ? 'cursor-pointer hover:bg-white/[0.04]'
                        : 'cursor-pointer hover:bg-zinc-100'
                  } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60`}
                >
                  <input
                    type="checkbox"
                    aria-hidden
                    tabIndex={-1}
                    readOnly
                    checked={selected}
                    disabled={locked}
                    className="mt-1 h-3.5 w-3.5 shrink-0 accent-violet-500"
                  />
                  {(() => {
                    const Icon = getRoleIcon(role.slug);
                    return (
                      <Icon
                        aria-hidden
                        className={`mt-0.5 h-4 w-4 shrink-0 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
                        strokeWidth={1.5}
                      />
                    );
                  })()}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-baseline gap-1.5">
                      <span className={`text-xs font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                        {role.displayName}
                      </span>
                      {recommended ? (
                        <span
                          className={`rounded px-1 py-px text-[9px] uppercase tracking-wide ${
                            isDark ? 'bg-violet-500/15 text-violet-300' : 'bg-violet-100 text-violet-700'
                          }`}
                        >
                          推荐
                        </span>
                      ) : null}
                    </span>
                    <span className={`mt-0.5 truncate text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                      {role.rationale}
                    </span>
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

export default SimpleStep2RolePicker;
