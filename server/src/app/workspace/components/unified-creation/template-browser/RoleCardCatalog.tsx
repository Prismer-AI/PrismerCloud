'use client';

/**
 * RoleCardCatalog — card-grid template browser for BrowseAllRolesModal.
 *
 * Why a grid, not a dense list:
 *   - The legacy RoleTemplateBrowser rendered 74 px rows with 3 right-side
 *     badges; it read as a settings panel, not a catalog. Users hunting
 *     across 225 templates need visual chunking.
 *   - Each card surfaces a Lucide icon + name + one-line tagline + category.
 *     Icon resolution: slug → ROLE_ICON_BY_SLUG (curated 5 native), else
 *     category → ROLE_ICON_BY_CATEGORY (covers agency-agents 16 categories),
 *     else neutral Globe. Imported source's `metadata.theme.color` is kept
 *     as the icon swatch tint so each card retains brand identity without
 *     the emoji noise.
 *
 * Two modes:
 *   - multi: checkbox semantics on each card, sticky footer summarising
 *     the selection (used by Simple Step 2's "team builder").
 *   - single: click to pick + dismiss (used by Pro New Agent surface).
 *
 * Front-end-only search + category pill filter. 225 rows is small enough
 * that no virtualization is needed.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, Loader2, Search, X } from 'lucide-react';

import { fuzzyFilter } from '../../../lib/templates/fuzzy';
import { defaultRoleTemplateLoader } from './loader';
import { normalizeRoleTemplates, renderedRoleToTemplateItem } from './normalize';
import { getTemplateIcon } from '../role-icons';
import type { RoleTemplateBrowserItem, RoleTemplateLoader } from './types';
import type { RenderedRole } from '../../../lib/templates/types';

export type CatalogMode = 'multi' | 'single';

export interface RoleCardCatalogProps {
  isDark: boolean;
  mode: CatalogMode;
  selectedSlugs: Set<string>;
  recommendedSet?: Set<string>;
  atCapacity?: boolean;
  fallbackRoles?: readonly RenderedRole[];
  loader?: RoleTemplateLoader;
  onToggle: (item: RoleTemplateBrowserItem) => void;
  onPick?: (item: RoleTemplateBrowserItem) => void;
  onCatalogChange?: (roles: RenderedRole[]) => void;
}

export function RoleCardCatalog({
  isDark,
  mode,
  selectedSlugs,
  recommendedSet = new Set(),
  atCapacity = false,
  fallbackRoles = [],
  loader = defaultRoleTemplateLoader,
  onToggle,
  onPick,
  onCatalogChange,
}: RoleCardCatalogProps) {
  const [items, setItems] = useState<RoleTemplateBrowserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('all');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const rows = await loader(controller.signal);
        if (controller.signal.aborted) return;
        setItems(normalizeRoleTemplates(rows));
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

  const allItems = useMemo(() => {
    const fallbacks = fallbackRoles.map((role) => renderedRoleToTemplateItem(role, 'recommended'));
    const seen = new Set<string>();
    const out: RoleTemplateBrowserItem[] = [];
    for (const item of [...items, ...fallbacks]) {
      if (seen.has(item.slug)) continue;
      seen.add(item.slug);
      out.push(item);
    }
    return out;
  }, [items, fallbackRoles]);

  useEffect(() => {
    onCatalogChange?.(allItems.map((item) => item.role));
  }, [allItems, onCatalogChange]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of allItems) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    return ['all', ...Array.from(counts.keys()).sort()];
  }, [allItems]);

  const fuzzyInputs = useMemo(
    () =>
      allItems.map((item) => ({
        slug: item.slug,
        searchText: [item.displayName, item.slug, item.description, item.category, item.tagline, ...item.tags]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
        raw: item,
      })),
    [allItems],
  );

  const visible = useMemo(() => {
    const matched = fuzzyFilter(query, fuzzyInputs);
    const inCategory = matched.filter((m) => activeCategory === 'all' || m.raw.category === activeCategory);
    return inCategory.map((m) => m.raw);
  }, [fuzzyInputs, query, activeCategory]);

  // Group by category for section rendering. When a single category is
  // active, sections collapse to one — preserves the same component for
  // both filtered and unfiltered views without a branch.
  const sections = useMemo(() => {
    const map = new Map<string, RoleTemplateBrowserItem[]>();
    for (const item of visible) {
      const bucket = map.get(item.category) ?? [];
      bucket.push(item);
      map.set(item.category, bucket);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [visible]);

  const selectedItems = useMemo(
    () => allItems.filter((item) => selectedSlugs.has(item.slug)),
    [allItems, selectedSlugs],
  );

  return (
    <div className="flex min-h-0 flex-col gap-3" data-testid="role-card-catalog">
      <SearchAndFilterBar
        isDark={isDark}
        loading={loading}
        query={query}
        onQueryChange={setQuery}
        categories={categories}
        activeCategory={activeCategory}
        onCategoryChange={setActiveCategory}
        totalCount={allItems.length}
        visibleCount={visible.length}
      />

      {error ? <ErrorLine isDark={isDark} text={error} /> : null}

      <div
        className={`min-h-0 flex-1 overflow-y-auto rounded-lg border ${
          isDark ? 'border-white/[0.06] bg-black/10' : 'border-zinc-200 bg-zinc-50/70'
        }`}
        role="region"
        aria-label="角色卡片目录"
      >
        {visible.length === 0 ? (
          <EmptyState isDark={isDark} loading={loading} query={query} />
        ) : (
          sections.map(([category, sectionItems]) => (
            <CategorySection
              key={category}
              isDark={isDark}
              category={category}
              items={sectionItems}
              recommendedSet={recommendedSet}
              selectedSlugs={selectedSlugs}
              atCapacity={atCapacity}
              mode={mode}
              onToggle={onToggle}
              onPick={onPick}
            />
          ))
        )}
      </div>

      {mode === 'multi' ? (
        <SelectionFooter
          isDark={isDark}
          items={selectedItems}
          atCapacity={atCapacity}
          onRemove={(item) => onToggle(item)}
        />
      ) : null}
    </div>
  );
}

function SearchAndFilterBar({
  isDark,
  loading,
  query,
  onQueryChange,
  categories,
  activeCategory,
  onCategoryChange,
  totalCount,
  visibleCount,
}: {
  isDark: boolean;
  loading: boolean;
  query: string;
  onQueryChange: (next: string) => void;
  categories: string[];
  activeCategory: string;
  onCategoryChange: (next: string) => void;
  totalCount: number;
  visibleCount: number;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className="relative">
        <Search
          aria-hidden
          className={`pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${
            isDark ? 'text-zinc-500' : 'text-zinc-400'
          }`}
        />
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          autoFocus
          placeholder={loading ? '加载角色库…' : `搜索 ${totalCount} 个角色（名称 / 领域 / 关键词）`}
          aria-label="搜索角色"
          data-testid="role-card-catalog-search"
          className={`w-full rounded-lg border bg-transparent py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-violet-400/60 ${
            isDark
              ? 'border-white/[0.08] text-zinc-100 placeholder:text-zinc-500'
              : 'border-zinc-200 text-zinc-800 placeholder:text-zinc-400'
          }`}
        />
        {loading ? (
          <Loader2
            aria-hidden
            className={`absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin ${
              isDark ? 'text-zinc-500' : 'text-zinc-400'
            }`}
          />
        ) : null}
      </label>
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-1 flex-wrap gap-1.5" aria-label="按领域过滤">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => onCategoryChange(cat)}
              className={[
                'rounded-full border px-2.5 py-1 text-[11px]',
                activeCategory === cat
                  ? isDark
                    ? 'border-violet-400/40 bg-violet-500/15 text-violet-200'
                    : 'border-violet-300 bg-violet-50 text-violet-700'
                  : isDark
                    ? 'border-white/[0.08] bg-white/[0.03] text-zinc-400 hover:bg-white/[0.06]'
                    : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50',
              ].join(' ')}
              data-testid={`role-card-catalog-filter-${cat}`}
            >
              {cat === 'all' ? '全部' : cat}
            </button>
          ))}
        </div>
        <span className={`shrink-0 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {visibleCount}/{totalCount}
        </span>
      </div>
    </div>
  );
}

function CategorySection({
  isDark,
  category,
  items,
  recommendedSet,
  selectedSlugs,
  atCapacity,
  mode,
  onToggle,
  onPick,
}: {
  isDark: boolean;
  category: string;
  items: RoleTemplateBrowserItem[];
  recommendedSet: Set<string>;
  selectedSlugs: Set<string>;
  atCapacity: boolean;
  mode: CatalogMode;
  onToggle: (item: RoleTemplateBrowserItem) => void;
  onPick?: (item: RoleTemplateBrowserItem) => void;
}) {
  return (
    <section className="px-3 py-2">
      <h3
        className={`sticky top-0 z-10 -mx-3 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide ${
          isDark ? 'bg-black/40 text-zinc-400 backdrop-blur' : 'bg-zinc-50/70 text-zinc-600 backdrop-blur'
        }`}
      >
        {category} <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>· {items.length}</span>
      </h3>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {items.map((item) => (
          <RoleCard
            key={item.slug}
            isDark={isDark}
            item={item}
            selected={selectedSlugs.has(item.slug)}
            recommended={recommendedSet.has(item.slug)}
            disabled={mode === 'multi' && atCapacity && !selectedSlugs.has(item.slug)}
            mode={mode}
            onClick={() => {
              if (mode === 'single') {
                onPick?.(item);
              } else {
                onToggle(item);
              }
            }}
          />
        ))}
      </div>
    </section>
  );
}

function RoleCard({
  isDark,
  item,
  selected,
  recommended,
  disabled,
  mode,
  onClick,
}: {
  isDark: boolean;
  item: RoleTemplateBrowserItem;
  selected: boolean;
  recommended: boolean;
  disabled: boolean;
  mode: CatalogMode;
  onClick: () => void;
}) {
  const Icon = getTemplateIcon(item.slug, item.category);
  // Apply a soft swatch using the imported color. Fallback to violet.
  const swatch = item.color || '#7C3AED';
  const subtitle = item.tagline || item.description || item.tags.slice(0, 3).join(' · ');
  const iconColor = isDark ? hexWithAlpha(swatch, 0.95) : swatch;
  return (
    <button
      type="button"
      role={mode === 'single' ? 'button' : 'checkbox'}
      aria-checked={mode === 'multi' ? selected : undefined}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={onClick}
      data-testid={`role-card-${item.slug}`}
      title={disabled ? '已达容量' : item.description || undefined}
      className={[
        'group relative flex h-[112px] items-start gap-3 overflow-hidden rounded-xl border p-3 text-left transition',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60',
        disabled
          ? 'cursor-not-allowed opacity-50'
          : isDark
            ? 'hover:border-violet-400/30 hover:bg-white/[0.04]'
            : 'hover:border-violet-300 hover:bg-white',
        selected
          ? isDark
            ? 'border-violet-400/40 bg-violet-500/10'
            : 'border-violet-300 bg-violet-50'
          : isDark
            ? 'border-white/[0.06] bg-black/20'
            : 'border-zinc-200 bg-white',
      ].join(' ')}
    >
      <span
        aria-hidden
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
        style={{ backgroundColor: hexWithAlpha(swatch, isDark ? 0.18 : 0.12) }}
      >
        <Icon className="h-5 w-5" strokeWidth={1.6} style={{ color: iconColor }} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className={`truncate text-sm font-medium ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
            {item.displayName}
          </span>
          {recommended ? (
            <span
              className={`shrink-0 rounded px-1 py-px text-[9px] ${
                isDark ? 'bg-violet-500/15 text-violet-300' : 'bg-violet-100 text-violet-700'
              }`}
            >
              推荐
            </span>
          ) : null}
        </span>
        <span className={`line-clamp-2 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>{subtitle}</span>
        <span className="mt-auto flex items-baseline gap-1.5">
          <span className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{item.category}</span>
          {item.source && item.source !== 'prismer-native' ? (
            <span className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>· {item.source}</span>
          ) : null}
        </span>
      </span>
      {mode === 'multi' ? (
        <span
          className={[
            'absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-md border',
            selected
              ? isDark
                ? 'border-violet-400/50 bg-violet-500/30 text-violet-100'
                : 'border-violet-400 bg-violet-500 text-white'
              : isDark
                ? 'border-white/[0.12] bg-black/30'
                : 'border-zinc-300 bg-white',
          ].join(' ')}
          aria-hidden
        >
          {selected ? <Check className="h-3.5 w-3.5" /> : null}
        </span>
      ) : null}
    </button>
  );
}

function SelectionFooter({
  isDark,
  items,
  atCapacity,
  onRemove,
}: {
  isDark: boolean;
  items: RoleTemplateBrowserItem[];
  atCapacity: boolean;
  onRemove: (item: RoleTemplateBrowserItem) => void;
}) {
  if (items.length === 0) {
    return (
      <div
        className={`flex items-center justify-between rounded-lg border px-3 py-2 text-[11px] ${
          isDark ? 'border-white/[0.06] bg-black/20 text-zinc-500' : 'border-zinc-200 bg-zinc-50 text-zinc-500'
        }`}
      >
        <span>还没有选择任何角色</span>
      </div>
    );
  }
  return (
    <div
      className={`flex flex-wrap items-center gap-1.5 rounded-lg border px-3 py-2 text-[11px] ${
        isDark ? 'border-white/[0.06] bg-black/20' : 'border-zinc-200 bg-zinc-50'
      }`}
      data-testid="role-card-catalog-selection-footer"
    >
      <span className={isDark ? 'text-zinc-400' : 'text-zinc-600'}>已选 {items.length}：</span>
      {items.map((item) => {
        const PillIcon = getTemplateIcon(item.slug, item.category);
        return (
          <span
            key={item.slug}
            className={[
              'inline-flex items-center gap-1 rounded-full pl-2 pr-1 py-0.5',
              isDark ? 'bg-violet-500/15 text-violet-200' : 'bg-violet-100 text-violet-700',
            ].join(' ')}
            data-testid={`role-card-catalog-selected-${item.slug}`}
          >
            <PillIcon className="h-3 w-3 shrink-0" strokeWidth={1.8} aria-hidden />
            <span className="truncate max-w-[150px]">{item.displayName}</span>
            <button
              type="button"
              onClick={() => onRemove(item)}
              aria-label={`取消选择 ${item.displayName}`}
              data-testid={`role-card-catalog-remove-${item.slug}`}
              className={[
                'ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition',
                isDark
                  ? 'text-violet-200/70 hover:bg-violet-400/30 hover:text-violet-100'
                  : 'text-violet-700/70 hover:bg-violet-200 hover:text-violet-900',
              ].join(' ')}
            >
              <X className="h-2.5 w-2.5" strokeWidth={2.5} aria-hidden />
            </button>
          </span>
        );
      })}
      {atCapacity ? <span className="ml-auto text-[10px] text-amber-500">容量已满</span> : null}
    </div>
  );
}

function ErrorLine({ isDark, text }: { isDark: boolean; text: string }) {
  return (
    <div className={`flex items-center gap-1.5 text-[11px] ${isDark ? 'text-amber-300' : 'text-amber-600'}`}>
      <AlertCircle aria-hidden className="h-3.5 w-3.5" />
      <span>模板接口不可用：{text}</span>
    </div>
  );
}

function EmptyState({ isDark, loading, query }: { isDark: boolean; loading: boolean; query: string }) {
  return (
    <div className={`flex items-center justify-center px-3 py-12 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
      {loading ? '正在加载角色…' : query ? `没有匹配 "${query}" 的角色` : '没有可见角色'}
    </div>
  );
}

function hexWithAlpha(hex: string, alpha: number): string {
  const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(124, 58, 237, ${alpha})`;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
