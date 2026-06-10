'use client';

/**
 * Generic card-shelf — layout switching (list/stack/grid), framer-motion
 * mount/exit/layout animations, multi-select wiring, and stack-mode swipe.
 *
 * Consumers pass `data` (flat list or pre-grouped sections) plus a
 * `renderCard` render-prop. The shelf owns layout state (or accepts it
 * controlled), the toggle UI (or hides it for controlled callers placing
 * `<LayoutToggle>` elsewhere), and section headers when grouped data is
 * supplied.
 *
 * Stack mode rotates a single deck; it is auto-disabled for grouped data
 * (multi-section or labeled groups) because flipping through cards loses
 * the section context.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, LayoutGroup, motion, type PanInfo } from 'framer-motion';
import { Grid3X3, LayoutList, Layers } from 'lucide-react';

import { cn } from '@/lib/utils';
import { springSoft } from '../lib/design';

export type CardLayoutMode = 'list' | 'stack' | 'grid';

export interface CardShelfGroup<T> {
  label?: string;
  items: T[];
}

export interface CardShelfRenderArgs<T> {
  item: T;
  layout: CardLayoutMode;
  selected: boolean;
  onToggleSelected?: () => void;
  onPrimaryAction: () => void;
}

export interface CardShelfProps<T> {
  isDark: boolean;

  /**
   * Flat list or grouped sections. Grouped sections render their `label`
   * as a header (unlabeled sections render without a header). A flat
   * `T[]` is treated as a single unlabeled group internally.
   */
  data: T[] | CardShelfGroup<T>[];

  getId: (item: T) => string;
  renderCard: (args: CardShelfRenderArgs<T>) => ReactNode;

  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
  onItemClick?: (item: T) => void;

  /**
   * Pass `layout` to put the shelf in controlled mode — the shelf will
   * NOT render its own `<LayoutToggle>` (caller is expected to render
   * it wherever fits). Omit to let the shelf manage state and render
   * its own toggle.
   */
  layout?: CardLayoutMode;
  defaultLayout?: CardLayoutMode;
  availableLayouts?: CardLayoutMode[];
  onLayoutChange?: (mode: CardLayoutMode) => void;

  /** Override container CSS per mode — e.g. custom grid breakpoints. */
  containerClassName?: Partial<Record<CardLayoutMode, string>>;

  emptyState?: ReactNode;
  className?: string;
}

const SWIPE_THRESHOLD = 50;
const ALL_MODES: CardLayoutMode[] = ['list', 'stack', 'grid'];

const DEFAULT_CONTAINER: Record<CardLayoutMode, string> = {
  list: 'flex flex-col gap-3',
  grid: 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3',
  stack: 'relative mx-auto h-[420px] w-full max-w-[760px]',
};

const LAYOUT_ICONS = {
  list: LayoutList,
  stack: Layers,
  grid: Grid3X3,
} as const;

const LAYOUT_LABELS: Record<CardLayoutMode, string> = {
  list: 'List',
  stack: 'Stack',
  grid: 'Grid',
};

/** Normalize a flat array into a single-group payload. */
function normalizeGroups<T>(data: T[] | CardShelfGroup<T>[]): CardShelfGroup<T>[] {
  if (data.length === 0) return [];
  // Heuristic: a CardShelfGroup is an object with an `items` array.
  // Anything else (string, number, or a plain T) is treated as a flat item.
  const first = data[0] as unknown;
  if (
    first &&
    typeof first === 'object' &&
    'items' in (first as object) &&
    Array.isArray((first as { items: unknown }).items)
  ) {
    return data as CardShelfGroup<T>[];
  }
  return [{ items: data as T[] }];
}

/** Stack mode only makes sense for a single, unlabeled group. */
function stackAllowed<T>(groups: CardShelfGroup<T>[]): boolean {
  return groups.length === 1 && !groups[0].label;
}

// ─── LayoutToggle (standalone export) ─────────────────────────────────────

export interface LayoutToggleProps {
  isDark: boolean;
  layout: CardLayoutMode;
  onChange: (mode: CardLayoutMode) => void;
  availableLayouts?: CardLayoutMode[];
  className?: string;
}

export function LayoutToggle({ isDark, layout, onChange, availableLayouts, className }: LayoutToggleProps) {
  const modes = useMemo(() => {
    const requested = availableLayouts ?? ALL_MODES;
    const filtered = ALL_MODES.filter((m) => requested.includes(m));
    return filtered.length > 0 ? filtered : ALL_MODES;
  }, [availableLayouts]);

  return (
    <div
      className={cn(
        'flex w-fit items-center gap-1 rounded-xl border p-1',
        isDark ? 'border-white/[0.06] bg-zinc-950/70' : 'border-zinc-200 bg-zinc-100',
        className,
      )}
    >
      {modes.map((mode) => {
        const Icon = LAYOUT_ICONS[mode];
        const active = layout === mode;
        return (
          <button
            key={mode}
            type="button"
            onClick={() => onChange(mode)}
            className={cn(
              'inline-flex h-8 items-center gap-2 rounded-lg px-3 text-xs font-semibold transition-colors',
              active
                ? isDark
                  ? 'bg-white/[0.08] text-zinc-100'
                  : 'bg-white text-zinc-950 shadow-sm'
                : isDark
                  ? 'text-zinc-400 hover:text-zinc-100'
                  : 'text-zinc-600 hover:text-zinc-950',
            )}
            aria-label={`Switch to ${mode} layout`}
            aria-pressed={active}
          >
            <Icon className="h-4 w-4" />
            <span className="capitalize">{LAYOUT_LABELS[mode]}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── CardShelf ────────────────────────────────────────────────────────────

export function CardShelf<T>({
  isDark,
  data,
  getId,
  renderCard,
  selectedIds,
  onToggleSelected,
  onItemClick,
  layout: layoutProp,
  defaultLayout = 'list',
  availableLayouts,
  onLayoutChange,
  containerClassName,
  emptyState,
  className,
}: CardShelfProps<T>) {
  const groups = useMemo(() => normalizeGroups(data), [data]);
  const totalCount = useMemo(() => groups.reduce((sum, g) => sum + g.items.length, 0), [groups]);

  // Filter available layouts: strip 'stack' when grouped data would lose
  // section context. The toggle simply hides it, so consumers don't have
  // to know the rule.
  const effectiveLayouts = useMemo(() => {
    const requested = availableLayouts ?? ALL_MODES;
    const allowed = requested.filter((m) => m !== 'stack' || stackAllowed(groups));
    return allowed.length > 0 ? allowed : (['list'] as CardLayoutMode[]);
  }, [availableLayouts, groups]);

  // Layout state: controlled if `layout` prop is provided, otherwise
  // managed internally with `defaultLayout`.
  const isControlled = layoutProp !== undefined;
  const [internalLayout, setInternalLayout] = useState<CardLayoutMode>(
    effectiveLayouts.includes(defaultLayout) ? defaultLayout : effectiveLayouts[0],
  );
  const activeLayout = (() => {
    const raw = isControlled ? layoutProp! : internalLayout;
    return effectiveLayouts.includes(raw) ? raw : effectiveLayouts[0];
  })();

  useEffect(() => {
    onLayoutChange?.(activeLayout);
  }, [activeLayout, onLayoutChange]);

  const setLayout = useCallback(
    (mode: CardLayoutMode) => {
      if (!isControlled) setInternalLayout(mode);
      onLayoutChange?.(mode);
    },
    [isControlled, onLayoutChange],
  );

  // Stack mode internals — only used when activeLayout === 'stack' and
  // groups contain a single unlabeled deck.
  const [activeIndex, setActiveIndex] = useState(0);
  const [dragging, setDragging] = useState(false);
  const stackItems = useMemo(() => {
    if (activeLayout !== 'stack') return [];
    const flat = groups[0]?.items ?? [];
    if (flat.length <= 1) return flat;
    const ordered: T[] = [];
    for (let i = 0; i < flat.length; i++) {
      ordered.push(flat[(activeIndex + i) % flat.length]);
    }
    return ordered;
  }, [activeLayout, groups, activeIndex]);

  const handleDragEnd = useCallback(
    (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      const flat = groups[0]?.items ?? [];
      if (flat.length === 0) return;
      const { offset, velocity } = info;
      const swipe = Math.abs(offset.x) * velocity.x;
      if (offset.x < -SWIPE_THRESHOLD || swipe < -1000) {
        setActiveIndex((prev) => (prev + 1) % flat.length);
      } else if (offset.x > SWIPE_THRESHOLD || swipe > 1000) {
        setActiveIndex((prev) => (prev - 1 + flat.length) % flat.length);
      }
      setDragging(false);
    },
    [groups],
  );

  if (totalCount === 0) {
    return emptyState ? <div className={className}>{emptyState}</div> : null;
  }

  const containerStyles: Record<CardLayoutMode, string> = {
    ...DEFAULT_CONTAINER,
    ...(containerClassName ?? {}),
  } as Record<CardLayoutMode, string>;

  const buildHandlers = (item: T): CardShelfRenderArgs<T> => {
    const id = getId(item);
    const selected = selectedIds?.has(id) ?? false;
    return {
      item,
      layout: activeLayout,
      selected,
      onToggleSelected: onToggleSelected ? () => onToggleSelected(id) : undefined,
      onPrimaryAction: () => onItemClick?.(item),
    };
  };

  const showInternalToggle = !isControlled;
  const flatCount = groups[0]?.items.length ?? 0;

  return (
    <div className={cn('space-y-4', className)}>
      {showInternalToggle ? (
        <LayoutToggle isDark={isDark} layout={activeLayout} onChange={setLayout} availableLayouts={effectiveLayouts} />
      ) : null}

      <LayoutGroup>
        {activeLayout === 'stack' ? (
          // ── Stack mode: single-deck swipe through one group ───────────
          <motion.div layout className={containerStyles.stack}>
            <AnimatePresence mode="popLayout">
              {stackItems.map((item, index) => {
                const id = getId(item);
                const depth = index;
                const isTop = depth === 0;
                const offset = depth * 10;
                const rotate = (depth - 1) * 2;
                return (
                  <motion.div
                    key={id}
                    layoutId={`stack:${id}`}
                    initial={{ opacity: 0, scale: 0.95, y: 8 }}
                    animate={{
                      opacity: 1,
                      scale: isTop && dragging ? 1.02 : depth > 0 ? 0.98 - depth * 0.02 : 1,
                      x: 0,
                      y: offset,
                      rotate,
                      zIndex: flatCount - depth,
                    }}
                    exit={{ opacity: 0, scale: 0.95, y: -8 }}
                    transition={springSoft}
                    drag={isTop ? 'x' : false}
                    dragConstraints={{ left: 0, right: 0 }}
                    dragElastic={0.7}
                    onDragStart={() => setDragging(true)}
                    onDragEnd={handleDragEnd}
                    whileDrag={isTop ? { scale: 1.02, cursor: 'grabbing' } : undefined}
                    onClick={() => {
                      if (dragging) return;
                      onItemClick?.(item);
                    }}
                    className="absolute inset-x-0 mx-auto w-full max-w-[720px] px-1"
                  >
                    {renderCard(buildHandlers(item))}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </motion.div>
        ) : (
          // ── List / Grid mode: render each group as a section ──────────
          //
          // The grid container is a plain <div> — NOT <motion.div layout>.
          // Wrapping the container in `layout` causes framer-motion to
          // measure it via getBoundingClientRect, which mis-reports flow
          // height inside `overflow-y-auto` parents and silently disables
          // the scrollbar. The per-item `<motion.div layoutId>` already
          // animates the list↔grid transition smoothly.
          <div className="space-y-6">
            {groups.map((group, gIdx) => (
              <section key={group.label ?? `g${gIdx}`}>
                {group.label ? (
                  <h3
                    className={cn(
                      'mb-2 text-[10px] font-bold uppercase tracking-wider',
                      isDark ? 'text-zinc-500' : 'text-zinc-500',
                    )}
                  >
                    {group.label}
                  </h3>
                ) : null}
                <div className={containerStyles[activeLayout]}>
                  <AnimatePresence mode="popLayout">
                    {group.items.map((item) => {
                      const id = getId(item);
                      return (
                        <motion.div
                          key={id}
                          layoutId={`flat:${gIdx}:${id}`}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.95, y: -8 }}
                          transition={springSoft}
                          onClick={() => onItemClick?.(item)}
                          className="w-full"
                        >
                          {renderCard(buildHandlers(item))}
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>
              </section>
            ))}
          </div>
        )}
      </LayoutGroup>

      {activeLayout === 'stack' && flatCount > 1 ? (
        <div className="flex justify-center gap-1.5">
          {Array.from({ length: flatCount }).map((_, index) => (
            <button
              key={index}
              type="button"
              onClick={() => setActiveIndex(index)}
              className={cn(
                'h-1.5 rounded-full transition-all',
                index === activeIndex ? 'w-4 bg-violet-500' : isDark ? 'w-1.5 bg-zinc-600' : 'w-1.5 bg-zinc-300',
              )}
              aria-label={`Go to card ${index + 1}`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
