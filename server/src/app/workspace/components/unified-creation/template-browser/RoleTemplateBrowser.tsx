'use client';

import { createElement, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertCircle, BadgeCheck, Check, Loader2, Search, ShieldCheck, UserPlus } from 'lucide-react';

import { getRoleIcon } from '../role-icons';
import {
  filterRoleTemplateItems,
  makeDefaultFacets,
  normalizeRoleTemplates,
  renderedRoleToTemplateItem,
} from './normalize';
import { defaultRoleTemplateLoader } from './loader';
import type {
  RoleTemplateBrowserFacets,
  RoleTemplateBrowserItem,
  RoleTemplateLoader,
  RoleTemplateQualityTier,
} from './types';
import type { RenderedRole } from '../../../lib/templates/types';

export interface RoleTemplateBrowserProps {
  isDark: boolean;
  selectedSlugs: Set<string>;
  atCapacity: boolean;
  fallbackRoles: readonly RenderedRole[];
  recommendedSet?: Set<string>;
  loader?: RoleTemplateLoader;
  onToggle: (role: RenderedRole) => void;
  onCatalogChange?: (roles: RenderedRole[]) => void;
  // Friction-first mode used by Simple Step 2 modal: hide quality + source
  // facets (internal concepts), keep search + category only. Default false
  // preserves the legacy power-user popover surface.
  simplifyFacets?: boolean;
  // Optional list height override (modal needs taller list than popover).
  listHeightClass?: string;
}

const QUALITY_LABEL: Record<RoleTemplateQualityTier | 'all', string> = {
  all: '全部',
  gold: 'Gold',
  silver: 'Silver',
  bronze: 'Bronze',
  review: 'Review',
  unknown: 'Unknown',
};

const QUALITY_ORDER: readonly (RoleTemplateQualityTier | 'all')[] = ['all', 'gold', 'silver', 'bronze', 'review'];

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function chipClass(isDark: boolean, active: boolean): string {
  if (active) {
    return isDark
      ? 'border-violet-400/40 bg-violet-500/15 text-violet-200'
      : 'border-violet-300 bg-violet-50 text-violet-700';
  }
  return isDark
    ? 'border-white/[0.08] bg-white/[0.03] text-zinc-400 hover:bg-white/[0.06]'
    : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50';
}

function qualityBadgeClass(isDark: boolean, quality: RoleTemplateQualityTier): string {
  if (quality === 'gold') return isDark ? 'bg-amber-400/15 text-amber-200' : 'bg-amber-100 text-amber-700';
  if (quality === 'silver') return isDark ? 'bg-sky-400/15 text-sky-200' : 'bg-sky-100 text-sky-700';
  if (quality === 'bronze') return isDark ? 'bg-orange-400/15 text-orange-200' : 'bg-orange-100 text-orange-700';
  return isDark ? 'bg-white/[0.06] text-zinc-300' : 'bg-zinc-100 text-zinc-600';
}

export function RoleTemplateBrowser({
  isDark,
  selectedSlugs,
  atCapacity,
  fallbackRoles,
  recommendedSet = new Set(),
  loader = defaultRoleTemplateLoader,
  onToggle,
  onCatalogChange,
  simplifyFacets = false,
  listHeightClass,
}: RoleTemplateBrowserProps) {
  const [search, setSearch] = useState('');
  const [facets, setFacets] = useState<RoleTemplateBrowserFacets>(() => makeDefaultFacets());
  const [remoteItems, setRemoteItems] = useState<RoleTemplateBrowserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const rows = await loader(controller.signal);
        if (controller.signal.aborted) return;
        setRemoteItems(normalizeRoleTemplates(rows));
      } catch (err) {
        if (controller.signal.aborted) return;
        setRemoteItems([]);
        setError(err instanceof Error ? err.message : '模板加载失败');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [loader]);

  const fallbackItems = useMemo(
    () => fallbackRoles.map((role) => renderedRoleToTemplateItem(role, 'recommended')),
    [fallbackRoles],
  );

  const items = useMemo(() => {
    const out: RoleTemplateBrowserItem[] = [];
    const seen = new Set<string>();
    for (const item of [...remoteItems, ...fallbackItems]) {
      if (seen.has(item.slug)) continue;
      seen.add(item.slug);
      out.push(item);
    }
    return out;
  }, [remoteItems, fallbackItems]);

  useEffect(() => {
    onCatalogChange?.(items.map((item) => item.role));
  }, [items, onCatalogChange]);

  const categories = useMemo(() => ['all', ...Array.from(new Set(items.map((item) => item.category))).sort()], [items]);
  const sources = useMemo(() => ['all', ...Array.from(new Set(items.map((item) => item.source))).sort()], [items]);
  const visibleItems = useMemo(() => filterRoleTemplateItems(items, { search, facets }), [items, search, facets]);

  const parentRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: visibleItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 74,
    overscan: 8,
  });

  const fieldClass = cx(
    'w-full rounded-lg border bg-transparent py-1.5 pl-8 pr-2 text-xs outline-none focus:ring-2 focus:ring-violet-400/60',
    isDark
      ? 'border-white/[0.08] text-zinc-200 placeholder:text-zinc-500'
      : 'border-zinc-200 text-zinc-800 placeholder:text-zinc-400',
  );

  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="role-template-browser">
      <label className="relative">
        <Search
          aria-hidden
          className={cx(
            'pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2',
            isDark ? 'text-zinc-500' : 'text-zinc-400',
          )}
        />
        <input
          type="text"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`搜索 ${items.length || 200} 个角色模板…`}
          aria-label="搜索角色模板"
          data-testid="role-template-browser-search"
          className={fieldClass}
        />
      </label>

      {simplifyFacets ? null : (
        <div className="flex flex-wrap gap-1.5" aria-label="质量分层筛选">
          {QUALITY_ORDER.map((tier) => (
            <button
              key={tier}
              type="button"
              onClick={() => setFacets((prev) => ({ ...prev, qualityTier: tier }))}
              className={cx('rounded-md border px-2 py-1 text-[11px]', chipClass(isDark, facets.qualityTier === tier))}
            >
              {QUALITY_LABEL[tier]}
            </button>
          ))}
        </div>
      )}

      <div className={simplifyFacets ? '' : 'grid grid-cols-2 gap-2'}>
        <select
          aria-label="模板分类筛选"
          value={facets.category}
          onChange={(e) => setFacets((prev) => ({ ...prev, category: e.target.value }))}
          className={cx(
            'min-w-0 rounded-lg border bg-transparent px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-violet-400/60',
            isDark ? 'border-white/[0.08] text-zinc-300' : 'border-zinc-200 text-zinc-700',
            simplifyFacets ? 'w-full' : '',
          )}
        >
          {categories.map((category) => (
            <option key={category} value={category}>
              {category === 'all' ? '全部分类' : category}
            </option>
          ))}
        </select>
        {simplifyFacets ? null : (
          <select
            aria-label="模板来源筛选"
            value={facets.source}
            onChange={(e) => setFacets((prev) => ({ ...prev, source: e.target.value }))}
            className={cx(
              'min-w-0 rounded-lg border bg-transparent px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-violet-400/60',
              isDark ? 'border-white/[0.08] text-zinc-300' : 'border-zinc-200 text-zinc-700',
            )}
          >
            {sources.map((source) => (
              <option key={source} value={source}>
                {source === 'all' ? '全部来源' : source}
              </option>
            ))}
          </select>
        )}
      </div>

      {loading ? (
        <StateLine isDark={isDark} icon="loading" text="正在加载模板…" />
      ) : error ? (
        <StateLine isDark={isDark} icon="error" text={`模板接口不可用，已显示本地角色：${error}`} />
      ) : null}

      <div
        ref={parentRef}
        className={cx(
          listHeightClass ?? 'h-72',
          'overflow-y-auto rounded-lg border',
          isDark ? 'border-white/[0.06] bg-black/10' : 'border-zinc-200 bg-zinc-50/70',
        )}
      >
        {visibleItems.length === 0 ? (
          <div className={cx('px-3 py-8 text-center text-xs', isDark ? 'text-zinc-500' : 'text-zinc-400')}>
            没有匹配的模板
          </div>
        ) : (
          <div
            style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}
            role="listbox"
            aria-label="角色模板"
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const item = visibleItems[virtualRow.index];
              return (
                <TemplateRow
                  key={item.slug}
                  item={item}
                  isDark={isDark}
                  selected={selectedSlugs.has(item.slug)}
                  recommended={recommendedSet.has(item.slug)}
                  disabled={atCapacity && !selectedSlugs.has(item.slug)}
                  onToggle={() => onToggle(item.role)}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function StateLine({ isDark, icon, text }: { isDark: boolean; icon: 'loading' | 'error'; text: string }) {
  const Icon = icon === 'loading' ? Loader2 : AlertCircle;
  return (
    <div className={cx('flex items-center gap-1.5 text-[11px]', isDark ? 'text-zinc-400' : 'text-zinc-500')}>
      <Icon aria-hidden className={cx('h-3.5 w-3.5', icon === 'loading' && 'animate-spin')} />
      <span className="truncate">{text}</span>
    </div>
  );
}

function TemplateRow({
  item,
  isDark,
  selected,
  recommended,
  disabled,
  onToggle,
  style,
}: {
  item: RoleTemplateBrowserItem;
  isDark: boolean;
  selected: boolean;
  recommended: boolean;
  disabled: boolean;
  onToggle: () => void;
  style: CSSProperties;
}) {
  const iconNode = createElement(getRoleIcon(item.slug), { 'aria-hidden': true, className: 'h-3.5 w-3.5' });
  return (
    <div style={style} className="px-1 py-1">
      <button
        type="button"
        role="option"
        aria-selected={selected}
        aria-disabled={disabled || undefined}
        onClick={() => !disabled && onToggle()}
        data-testid={`role-template-browser-row-${item.slug}`}
        title={disabled ? '容量已满' : undefined}
        className={cx(
          'group flex h-[66px] w-full items-start gap-2 rounded-lg px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60',
          disabled ? 'cursor-default opacity-60' : isDark ? 'hover:bg-white/[0.05]' : 'hover:bg-white',
          selected && (isDark ? 'bg-violet-500/10' : 'bg-violet-50'),
        )}
      >
        <span
          className={cx(
            'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border',
            selected
              ? isDark
                ? 'border-violet-400/40 bg-violet-500/20 text-violet-200'
                : 'border-violet-300 bg-violet-100 text-violet-700'
              : isDark
                ? 'border-white/[0.08] text-zinc-400'
                : 'border-zinc-200 text-zinc-500',
          )}
        >
          {selected ? <Check aria-hidden className="h-3.5 w-3.5" /> : iconNode}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cx('truncate text-xs font-medium', isDark ? 'text-zinc-200' : 'text-zinc-800')}>
              {item.displayName}
            </span>
            {item.qualityTier === 'gold' ? (
              <ShieldCheck aria-hidden className="h-3.5 w-3.5 shrink-0 text-amber-500" />
            ) : null}
            {recommended ? (
              <span
                className={cx(
                  'shrink-0 rounded px-1 py-px text-[9px]',
                  isDark ? 'bg-violet-500/15 text-violet-300' : 'bg-violet-100 text-violet-700',
                )}
              >
                推荐
              </span>
            ) : null}
          </span>
          <span className={cx('mt-0.5 block truncate text-[11px]', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
            {item.description || item.slug}
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5">
            <span className={cx('rounded px-1 py-px text-[9px]', qualityBadgeClass(isDark, item.qualityTier))}>
              {QUALITY_LABEL[item.qualityTier]}
            </span>
            <span className={cx('truncate text-[10px]', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
              {item.category} · {item.source}
            </span>
            {item.license ? (
              <span
                className={cx(
                  'inline-flex items-center gap-0.5 text-[10px]',
                  isDark ? 'text-zinc-400' : 'text-zinc-500',
                )}
              >
                <BadgeCheck aria-hidden className="h-3 w-3" />
                {item.license}
              </span>
            ) : null}
            {item.requiredSkillCount > 0 ? (
              <span
                className={cx(
                  'inline-flex items-center gap-0.5 text-[10px]',
                  isDark ? 'text-zinc-400' : 'text-zinc-500',
                )}
              >
                <UserPlus aria-hidden className="h-3 w-3" />
                {item.requiredSkillCount}
              </span>
            ) : null}
          </span>
        </span>
      </button>
    </div>
  );
}

export default RoleTemplateBrowser;
