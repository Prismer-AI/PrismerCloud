'use client';

/**
 * LibraryGraphPanel — Memory Line B / B6.
 *
 * Renders the workspace memory page graph + a Health rail. The graph
 * deliberately uses pure SVG with a BFS-tier layout (no D3 / cytoscape /
 * react-flow / dagre dependency) — for the doc 23 §6.2 cap of ≤ 80 nodes
 * default the depth-bucketed columnar layout is plenty, and we save
 * 80–250 KB of bundle the plan explicitly warns about.
 *
 * Health items below the graph are rendered as four rows (broken links /
 * stale / duplicates / orphans). Clicking a row jumps back to the Memory
 * list view with a path filter (callback up to the parent surface).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Loader2, RefreshCcw } from 'lucide-react';

import {
  getMemoryGraph,
  getMemoryHealth,
  listMemoryPages,
  type MemoryGraphEdgeDTO,
  type MemoryGraphNodeDTO,
  type MemoryGraphResponseDTO,
  type MemoryHealthItemDTO,
  type MemoryHealthKind,
  type MemoryPageSummaryDTO,
} from '../lib/memory-api';

interface LibraryGraphPanelProps {
  workspaceId: string;
  isDark: boolean;
  /** Called when the user clicks a node's "Open in Memory view" or a Health row's path. */
  onJumpToMemory: (path: string) => void;
}

const PAGE_TYPE_COLOR: Record<string, { bg: string; ring: string }> = {
  hub: { bg: '#8b5cf6', ring: '#c4b5fd' },
  leaf: { bg: '#06b6d4', ring: '#67e8f9' },
  index: { bg: '#3b82f6', ring: '#93c5fd' },
  dataset: { bg: '#10b981', ring: '#6ee7b7' },
  decision: { bg: '#f59e0b', ring: '#fcd34d' },
  procedure: { bg: '#ec4899', ring: '#f9a8d4' },
  glossary: { bg: '#6366f1', ring: '#a5b4fc' },
  archive: { bg: '#64748b', ring: '#cbd5e1' },
};

const NODE_R_BASE = 12;
const NODE_R_PER_INBOUND = 1.4;
const NODE_R_MAX = 30;
const COL_WIDTH = 200;
const ROW_HEIGHT = 56;
const PAD = 40;

interface PositionedNode extends MemoryGraphNodeDTO {
  x: number;
  y: number;
  r: number;
}

const HEALTH_KINDS: MemoryHealthKind[] = ['broken-links', 'stale', 'duplicates', 'orphans'];

// D3: UI-only rail kinds. 'top-index-size' is a client-side count from the
// already-loaded pages list (no backend endpoint) so it lives outside the
// MemoryHealthKind union, which is reserved for /memory/health/<kind>.
type RailKind = MemoryHealthKind | 'top-index-size';
const RAIL_KINDS: RailKind[] = [...HEALTH_KINDS, 'top-index-size'];
// Thresholds for the Top-INDEX rail. Past 180 the workspace's INDEX.md is
// getting unwieldy; past 200 it has saturated the listMemoryPages cap and
// becomes a real navigation problem.
const TOP_INDEX_WARN = 180;
const TOP_INDEX_ERROR = 200;

export function LibraryGraphPanel({ workspaceId, isDark, onJumpToMemory }: LibraryGraphPanelProps) {
  const [pages, setPages] = useState<MemoryPageSummaryDTO[]>([]);
  const [rootId, setRootId] = useState<string | null>(null);
  const [depth, setDepth] = useState<number>(2);
  const [graph, setGraph] = useState<MemoryGraphResponseDTO | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<MemoryGraphNodeDTO | null>(null);
  const [healthLoading, setHealthLoading] = useState<Record<MemoryHealthKind, boolean>>({
    'broken-links': false,
    stale: false,
    duplicates: false,
    orphans: false,
  });
  const [health, setHealth] = useState<Record<MemoryHealthKind, { items: MemoryHealthItemDTO[]; total: number }>>(
    () => ({
      'broken-links': { items: [], total: 0 },
      stale: { items: [], total: 0 },
      duplicates: { items: [], total: 0 },
      orphans: { items: [], total: 0 },
    }),
  );

  // Load pages once for the root selector + reference labels.
  useEffect(() => {
    if (!workspaceId) return;
    const ac = new AbortController();
    listMemoryPages({ workspaceId, limit: 200, signal: ac.signal }).then((res) => {
      if (!res.ok || ac.signal.aborted) return;
      setPages(res.data ?? []);
      // Auto-select INDEX.md or first hub if rootId is null.
      if (!rootId) {
        const indexPage =
          res.data?.find((p) => p.path === 'memory/INDEX.md') ??
          res.data?.find((p) => p.pageType === 'hub') ??
          res.data?.[0];
        if (indexPage) setRootId(indexPage.id);
      }
    });
    return () => ac.abort();
    // rootId intentionally excluded so re-listing pages doesn't ping the
    // root selector after the user picks one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // Refresh graph whenever root + depth change.
  useEffect(() => {
    if (!workspaceId || !rootId) return;
    const ac = new AbortController();
    setGraphLoading(true);
    setGraphError(null);
    getMemoryGraph({ workspaceId, rootId, depth, signal: ac.signal }).then((res) => {
      if (ac.signal.aborted) return;
      if (res.ok) {
        setGraph(res.data ?? null);
      } else {
        setGraphError(res.message);
        setGraph(null);
      }
      setGraphLoading(false);
    });
    return () => ac.abort();
  }, [workspaceId, rootId, depth]);

  // Load health rails on mount; AbortController + signal so a workspaceId
  // switch tears down any in-flight fetch before its setState lands.
  useEffect(() => {
    if (!workspaceId) return undefined;
    const ac = new AbortController();
    HEALTH_KINDS.forEach((kind) => {
      setHealthLoading((prev) => ({ ...prev, [kind]: true }));
      getMemoryHealth(kind, workspaceId, 50, ac.signal).then((res) => {
        if (ac.signal.aborted) return;
        setHealthLoading((prev) => ({ ...prev, [kind]: false }));
        if (!res.ok) return;
        setHealth((prev) => ({ ...prev, [kind]: res.data ?? { items: [], total: 0 } }));
      });
    });
    return () => ac.abort();
  }, [workspaceId]);

  // Lay out the graph as BFS columns from the root id.
  const positioned = useMemo(() => {
    if (!graph || !rootId)
      return { nodes: [] as PositionedNode[], edges: [] as MemoryGraphEdgeDTO[], width: 0, height: 0 };
    return layoutBfs(graph, rootId);
  }, [graph, rootId]);

  // D3: Top-INDEX size — count of organizational pages (hub | index) in the
  // already-loaded list. parentPageId isn't currently returned by the list
  // API, so this is a pageType-only proxy: counts every hub/index page in
  // the workspace, not strictly the top-level ones. listMemoryPages caps at
  // 200, which by design coincides with the TOP_INDEX_ERROR threshold — if
  // we see ≥ 200, the count has saturated and the rail rightly shows red.
  const topIndexRail = useMemo(() => {
    const items = pages.filter((p) => p.pageType === 'hub' || p.pageType === 'index');
    return {
      total: items.length,
      items: items.slice(0, 12).map((p) => ({
        pageId: p.id,
        path: p.path,
        title: p.title,
        reason: `${p.pageType} · ${p.inboundLinkCount ?? 0} inbound`,
      })),
    };
  }, [pages]);

  return (
    <div data-testid="library-graph-panel" className="flex h-full min-h-0 flex-col">
      <div
        className={`flex flex-wrap items-center gap-2 border-b px-3 py-2 ${
          isDark ? 'border-white/[0.06] bg-zinc-950/30' : 'border-zinc-200 bg-zinc-50/60'
        }`}
      >
        <label
          className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
        >
          Root
        </label>
        <select
          data-testid="library-graph-root"
          value={rootId ?? ''}
          onChange={(event) => setRootId(event.target.value || null)}
          className={`min-w-[12rem] rounded-xl border px-2 py-1 text-xs outline-none ${
            isDark ? 'border-white/[0.08] bg-white/[0.03] text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
          }`}
        >
          {pages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.path}
            </option>
          ))}
        </select>
        <label
          className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
        >
          Depth
        </label>
        <select
          data-testid="library-graph-depth"
          value={depth}
          onChange={(event) => setDepth(Number(event.target.value))}
          className={`rounded-xl border px-2 py-1 text-xs outline-none ${
            isDark ? 'border-white/[0.08] bg-white/[0.03] text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
          }`}
        >
          {[1, 2, 3, 4].map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="library-graph-refresh"
          onClick={() => setRootId((prev) => prev)}
          className={`ml-1 inline-flex items-center gap-1 rounded-xl border px-2 py-1 text-[11px] font-semibold ${
            isDark
              ? 'border-white/[0.06] bg-white/[0.04] text-zinc-200 hover:bg-white/[0.08]'
              : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'
          }`}
        >
          <RefreshCcw className="h-3 w-3" /> Refresh
        </button>
        {graph?.truncated && graph.truncated.totalNodes > graph.truncated.shownNodes ? (
          <span
            data-testid="library-graph-truncated-banner"
            className={`ml-auto rounded-full border px-2 py-0.5 text-[10px] ${
              isDark
                ? 'border-amber-400/40 bg-amber-500/10 text-amber-200'
                : 'border-amber-300 bg-amber-50 text-amber-700'
            }`}
          >
            showing {graph.truncated.shownNodes} of {graph.truncated.totalNodes} total nodes within depth={depth} of
            root
          </span>
        ) : null}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="relative min-h-0 overflow-auto" data-testid="library-graph-canvas">
          {graphLoading ? (
            <div
              className={`flex h-full items-center justify-center text-[11px] ${
                isDark ? 'text-zinc-400' : 'text-zinc-500'
              }`}
            >
              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
              Loading graph…
            </div>
          ) : graphError ? (
            <div
              data-testid="library-graph-error"
              className={`flex h-full items-center justify-center px-6 text-center text-xs ${
                isDark ? 'text-rose-300' : 'text-rose-600'
              }`}
            >
              {graphError}
            </div>
          ) : positioned.nodes.length === 0 ? (
            <div
              data-testid="library-graph-empty"
              className={`flex h-full items-center justify-center px-6 text-center text-xs ${
                isDark ? 'text-zinc-500' : 'text-zinc-500'
              }`}
            >
              No connected pages within depth {depth} of this root.
            </div>
          ) : (
            <GraphSvg
              positioned={positioned}
              isDark={isDark}
              selectedNode={selectedNode}
              onSelect={setSelectedNode}
              onJumpToMemory={onJumpToMemory}
            />
          )}
        </div>

        <aside
          data-testid="library-graph-health"
          className={`min-h-0 overflow-y-auto border-l px-3 py-3 ${
            isDark ? 'border-white/[0.06] bg-zinc-950/30' : 'border-zinc-200 bg-zinc-50/60'
          }`}
        >
          <p
            className={`mb-2 text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
          >
            Health
          </p>
          {RAIL_KINDS.map((kind) =>
            kind === 'top-index-size' ? (
              <HealthRow
                key={kind}
                kind={kind}
                isDark={isDark}
                loading={false}
                total={topIndexRail.total}
                items={topIndexRail.items}
                onJumpToMemory={onJumpToMemory}
              />
            ) : (
              <HealthRow
                key={kind}
                kind={kind}
                isDark={isDark}
                loading={healthLoading[kind]}
                total={health[kind].total}
                items={health[kind].items}
                onJumpToMemory={onJumpToMemory}
              />
            ),
          )}
        </aside>
      </div>
    </div>
  );
}

function HealthRow({
  kind,
  isDark,
  loading,
  total,
  items,
  onJumpToMemory,
}: {
  kind: RailKind;
  isDark: boolean;
  loading: boolean;
  total: number;
  items: Pick<MemoryHealthItemDTO, 'pageId' | 'path' | 'title' | 'reason'>[];
  onJumpToMemory: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // 'top-index-size' tone is dynamic: green ≤179, amber 180–199, rose ≥200.
  // The other kinds are static — non-zero means a problem to surface.
  const tone =
    kind === 'top-index-size'
      ? total >= TOP_INDEX_ERROR
        ? 'rose'
        : total >= TOP_INDEX_WARN
          ? 'amber'
          : 'green'
      : kind === 'broken-links'
        ? 'rose'
        : kind === 'stale'
          ? 'amber'
          : kind === 'duplicates'
            ? 'violet'
            : 'zinc';
  const labelMap: Record<RailKind, string> = {
    'broken-links': 'Broken links',
    stale: 'Stale pages',
    duplicates: 'Duplicate clusters',
    orphans: 'Orphans',
    'top-index-size': `Top-index: ${total} / ${TOP_INDEX_ERROR} entries`,
  };
  return (
    <div data-testid={`library-graph-health-${kind}`} className="mb-2">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className={`flex w-full items-center gap-2 rounded-2xl border px-3 py-2 text-left transition-colors ${
          isDark
            ? 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'
            : 'border-zinc-200 bg-white hover:bg-zinc-50'
        }`}
      >
        <ChevronRight
          className={`h-3 w-3 transition-transform ${expanded ? 'rotate-90' : ''} ${
            isDark ? 'text-zinc-500' : 'text-zinc-400'
          }`}
        />
        <span className={`flex-1 text-xs font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
          {labelMap[kind]}
        </span>
        {loading ? (
          <Loader2 className="h-3 w-3 animate-spin text-zinc-400" />
        ) : kind === 'top-index-size' ? (
          // Top-index rail: label already shows the count, but render a
          // colored dot so the rail is scannable at a glance.
          <span
            data-testid="library-graph-health-top-index-size-dot"
            className={`inline-block h-2 w-2 rounded-full ${
              tone === 'rose'
                ? 'bg-rose-500'
                : tone === 'amber'
                  ? 'bg-amber-500'
                  : 'bg-emerald-500'
            }`}
          />
        ) : (
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums ${
              total === 0
                ? isDark
                  ? 'bg-emerald-500/15 text-emerald-200'
                  : 'bg-emerald-50 text-emerald-700'
                : tone === 'rose'
                  ? isDark
                    ? 'bg-rose-500/15 text-rose-200'
                    : 'bg-rose-50 text-rose-700'
                  : tone === 'amber'
                    ? isDark
                      ? 'bg-amber-500/15 text-amber-200'
                      : 'bg-amber-50 text-amber-700'
                    : tone === 'violet'
                      ? isDark
                        ? 'bg-violet-500/15 text-violet-200'
                        : 'bg-violet-50 text-violet-700'
                      : isDark
                        ? 'bg-white/[0.05] text-zinc-300'
                        : 'bg-zinc-100 text-zinc-700'
            }`}
          >
            {total}
          </span>
        )}
      </button>
      {expanded && items.length > 0 ? (
        <ul className="mt-1 space-y-0.5 px-1">
          {items.slice(0, 12).map((item) => (
            <li key={`${kind}-${item.pageId}`}>
              <button
                type="button"
                data-testid={`library-graph-health-${kind}-row-${item.pageId}`}
                onClick={() => onJumpToMemory(item.path)}
                className={`flex w-full flex-col rounded-xl px-2.5 py-1.5 text-left transition-colors ${
                  isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-zinc-100'
                }`}
              >
                <span className={`truncate text-[11px] font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                  {item.title ?? item.path.split('/').pop()}
                </span>
                <span className={`truncate text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  {item.path} · {item.reason}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface LayoutResult {
  nodes: PositionedNode[];
  edges: MemoryGraphEdgeDTO[];
  width: number;
  height: number;
}

function layoutBfs(graph: MemoryGraphResponseDTO, rootId: string): LayoutResult {
  const byId = new Map(graph.nodes.map((n) => [n.pageId, n]));
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.sourcePageId)) adjacency.set(edge.sourcePageId, []);
    adjacency.get(edge.sourcePageId)!.push(edge.targetPageId);
  }

  const tier = new Map<string, number>();
  if (byId.has(rootId)) {
    tier.set(rootId, 0);
    const queue: string[] = [rootId];
    while (queue.length) {
      const cur = queue.shift()!;
      const curTier = tier.get(cur) ?? 0;
      for (const next of adjacency.get(cur) ?? []) {
        if (!byId.has(next) || tier.has(next)) continue;
        tier.set(next, curTier + 1);
        queue.push(next);
      }
    }
  }
  // Anything still missing a tier (no inbound from root) lands in the
  // "outside" column at the right.
  let outsideTier = 0;
  for (const node of graph.nodes) {
    if (!tier.has(node.pageId)) {
      const t = Math.max(...Array.from(tier.values()), 0) + 1 + outsideTier;
      tier.set(node.pageId, t);
      outsideTier += 1;
    }
  }

  const cols = new Map<number, MemoryGraphNodeDTO[]>();
  for (const node of graph.nodes) {
    const t = tier.get(node.pageId) ?? 0;
    if (!cols.has(t)) cols.set(t, []);
    cols.get(t)!.push(node);
  }
  for (const arr of cols.values()) {
    arr.sort((a, b) => b.inboundCount - a.inboundCount || a.path.localeCompare(b.path));
  }
  const sortedTiers = Array.from(cols.keys()).sort((a, b) => a - b);

  const positioned: PositionedNode[] = [];
  let maxRows = 0;
  for (const t of sortedTiers) {
    const arr = cols.get(t)!;
    maxRows = Math.max(maxRows, arr.length);
    arr.forEach((n, idx) => {
      const r = Math.min(NODE_R_MAX, NODE_R_BASE + Math.log1p(n.inboundCount) * NODE_R_PER_INBOUND * 4);
      positioned.push({
        ...n,
        x: PAD + sortedTiers.indexOf(t) * COL_WIDTH,
        y: PAD + idx * ROW_HEIGHT,
        r,
      });
    });
  }
  const width = PAD * 2 + (sortedTiers.length - 1) * COL_WIDTH + 80;
  const height = PAD * 2 + maxRows * ROW_HEIGHT + 40;
  return { nodes: positioned, edges: graph.edges, width: Math.max(width, 480), height: Math.max(height, 360) };
}

function GraphSvg({
  positioned,
  isDark,
  selectedNode,
  onSelect,
  onJumpToMemory,
}: {
  positioned: LayoutResult;
  isDark: boolean;
  selectedNode: MemoryGraphNodeDTO | null;
  onSelect: (node: MemoryGraphNodeDTO | null) => void;
  onJumpToMemory: (path: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const positionMap = useMemo(() => new Map(positioned.nodes.map((n) => [n.pageId, n])), [positioned.nodes]);
  const edgeStroke = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.18)';
  const brokenStroke = isDark ? 'rgba(244,63,94,0.55)' : 'rgba(220,38,38,0.7)';
  const labelColor = isDark ? 'rgba(244,244,245,0.9)' : 'rgba(24,24,27,0.92)';

  return (
    <div className="relative h-full w-full">
      <svg
        ref={svgRef}
        data-testid="library-graph-svg"
        width={positioned.width}
        height={positioned.height}
        viewBox={`0 0 ${positioned.width} ${positioned.height}`}
        style={{ minWidth: positioned.width, minHeight: positioned.height }}
      >
        <g>
          {positioned.edges.map((edge, idx) => {
            const a = positionMap.get(edge.sourcePageId);
            const b = positionMap.get(edge.targetPageId);
            if (!a || !b) return null;
            const stroke = edge.broken ? brokenStroke : edgeStroke;
            return (
              <line
                key={`e-${idx}-${edge.sourcePageId}-${edge.targetPageId}`}
                data-testid={edge.broken ? 'library-graph-edge-broken' : 'library-graph-edge'}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={stroke}
                strokeWidth={edge.broken ? 1.6 : 1}
                strokeDasharray={edge.broken ? '4 3' : undefined}
              />
            );
          })}
        </g>
        <g>
          {positioned.nodes.map((node) => {
            const tone = PAGE_TYPE_COLOR[node.pageType] ?? PAGE_TYPE_COLOR.leaf;
            const opacity = node.stale ? 0.45 : 1;
            const isSelected = selectedNode?.pageId === node.pageId;
            return (
              <g
                key={node.pageId}
                data-testid={`library-graph-node-${node.pageId}`}
                data-stale={node.stale ? 'true' : undefined}
                onClick={() => onSelect(node)}
                style={{ cursor: 'pointer', opacity }}
              >
                <circle cx={node.x} cy={node.y} r={node.r + 3} fill={tone.ring} fillOpacity={isSelected ? 0.6 : 0.25} />
                <circle cx={node.x} cy={node.y} r={node.r} fill={tone.bg} stroke={tone.ring} strokeWidth={1} />
                <text
                  x={node.x + node.r + 4}
                  y={node.y + 4}
                  fontSize={11}
                  fill={labelColor}
                  style={{ pointerEvents: 'none' }}
                >
                  {(node.title ?? node.path.split('/').pop() ?? '').slice(0, 24)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      {selectedNode ? (
        <div
          data-testid="library-graph-node-popover"
          className={`absolute right-3 top-3 w-72 rounded-2xl border p-3 shadow-2xl ${
            isDark ? 'border-white/[0.08] bg-zinc-950/95' : 'border-zinc-200 bg-white/95'
          }`}
        >
          <p className={`truncate text-sm font-bold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
            {selectedNode.title ?? selectedNode.path.split('/').pop()}
          </p>
          <p className={`truncate text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{selectedNode.path}</p>
          <p className={`mt-2 text-[10px] ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            {selectedNode.pageType} · v? · inbound {selectedNode.inboundCount}
            {selectedNode.stale ? ' · stale' : ''}
          </p>
          <div className="mt-3 flex justify-end gap-1">
            <button
              type="button"
              data-testid="library-graph-popover-close"
              onClick={() => onSelect(null)}
              className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${
                isDark ? 'text-zinc-400 hover:bg-white/[0.05]' : 'text-zinc-500 hover:bg-zinc-100'
              }`}
            >
              Close
            </button>
            <button
              type="button"
              data-testid="library-graph-popover-open"
              onClick={() => {
                onJumpToMemory(selectedNode.path);
                onSelect(null);
              }}
              className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${
                isDark
                  ? 'bg-violet-500/30 text-violet-100 hover:bg-violet-500/40'
                  : 'bg-violet-100 text-violet-900 hover:bg-violet-200'
              }`}
            >
              Open in Memory view
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
