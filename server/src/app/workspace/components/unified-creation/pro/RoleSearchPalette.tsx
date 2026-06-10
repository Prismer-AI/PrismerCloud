'use client';

/**
 * Pro mode role search — friction-first command-palette pattern.
 *
 * Why a palette (not a 225-row list + facets):
 *   - Pro users already know what they want ("frontend developer", "ui
 *     designer"). They type three letters and pick. Left-rail facets are
 *     slow for users who can type the answer.
 *   - 225 results is small enough for front-end-only fuzzy matching; no
 *     server search round-trip needed.
 *
 * Shape:
 *   - Search input always visible.
 *   - When query is empty, the dropdown is hidden — caller renders its
 *     curated tile grid below to avoid noise.
 *   - When the user types, top 8 fuzzy matches show as clickable rows.
 *   - Selecting a row calls onSelect(AgentRoleTemplate). The caller
 *     synthesises an AgentRoleTemplate-shaped object from the picked
 *     API row so the downstream form (display name, slug seed, system
 *     prompt, adapter default) keeps working without branching.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';

import { fuzzyFilter, type FuzzyItem } from '../../../lib/templates/fuzzy';
import { defaultRoleTemplateLoader } from '../template-browser/loader';
import { normalizeRoleTemplates } from '../template-browser/normalize';
import type { RoleTemplateBrowserItem, RoleTemplateLoader } from '../template-browser/types';
import { type AgentRoleTemplate } from '../../../lib/templates';
import { adaptApiRowToRoleTemplate } from './adapt-role-template';

export interface RoleSearchPaletteProps {
  isDark: boolean;
  loader?: RoleTemplateLoader;
  onSelect: (template: AgentRoleTemplate) => void;
  // Disable the palette while the parent is submitting.
  disabled?: boolean;
}

interface PaletteItem extends FuzzyItem {
  raw: RoleTemplateBrowserItem;
}

const MAX_RESULTS = 8;

export function RoleSearchPalette({ isDark, loader = defaultRoleTemplateLoader, onSelect, disabled }: RoleSearchPaletteProps) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<PaletteItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const rows = await loader(controller.signal);
        if (controller.signal.aborted) return;
        const normalized = normalizeRoleTemplates(rows);
        setItems(
          normalized.map((row) => ({
            slug: row.slug,
            searchText: [row.displayName, row.slug, row.description, row.category, ...(row.tags ?? [])]
              .filter(Boolean)
              .join(' ')
              .toLowerCase(),
            raw: row,
          })),
        );
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : '模板加载失败');
        setItems([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [loader]);

  const matches = useMemo(() => fuzzyFilter(query, items, MAX_RESULTS), [query, items]);
  const showDropdown = focused && query.trim().length > 0;

  const fieldClass = [
    'w-full rounded-lg border bg-transparent py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-violet-400/60',
    isDark ? 'border-white/[0.08] text-zinc-100 placeholder:text-zinc-500' : 'border-zinc-200 text-zinc-800 placeholder:text-zinc-400',
  ].join(' ');

  return (
    <div className="relative" data-testid="pro-role-search-palette">
      <Search
        aria-hidden
        className={`pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
      />
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          // Delay so click on dropdown row registers before blur tears it down.
          setTimeout(() => setFocused(false), 120);
        }}
        placeholder={loading ? '加载角色库…' : `搜索全部 ${items.length} 个角色…`}
        aria-label="搜索角色模板"
        disabled={disabled || loading}
        className={fieldClass}
        data-testid="pro-role-search-input"
      />
      {loading ? (
        <Loader2 aria-hidden className={`absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
      ) : null}

      {showDropdown ? (
        <div
          role="listbox"
          aria-label="角色匹配结果"
          className={`absolute z-50 mt-1 w-full overflow-hidden rounded-lg border shadow-lg ${
            isDark ? 'border-white/[0.08] bg-zinc-900' : 'border-zinc-200 bg-white'
          }`}
        >
          {matches.length === 0 ? (
            <div className={`px-3 py-3 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              {error ? `加载失败：${error}` : `没有匹配 "${query}" 的角色`}
            </div>
          ) : (
            matches.map((m) => (
              <button
                key={m.slug}
                type="button"
                role="option"
                aria-selected={false}
                onMouseDown={(e) => e.preventDefault()} // keep input focused so click fires
                onClick={() => {
                  const template = adaptApiRowToRoleTemplate(m.raw);
                  onSelect(template);
                  setQuery('');
                }}
                data-testid={`pro-role-search-result-${m.slug}`}
                className={`flex w-full items-baseline gap-2 px-3 py-2 text-left ${
                  isDark ? 'text-zinc-200 hover:bg-white/[0.05]' : 'text-zinc-800 hover:bg-zinc-50'
                }`}
              >
                <span className="min-w-0 flex-1 truncate text-sm">{m.raw.displayName}</span>
                <span className={`shrink-0 text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{m.raw.category}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
