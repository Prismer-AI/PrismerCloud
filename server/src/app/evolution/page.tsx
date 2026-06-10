'use client';

/**
 * /evolution — Evolution Visualization Page
 *
 * Five sub-tabs:
 * 1. OVERVIEW  — Hero canvas + KPIs + How it Works + Milestones
 * 2. SKILLS    — 5,455 skill catalog from OpenClaw
 * 3. GENES     — Gene library with real execution data
 * 4. TIMELINE  — Temporal feed of evolution events
 * 5. AGENTS    — Agent leaderboard
 */

import { Suspense, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import {
  Dna,
  Zap,
  TrendingUp,
  Network,
  Search,
  Sparkles,
  ArrowRight,
  ChevronDown,
  Copy,
  Check,
  Activity,
  Clock,
  XCircle,
  Loader2,
  Play,
  Brain,
  ExternalLink,
  Star,
  Download,
  Users,
  Trophy,
  User,
  Filter,
  Diamond,
  CircleDot,
  Compass,
  X,
  MessageSquare,
  Map,
  GitFork,
  Share2,
  Wrench,
} from 'lucide-react';
import { useTheme } from '@/contexts/theme-context';
import { useApp } from '@/contexts/app-context';
import { useI18n } from '@/contexts/i18n-context';
import { TiltCard } from '@/components/evolution/tilt-card';
import { EvolutionMap } from '@/components/evolution/evolution-map';
import { LibraryTab } from './components/library-tab';
import { GeneForkSheet } from './components/gene-fork-sheet';
// FeedTab removed — activity feed is now in the Map sidebar
// my-evolution-tab.tsx 已于 v2.0.8 物理删除 (doc-13 §4.4 §11)；未登录用户改用
// 下方 UnauthenticatedStudioPlaceholder（~30 行登录引导，避免 1050 行 fallback 长尾）。
import {
  StudioTab,
  type SkillsSubview,
  type StudioView,
  normalizeLegacyView,
  normalizeSkillsSubview,
  legacyViewToSubview,
} from './components/studio-tab';
// release201/28 — Evolution Studio v2 shell (feature-flagged, coexists with the
// legacy StudioTab). normalizeLegacyView aliased to avoid clashing with the
// legacy studio-tab export of the same name.
import { StudioShellV2 } from './components/studio/v2/studio-shell';
import { parseStudioUrl, normalizeLegacyView as normalizeStudioV2Section } from './components/studio/v2/url';
import { STUDIO_V2_ENABLED } from './components/studio/v2/flags';
import { getSourceBadge, glass } from './components/helpers';
import { LeaderboardTab } from './components/leaderboard-tab';
// ─── Evolution types (inline — leaderboard module removed, pending redesign) ─────

interface PublicGene {
  id?: string;
  gene_id?: string;
  title: string;
  description?: string;
  category?: string;
  signals_match?: { type: string }[];
  strategy?: string[];
  successCount?: number;
  failureCount?: number;
  forkCount?: number;
  visibility?: string;
  author?: string;
  qualityScore?: number;
  createdAt?: string;
  updatedAt?: string;
  success_count?: number;
  failure_count?: number;
  fork_count?: number;
  used_by_count?: number;
  [key: string]: any;
}

interface FeedEvent {
  id?: string;
  type?: string;
  geneId?: string;
  geneTitle?: string;
  geneCategory?: string;
  agentName?: string;
  outcome?: string;
  signalKey?: string;
  ts?: string;
  timestamp?: string;
  [key: string]: any;
}

interface MetricsSnapshot {
  id?: number;
  ts?: string;
  ssr?: number;
  gd?: number;
  er?: number;
  frrApprox?: number;
  nrr?: number;
  totalGenes?: number;
  totalCapsules?: number;
  activeAgents?: number;
  repeatRate?: number;
  mode?: string;
  scope?: string;
  [key: string]: any;
}

function agentScore(a: { successes: number; failures: number; capsules: number }): number {
  const total = a.successes + a.failures;
  if (total === 0) return 0;
  return (a.successes / total) * Math.log2(total + 1);
}

function aggregateAgentHeatmap(feed: FeedEvent[], name: string): { date: string; count: number }[] {
  const counts: Record<string, number> = {};
  for (const e of feed) {
    if (e.agentName !== name || !e.ts) continue;
    const d = new Date(e.ts as string).toISOString().slice(0, 10);
    counts[d] = (counts[d] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

interface Skill {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  author: string;
  source: string;
  sourceUrl: string;
  installs: number;
  stars: number;
  status: string;
  geneId?: string;
}

interface SkillCategory {
  category: string;
  count: number;
}

interface EvolutionStats {
  total_genes: number;
  total_capsules: number;
  avg_success_rate: number;
  active_agents: number;
}

interface SkillStats {
  total: number;
  by_source: Record<string, number>;
  by_category: Record<string, number>;
  total_installs: number;
}

type TabKey = 'overview' | 'skills' | 'genes' | 'timeline' | 'agents' | 'studio' | 'library' | 'feed';

const VALID_TAB_KEYS = new Set<TabKey>(['overview', 'skills', 'genes', 'timeline', 'agents', 'studio', 'library']);

// ─── Constants ──────────────────────────────────────────

const TABS: { key: TabKey; labelKey: `evolution.${string}`; icon: typeof Activity }[] = [
  { key: 'overview', labelKey: 'evolution.tabs.map', icon: Map },
  { key: 'library', labelKey: 'evolution.tabs.marketplace', icon: Sparkles },
  { key: 'agents', labelKey: 'evolution.tabs.leaderboard', icon: Trophy },
  { key: 'studio', labelKey: 'evolution.tabs.studio', icon: Wrench },
];

const CAT_COLORS: Record<string, { text: string; bg: string; border: string; glow: string; hex: string }> = {
  repair: {
    text: 'text-orange-400',
    bg: 'bg-orange-500/10',
    border: 'border-orange-500/20',
    glow: 'rgba(249,115,22,0.12)',
    hex: '#f97316',
  },
  optimize: {
    text: 'text-cyan-400',
    bg: 'bg-cyan-500/10',
    border: 'border-cyan-500/20',
    glow: 'rgba(6,182,212,0.12)',
    hex: '#06b6d4',
  },
  innovate: {
    text: 'text-violet-400',
    bg: 'bg-violet-500/10',
    border: 'border-violet-500/20',
    glow: 'rgba(139,92,246,0.12)',
    hex: '#8b5cf6',
  },
};

const GENE_CATEGORIES = [
  { key: '', label: 'All' },
  { key: 'repair', label: 'Repair' },
  { key: 'optimize', label: 'Optimize' },
  { key: 'innovate', label: 'Innovate' },
] as const;

const SORT_OPTIONS = [
  { key: 'newest', label: 'Newest' },
  { key: 'most_used', label: 'Most Used' },
  { key: 'highest_success', label: 'Highest Success' },
] as const;

const FEED_ICONS: Record<string, { icon: typeof CircleDot; color: string }> = {
  capsule: { icon: CircleDot, color: 'text-emerald-400' },
  distill: { icon: Diamond, color: 'text-violet-400' },
  publish: { icon: Star, color: 'text-amber-400' },
  milestone: { icon: Trophy, color: 'text-cyan-400' },
  import: { icon: Download, color: 'text-blue-400' },
};

// ─── Helpers ────────────────────────────────────────────

type EvolutionT = ReturnType<typeof useI18n>['t'];

function localizedTimeAgo(ts: string, t: EvolutionT): string {
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return t('evolution.common.justNow');
  if (m < 60) return t('evolution.common.minutesAgo', { count: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('evolution.common.hoursAgo', { count: h });
  const d = Math.floor(h / 24);
  if (d < 30) return t('evolution.common.daysAgo', { count: d });
  return new Date(ts).toLocaleDateString();
}

function categoryLabel(category: string | undefined, t: EvolutionT): string {
  const key = category || 'all';
  const translationKey = `evolution.common.categoryLabels.${key}` as `evolution.${string}`;
  const translated = t(translationKey);
  return translated === translationKey ? key : translated;
}

function eventActionLabel(type: string | undefined, t: EvolutionT): string {
  if (type === 'capsule') return t('evolution.legacy.executed');
  if (type === 'publish') return t('evolution.legacy.published');
  if (type === 'distill') return t('evolution.legacy.distilled');
  return t('evolution.legacy.achieved');
}

function eventTypeLabel(type: string, t: EvolutionT): string {
  if (!type) return t('evolution.common.all');
  const key = `evolution.legacy.eventTypes.${type}` as `evolution.${string}`;
  const translated = t(key);
  return translated === key ? type : translated;
}

function sourceBadgeLabel(source: string | undefined, fallback: string | undefined, t: EvolutionT): string {
  const sourceKey =
    source === 'awesome-openclaw' ? 'awesomeOpenclaw' : source === 'evolution' ? 'evolved' : source || '';
  if (!sourceKey) return fallback || t('evolution.common.community');
  const translationKey = `evolution.library.sourceBadge.${sourceKey}` as `evolution.${string}`;
  const translated = t(translationKey);
  return translated === translationKey ? fallback || sourceKey : translated;
}

/** Hydration-safe time display — renders empty on SSR, fills client-side */
function TimeAgo({ ts, className }: { ts: string; className?: string }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  useEffect(() => {
    setText(localizedTimeAgo(ts, t));
  }, [ts, t]);
  return (
    <span className={className} suppressHydrationWarning>
      {text}
    </span>
  );
}

function dateLocale(locale: string): string {
  return locale === 'zh' ? 'zh-CN' : locale === 'en' ? 'en-US' : locale;
}

function formatDate(ts: string, locale: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(dateLocale(locale), { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function formatDay(ts: string, locale: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(dateLocale(locale), { day: 'numeric' }).format(date);
}

function computePQI(g: PublicGene, maxExecutions: number): number {
  const total = (g.success_count || 0) + (g.failure_count || 0);
  const successRate = total > 0 ? (g.success_count || 0) / total : 0;
  const normalizedExec = maxExecutions > 0 ? Math.min(total / maxExecutions, 1) : 0;
  const adoptionRate = (g.used_by_count || 0) > 0 ? Math.min((g.used_by_count || 0) / 50, 1) : 0;
  const freshness = 0.5; // No date info in list view, assume moderate freshness
  return Math.round((successRate * 0.4 + normalizedExec * 0.3 + adoptionRate * 0.2 + freshness * 0.1) * 100);
}

function getGeneId(g: PublicGene): string {
  return g.gene_id || g.id || '';
}
function getSignals(g: PublicGene): string[] {
  const raw = g.signals || g.signals_match || [];
  return raw
    .map((s: unknown) => (typeof s === 'string' ? s : ((s as Record<string, unknown>)?.type as string) || ''))
    .filter(Boolean);
}
function getSteps(g: PublicGene): string[] {
  if (Array.isArray(g.strategy)) return g.strategy as string[];
  if (g.strategy && typeof g.strategy === 'object' && Array.isArray((g.strategy as { steps?: string[] }).steps))
    return (g.strategy as { steps: string[] }).steps;
  return [];
}

// ─── Animated Counter ───────────────────────────────────

function AnimatedCounter({ value, suffix = '' }: { value: number | string; suffix?: string }) {
  const [display, setDisplay] = useState(0);
  const numVal = typeof value === 'string' ? parseFloat(value) : value;
  useEffect(() => {
    if (isNaN(numVal)) return;
    const duration = 1200;
    const start = performance.now();
    const from = 0;
    function tick(now: number) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(from + (numVal - from) * eased));
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }, [numVal]);
  return (
    <>
      {display.toLocaleString()}
      {suffix}
    </>
  );
}

// ─── Canvas Network Visualization (3-column: Signal→Gene→Outcome) ───

function NetworkCanvas({ isDark }: { isDark: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = 0;
    let height = 0;

    interface Node {
      x: number;
      y: number;
      baseX: number;
      baseY: number;
      r: number;
      color: string;
      type: 'signal' | 'gene' | 'outcome';
      pulse: number;
      label: string;
    }
    interface Edge {
      from: number;
      to: number;
      particles: number[];
      speed: number;
    }

    const colors = { signal: '#f97316', gene: '#06b6d4', outcome_ok: '#22c55e', outcome_fail: '#ef4444' };
    const signalLabels = ['error:timeout', 'error:429', 'task.failed', 'error:401', 'error:dns', 'error:parse'];
    const geneLabels = [
      'Timeout Recovery',
      'Rate Limiter',
      'Auth Refresh',
      'DNS Fallback',
      'Retry Logic',
      'Cache First',
    ];
    const outcomeLabels = ['Success', 'Success', 'Retry', 'Success', 'Failed', 'Success'];

    let nodes: Node[] = [];
    let edges: Edge[] = [];

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas!.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function init() {
      resize();
      nodes = [];
      edges = [];
      const rows = Math.min(Math.floor(height / 50), 6);
      const colX = [width * 0.18, width * 0.5, width * 0.82];
      const padY = height * 0.15;
      const stepY = rows > 1 ? (height - padY * 2) / (rows - 1) : 0;

      for (let i = 0; i < rows; i++) {
        const y = padY + stepY * i;
        const jitter = () => (Math.random() - 0.5) * 12;
        // Signal node
        nodes.push({
          x: colX[0] + jitter(),
          y: y + jitter(),
          baseX: colX[0],
          baseY: y,
          r: 4.5,
          color: colors.signal,
          type: 'signal',
          pulse: Math.random() * Math.PI * 2,
          label: signalLabels[i % signalLabels.length],
        });
        // Gene node
        nodes.push({
          x: colX[1] + jitter(),
          y: y + jitter(),
          baseX: colX[1],
          baseY: y,
          r: 5.5,
          color: colors.gene,
          type: 'gene',
          pulse: Math.random() * Math.PI * 2,
          label: geneLabels[i % geneLabels.length],
        });
        // Outcome node
        const isFail = outcomeLabels[i % outcomeLabels.length] === 'Failed';
        nodes.push({
          x: colX[2] + jitter(),
          y: y + jitter(),
          baseX: colX[2],
          baseY: y,
          r: 4,
          color: isFail ? colors.outcome_fail : colors.outcome_ok,
          type: 'outcome',
          pulse: Math.random() * Math.PI * 2,
          label: outcomeLabels[i % outcomeLabels.length],
        });

        const base = i * 3;
        // Signal→Gene edge
        edges.push({
          from: base,
          to: base + 1,
          particles: [Math.random(), Math.random() * 0.5],
          speed: 0.003 + Math.random() * 0.002,
        });
        // Gene→Outcome edge
        edges.push({ from: base + 1, to: base + 2, particles: [Math.random()], speed: 0.003 + Math.random() * 0.002 });
      }
      // Cross-connections: some signals connect to adjacent genes
      for (let i = 0; i < rows - 1; i++) {
        if (Math.random() > 0.5) {
          edges.push({ from: i * 3, to: (i + 1) * 3 + 1, particles: [Math.random()], speed: 0.002 });
        }
      }
    }

    function draw() {
      ctx!.clearRect(0, 0, width, height);
      const alpha = isDark ? 1 : 0.7;

      // Column labels
      ctx!.font = '10px ui-monospace, monospace';
      ctx!.textAlign = 'center';
      ctx!.globalAlpha = 0.25 * alpha;
      ctx!.fillStyle = isDark ? '#fff' : '#000';
      if (width > 400) {
        ctx!.fillText('SIGNALS', width * 0.18, 20);
        ctx!.fillText('GENES', width * 0.5, 20);
        ctx!.fillText('OUTCOMES', width * 0.82, 20);
      }
      ctx!.globalAlpha = 1;

      // Edges with Bezier curves
      for (const edge of edges) {
        const a = nodes[edge.from];
        const b = nodes[edge.to];
        const midX = (a.x + b.x) / 2;

        ctx!.beginPath();
        ctx!.moveTo(a.x, a.y);
        ctx!.bezierCurveTo(midX, a.y, midX, b.y, b.x, b.y);
        ctx!.strokeStyle = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)';
        ctx!.lineWidth = 1;
        ctx!.stroke();

        // Particles along bezier
        for (let p = 0; p < edge.particles.length; p++) {
          edge.particles[p] += edge.speed;
          if (edge.particles[p] > 1) edge.particles[p] = 0;
          const t = edge.particles[p];
          const t1 = 1 - t;
          const px = t1 * t1 * t1 * a.x + 3 * t1 * t1 * t * midX + 3 * t1 * t * t * midX + t * t * t * b.x;
          const py = t1 * t1 * t1 * a.y + 3 * t1 * t1 * t * a.y + 3 * t1 * t * t * b.y + t * t * t * b.y;
          ctx!.beginPath();
          ctx!.arc(px, py, 2, 0, Math.PI * 2);
          ctx!.fillStyle = a.color;
          ctx!.globalAlpha = 0.7 * alpha;
          ctx!.fill();
          ctx!.globalAlpha = 1;
        }
      }

      // Nodes with gentle float
      for (const node of nodes) {
        node.pulse += 0.015;
        node.x = node.baseX + Math.sin(node.pulse) * 4;
        node.y = node.baseY + Math.cos(node.pulse * 0.7) * 3;

        const pulseR = node.r + Math.sin(node.pulse * 2) * 1;

        // Glow
        ctx!.beginPath();
        ctx!.arc(node.x, node.y, pulseR * 3.5, 0, Math.PI * 2);
        ctx!.fillStyle = node.color;
        ctx!.globalAlpha = 0.06 * alpha;
        ctx!.fill();
        ctx!.globalAlpha = 1;

        // Core
        ctx!.beginPath();
        ctx!.arc(node.x, node.y, pulseR, 0, Math.PI * 2);
        ctx!.fillStyle = node.color;
        ctx!.globalAlpha = 0.85 * alpha;
        ctx!.fill();
        ctx!.globalAlpha = 1;

        // Label
        if (width > 500) {
          ctx!.font = '9px ui-sans-serif, system-ui, sans-serif';
          ctx!.textAlign = node.type === 'signal' ? 'right' : node.type === 'outcome' ? 'left' : 'center';
          ctx!.fillStyle = node.color;
          ctx!.globalAlpha = 0.5 * alpha;
          const labelX =
            node.type === 'signal' ? node.x - pulseR - 6 : node.type === 'outcome' ? node.x + pulseR + 6 : node.x;
          const labelY = node.type === 'gene' ? node.y - pulseR - 5 : node.y + 3;
          ctx!.fillText(node.label, labelX, labelY);
          ctx!.globalAlpha = 1;
        }
      }

      animRef.current = requestAnimationFrame(draw);
    }

    init();
    animRef.current = requestAnimationFrame(draw);
    window.addEventListener('resize', init);

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener('resize', init);
    };
  }, [isDark]);

  return <canvas ref={canvasRef} className="w-full h-full" />;
}

// ─── Loading Skeleton ───────────────────────────────────

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-zinc-800/40 ${className}`} />;
}

function CardSkeleton({ isDark }: { isDark: boolean }) {
  return (
    <div className={`rounded-xl p-5 ${glass(isDark)}`}>
      <Skeleton className="h-4 w-20 mb-3" />
      <Skeleton className="h-5 w-3/4 mb-2" />
      <Skeleton className="h-3 w-full mb-1" />
      <Skeleton className="h-3 w-2/3 mb-4" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────

export default function EvolutionPage() {
  return (
    <Suspense fallback={null}>
      <EvolutionPageContent />
    </Suspense>
  );
}

function EvolutionPageContent() {
  const { resolvedTheme } = useTheme();
  const { isAuthenticated, addToast } = useApp();
  const { t, locale } = useI18n();
  const isDark = resolvedTheme === 'dark';

  // ─── URL state adapter (13-P0, doc release201/13 §3.1) ──────────
  // Hydrate tab/view/agentId/draftId from search params so refresh and
  // book-marks survive. Legacy `?tab=my` middleware was retired in v2.0.9
  // (S37) — unknown / legacy tab keys fall back to `overview` with a console
  // warn for debug trace. See doc release201/13 §3.1 and decision D-15.
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const initialTab: TabKey = (() => {
    const raw = searchParams?.get('tab');
    if (raw && VALID_TAB_KEYS.has(raw as TabKey)) return raw as TabKey;
    if (raw && typeof window !== 'undefined') {
      // v2.0.9 (S37): legacy `?tab=my` and other unknown keys no longer
      // rewrite — they degrade to overview. Surface a debug trace so we can
      // see lingering bookmarks if they materially persist.

      console.warn(`[evolution] Legacy or unknown tab key "${raw}", falling back to overview`);
    }
    return 'overview';
  })();
  const initialView: StudioView = (() => {
    // Studio now exposes 3 views (my-agents / skills / metrics). Legacy values
    // from the 6-domain split are collapsed via normalizeLegacyView so existing
    // bookmarks keep working.
    return normalizeLegacyView(searchParams?.get('view'));
  })();

  const [activeTab, setActiveTab] = useState<TabKey>(initialTab);
  const [tabTransition, setTabTransition] = useState(false);
  const [studioView, setStudioView] = useState<StudioView>(initialView);
  const [studioSubview, setStudioSubview] = useState<SkillsSubview>(
    // release201/13 §3.2 (S22): `?subview=` carries Skills view sub-tab.
    // release201/24 §Phase3: also honour a legacy `?view=lifecycle|installed|
    // evolution|authoring` link by deriving the canonical subview from it, so
    // old deep links (and library-surface's `view=lifecycle`) land correctly.
    normalizeSkillsSubview(searchParams?.get('subview') ?? legacyViewToSubview(searchParams?.get('view'))),
  );
  const [studioAgentId, setStudioAgentId] = useState<string | null>(searchParams?.get('agentId') ?? null);
  const [studioDraftId, setStudioDraftId] = useState<string | null>(searchParams?.get('draftId') ?? null);

  // ─── URL <-> state sync ────────────────────────────────
  // Push current state to the URL using router.replace (keeps history clean).
  const writeUrlState = useCallback(
    (next: {
      tab?: TabKey;
      view?: StudioView;
      subview?: SkillsSubview;
      agentId?: string | null;
      draftId?: string | null;
    }) => {
      const params = new URLSearchParams(searchParams?.toString() ?? '');
      const tab = next.tab ?? activeTab;
      const view = next.view ?? studioView;
      const subview = next.subview ?? studioSubview;
      const agentId = next.agentId === undefined ? studioAgentId : next.agentId;
      const draftId = next.draftId === undefined ? studioDraftId : next.draftId;

      if (tab === 'overview') params.delete('tab');
      else params.set('tab', tab);

      if (tab === 'studio') {
        // `my-agents` is the default; omit it from the URL to keep it short.
        if (view === 'my-agents') params.delete('view');
        else params.set('view', view);
        // Skills view sub-tab — only meaningful when view === 'skills', and
        // `authoring` is the default we elide.
        if (view === 'skills' && subview !== 'authoring') {
          params.set('subview', subview);
        } else {
          params.delete('subview');
        }
        if (agentId) params.set('agentId', agentId);
        else params.delete('agentId');
        if (draftId) params.set('draftId', draftId);
        else params.delete('draftId');
      } else {
        params.delete('view');
        params.delete('subview');
        params.delete('agentId');
        params.delete('draftId');
      }
      const qs = params.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      router.replace(url, { scroll: false });
    },
    [searchParams, pathname, router, activeTab, studioView, studioSubview, studioAgentId, studioDraftId],
  );

  // Global data
  const [stats, setStats] = useState<EvolutionStats>({
    total_genes: 0,
    total_capsules: 0,
    avg_success_rate: 0,
    active_agents: 0,
  });
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [hotGenes, setHotGenes] = useState<PublicGene[]>([]);

  // Skills
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillCategories, setSkillCategories] = useState<SkillCategory[]>([]);
  const [skillStats, setSkillStats] = useState<SkillStats | null>(null);
  const [skillSearchInput, setSkillSearchInput] = useState('');
  const [skillSearch, setSkillSearch] = useState('');
  const [skillCategory, setSkillCategory] = useState('');
  const [skillSort, setSkillSort] = useState('most_installed');
  const [skillPage, setSkillPage] = useState(1);
  const [skillTotal, setSkillTotal] = useState(0);
  const [skillLoading, setSkillLoading] = useState(false);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [skillExploreMode, setSkillExploreMode] = useState(false);
  const [skillDetailId, setSkillDetailId] = useState<string | null>(null);
  const [skillDetail, setSkillDetail] = useState<Skill | null>(null);
  const [skillDetailLoading, setSkillDetailLoading] = useState(false);
  const [skillRelated, setSkillRelated] = useState<Skill[]>([]);

  // Genes
  const [genes, setGenes] = useState<PublicGene[]>([]);
  const [geneCategory, setGeneCategory] = useState('');
  const [geneSearchInput, setGeneSearchInput] = useState('');
  const [geneSearch, setGeneSearch] = useState('');
  const [geneSort, setGeneSort] = useState('newest');
  const [genePage, setGenePage] = useState(1);
  const [geneTotal, setGeneTotal] = useState(0);
  const [geneLoading, setGeneLoading] = useState(false);
  const [expandedGene, setExpandedGene] = useState<string | null>(null);

  // Trending
  const [trendingSkills, setTrendingSkills] = useState<Skill[]>([]);

  // Metrics (for AEI Hero)
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [prevMetrics, setPrevMetrics] = useState<MetricsSnapshot | null>(null);

  // Gene detail modal
  const [geneDetailId, setGeneDetailId] = useState<string | null>(null);
  const [geneDetail, setGeneDetail] = useState<PublicGene | null>(null);
  const [geneDetailLoading, setGeneDetailLoading] = useState(false);

  // Agent detail

  // Library fork sheet
  const [forkGene, setForkGene] = useState<PublicGene | null>(null);

  // Timeline
  const [timelineFeed, setTimelineFeed] = useState<FeedEvent[]>([]);
  const [timelineFilter, setTimelineFilter] = useState('');
  const [timelineCatFilter, setTimelineCatFilter] = useState('');
  const [timelineOutcomeFilter, setTimelineOutcomeFilter] = useState('');
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [sharingEventIdx, setSharingEventIdx] = useState<string | null>(null);

  const SKILL_LIMIT = 60;
  const GENE_LIMIT = 18;

  // ─── Tab switching with transition ────────────────────
  const switchTab = useCallback(
    (tab: TabKey) => {
      if (tab === activeTab) return;
      setTabTransition(true);
      writeUrlState({ tab });
      setTimeout(() => {
        setActiveTab(tab);
        setTabTransition(false);
      }, 150);
    },
    [activeTab, writeUrlState],
  );

  // Studio sub-view setters (write through to URL).
  const switchStudioView = useCallback(
    (view: StudioView) => {
      setStudioView(view);
      writeUrlState({ view });
    },
    [writeUrlState],
  );
  const switchStudioSubview = useCallback(
    (subview: SkillsSubview) => {
      setStudioSubview(subview);
      writeUrlState({ subview });
    },
    [writeUrlState],
  );
  const setStudioAgent = useCallback(
    (agentId: string | null) => {
      setStudioAgentId(agentId);
      writeUrlState({ agentId });
    },
    [writeUrlState],
  );
  const setStudioDraft = useCallback(
    (draftId: string | null) => {
      setStudioDraftId(draftId);
      writeUrlState({ draftId });
    },
    [writeUrlState],
  );

  // release201/28 — Studio v2 writes `?tab=studio&section=` directly (the legacy
  // writeUrlState speaks view/subview). roster is the default and is elided.
  const writeStudioSection = useCallback(
    (section: string) => {
      const params = new URLSearchParams(searchParams?.toString() ?? '');
      params.set('tab', 'studio');
      params.delete('view');
      params.delete('subview');
      // Always write `section` explicitly (incl. roster). Deleting it for roster
      // made the URL fall back to the legacy view/subview derivation, which maps
      // the default `my-agents` → `profiles`, so clicking 团队/Roster never landed
      // on roster. Explicit section is the single source of truth.
      params.set('section', section);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [searchParams, pathname, router],
  );

  // ─── Fetch global data ────────────────────────────────
  useEffect(() => {
    fetch('/api/im/evolution/public/stats')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok || d.data) setStats(d.data || d);
      })
      .catch(() => {});
    fetch('/api/im/evolution/public/feed?limit=100')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok || d.data) setFeed(d.data || []);
      })
      .catch(() => {});
    fetch('/api/im/evolution/public/hot?limit=10')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok || d.data) setHotGenes(d.data || []);
      })
      .catch(() => {});
    fetch('/api/im/skills/trending?limit=5')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok || d.data) setTrendingSkills(d.data || []);
      })
      .catch(() => {});
    fetch('/api/im/evolution/metrics')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && d.data) setMetrics(d.data.standard || null);
      })
      .catch(() => {});
    // Fetch previous week's metrics for stage label comparison
    fetch('/api/im/evolution/public/metrics-history?days=14')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && d.data && d.data.length >= 2) {
          const rows = d.data as MetricsSnapshot[];
          const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
          const prev = rows.find((r: MetricsSnapshot) => r.ts && new Date(r.ts).getTime() <= weekAgo);
          if (prev) setPrevMetrics(prev);
        }
      })
      .catch(() => {});
  }, []);

  // ─── Debounce skill search (300ms) ────────────────────
  useEffect(() => {
    const timer = setTimeout(() => {
      setSkillSearch(skillSearchInput);
      setSkillPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [skillSearchInput]);

  // ─── Fetch skill detail + related skills for detail modal ───
  useEffect(() => {
    if (!skillDetailId) {
      setSkillDetail(null);
      setSkillRelated([]);
      return;
    }
    // Try to find in current page first, otherwise fetch from API
    const local = skills.find((s) => s.id === skillDetailId);
    if (local) {
      setSkillDetail(local);
      setSkillDetailLoading(false);
    } else {
      setSkillDetailLoading(true);
      fetch(`/api/im/skills/${skillDetailId}`)
        .then((r) => r.json())
        .then((d) => setSkillDetail(d.data || null))
        .catch(() => setSkillDetail(null))
        .finally(() => setSkillDetailLoading(false));
    }
    fetch(`/api/im/skills/${skillDetailId}/related?limit=5`)
      .then((r) => r.json())
      .then((d) => setSkillRelated(d.data || []))
      .catch(() => setSkillRelated([]));
  }, [skillDetailId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Fetch skills ─────────────────────────────────────
  useEffect(() => {
    if (activeTab !== 'skills') return;
    setSkillLoading(true);
    if (skillExploreMode && !skillSearch) {
      // Explore mode: fetch trending (high quality, low exposure)
      fetch(`/api/im/skills/trending?limit=${SKILL_LIMIT}`)
        .then((r) => r.json())
        .then((d) => {
          setSkills(d.data || []);
          setSkillTotal(d.data?.length || 0);
        })
        .catch(() => {})
        .finally(() => setSkillLoading(false));
    } else {
      const params = new URLSearchParams({ sort: skillSort, page: String(skillPage), limit: String(SKILL_LIMIT) });
      if (skillSearch) params.set('query', skillSearch);
      if (skillCategory) params.set('category', skillCategory);
      fetch(`/api/im/skills/search?${params}`)
        .then((r) => r.json())
        .then((d) => {
          setSkills(d.data || []);
          setSkillTotal(d.meta?.total || 0);
        })
        .catch(() => {})
        .finally(() => setSkillLoading(false));
    }
  }, [activeTab, skillSearch, skillCategory, skillSort, skillPage, skillExploreMode]);

  useEffect(() => {
    if (activeTab !== 'skills') return;
    if (skillCategories.length > 0) return;
    fetch('/api/im/skills/categories')
      .then((r) => r.json())
      .then((d) => {
        const arr = d.data || d;
        setSkillCategories(Array.isArray(arr) ? arr : []);
      })
      .catch(() => {});
    fetch('/api/im/skills/stats')
      .then((r) => r.json())
      .then((d) => setSkillStats(d.data || d || null))
      .catch(() => {});
  }, [activeTab, skillCategories.length]);

  // ─── Fetch gene detail ───────────────────────────────
  useEffect(() => {
    if (!geneDetailId) {
      setGeneDetail(null);
      return;
    }
    setGeneDetailLoading(true);
    fetch(`/api/im/evolution/public/genes/${geneDetailId}`)
      .then((r) => r.json())
      .then((d) => setGeneDetail(d.data || null))
      .catch(() => setGeneDetail(null))
      .finally(() => setGeneDetailLoading(false));
  }, [geneDetailId]);

  // ─── Debounce gene search (300ms) ─────────────────────
  useEffect(() => {
    const timer = setTimeout(() => {
      setGeneSearch(geneSearchInput);
      setGenePage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [geneSearchInput]);

  // ─── Fetch genes ──────────────────────────────────────
  useEffect(() => {
    if (activeTab !== 'genes') return;
    setGeneLoading(true);
    const params = new URLSearchParams({ sort: geneSort, page: String(genePage), limit: String(GENE_LIMIT) });
    if (geneCategory) params.set('category', geneCategory);
    if (geneSearch) params.set('search', geneSearch);
    fetch(`/api/im/evolution/public/genes?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setGenes(d.data || []);
        setGeneTotal(d.meta?.total || d.total || 0);
      })
      .catch(() => {})
      .finally(() => setGeneLoading(false));
  }, [activeTab, geneCategory, geneSearch, geneSort, genePage]);

  // ─── Fetch timeline ───────────────────────────────────
  useEffect(() => {
    if (activeTab !== 'timeline') return;
    setTimelineLoading(true);
    fetch('/api/im/evolution/public/feed?limit=50')
      .then((r) => r.json())
      .then((d) => {
        setTimelineFeed(d.data || []);
      })
      .catch(() => {})
      .finally(() => setTimelineLoading(false));
  }, [activeTab]);

  // ─── Tab cross-navigation helpers ────────────────────
  const navigateToGene = useCallback(
    (geneId: string) => {
      setGeneSearchInput(geneId);
      switchTab('genes');
    },
    [switchTab],
  );

  const navigateToAgent = useCallback(
    (agentName: string) => {
      // leaderboard coming soon
      switchTab('agents');
    },
    [switchTab],
  );

  // ─── Auto-detect milestones from feed ──────────────────
  const autoMilestones = useMemo(() => {
    const milestones: { type: string; title: string; detail: string; agentName?: string; timestamp?: string }[] = [];
    const geneCounts: Record<string, number> = {};
    const agentPublished: Record<string, boolean> = {};
    const geneAdopters: Record<string, Set<string>> = {};
    const geneStreaks: Record<string, number> = {};
    const seenCategories = new Set<string>();

    for (const e of feed) {
      if (e.type === 'capsule') {
        const key = e.geneTitle || '';
        geneCounts[key] = (geneCounts[key] || 0) + 1;
        const count = geneCounts[key];
        if (count === 10 || count === 50 || count === 100 || count === 500) {
          milestones.push({
            type: 'execution_milestone',
            title: `${key} reached ${count} executions`,
            detail: `Gene executed ${count} times across all agents`,
            agentName: e.agentName,
            timestamp: e.timestamp,
          });
        }
        // Consecutive success streak
        if (e.outcome === 'success') {
          geneStreaks[key] = (geneStreaks[key] || 0) + 1;
          if (geneStreaks[key] === 10 || geneStreaks[key] === 50 || geneStreaks[key] === 100) {
            milestones.push({
              type: 'streak',
              title: `${key}: ${geneStreaks[key]} consecutive successes`,
              detail: `Unbroken success streak`,
              agentName: e.agentName,
              timestamp: e.timestamp,
            });
          }
        } else {
          geneStreaks[key] = 0;
        }
      }
      if (e.type === 'publish' && e.agentName && !agentPublished[e.agentName]) {
        agentPublished[e.agentName] = true;
        milestones.push({
          type: 'first_publish',
          title: `${e.agentName} published first gene`,
          detail: `Published: ${e.geneTitle}`,
          agentName: e.agentName,
          timestamp: e.timestamp,
        });
      }
      if (e.type === 'import' && e.geneTitle) {
        if (!geneAdopters[e.geneTitle]) geneAdopters[e.geneTitle] = new Set();
        geneAdopters[e.geneTitle].add(e.agentName || '');
        const adopters = geneAdopters[e.geneTitle].size;
        if (adopters === 3 || adopters === 5 || adopters === 10) {
          milestones.push({
            type: 'adoption_milestone',
            title: `${e.geneTitle} adopted by ${adopters} agents`,
            detail: `Growing adoption across the network`,
            agentName: e.agentName,
            timestamp: e.timestamp,
          });
        }
      }
      // New category first gene
      if ((e.type === 'distill' || e.type === 'publish') && e.geneCategory) {
        if (!seenCategories.has(e.geneCategory)) {
          seenCategories.add(e.geneCategory);
          if (seenCategories.size > 1) {
            milestones.push({
              type: 'new_category',
              title: `First ${e.geneCategory} gene appeared`,
              detail: `New evolution category unlocked`,
              agentName: e.agentName,
              timestamp: e.timestamp,
            });
          }
        }
      }
    }
    return milestones;
  }, [feed]);

  // ─── Gene import handler ──────────────────────────────
  const handleImport = async (geneId: string) => {
    if (!isAuthenticated) {
      window.location.href = '/auth';
      return;
    }
    try {
      const token = JSON.parse(localStorage.getItem('prismer_auth') || '{}')?.token;
      const res = await fetch('/api/im/evolution/genes/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ gene_id: geneId }),
      });
      const data = await res.json();
      addToast(
        data.ok ? t('evolution.toast.geneInstalled') : data.error || t('evolution.toast.failed'),
        data.ok ? 'success' : 'error',
      );
    } catch {
      addToast(t('evolution.toast.geneInstallFailed'), 'error');
    }
  };

  // ─── Gene fork handler ──────────────────────────────
  const handleFork = async (geneId: string) => {
    if (!isAuthenticated) {
      window.location.href = '/auth';
      return;
    }
    try {
      const token = JSON.parse(localStorage.getItem('prismer_auth') || '{}')?.token;
      const res = await fetch('/api/im/evolution/genes/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ gene_id: geneId }),
      });
      const data = await res.json();
      addToast(
        data.ok ? t('evolution.toast.geneForked') : data.error || t('evolution.toast.failed'),
        data.ok ? 'success' : 'error',
      );
    } catch {
      addToast(t('evolution.toast.geneForkFailed'), 'error');
    }
  };

  // ─── Skill install handler ──────────────────────────────
  const handleSkillInstall = async (skillId: string) => {
    if (!isAuthenticated) {
      window.location.href = '/auth';
      return;
    }
    try {
      const token = JSON.parse(localStorage.getItem('prismer_auth') || '{}')?.token;
      const res = await fetch(`/api/im/skills/${skillId}/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.ok) {
        const geneName = data.data?.gene?.id ? ` + Gene ${data.data.gene.category}` : '';
        addToast(
          t('evolution.toast.skillInstalled', { name: data.data?.skill?.name || skillId, gene: geneName }),
          'success',
        );
      } else {
        addToast(data.error || t('evolution.toast.skillInstallFailed'), 'error');
      }
    } catch {
      addToast(t('evolution.toast.skillInstallFailed'), 'error');
    }
  };

  // ─── Filtered timeline ────────────────────────────────
  const filteredTimeline = timelineFeed.filter((e) => {
    if (timelineFilter && e.type !== timelineFilter) return false;
    if (timelineCatFilter && e.geneCategory !== timelineCatFilter) return false;
    if (timelineOutcomeFilter) {
      if (e.type !== 'capsule') return false;
      if (timelineOutcomeFilter === 'success' && e.outcome !== 'success') return false;
      if (timelineOutcomeFilter === 'failure' && e.outcome !== 'failure') return false;
    }
    return true;
  });

  // Group timeline by date
  const timelineGroups: { date: string; day: string; events: FeedEvent[] }[] = [];
  for (const event of filteredTimeline) {
    const date = formatDate(event.timestamp || '', locale);
    const day = formatDay(event.timestamp || '', locale);
    const last = timelineGroups[timelineGroups.length - 1];
    if (last && last.date === date) {
      last.events.push(event);
    } else {
      timelineGroups.push({ date, day, events: [event] });
    }
  }

  // ─── Build agent leaderboard from feed ────────────────
  const agentMap: Record<
    string,
    {
      name: string;
      capsules: number;
      published: number;
      imported: number;
      successes: number;
      failures: number;
      categories: Record<string, number>;
      genes: string[];
      lastSeen: string;
    }
  > = {};
  for (const e of feed) {
    if (!e.agentName) continue;
    if (!agentMap[e.agentName])
      agentMap[e.agentName] = {
        name: e.agentName,
        capsules: 0,
        published: 0,
        imported: 0,
        successes: 0,
        failures: 0,
        categories: {},
        genes: [],
        lastSeen: '',
      };
    const a = agentMap[e.agentName];
    if (e.timestamp && (!a.lastSeen || e.timestamp > a.lastSeen)) a.lastSeen = e.timestamp;
    if (e.type === 'capsule') {
      a.capsules++;
      if (e.outcome === 'success') a.successes++;
      else a.failures++;
    }
    if (e.type === 'publish') {
      a.published++;
      if (e.geneTitle && !a.genes.includes(e.geneTitle)) a.genes.push(e.geneTitle);
    }
    if (e.type === 'import') a.imported++;
    if (e.geneCategory) a.categories[e.geneCategory] = (a.categories[e.geneCategory] || 0) + 1;
  }
  // Ranking: capsules*1 + published*10 + imported*5 + success_rate*50
  const agents = Object.values(agentMap).sort((a, b) => agentScore(b) - agentScore(a));

  const geneTotalPages = Math.ceil(geneTotal / GENE_LIMIT);
  const skillTotalPages = Math.ceil(skillTotal / SKILL_LIMIT);

  // Pre-compute agent heatmap data to avoid running aggregation inside render loop
  const agentHeatmaps = useMemo(() => {
    const map: Record<string, { date: string; count: number }[]> = {};
    for (const a of agents.slice(0, 10)) {
      map[a.name] = aggregateAgentHeatmap(feed, a.name);
    }
    return map;
  }, [agents, feed]);

  // Max capsules across agents for radar normalization
  const maxAgentCapsules = useMemo(() => Math.max(...agents.slice(0, 10).map((a) => a.capsules), 1), [agents]);

  // ═══════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════

  return (
    <div className={`max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-8`}>
      {/* Header */}
      <div className="flex items-start sm:items-center justify-between mb-4 sm:mb-6">
        <div>
          <h1
            className={`text-xl sm:text-2xl md:text-3xl font-bold mb-1 sm:mb-2 ${isDark ? 'text-white' : 'text-zinc-900'}`}
          >
            {t('evolution.title')}
          </h1>
          <div className={`flex items-center gap-2 text-xs sm:text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
            </span>
            {t('evolution.subtitle')}
          </div>
        </div>
      </div>

      {/* Tab Bar */}
      <div className={`relative flex gap-1 p-1 rounded-xl mb-6 sm:mb-8 ${glass(isDark)}`}>
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => switchTab(tab.key)}
              className={`relative flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold rounded-lg transition-all duration-200 ${
                isActive
                  ? isDark
                    ? 'text-white'
                    : 'text-zinc-900'
                  : isDark
                    ? 'text-zinc-500 hover:text-zinc-300'
                    : 'text-zinc-500 hover:text-zinc-900'
              }`}
            >
              {isActive && (
                <div
                  className={`absolute inset-0 rounded-lg ${isDark ? 'bg-white/[0.08]' : 'bg-white shadow-sm'}`}
                  style={{ transition: 'all 0.2s ease' }}
                />
              )}
              <span className="relative flex items-center gap-1.5">
                <Icon className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t(tab.labelKey)}</span>
              </span>
              {isActive && (
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full bg-gradient-to-r from-violet-500 via-cyan-500 to-emerald-500" />
              )}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div
        className={`transition-all duration-150 ${tabTransition ? 'opacity-0 translate-y-2' : 'opacity-100 translate-y-0'}`}
      >
        {/* ═══════════════════════════════════════════════ */}
        {/* TAB 1: OVERVIEW                                */}
        {/* ═══════════════════════════════════════════════ */}
        {activeTab === 'overview' && <EvolutionMap isDark={isDark} fullHeight />}

        {/* ═══════════════════════════════════════════════ */}
        {/* TAB: LIBRARY (merged Skills + Genes)           */}
        {/* ═══════════════════════════════════════════════ */}
        {activeTab === 'library' && (
          <LibraryTab
            isDark={isDark}
            onGeneClick={(id) => setGeneDetailId(id)}
            onSkillClick={(id) => setSkillDetailId(id)}
            onGeneImport={handleImport}
            onGeneFork={(gene: any) => setForkGene(gene as PublicGene)}
            onSkillInstall={handleSkillInstall}
            onSkillUninstall={async (slugOrId: string) => {
              if (!isAuthenticated) {
                window.location.href = '/auth';
                return;
              }
              try {
                const token = JSON.parse(localStorage.getItem('prismer_auth') || '{}')?.token;
                const res = await fetch(`/api/im/skills/${slugOrId}/install`, {
                  method: 'DELETE',
                  headers: { Authorization: `Bearer ${token}` },
                });
                const data = await res.json();
                addToast(
                  data.ok ? t('evolution.toast.skillUninstalled') : data.error || t('evolution.toast.failed'),
                  data.ok ? 'success' : 'error',
                );
              } catch {
                addToast(t('evolution.toast.skillUninstallFailed'), 'error');
              }
            }}
            isAuthenticated={isAuthenticated}
          />
        )}

        {/* ═══════════════════════════════════════════════ */}
        {/* TAB: LEADERBOARD (Coming Soon — v1.8)          */}
        {/* ═══════════════════════════════════════════════ */}
        {activeTab === 'agents' && <LeaderboardTab isDark={isDark} isAuthenticated={isAuthenticated} />}

        {/* ═══════════════════════════════════════════════ */}
        {/* TAB 2: SKILLS (legacy, hidden)                 */}
        {/* ═══════════════════════════════════════════════ */}
        {activeTab === 'skills' && (
          <div>
            {/* Stats bar */}
            {skillStats && (
              <div
                className={`text-center text-xs mb-4 py-2 px-4 rounded-lg ${isDark ? 'text-zinc-500 bg-zinc-900/40' : 'text-zinc-500 bg-zinc-100/60'}`}
              >
                {skillExploreMode ? (
                  <>
                    <Compass className="w-3 h-3 inline mr-1 text-violet-400" />
                    <span className="text-violet-400 font-semibold">{t('evolution.legacy.exploreMode')}</span> —{' '}
                    {t('evolution.legacy.exploreModeBody')}
                  </>
                ) : (
                  <>
                    {t('evolution.legacy.skillsFromCategories', {
                      skills: (skillStats.total || 0).toLocaleString(),
                      categories: skillCategories.length,
                    })}
                    {skillStats.by_source && Object.keys(skillStats.by_source).length > 0 && (
                      <>
                        {' '}
                        | {t('evolution.legacy.source')}{' '}
                        <span className="font-semibold">{Object.keys(skillStats.by_source).join(', ')}</span>
                      </>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Search + Filters */}
            <div className={`flex flex-col gap-3 mb-4 p-3 rounded-xl ${glass(isDark)}`}>
              <div className="flex flex-col sm:flex-row gap-3">
                <div
                  className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border ${isDark ? 'bg-zinc-900/40 border-white/10' : 'bg-white/60 border-zinc-200/60'}`}
                >
                  <Search className={`w-4 h-4 shrink-0 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
                  <input
                    type="text"
                    placeholder={t('evolution.legacy.searchSkills')}
                    value={skillSearchInput}
                    onChange={(e) => setSkillSearchInput(e.target.value)}
                    className={`w-full bg-transparent outline-none text-sm ${isDark ? 'text-white placeholder-zinc-600' : 'text-zinc-900 placeholder-zinc-400'}`}
                  />
                </div>
                <select
                  value={skillSort}
                  onChange={(e) => {
                    setSkillSort(e.target.value);
                    setSkillPage(1);
                  }}
                  className={`px-3 py-2 rounded-lg text-xs font-medium border shrink-0 ${isDark ? 'bg-zinc-900/60 border-white/10 text-zinc-300' : 'bg-white/60 border-zinc-200/60 text-zinc-700'}`}
                >
                  <option value="most_installed">{t('evolution.common.mostInstalled')}</option>
                  <option value="newest">{t('evolution.common.newest')}</option>
                  <option value="name">{t('evolution.common.name')}</option>
                </select>
                <button
                  onClick={() => {
                    setSkillExploreMode(!skillExploreMode);
                    setSkillPage(1);
                  }}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border shrink-0 transition-all ${
                    skillExploreMode
                      ? isDark
                        ? 'bg-violet-500/15 border-violet-500/30 text-violet-300'
                        : 'bg-violet-100 border-violet-200 text-violet-700'
                      : isDark
                        ? 'bg-zinc-900/60 border-white/10 text-zinc-400 hover:text-zinc-200'
                        : 'bg-white/60 border-zinc-200/60 text-zinc-500 hover:text-zinc-700'
                  }`}
                  title={t('evolution.legacy.exploreTitle')}
                >
                  <Compass className="w-3.5 h-3.5" />
                  {t('evolution.legacy.explore')}
                </button>
              </div>

              {/* Category pills */}
              <div className="flex gap-2 overflow-x-auto pb-1 custom-scrollbar">
                <button
                  onClick={() => {
                    setSkillCategory('');
                    setSkillPage(1);
                  }}
                  className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                    !skillCategory
                      ? isDark
                        ? 'bg-white/10 text-white'
                        : 'bg-zinc-900 text-white'
                      : isDark
                        ? 'bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'
                        : 'bg-zinc-100 text-zinc-600 hover:text-zinc-900'
                  }`}
                >
                  {t('evolution.common.all')}
                </button>
                {skillCategories.slice(0, 20).map((cat) => (
                  <button
                    key={cat.category}
                    onClick={() => {
                      setSkillCategory(cat.category);
                      setSkillPage(1);
                    }}
                    className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-all whitespace-nowrap ${
                      skillCategory === cat.category
                        ? isDark
                          ? 'bg-white/10 text-white'
                          : 'bg-zinc-900 text-white'
                        : isDark
                          ? 'bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'
                          : 'bg-zinc-100 text-zinc-600 hover:text-zinc-900'
                    }`}
                  >
                    {cat.category} <span className="opacity-60">({cat.count})</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Skill Grid */}
            {skillLoading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <CardSkeleton key={i} isDark={isDark} />
                ))}
              </div>
            ) : skills.length === 0 ? (
              <div className={`text-center py-20 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                <Sparkles className="w-8 h-8 mx-auto mb-3 opacity-40" />
                <p className="text-sm">{t('evolution.common.noSkillsFound')}</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {skills.map((skill) => (
                  <SkillCard
                    key={skill.id}
                    skill={skill}
                    isDark={isDark}
                    expanded={expandedSkill === skill.id}
                    onToggle={() => setExpandedSkill(expandedSkill === skill.id ? null : skill.id)}
                    onDetail={() => setSkillDetailId(skill.id)}
                    onCardClick={() => setSkillDetailId(skill.id)}
                    onViewGene={skill.geneId ? () => navigateToGene(skill.geneId!) : undefined}
                  />
                ))}
              </div>
            )}

            {/* Pagination */}
            {skillTotalPages > 1 && (
              <div className="flex items-center justify-center gap-2 mt-8">
                <button
                  disabled={skillPage <= 1}
                  onClick={() => setSkillPage((p) => p - 1)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 ${isDark ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'}`}
                >
                  {t('evolution.common.prev')}
                </button>
                {/* Page numbers (§4.4) */}
                {(() => {
                  const pages: (number | '...')[] = [];
                  if (skillTotalPages <= 7) {
                    for (let i = 1; i <= skillTotalPages; i++) pages.push(i);
                  } else {
                    pages.push(1);
                    if (skillPage > 3) pages.push('...');
                    for (let i = Math.max(2, skillPage - 1); i <= Math.min(skillTotalPages - 1, skillPage + 1); i++)
                      pages.push(i);
                    if (skillPage < skillTotalPages - 2) pages.push('...');
                    pages.push(skillTotalPages);
                  }
                  return pages.map((p, i) =>
                    p === '...' ? (
                      <span
                        key={`ellipsis-${i}`}
                        className={`text-xs px-1 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                      >
                        ...
                      </span>
                    ) : (
                      <button
                        key={p}
                        onClick={() => setSkillPage(p as number)}
                        className={`w-8 h-8 rounded-lg text-xs font-medium transition-colors ${
                          skillPage === p
                            ? isDark
                              ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                              : 'bg-violet-100 text-violet-700 border border-violet-200'
                            : isDark
                              ? 'text-zinc-500 hover:bg-white/5'
                              : 'text-zinc-500 hover:bg-zinc-100'
                        }`}
                      >
                        {p}
                      </button>
                    ),
                  );
                })()}
                <button
                  disabled={skillPage >= skillTotalPages}
                  onClick={() => setSkillPage((p) => p + 1)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 ${isDark ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'}`}
                >
                  {t('evolution.common.next')}
                </button>
                <span className={`text-xs tabular-nums ml-2 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                  {t('evolution.legacy.showingRangeCompact', {
                    from: (skillPage - 1) * SKILL_LIMIT + 1,
                    to: Math.min(skillPage * SKILL_LIMIT, skillTotal),
                    total: skillTotal.toLocaleString(),
                  })}
                </span>
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════ */}
        {/* TAB 3: GENES                                   */}
        {/* ═══════════════════════════════════════════════ */}
        {activeTab === 'genes' && (
          <div>
            {/* Filters */}
            <div className={`flex flex-col sm:flex-row gap-3 mb-6 p-3 rounded-xl ${glass(isDark)}`}>
              <div
                className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border ${isDark ? 'bg-zinc-900/40 border-white/10' : 'bg-white/60 border-zinc-200/60'}`}
              >
                <Search className={`w-4 h-4 shrink-0 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
                <input
                  type="text"
                  placeholder={t('evolution.legacy.searchGenes')}
                  value={geneSearchInput}
                  onChange={(e) => setGeneSearchInput(e.target.value)}
                  className={`w-full bg-transparent outline-none text-sm ${isDark ? 'text-white placeholder-zinc-600' : 'text-zinc-900 placeholder-zinc-400'}`}
                />
              </div>
              <div
                className={`flex p-0.5 rounded-lg shrink-0 ${isDark ? 'bg-zinc-900/60 border border-white/5' : 'bg-zinc-100/80 border border-zinc-200/60'}`}
              >
                {GENE_CATEGORIES.map((cat) => (
                  <button
                    key={cat.key}
                    onClick={() => {
                      setGeneCategory(cat.key);
                      setGenePage(1);
                    }}
                    className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md transition-all ${
                      geneCategory === cat.key
                        ? isDark
                          ? 'bg-zinc-800 text-white shadow-sm'
                          : 'bg-white text-zinc-900 shadow-sm'
                        : isDark
                          ? 'text-zinc-500 hover:text-zinc-300'
                          : 'text-zinc-500 hover:text-zinc-900'
                    }`}
                  >
                    {categoryLabel(cat.key, t)}
                  </button>
                ))}
              </div>
              <select
                value={geneSort}
                onChange={(e) => {
                  setGeneSort(e.target.value);
                  setGenePage(1);
                }}
                className={`px-3 py-2 rounded-lg text-xs font-medium border shrink-0 ${isDark ? 'bg-zinc-900/60 border-white/10 text-zinc-300' : 'bg-white/60 border-zinc-200/60 text-zinc-700'}`}
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.key} value={opt.key}>
                    {opt.key === 'newest'
                      ? t('evolution.common.newest')
                      : opt.key === 'most_used'
                        ? t('evolution.common.mostPopular')
                        : t('evolution.common.successRate')}
                  </option>
                ))}
              </select>
            </div>

            {/* Gene Grid */}
            {geneLoading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <CardSkeleton key={i} isDark={isDark} />
                ))}
              </div>
            ) : genes.length === 0 ? (
              <div className={`text-center py-20 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                <Dna className="w-8 h-8 mx-auto mb-3 opacity-40" />
                <p className="text-sm">{t('evolution.common.noGenesFound')}</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {(() => {
                  const maxExec = Math.max(...genes.map((g) => (g.success_count || 0) + (g.failure_count || 0)), 1);
                  return genes.map((gene) => (
                    <GeneCard
                      key={getGeneId(gene)}
                      gene={gene}
                      isDark={isDark}
                      maxExecutions={maxExec}
                      expanded={expandedGene === getGeneId(gene)}
                      onToggle={() => setExpandedGene(expandedGene === getGeneId(gene) ? null : getGeneId(gene))}
                      onImport={handleImport}
                      onDetail={() => setGeneDetailId(getGeneId(gene))}
                      onCardClick={() => setGeneDetailId(getGeneId(gene))}
                      onAgentClick={navigateToAgent}
                    />
                  ));
                })()}
              </div>
            )}

            {/* Pagination */}
            {geneTotalPages > 1 && (
              <div className="flex items-center justify-center gap-3 mt-8">
                <button
                  disabled={genePage <= 1}
                  onClick={() => setGenePage((p) => p - 1)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 ${isDark ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'}`}
                >
                  {t('evolution.common.prev')}
                </button>
                <span className={`text-xs tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  {t('evolution.legacy.showingRange', {
                    from: (genePage - 1) * GENE_LIMIT + 1,
                    to: Math.min(genePage * GENE_LIMIT, geneTotal),
                    total: geneTotal,
                  })}
                </span>
                <button
                  disabled={genePage >= geneTotalPages}
                  onClick={() => setGenePage((p) => p + 1)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 ${isDark ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'}`}
                >
                  {t('evolution.common.next')}
                </button>
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════ */}
        {/* TAB 4: TIMELINE                                */}
        {/* ═══════════════════════════════════════════════ */}
        {activeTab === 'timeline' && (
          <div>
            {/* Filters */}
            <div className={`flex flex-wrap gap-2 mb-6 p-3 rounded-xl ${glass(isDark)}`}>
              <span
                className={`flex items-center gap-1 text-xs font-medium ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}
              >
                <Filter className="w-3 h-3" /> {t('evolution.legacy.filter')}
              </span>
              {['', 'capsule', 'distill', 'publish', 'milestone'].map((type) => (
                <button
                  key={type}
                  onClick={() => setTimelineFilter(type)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all ${
                    timelineFilter === type
                      ? isDark
                        ? 'bg-white/10 text-white'
                        : 'bg-zinc-900 text-white'
                      : isDark
                        ? 'bg-zinc-800/60 text-zinc-500 hover:text-zinc-300'
                        : 'bg-zinc-100 text-zinc-500 hover:text-zinc-900'
                  }`}
                >
                  {eventTypeLabel(type, t)}
                </button>
              ))}
              <div className="w-px h-5 self-center bg-zinc-700/30" />
              {['', 'repair', 'optimize', 'innovate'].map((cat) => (
                <button
                  key={cat}
                  onClick={() => setTimelineCatFilter(cat)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all ${
                    timelineCatFilter === cat
                      ? isDark
                        ? 'bg-white/10 text-white'
                        : 'bg-zinc-900 text-white'
                      : isDark
                        ? 'bg-zinc-800/60 text-zinc-500 hover:text-zinc-300'
                        : 'bg-zinc-100 text-zinc-500 hover:text-zinc-900'
                  }`}
                >
                  {cat ? categoryLabel(cat, t) : t('evolution.legacy.allCategories')}
                </button>
              ))}
              <div className="w-px h-5 self-center bg-zinc-700/30" />
              {['', 'success', 'failure'].map((outcome) => (
                <button
                  key={outcome}
                  onClick={() => setTimelineOutcomeFilter(outcome)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all ${
                    timelineOutcomeFilter === outcome
                      ? isDark
                        ? 'bg-white/10 text-white'
                        : 'bg-zinc-900 text-white'
                      : isDark
                        ? 'bg-zinc-800/60 text-zinc-500 hover:text-zinc-300'
                        : 'bg-zinc-100 text-zinc-500 hover:text-zinc-900'
                  }`}
                >
                  {outcome
                    ? outcome === 'success'
                      ? t('evolution.common.successStatus')
                      : t('evolution.common.failedStatus')
                    : t('evolution.legacy.allOutcomes')}
                </button>
              ))}
            </div>

            {/* Timeline */}
            {timelineLoading ? (
              <div className="flex justify-center py-20">
                <Loader2 className="w-6 h-6 animate-spin text-violet-400" />
              </div>
            ) : filteredTimeline.length === 0 ? (
              <div className={`text-center py-20 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                <Clock className="w-8 h-8 mx-auto mb-3 opacity-40" />
                <p className="text-sm">{t('evolution.legacy.noEvents')}</p>
              </div>
            ) : (
              <div className="relative">
                {/* Vertical line */}
                <div className={`absolute left-[19px] top-0 bottom-0 w-px ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`} />

                {timelineGroups.map((group) => (
                  <div key={group.date} className="mb-6">
                    {/* Date header */}
                    <div className="flex items-center gap-3 mb-3">
                      <div
                        className={`w-10 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${isDark ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-200 text-zinc-600'}`}
                      >
                        {group.day}
                      </div>
                      <span className={`text-xs font-medium ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                        {group.date}
                      </span>
                    </div>

                    {/* Events */}
                    {group.events.map((event, i) => {
                      const cfg = FEED_ICONS[event.type || 'capsule'] || FEED_ICONS.capsule;
                      const Icon = cfg.icon;
                      const catColor = CAT_COLORS[event.geneCategory || '']?.hex || '#71717a';
                      const isFailure = event.type === 'capsule' && event.outcome === 'failure';

                      return (
                        <div
                          key={i}
                          className={`flex items-start gap-3 py-2 pl-0 pr-4 ml-1 transition-colors rounded-lg ${isDark ? 'hover:bg-white/[0.02]' : 'hover:bg-black/[0.02]'}`}
                        >
                          {/* Node */}
                          <div className="relative z-10 shrink-0">
                            <div
                              className="w-8 h-8 rounded-full flex items-center justify-center border-2"
                              style={{
                                borderColor: isFailure ? '#ef4444' : catColor,
                                backgroundColor: isDark ? 'rgb(24,24,27)' : 'white',
                              }}
                            >
                              {isFailure ? (
                                <XCircle className="w-3.5 h-3.5 text-red-400" />
                              ) : (
                                <Icon className={`w-3.5 h-3.5 ${cfg.color}`} />
                              )}
                            </div>
                          </div>

                          {/* Content */}
                          <div className="flex-1 min-w-0 pt-1">
                            <p className={`text-sm leading-snug ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                              <span className="font-semibold" style={{ color: catColor }}>
                                {event.agentName}
                              </span>{' '}
                              <span className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>
                                {eventActionLabel(event.type, t)}
                              </span>{' '}
                              <span className={`font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                                {event.geneTitle}
                              </span>
                              {event.score != null && (
                                <span className={`ml-1 text-xs ${isFailure ? 'text-red-400' : 'text-emerald-400'}`}>
                                  ({Math.round(event.score * 100)}%)
                                </span>
                              )}
                            </p>
                            {event.summary && (
                              <p className={`text-xs mt-0.5 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                                {event.summary}
                              </p>
                            )}
                            <p className={`text-[10px] mt-0.5 ${isDark ? 'text-zinc-700' : 'text-zinc-400'}`}>
                              <TimeAgo ts={event.timestamp || ''} />
                            </p>
                          </div>

                          {/* Outcome badge */}
                          {event.type === 'capsule' && (
                            <span
                              className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full mt-1 ${
                                isFailure
                                  ? isDark
                                    ? 'bg-red-500/10 text-red-400'
                                    : 'bg-red-100 text-red-600'
                                  : isDark
                                    ? 'bg-emerald-500/10 text-emerald-400'
                                    : 'bg-emerald-100 text-emerald-600'
                              }`}
                            >
                              {isFailure ? t('evolution.common.failedStatus') : t('evolution.common.successStatus')}
                            </span>
                          )}

                          {/* Share button for milestones and high-score capsules */}
                          {(event.type === 'milestone' ||
                            event.type === 'publish' ||
                            (event.type === 'capsule' && event.score != null && event.score >= 0.9)) && (
                            <div className="relative shrink-0 mt-1">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSharingEventIdx(
                                    sharingEventIdx === `${group.date}-${i}` ? null : `${group.date}-${i}`,
                                  );
                                }}
                                className={`p-1 rounded transition-colors ${isDark ? 'text-zinc-600 hover:text-zinc-400 hover:bg-white/5' : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100'}`}
                                title={t('evolution.legacy.share')}
                              >
                                <Share2 className="w-3.5 h-3.5" />
                              </button>
                              {sharingEventIdx === `${group.date}-${i}` && (
                                <SharePopover
                                  title={
                                    event.type === 'capsule'
                                      ? t('evolution.legacy.eventCapsuleShare', {
                                          agent: event.agentName || '',
                                          score: Math.round((event.score || 0) * 100),
                                          gene: event.geneTitle || '',
                                        })
                                      : t('evolution.legacy.eventShare', {
                                          agent: event.agentName || '',
                                          action: eventActionLabel(event.type, t),
                                          gene: event.geneTitle || '',
                                        })
                                  }
                                  url={`/evolution`}
                                  isDark={isDark}
                                  onClose={() => setSharingEventIdx(null)}
                                />
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ═══════════════════════════════════════════════ */}
      {/* TAB 6: STUDIO (replaces My Agents)              */}
      {/* ═══════════════════════════════════════════════ */}
      {activeTab === 'studio' &&
        (isAuthenticated ? (
          STUDIO_V2_ENABLED ? (
            <StudioShellV2
              initialSection={
                searchParams?.get('section')
                  ? parseStudioUrl(searchParams).section
                  : searchParams?.get('view')
                    ? normalizeStudioV2Section(studioView, studioSubview)
                    : 'roster'
              }
              initialAgentId={studioAgentId}
              initialDraftId={studioDraftId}
              onSectionChange={writeStudioSection}
              onAgentChange={setStudioAgent}
              onToWorkspace={() => router.push('/workspace')}
            />
          ) : (
            <StudioTab
              isDark={isDark}
              view={studioView}
              subview={studioSubview}
              agentId={studioAgentId}
              draftId={studioDraftId}
              onViewChange={switchStudioView}
              onSubviewChange={switchStudioSubview}
              onAgentChange={setStudioAgent}
              onDraftChange={setStudioDraft}
            />
          )
        ) : (
          <UnauthenticatedStudioPlaceholder isDark={isDark} />
        ))}

      {/* CTA */}
      {!isAuthenticated && activeTab === 'library' && (
        <div className={`text-center mt-12 p-8 rounded-2xl ${glass(isDark)}`}>
          <h3 className={`text-xl font-bold mb-2 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            {t('evolution.cta.libraryTitle')}
          </h3>
          <p className={`text-sm mb-4 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            {t('evolution.cta.libraryBody')}
          </p>
          <Link
            href="/auth"
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-bold text-white bg-[var(--prismer-primary)] hover:bg-[var(--prismer-primary-light)] transition-colors"
          >
            {t('evolution.cta.getStarted')} <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      )}

      {/* ─── Global Modals (rendered outside tab blocks) ─── */}
      {skillDetailId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setSkillDetailId(null)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          {skillDetailLoading ? (
            <div className="relative">
              <Loader2 className="w-8 h-8 animate-spin text-violet-400" />
            </div>
          ) : !skillDetail ? (
            <div
              className={`relative max-w-sm w-full rounded-2xl p-8 text-center ${isDark ? 'bg-zinc-900 border border-white/10' : 'bg-white border border-zinc-200 shadow-xl'}`}
              onClick={(e) => e.stopPropagation()}
            >
              <Sparkles className={`w-8 h-8 mx-auto mb-3 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />
              <p className={`text-sm mb-4 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                {t('evolution.skill.notFound')}
              </p>
              <button
                onClick={() => setSkillDetailId(null)}
                className={`text-sm font-medium px-4 py-2 rounded-lg ${isDark ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'}`}
              >
                {t('common.close')}
              </button>
            </div>
          ) : (
            <div
              className={`relative max-w-lg w-full max-h-[80vh] overflow-y-auto rounded-2xl p-6 ${isDark ? 'bg-zinc-900 border border-white/10' : 'bg-white border border-zinc-200 shadow-xl'}`}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => setSkillDetailId(null)}
                className={`absolute top-4 right-4 p-1 rounded-lg transition-colors ${isDark ? 'text-zinc-500 hover:text-white hover:bg-white/10' : 'text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100'}`}
              >
                <X className="w-4 h-4" />
              </button>
              <div className="flex items-center gap-2 mb-1">
                {(() => {
                  const badge = getSourceBadge(skillDetail.source, isDark);
                  return (
                    <span
                      className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${badge?.className || (isDark ? 'bg-zinc-700/60 text-zinc-400' : 'bg-zinc-100 text-zinc-500')}`}
                    >
                      {sourceBadgeLabel(skillDetail.source, badge?.label, t)}
                    </span>
                  );
                })()}
                {skillDetail.geneId && (
                  <span
                    className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${isDark ? 'bg-cyan-500/15 text-cyan-300' : 'bg-cyan-100 text-cyan-600'}`}
                  >
                    {t('evolution.common.hasGene')}
                  </span>
                )}
              </div>
              <h2 className={`text-xl font-bold mb-2 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                {skillDetail.name}
              </h2>
              <p className={`text-sm leading-relaxed mb-4 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                {skillDetail.description}
              </p>
              <div className={`grid grid-cols-2 gap-3 mb-4 p-3 rounded-lg ${isDark ? 'bg-zinc-800/50' : 'bg-zinc-50'}`}>
                <div>
                  <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    {t('evolution.common.category')}
                  </p>
                  <p className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                    {skillDetail.category}
                  </p>
                </div>
                <div>
                  <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    {t('evolution.common.author')}
                  </p>
                  <p className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                    {skillDetail.author || t('evolution.common.unknown')}
                  </p>
                </div>
                <div>
                  <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    {t('evolution.common.installs')}
                  </p>
                  <p className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                    {(skillDetail.installs || 0).toLocaleString()}
                  </p>
                </div>
              </div>
              {skillDetail.tags?.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-4">
                  {skillDetail.tags.map((tag) => (
                    <span
                      key={tag}
                      className={`text-[10px] px-1.5 py-0.5 rounded ${isDark ? 'bg-zinc-800/60 text-zinc-400' : 'bg-zinc-100 text-zinc-500'}`}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              {/* Action buttons */}
              {isAuthenticated && (
                <div className={`flex gap-2 mb-4 pt-3 border-t ${isDark ? 'border-white/5' : 'border-zinc-200/60'}`}>
                  <button
                    onClick={() => handleSkillInstall(skillDetail.id)}
                    className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" /> {t('evolution.common.install')}
                  </button>

                  {skillDetail.sourceUrl && (
                    <a
                      href={skillDetail.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors"
                      style={{
                        color: isDark ? '#a78bfa' : '#7c3aed',
                        background: isDark ? 'rgba(167,139,250,0.1)' : 'rgba(124,58,237,0.06)',
                      }}
                    >
                      <ExternalLink className="w-3.5 h-3.5" /> {t('evolution.common.source')}
                    </a>
                  )}
                </div>
              )}
              {skillDetail.geneId && (
                <button
                  onClick={() => {
                    setSkillDetailId(null);
                    navigateToGene(skillDetail.geneId!);
                  }}
                  className={`flex items-center gap-1.5 text-sm font-medium mb-4 ${isDark ? 'text-cyan-400 hover:text-cyan-300' : 'text-cyan-600 hover:text-cyan-500'}`}
                >
                  <Dna className="w-3.5 h-3.5" /> {t('evolution.common.viewLinkedGene')}
                </button>
              )}
              {skillRelated.length > 0 && (
                <div className={`pt-4 border-t ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}>
                  <h4
                    className={`text-xs font-bold uppercase tracking-wider mb-3 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
                  >
                    {t('evolution.common.relatedSkills')}
                  </h4>
                  <div className="space-y-2">
                    {skillRelated.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => setSkillDetailId(r.id)}
                        className={`w-full text-left flex items-center justify-between p-2.5 rounded-lg transition-colors ${isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-zinc-50'}`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className={`text-sm font-medium truncate ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                            {r.name}
                          </p>
                          <p className={`text-xs truncate ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                            {r.description}
                          </p>
                        </div>
                        <span
                          className={`flex items-center gap-1 text-xs shrink-0 ml-3 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
                        >
                          <Download className="w-3 h-3" />
                          {(r.installs || 0).toLocaleString()}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {geneDetailId && (
        <GeneDetailModal
          gene={geneDetail}
          loading={geneDetailLoading}
          isDark={isDark}
          onClose={() => setGeneDetailId(null)}
          onImport={handleImport}
          onFork={handleFork}
          onAgentClick={navigateToAgent}
          isAuthenticated={isAuthenticated}
        />
      )}

      {/* Fork Sheet (triggered from Library tab gene cards) */}
      <GeneForkSheet
        open={!!forkGene}
        onOpenChange={(open) => {
          if (!open) setForkGene(null);
        }}
        parentGene={
          forkGene
            ? {
                id: forkGene.gene_id || forkGene.id || '',
                title: forkGene.title,
                category: forkGene.category || '',
                signals_match: forkGene.signals_match || forkGene.signals || [],
                strategy: forkGene.strategy || [],
              }
            : null
        }
        isDark={isDark}
        onForked={() => {
          addToast(t('evolution.toast.geneForked'), 'success');
          setForkGene(null);
        }}
      />
    </div>
  );
}

// ═════════════════════════════════════════════════════════
// UNAUTHENTICATED STUDIO PLACEHOLDER (S34, v2.0.8)
// ═════════════════════════════════════════════════════════
// Replaces the deleted my-evolution-tab.tsx (1050+ lines) fallback. Used by
// the Studio tab when the visitor isn't logged in — see doc-13 §4.4 / §11.

function UnauthenticatedStudioPlaceholder({ isDark }: { isDark: boolean }) {
  const { t } = useI18n();
  // 替代 my-evolution-tab.tsx 1050 行 fallback (S34, v2.0.8)。未登录用户访问
  // /evolution?tab=studio 看到的登录引导卡片。S37 (v2.0.9) 已下线 `?tab=my`
  // 重写 — 旧书签现 fallback 到 overview tab。
  // 设计原则: 极简; 不渲染任何 user-scoped 数据; CTA 引导到 /auth。
  return (
    <div className={`rounded-2xl p-10 text-center ${glass(isDark)}`}>
      <Wrench className={`w-10 h-10 mx-auto mb-4 ${isDark ? 'text-violet-300' : 'text-violet-500'}`} />
      <h3 className={`text-xl font-bold mb-2 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
        {t('evolution.cta.signInStudioTitle')}
      </h3>
      <p className={`text-sm mb-6 max-w-md mx-auto ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
        {t('evolution.cta.signInStudioBody')}
      </p>
      <Link
        href="/auth"
        className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-bold text-white bg-[var(--prismer-primary)] hover:bg-[var(--prismer-primary-light)] transition-colors"
      >
        {t('evolution.cta.signIn')} <ArrowRight className="w-4 h-4" />
      </Link>
    </div>
  );
}

// ═════════════════════════════════════════════════════════
// OVERVIEW TAB COMPONENT
// ═════════════════════════════════════════════════════════

function OverviewTab({
  isDark,
  stats,
  hotGenes,
  feed,
  trendingSkills,
  autoMilestones,
  switchTab,
  onSkillClick,
  onGeneClick,
}: {
  isDark: boolean;
  stats: EvolutionStats;
  hotGenes: PublicGene[];
  feed: FeedEvent[];
  trendingSkills: Skill[];
  autoMilestones: { type: string; title: string; detail: string; agentName: string; timestamp: string }[];
  switchTab: (tab: TabKey) => void;
  onSkillClick: (id: string) => void;
  onGeneClick: (id: string) => void;
}) {
  const { t } = useI18n();
  // Extract milestones from feed + auto-detected
  const milestones = feed.filter(
    (e) =>
      e.type === 'milestone' || e.type === 'publish' || (e.type === 'capsule' && e.score != null && e.score >= 0.9),
  );

  // KPI trending: compare with previous stats from localStorage
  // Use useEffect to avoid hydration mismatch (localStorage is client-only)
  const [trends, setTrends] = useState({ genes: 0, capsules: 0, success: 0, agents: 0 });
  useEffect(() => {
    const STORAGE_KEY = 'prismer_evo_stats_prev';
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const prev = JSON.parse(stored);
        const prevDate = prev.date ? new Date(prev.date).toDateString() : '';
        const today = new Date().toDateString();
        setTrends({
          genes: stats.total_genes - (prev.total_genes || 0),
          capsules: stats.total_capsules - (prev.total_capsules || 0),
          success: Math.round((stats.avg_success_rate - (prev.avg_success_rate || 0)) * 10) / 10,
          agents: stats.active_agents - (prev.active_agents || 0),
        });
        if (prevDate !== today && stats.total_genes > 0) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...stats, date: new Date().toISOString() }));
        }
      } else if (stats.total_genes > 0) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...stats, date: new Date().toISOString() }));
      }
    } catch {
      /* localStorage unavailable */
    }
  }, [stats]);

  return (
    <div className="space-y-8">
      {/* Hero: Canvas + Tagline */}
      <div className={`relative rounded-2xl overflow-hidden ${glass(isDark)}`}>
        <div className="absolute inset-0 z-0">
          <NetworkCanvas isDark={isDark} />
        </div>
        <div className="relative z-10 flex flex-col items-center justify-center text-center py-16 sm:py-24 px-6">
          <div
            className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium mb-4 ${isDark ? 'bg-white/[0.06] text-zinc-300' : 'bg-black/[0.04] text-zinc-700'}`}
          >
            <Dna className="w-3.5 h-3.5 text-violet-400" />
            {t('evolution.overview.badge')}
          </div>
          <h2 className={`text-2xl sm:text-4xl font-bold mb-3 max-w-2xl ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            {t('evolution.overview.title')}
          </h2>
          <p className={`text-sm sm:text-base max-w-xl leading-relaxed ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            {t('evolution.overview.body')}
          </p>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          {
            label: t('evolution.overview.activeGenes'),
            value: stats.total_genes,
            icon: Dna,
            accent: 'text-violet-400',
            gradient: 'from-violet-500/20 to-violet-500/0',
            trend: trends.genes,
          },
          {
            label: t('evolution.overview.executions'),
            value: stats.total_capsules,
            icon: Zap,
            accent: 'text-amber-400',
            gradient: 'from-amber-500/20 to-amber-500/0',
            trend: trends.capsules,
          },
          {
            label: t('evolution.overview.avgSuccess'),
            value: stats.avg_success_rate,
            suffix: '%',
            icon: TrendingUp,
            accent: 'text-emerald-400',
            gradient: 'from-emerald-500/20 to-emerald-500/0',
            trend: trends.success,
          },
          {
            label: t('evolution.overview.agents'),
            value: stats.active_agents,
            icon: Network,
            accent: 'text-cyan-400',
            gradient: 'from-cyan-500/20 to-cyan-500/0',
            trend: trends.agents,
          },
        ].map(({ label, value, suffix, icon: Icon, accent, gradient, trend }) => (
          <TiltCard
            key={label}
            glowColor="rgba(139,92,246,0.06)"
            maxTilt={3}
            scale={1.01}
            className="rounded-xl h-full"
          >
            <div className={`relative overflow-hidden rounded-xl p-4 sm:p-5 text-center ${glass(isDark)}`}>
              <div className={`absolute inset-0 bg-gradient-to-b ${gradient} pointer-events-none`} />
              <div className="relative">
                <Icon className={`w-5 h-5 mx-auto mb-2 ${accent}`} />
                <div
                  className={`text-2xl sm:text-3xl font-bold tabular-nums ${isDark ? 'text-white' : 'text-zinc-900'}`}
                >
                  <AnimatedCounter value={value} suffix={suffix || ''} />
                </div>
                <div
                  className={`text-[10px] uppercase tracking-wider mt-1 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                >
                  {label}
                </div>
                {trend !== undefined && trend !== 0 && (
                  <div className={`text-[10px] mt-0.5 font-medium ${trend > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {trend > 0 ? '+' : ''}
                    {suffix === '%' ? `${trend}%` : trend} {t('evolution.overview.thisWeek')}
                  </div>
                )}
              </div>
            </div>
          </TiltCard>
        ))}
      </div>

      {/* How Evolution Works — 4 Steps */}
      <div>
        <h3 className={`text-lg font-bold mb-4 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
          {t('evolution.overview.howItWorks')}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 relative">
          {[
            {
              step: 1,
              icon: Zap,
              title: t('evolution.overview.steps.signalTitle'),
              desc: t('evolution.overview.steps.signalDesc'),
              color: 'text-orange-400',
              bg: 'from-orange-500/10',
              borderColor: 'border-orange-500/20',
            },
            {
              step: 2,
              icon: Dna,
              title: t('evolution.overview.steps.geneTitle'),
              desc: t('evolution.overview.steps.geneDesc'),
              color: 'text-cyan-400',
              bg: 'from-cyan-500/10',
              borderColor: 'border-cyan-500/20',
            },
            {
              step: 3,
              icon: Play,
              title: t('evolution.overview.steps.executeTitle'),
              desc: t('evolution.overview.steps.executeDesc'),
              color: 'text-emerald-400',
              bg: 'from-emerald-500/10',
              borderColor: 'border-emerald-500/20',
            },
            {
              step: 4,
              icon: Brain,
              title: t('evolution.overview.steps.captureTitle'),
              desc: t('evolution.overview.steps.captureDesc'),
              color: 'text-violet-400',
              bg: 'from-violet-500/10',
              borderColor: 'border-violet-500/20',
            },
          ].map(({ step, icon: Icon, title, desc, color, bg, borderColor }) => (
            <div key={step} className="relative">
              <TiltCard glowColor="rgba(139,92,246,0.06)" maxTilt={3} className="rounded-xl h-full">
                <div
                  className={`relative overflow-hidden rounded-xl p-5 h-full border ${borderColor} ${glass(isDark)}`}
                >
                  <div className={`absolute inset-0 bg-gradient-to-b ${bg} to-transparent pointer-events-none`} />
                  <div className="relative">
                    <div className="flex items-center gap-2 mb-3">
                      <span
                        className={`text-[10px] font-bold tabular-nums ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                      >
                        0{step}
                      </span>
                      <Icon className={`w-5 h-5 ${color}`} />
                    </div>
                    <h4 className={`font-bold text-sm mb-1.5 ${isDark ? 'text-white' : 'text-zinc-900'}`}>{title}</h4>
                    <p className={`text-xs leading-relaxed ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>{desc}</p>
                  </div>
                </div>
              </TiltCard>
              {/* Arrow connector with pulse animation (desktop only, §3.3) */}
              {step < 4 && (
                <div className="hidden lg:flex absolute -right-2 top-1/2 -translate-y-1/2 z-20">
                  <ArrowRight className={`w-4 h-4 animate-pulse ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Recent Milestones */}
      {hotGenes.length > 0 && (
        <div>
          <h3 className={`text-lg font-bold mb-4 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            {t('evolution.overview.hotGenes')}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {hotGenes.slice(0, 3).map((gene) => {
              const cat = CAT_COLORS[gene.category || ''] || CAT_COLORS.repair;
              const totalUses = (gene.success_count || 0) + (gene.failure_count || 0);
              const successRate = totalUses > 0 ? Math.round(((gene.success_count || 0) / totalUses) * 100) : 0;
              return (
                <TiltCard key={getGeneId(gene)} glowColor={cat.glow} maxTilt={3} className="rounded-xl h-full">
                  <div
                    className={`rounded-xl p-5 h-full cursor-pointer ${glass(isDark)}`}
                    onClick={() => onGeneClick(getGeneId(gene))}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span
                        className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${cat.bg} ${cat.text} ${cat.border}`}
                      >
                        {categoryLabel(gene.category, t)}
                      </span>
                      {gene.is_seed && (
                        <span
                          className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${isDark ? 'bg-violet-500/15 text-violet-300' : 'bg-violet-100 text-violet-600'}`}
                        >
                          {t('evolution.common.seed')}
                        </span>
                      )}
                    </div>
                    <h4 className={`font-bold text-sm mb-1 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                      {gene.title || getSignals(gene)[0] || 'Untitled'}
                    </h4>
                    <p
                      className={`text-xs leading-relaxed line-clamp-2 mb-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}
                    >
                      {gene.description || ''}
                    </p>
                    <div
                      className={`flex items-center gap-3 pt-2 border-t ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}
                    >
                      {/* Ring chart (§3.5) */}
                      {totalUses > 0 ? (
                        <>
                          <svg width="32" height="32" viewBox="0 0 36 36" className="shrink-0">
                            <circle
                              cx="18"
                              cy="18"
                              r="15"
                              fill="none"
                              stroke={isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'}
                              strokeWidth="4"
                            />
                            <circle
                              cx="18"
                              cy="18"
                              r="15"
                              fill="none"
                              stroke={successRate >= 70 ? '#22c55e' : successRate >= 40 ? '#eab308' : '#ef4444'}
                              strokeWidth="4"
                              strokeDasharray={`${successRate * 0.942} ${94.2 - successRate * 0.942}`}
                              strokeDashoffset="23.55"
                              strokeLinecap="round"
                            />
                          </svg>
                          <div className="flex-1 min-w-0">
                            <span
                              className={`text-xs font-bold tabular-nums ${successRate >= 70 ? 'text-emerald-400' : successRate >= 40 ? 'text-amber-400' : 'text-red-400'}`}
                            >
                              {successRate}%
                            </span>
                            <span className={`text-[10px] ml-1 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                              {t('evolution.common.uses', { count: totalUses })}
                            </span>
                          </div>
                        </>
                      ) : (
                        <span className={`text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                          {t('evolution.common.noExecutionsYet')}
                        </span>
                      )}
                      {gene.used_by_count != null && gene.used_by_count > 0 && (
                        <span
                          className={`flex items-center gap-0.5 text-xs shrink-0 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
                        >
                          <Users className="w-3 h-3" />
                          {gene.used_by_count}
                        </span>
                      )}
                    </div>
                  </div>
                </TiltCard>
              );
            })}
          </div>
        </div>
      )}

      {/* Trending This Week */}
      {trendingSkills.length > 0 && (
        <div className={`rounded-xl overflow-hidden ${glass(isDark)}`}>
          <div
            className={`px-5 py-3 flex items-center justify-between border-b ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}
          >
            <div className="flex items-center gap-2">
              <TrendingUp className={`w-4 h-4 ${isDark ? 'text-amber-400' : 'text-amber-600'}`} />
              <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                {t('evolution.overview.trendingSkills')}
              </h3>
            </div>
            <button
              onClick={() => switchTab('skills')}
              className="text-xs font-medium text-violet-400 hover:text-violet-300 flex items-center gap-1"
            >
              {t('evolution.overview.viewAll')} <ArrowRight className="w-3 h-3" />
            </button>
          </div>
          <div className="divide-y divide-transparent">
            {trendingSkills.map((skill, i) => (
              <div
                key={skill.id}
                className={`flex items-center gap-3 px-5 py-2.5 cursor-pointer ${isDark ? 'hover:bg-white/[0.02]' : 'hover:bg-black/[0.02]'}`}
                onClick={() => onSkillClick(skill.id)}
              >
                <span
                  className={`text-xs font-bold tabular-nums w-5 text-right ${i < 3 ? (isDark ? 'text-amber-400' : 'text-amber-600') : isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                >
                  #{i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium truncate ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                    {skill.name}
                  </p>
                </div>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${isDark ? 'bg-zinc-800/60 text-zinc-500' : 'bg-zinc-100 text-zinc-500'}`}
                >
                  {categoryLabel(skill.category, t)}
                </span>
                <span
                  className={`flex items-center gap-1 text-xs tabular-nums shrink-0 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
                >
                  <Download className="w-3 h-3" />
                  {(skill.installs || 0).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Milestones */}
      {milestones.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h3 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
              {t('evolution.overview.recentMilestones')}
            </h3>
            <button
              onClick={() => switchTab('timeline')}
              className="text-xs font-medium text-violet-400 hover:text-violet-300 flex items-center gap-1"
            >
              {t('evolution.overview.viewTimeline')} <ArrowRight className="w-3 h-3" />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {milestones.slice(0, 3).map((event, i) => {
              const cfg = FEED_ICONS[event.type || 'capsule'] || FEED_ICONS.capsule;
              const Icon = cfg.icon;
              const catColor = CAT_COLORS[event.geneCategory || '']?.hex || '#71717a';
              return (
                <div key={i} className={`rounded-xl p-4 ${glass(isDark)}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <div
                      className="w-6 h-6 rounded-full flex items-center justify-center"
                      style={{ backgroundColor: catColor + '20' }}
                    >
                      <Icon className={`w-3 h-3 ${cfg.color}`} />
                    </div>
                    <span
                      className={`text-[10px] uppercase tracking-wider font-semibold ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
                    >
                      {eventTypeLabel(event.type || '', t)}
                    </span>
                  </div>
                  <p className={`text-sm font-semibold mb-1 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                    {event.geneTitle}
                  </p>
                  <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    {t('evolution.common.authorLabel')} {event.agentName}{' '}
                    {event.score != null && `(${Math.round(event.score * 100)}%)`}
                  </p>
                  <p className={`text-[10px] mt-1 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                    <TimeAgo ts={event.timestamp || ''} />
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Auto-Detected Milestones */}
      {autoMilestones.length > 0 && (
        <div className={`rounded-xl overflow-hidden ${glass(isDark)}`}>
          <div
            className={`px-5 py-3 flex items-center justify-between border-b ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}
          >
            <div className="flex items-center gap-2">
              <Trophy className={`w-4 h-4 ${isDark ? 'text-amber-400' : 'text-amber-600'}`} />
              <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                {t('evolution.overview.detectedMilestones')}
              </h3>
            </div>
          </div>
          <div className="divide-y divide-transparent">
            {autoMilestones.slice(0, 5).map((ms, i) => (
              <div
                key={i}
                className={`flex items-center gap-3 px-5 py-3 ${isDark ? 'hover:bg-white/[0.02]' : 'hover:bg-black/[0.02]'}`}
              >
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                    ms.type === 'execution_milestone'
                      ? 'bg-amber-500/10'
                      : ms.type === 'first_publish'
                        ? 'bg-violet-500/10'
                        : 'bg-cyan-500/10'
                  }`}
                >
                  <Trophy
                    className={`w-3.5 h-3.5 ${
                      ms.type === 'execution_milestone'
                        ? 'text-amber-400'
                        : ms.type === 'first_publish'
                          ? 'text-violet-400'
                          : 'text-cyan-400'
                    }`}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium truncate ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                    {ms.title}
                  </p>
                  <p className={`text-xs truncate ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>{ms.detail}</p>
                </div>
                <TimeAgo
                  ts={ms.timestamp}
                  className={`text-[10px] shrink-0 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Activity Preview */}
      {feed.length > 0 && (
        <div className={`rounded-xl overflow-hidden ${glass(isDark)}`}>
          <div
            className={`px-5 py-3 flex items-center justify-between border-b ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}
          >
            <div className="flex items-center gap-2">
              <Activity className={`w-4 h-4 ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`} />
              <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                {t('evolution.overview.recentActivity')}
              </h3>
            </div>
            <button
              onClick={() => switchTab('timeline')}
              className="text-xs font-medium text-violet-400 hover:text-violet-300 flex items-center gap-1"
            >
              {t('evolution.overview.viewAll')} <ArrowRight className="w-3 h-3" />
            </button>
          </div>
          <div className="divide-y divide-transparent max-h-64 overflow-y-auto custom-scrollbar">
            {feed.slice(0, 5).map((event, i) => {
              const cfg = FEED_ICONS[event.type || 'capsule'] || FEED_ICONS.capsule;
              const Icon = cfg.icon;
              return (
                <div
                  key={i}
                  className={`flex items-center gap-3 px-5 py-3 ${isDark ? 'hover:bg-white/[0.02]' : 'hover:bg-black/[0.02]'}`}
                >
                  <div
                    className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${isDark ? 'bg-zinc-800' : 'bg-zinc-100'}`}
                  >
                    {event.type === 'capsule' && event.outcome === 'failure' ? (
                      <XCircle className="w-3.5 h-3.5 text-red-400" />
                    ) : (
                      <Icon className={`w-3.5 h-3.5 ${cfg.color}`} />
                    )}
                  </div>
                  <p className={`text-sm flex-1 min-w-0 truncate ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                    <span className="font-semibold">{event.agentName}</span>{' '}
                    {event.type === 'capsule' ? t('evolution.legacy.executed') : eventActionLabel(event.type, t)}{' '}
                    <span className="font-medium">{event.geneTitle}</span>
                  </p>
                  <TimeAgo
                    ts={event.timestamp || ''}
                    className={`text-[10px] shrink-0 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* CTA Buttons */}
      <div className="flex flex-wrap gap-3 justify-center">
        <button
          onClick={() => switchTab('skills')}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold bg-gradient-to-r from-violet-600 to-violet-500 text-white hover:from-violet-500 hover:to-violet-400 transition-all shadow-lg shadow-violet-500/20"
        >
          <Sparkles className="w-4 h-4" /> {t('evolution.overview.exploreSkills')}
        </button>
        <button
          onClick={() => switchTab('genes')}
          className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all ${isDark ? 'bg-white/[0.06] text-white hover:bg-white/[0.1] border border-white/10' : 'bg-zinc-100 text-zinc-900 hover:bg-zinc-200 border border-zinc-200'}`}
        >
          <Dna className="w-4 h-4" /> {t('evolution.overview.browseGenes')}
        </button>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════
// SKILL CARD COMPONENT
// ═════════════════════════════════════════════════════════

function SkillCard({
  skill,
  isDark,
  expanded,
  onToggle,
  onDetail,
  onCardClick,
  onViewGene,
}: {
  skill: Skill;
  isDark: boolean;
  expanded: boolean;
  onToggle: () => void;
  onDetail: () => void;
  onCardClick: () => void;
  onViewGene?: () => void;
}) {
  const { t } = useI18n();
  const sourceBadge = getSourceBadge(skill.source, isDark);
  return (
    <TiltCard glowColor="rgba(139,92,246,0.08)" maxTilt={2} scale={1.005} className="rounded-xl h-full">
      <div className={`rounded-xl p-5 flex flex-col h-full cursor-pointer ${glass(isDark)}`} onClick={onCardClick}>
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <h3 className={`font-bold text-sm leading-tight ${isDark ? 'text-white' : 'text-zinc-900'}`}>{skill.name}</h3>
          <div className="flex items-center gap-1 shrink-0">
            {skill.geneId && (
              <span
                className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${isDark ? 'bg-cyan-500/15 text-cyan-300' : 'bg-cyan-100 text-cyan-600'}`}
              >
                {t('evolution.common.hasGene')}
              </span>
            )}
            <span
              className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                skill.source === 'awesome-openclaw'
                  ? isDark
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : 'bg-emerald-100 text-emerald-600'
                  : isDark
                    ? 'bg-zinc-700/60 text-zinc-400'
                    : 'bg-zinc-100 text-zinc-500'
              }`}
            >
              {sourceBadgeLabel(skill.source, sourceBadge?.label, t)}
            </span>
          </div>
        </div>

        {/* Description */}
        <p
          className={`text-xs leading-relaxed mb-3 ${expanded ? '' : 'line-clamp-2'} min-h-[2.5rem] ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}
        >
          {skill.description}
        </p>

        {/* Category + Tags */}
        <div className="flex flex-wrap gap-1 mb-3">
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${isDark ? 'bg-zinc-800/80 text-zinc-300' : 'bg-zinc-100 text-zinc-600'}`}
          >
            {categoryLabel(skill.category, t)}
          </span>
          {skill.tags?.slice(0, expanded ? undefined : 2).map((tag) => (
            <span
              key={tag}
              className={`text-[10px] px-1.5 py-0.5 rounded ${isDark ? 'bg-zinc-800/60 text-zinc-500' : 'bg-zinc-100 text-zinc-500'}`}
            >
              {tag}
            </span>
          ))}
          {!expanded && skill.tags?.length > 2 && (
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded ${isDark ? 'bg-zinc-800/60 text-zinc-600' : 'bg-zinc-100 text-zinc-400'}`}
            >
              +{skill.tags.length - 2}
            </span>
          )}
        </div>

        {/* Expanded details */}
        {expanded && (
          <div className={`mb-3 pt-3 border-t space-y-2 ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}>
            {skill.author && (
              <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                <span className="font-medium">{t('evolution.common.authorLabel')}</span> {skill.author}
              </p>
            )}
            {skill.sourceUrl && (
              <a
                href={skill.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300"
              >
                <ExternalLink className="w-3 h-3" /> {t('evolution.common.viewSource')}
              </a>
            )}
          </div>
        )}

        <div className="flex-1" />

        {/* Footer */}
        <div
          className={`flex items-center justify-between pt-3 border-t ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}
        >
          <div className="flex items-center gap-3">
            <span className={`flex items-center gap-1 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
              <Download className="w-3 h-3" /> {(skill.installs || 0).toLocaleString()}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {skill.sourceUrl && (
              <a
                href={skill.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className={`flex items-center gap-0.5 text-xs font-medium transition-colors ${isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-600'}`}
              >
                <ExternalLink className="w-3 h-3" /> {t('evolution.common.source')}
              </a>
            )}
            {onViewGene && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onViewGene();
                }}
                className={`text-xs font-medium transition-colors ${isDark ? 'text-cyan-400 hover:text-cyan-300' : 'text-cyan-600 hover:text-cyan-500'}`}
              >
                {t('evolution.common.geneShort')}
              </button>
            )}
          </div>
        </div>
      </div>
    </TiltCard>
  );
}

// ═════════════════════════════════════════════════════════
// GENE CARD COMPONENT
// ═════════════════════════════════════════════════════════

function GeneCard({
  gene,
  isDark,
  maxExecutions,
  expanded,
  onToggle,
  onImport,
  onDetail,
  onCardClick,
  onAgentClick,
}: {
  gene: PublicGene;
  isDark: boolean;
  maxExecutions: number;
  expanded: boolean;
  onToggle: () => void;
  onImport: (id: string) => void;
  onDetail?: () => void;
  onCardClick?: () => void;
  onAgentClick?: (name: string) => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const cat = CAT_COLORS[gene.category || ''] || CAT_COLORS.repair;
  const totalUses = (gene.success_count || 0) + (gene.failure_count || 0);
  const successRate = totalUses > 0 ? Math.round(((gene.success_count || 0) / totalUses) * 100) : 0;
  const pqi = computePQI(gene, maxExecutions);
  const isSeed = gene.is_seed || gene.visibility === 'seed' || gene.created_by?.includes('seed');
  const signals = getSignals(gene);
  const steps = getSteps(gene);
  const id = getGeneId(gene);

  const handleCopyId = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        /* noop */
      }
    },
    [id],
  );

  const pqiColor =
    pqi >= 70
      ? isDark
        ? 'text-emerald-400'
        : 'text-emerald-600'
      : pqi >= 40
        ? isDark
          ? 'text-amber-400'
          : 'text-amber-600'
        : isDark
          ? 'text-zinc-500'
          : 'text-zinc-400';

  return (
    <TiltCard glowColor={cat.glow} maxTilt={3} scale={1.008} className="rounded-xl h-full">
      <div
        className={`rounded-xl p-5 flex flex-col h-full cursor-pointer ${glass(isDark)}`}
        onClick={onCardClick || onDetail || onToggle}
      >
        {/* Row 1: Category + PQI + Badge */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${cat.bg} ${cat.text} ${cat.border}`}
            >
              {categoryLabel(gene.category, t)}
            </span>
            {totalUses > 0 && <span className={`text-[10px] font-bold tabular-nums ${pqiColor}`}>PQI {pqi}</span>}
          </div>
          <div className="flex items-center gap-1">
            {isSeed && (
              <span
                className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${isDark ? 'bg-violet-500/15 text-violet-300' : 'bg-violet-100 text-violet-600'}`}
              >
                {t('evolution.common.seed')}
              </span>
            )}
            {gene.used_by_count != null && gene.used_by_count > 0 && (
              <span className={`flex items-center gap-0.5 text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                <Users className="w-3 h-3" />
                {gene.used_by_count}
              </span>
            )}
          </div>
        </div>

        {/* Title */}
        <h3 className={`font-bold text-sm leading-tight mb-1 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
          {gene.title || signals[0] || t('evolution.common.untitled')}
        </h3>

        {/* Description */}
        <p
          className={`text-xs leading-relaxed mb-3 line-clamp-2 min-h-[2.5rem] ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}
        >
          {gene.description || steps[0] || ''}
        </p>

        {/* Success rate bar */}
        {totalUses > 0 && (
          <div className="flex items-center gap-2 mb-3">
            <div className={`flex-1 h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`}>
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all"
                style={{ width: `${successRate}%` }}
              />
            </div>
            <span className={`text-xs font-semibold tabular-nums ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
              {successRate}%
            </span>
            <span className={`text-[10px] tabular-nums ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
              {t('evolution.common.uses', { count: totalUses })}
            </span>
          </div>
        )}

        {/* Signals */}
        <div className="flex flex-wrap gap-1 mb-3 min-h-[1.5rem]">
          {signals.slice(0, expanded ? undefined : 3).map((sig) => (
            <span
              key={sig}
              className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${isDark ? 'bg-zinc-800/60 text-zinc-400' : 'bg-zinc-100 text-zinc-500'}`}
            >
              {sig}
            </span>
          ))}
          {!expanded && signals.length > 3 && (
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded ${isDark ? 'bg-zinc-800/60 text-zinc-500' : 'bg-zinc-100 text-zinc-400'}`}
            >
              +{signals.length - 3}
            </span>
          )}
        </div>

        {/* Attribution — always visible on card (§5.3) */}
        {(gene.published_by || gene.created_by) && (
          <div
            className={`flex items-center justify-between mb-2 text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
          >
            <span>
              {t('evolution.common.publishedBy')}{' '}
              {onAgentClick ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onAgentClick(gene.published_by || gene.created_by || '');
                  }}
                  className={`font-semibold underline decoration-dotted ${isDark ? 'text-cyan-400 hover:text-cyan-300' : 'text-cyan-600 hover:text-cyan-500'}`}
                >
                  {gene.published_by || gene.created_by}
                </button>
              ) : (
                <span className="font-semibold">{gene.published_by || gene.created_by}</span>
              )}
            </span>
            {gene.used_by_count != null && gene.used_by_count > 0 && (
              <span>
                {t('evolution.common.adoptedByAgents', {
                  count: gene.used_by_count,
                  suffix: gene.used_by_count > 1 ? 's' : '',
                })}
              </span>
            )}
          </div>
        )}

        {/* Strategy steps (collapsed: 2, expanded: all) */}
        <div className={`text-xs mb-2 space-y-0.5 min-h-[2rem] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {steps.slice(0, expanded ? undefined : 2).map((step, i) => (
            <p key={i} className={expanded ? '' : 'truncate'}>
              <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>{i + 1}.</span> {step}
            </p>
          ))}
          {!expanded && steps.length > 2 && (
            <p className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>
              +{steps.length - 2} {t('evolution.common.more')}
            </p>
          )}
        </div>

        {/* Expanded details */}
        {expanded && (
          <div className={`mb-2 pt-2 border-t ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}>
            <button
              onClick={handleCopyId}
              className={`flex items-center gap-1 text-[10px] font-mono mb-2 transition-colors ${isDark ? 'text-zinc-600 hover:text-zinc-400' : 'text-zinc-400 hover:text-zinc-600'}`}
            >
              ID: {id} {copied ? <Check className="w-2.5 h-2.5 text-emerald-400" /> : <Copy className="w-2.5 h-2.5" />}
            </button>
            {gene.preconditions && gene.preconditions.length > 0 && (
              <div className="mt-1">
                <p
                  className={`text-[10px] font-semibold uppercase tracking-wider mb-0.5 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
                >
                  {t('evolution.common.preconditions')}
                </p>
                {gene.preconditions.map((p: string, i: number) => (
                  <p key={i} className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                    {p}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex-1" />

        {/* Footer */}
        <div
          className={`flex items-center justify-between pt-3 border-t ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className={`flex items-center gap-1 text-[10px] font-medium transition-colors ${isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-700'}`}
          >
            {expanded ? t('evolution.common.less') : t('evolution.common.more')}{' '}
            <ChevronDown className={`w-3 h-3 transition-transform duration-300 ${expanded ? 'rotate-180' : ''}`} />
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onImport(id);
              }}
              className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${
                isDark
                  ? 'text-violet-400 hover:bg-violet-500/10 border border-violet-500/0 hover:border-violet-500/20'
                  : 'text-[var(--prismer-primary)] hover:bg-[var(--prismer-primary)]/8 border border-transparent hover:border-[var(--prismer-primary)]/20'
              }`}
            >
              {t('evolution.common.installGene')}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                const url = `${window.location.origin}/evolution?gene=${id}`;
                navigator.clipboard.writeText(url).catch(() => {});
              }}
              className={`p-1.5 rounded-lg transition-colors ${isDark ? 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]' : 'text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100'}`}
              title={t('evolution.common.copyShareLink')}
            >
              <Share2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </TiltCard>
  );
}

// ═════════════════════════════════════════════════════════
// LINEAGE TREE COMPONENT
// ═════════════════════════════════════════════════════════

interface LineageGene {
  id: string;
  title?: string;
  category: string;
  success_count: number;
  failure_count: number;
  created_by?: string;
  parentGeneId?: string | null;
  generation?: number;
}

interface TreeNode {
  gene: LineageGene;
  children: TreeNode[];
  x: number;
  y: number;
  width: number;
}

function LineageTree({
  gene,
  ancestors,
  descendants,
  isDark,
  onGeneClick,
}: {
  gene: LineageGene;
  ancestors: LineageGene[];
  descendants: LineageGene[];
  isDark: boolean;
  onGeneClick?: (id: string) => void;
}) {
  const { t } = useI18n();
  const NODE_W = 130;
  const NODE_H = 44;
  const GAP_X = 16;
  const GAP_Y = 60;

  // Build tree from flat data
  const allNodes = [...ancestors.slice().reverse(), gene, ...descendants];
  const nodeMap = Object.fromEntries(allNodes.map((n) => [n.id, n])) as Record<string, LineageGene>;

  // Find root: last ancestor or the gene itself
  const root = ancestors.length > 0 ? ancestors[ancestors.length - 1] : gene;

  // Build parent→children map
  const childrenMap: Record<string, string[]> = {};
  for (const n of allNodes) {
    if (n.parentGeneId && n.parentGeneId in nodeMap) {
      const siblings = childrenMap[n.parentGeneId] || [];
      if (!siblings.includes(n.id)) siblings.push(n.id);
      childrenMap[n.parentGeneId] = siblings;
    }
  }

  // Build tree recursively
  function buildTree(nodeId: string): TreeNode {
    const g = nodeMap[nodeId];
    const childIds = childrenMap[nodeId] || [];
    const children = childIds.map((cid) => buildTree(cid));
    const childrenWidth =
      children.length > 0 ? children.reduce((sum, c) => sum + c.width, 0) + (children.length - 1) * GAP_X : 0;
    return { gene: g, children, x: 0, y: 0, width: Math.max(NODE_W, childrenWidth) };
  }

  const tree = buildTree(root.id);

  // Layout: assign x,y positions
  function layout(node: TreeNode, x: number, depth: number) {
    node.y = depth * (NODE_H + GAP_Y);
    if (node.children.length === 0) {
      node.x = x + node.width / 2;
    } else {
      let cx = x;
      for (const child of node.children) {
        layout(child, cx, depth + 1);
        cx += child.width + GAP_X;
      }
      // Center parent over children
      const first = node.children[0];
      const last = node.children[node.children.length - 1];
      node.x = (first.x + last.x) / 2;
    }
  }
  layout(tree, 0, 0);

  // Calculate SVG dimensions
  function getBounds(node: TreeNode): { minX: number; maxX: number; maxY: number } {
    let minX = node.x - NODE_W / 2;
    let maxX = node.x + NODE_W / 2;
    let maxY = node.y + NODE_H;
    for (const c of node.children) {
      const cb = getBounds(c);
      minX = Math.min(minX, cb.minX);
      maxX = Math.max(maxX, cb.maxX);
      maxY = Math.max(maxY, cb.maxY);
    }
    return { minX, maxX, maxY };
  }
  const bounds = getBounds(tree);
  const pad = 12;
  const svgW = bounds.maxX - bounds.minX + pad * 2;
  const svgH = bounds.maxY + pad * 2;
  const offsetX = -bounds.minX + pad;
  const offsetY = pad;

  // Render edges + nodes
  function renderEdges(node: TreeNode): React.ReactNode[] {
    const edges: React.ReactNode[] = [];
    for (const child of node.children) {
      const x1 = node.x + offsetX;
      const y1 = node.y + NODE_H + offsetY;
      const x2 = child.x + offsetX;
      const y2 = child.y + offsetY;
      const midY = (y1 + y2) / 2;
      edges.push(
        <path
          key={`${node.gene.id}-${child.gene.id}`}
          d={`M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`}
          fill="none"
          stroke={isDark ? 'rgba(139,92,246,0.3)' : 'rgba(139,92,246,0.25)'}
          strokeWidth="1.5"
        />,
      );
      edges.push(...renderEdges(child));
    }
    return edges;
  }

  function renderNodes(node: TreeNode): React.ReactNode[] {
    const nodes: React.ReactNode[] = [];
    const g = node.gene;
    const total = g.success_count + (g.failure_count || 0);
    const sr = total > 0 ? Math.round((g.success_count / total) * 100) : 0;
    const isCurrent = g.id === gene.id;
    const isRoot = g.id === root.id && ancestors.length > 0;
    const cat = CAT_COLORS[g.category || ''] || CAT_COLORS.repair;
    const nx = node.x + offsetX - NODE_W / 2;
    const ny = node.y + offsetY;

    nodes.push(
      <g key={g.id} className="cursor-pointer" onClick={() => onGeneClick?.(g.id)}>
        <rect
          x={nx}
          y={ny}
          width={NODE_W}
          height={NODE_H}
          rx={8}
          fill={
            isDark
              ? isCurrent
                ? 'rgba(139,92,246,0.15)'
                : 'rgba(255,255,255,0.04)'
              : isCurrent
                ? 'rgba(139,92,246,0.08)'
                : 'rgba(255,255,255,0.8)'
          }
          stroke={isCurrent ? 'rgba(139,92,246,0.6)' : isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}
          strokeWidth={isCurrent ? 2 : 1}
        />
        {/* Title */}
        <text
          x={nx + NODE_W / 2}
          y={ny + 16}
          textAnchor="middle"
          fontSize="11"
          fontWeight="600"
          fill={isDark ? '#f4f4f5' : '#18181b'}
        >
          {(g.title || t('evolution.common.untitled')).slice(0, 16)}
          {(g.title || '').length > 16 ? '…' : ''}
        </text>
        {/* Stats line */}
        <text
          x={nx + NODE_W / 2}
          y={ny + 32}
          textAnchor="middle"
          fontSize="9"
          fontWeight="500"
          fill={sr >= 70 ? '#22c55e' : sr >= 40 ? '#eab308' : total > 0 ? '#ef4444' : isDark ? '#71717a' : '#a1a1aa'}
        >
          {total > 0
            ? `${sr}% · ${t('evolution.common.runsShort', { count: total })}`
            : t('evolution.common.noExecutions')}
        </text>
        {/* Origin badge */}
        {isRoot && (
          <>
            <rect x={nx + NODE_W - 36} y={ny - 6} width={36} height={14} rx={7} fill={cat.hex} fillOpacity={0.8} />
            <text x={nx + NODE_W - 18} y={ny + 4} textAnchor="middle" fontSize="7" fontWeight="700" fill="#fff">
              {t('evolution.legacy.origin')}
            </text>
          </>
        )}
        {/* Current indicator */}
        {isCurrent && <circle cx={nx + 8} cy={ny + NODE_H / 2} r={3} fill="rgba(139,92,246,0.8)" />}
      </g>,
    );

    for (const child of node.children) {
      nodes.push(...renderNodes(child));
    }
    return nodes;
  }

  const totalNodes = allNodes.length;
  if (totalNodes <= 1) return null; // No tree to show if only the gene itself

  return (
    <div
      className={`mt-4 rounded-lg border overflow-x-auto ${isDark ? 'border-white/5 bg-zinc-800/30' : 'border-zinc-200/50 bg-zinc-50'}`}
    >
      <div className="flex items-center justify-between px-3 pt-2">
        <h4 className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
          {t('evolution.legacy.evolutionTree')}
        </h4>
        <span className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
          {t('evolution.legacy.variantsTotalRuns', {
            variants: totalNodes,
            runs: allNodes.reduce((s, g) => s + g.success_count + (g.failure_count || 0), 0).toLocaleString(),
          })}
        </span>
      </div>
      <div className="p-2 flex justify-center" style={{ minWidth: Math.max(svgW, 200) }}>
        <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`}>
          {renderEdges(tree)}
          {renderNodes(tree)}
        </svg>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════
// RADAR CHART COMPONENT
// ═════════════════════════════════════════════════════════

function RadarChart({
  dimensions,
  isDark,
  size = 140,
}: {
  dimensions: { label: string; value: number; color: string }[];
  isDark: boolean;
  size?: number;
}) {
  const cx = size / 2,
    cy = size / 2,
    r = size / 2 - 20;
  const n = dimensions.length;
  const gridLevels = [0.25, 0.5, 0.75, 1.0];

  const getPoint = (index: number, scale: number) => {
    const angle = (Math.PI * 2 * index) / n - Math.PI / 2;
    return { x: cx + Math.cos(angle) * r * scale, y: cy + Math.sin(angle) * r * scale };
  };

  const points = dimensions.map((d, i) => {
    const p = getPoint(i, d.value / 100);
    const lp = getPoint(i, 1.2);
    return { ...p, lx: lp.x, ly: lp.y, ...d };
  });
  const polygon = points.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="mx-auto">
      {/* Grid rings */}
      {gridLevels.map((level) => {
        const ring = Array.from({ length: n }, (_, i) => getPoint(i, level));
        return (
          <polygon
            key={level}
            points={ring.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke={isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'}
            strokeWidth="1"
          />
        );
      })}
      {/* Axis lines */}
      {dimensions.map((_, i) => {
        const p = getPoint(i, 1);
        return (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={p.x}
            y2={p.y}
            stroke={isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'}
            strokeWidth="1"
          />
        );
      })}
      {/* Data polygon */}
      <polygon points={polygon} fill="rgba(139,92,246,0.15)" stroke="rgba(139,92,246,0.6)" strokeWidth="1.5" />
      {/* Data points */}
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={2.5} fill={p.color} />
      ))}
      {/* Labels */}
      {points.map((p, i) => (
        <text
          key={i}
          x={p.lx}
          y={p.ly}
          textAnchor="middle"
          dominantBaseline="central"
          fill={isDark ? '#71717a' : '#a1a1aa'}
          fontSize="9"
          fontWeight="600"
        >
          {p.label}
        </text>
      ))}
    </svg>
  );
}

// SHARE POPOVER COMPONENT
// ═════════════════════════════════════════════════════════

function SharePopover({
  title,
  url,
  isDark,
  onClose,
}: {
  title: string;
  url: string;
  isDark: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const fullUrl = `https://prismer.cloud${url}`;
  const tweetText = encodeURIComponent(`${title} - @PrismerCloud`);
  return (
    <div
      className={`absolute right-0 top-full mt-1 z-50 p-3 rounded-lg shadow-xl border ${isDark ? 'bg-zinc-900 border-white/10' : 'bg-white border-zinc-200'}`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex flex-col gap-2 min-w-[180px]">
        <button
          onClick={() => {
            navigator.clipboard.writeText(fullUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className={`flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${isDark ? 'text-zinc-300 hover:bg-white/5' : 'text-zinc-700 hover:bg-zinc-100'}`}
        >
          {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}{' '}
          {copied ? t('evolution.common.copied') : t('evolution.common.copyLink')}
        </button>
        <a
          href={`https://twitter.com/intent/tweet?text=${tweetText}&url=${encodeURIComponent(fullUrl)}`}
          target="_blank"
          rel="noopener noreferrer"
          className={`flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${isDark ? 'text-zinc-300 hover:bg-white/5' : 'text-zinc-700 hover:bg-zinc-100'}`}
          onClick={onClose}
        >
          <ExternalLink className="w-3 h-3" /> {t('evolution.common.shareToX')}
        </a>
        <a
          href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(fullUrl)}`}
          target="_blank"
          rel="noopener noreferrer"
          className={`flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${isDark ? 'text-zinc-300 hover:bg-white/5' : 'text-zinc-700 hover:bg-zinc-100'}`}
          onClick={onClose}
        >
          <ExternalLink className="w-3 h-3" /> {t('evolution.common.shareToLinkedIn')}
        </a>
      </div>
    </div>
  );
}

// GENE DETAIL MODAL COMPONENT
// ═════════════════════════════════════════════════════════

function GeneDetailModal({
  gene,
  loading,
  isDark,
  onClose,
  onImport,
  onFork,
  onAgentClick,
  isAuthenticated,
}: {
  gene: PublicGene | null;
  loading: boolean;
  isDark: boolean;
  onClose: () => void;
  onImport: (id: string) => void;
  onFork: (id: string) => void;
  onAgentClick: (name: string) => void;
  isAuthenticated: boolean;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [capsules, setCapsules] = useState<
    { outcome: string; score: number | null; agentName: string; createdAt: string }[]
  >([]);
  const [lineage, setLineage] = useState<{
    gene: LineageGene;
    ancestors: LineageGene[];
    descendants: LineageGene[];
    stats: { totalVariants: number; totalExecutions: number; maxGeneration: number };
  } | null>(null);

  useEffect(() => {
    if (!gene) return;
    const geneId = gene.gene_id || gene.id || '';
    if (!geneId) return;
    fetch(`/api/im/evolution/public/genes/${geneId}/capsules?limit=10`)
      .then((r) => r.json())
      .then((d) => setCapsules(d.data || []))
      .catch(() => setCapsules([]));
    fetch(`/api/im/evolution/public/genes/${geneId}/lineage`)
      .then((r) => r.json())
      .then((d) => setLineage(d.data || null))
      .catch(() => setLineage(null));
  }, [gene]);

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
        <div className="relative">
          <Loader2 className="w-8 h-8 animate-spin text-violet-400" />
        </div>
      </div>
    );
  }

  if (!gene) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
        <div
          className={`relative max-w-sm w-full rounded-2xl p-8 text-center ${isDark ? 'bg-zinc-900 border border-white/10' : 'bg-white border border-zinc-200 shadow-xl'}`}
          onClick={(e) => e.stopPropagation()}
        >
          <Dna className={`w-8 h-8 mx-auto mb-3 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />
          <p className={`text-sm mb-4 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            {t('evolution.legacy.geneNotFound')}
          </p>
          <button
            onClick={onClose}
            className={`text-sm font-medium px-4 py-2 rounded-lg ${isDark ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'}`}
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    );
  }

  const cat = CAT_COLORS[gene.category || ''] || CAT_COLORS.repair;
  const totalUses = (gene.success_count || 0) + (gene.failure_count || 0);
  const successRate = totalUses > 0 ? Math.round(((gene.success_count || 0) / totalUses) * 100) : 0;
  const pqi = computePQI(gene, totalUses);
  const signals = getSignals(gene);
  const steps = getSteps(gene);
  const id = getGeneId(gene);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop */
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className={`relative max-w-lg w-full max-h-[85vh] overflow-y-auto rounded-2xl p-6 ${isDark ? 'bg-zinc-900 border border-white/10' : 'bg-white border border-zinc-200 shadow-xl'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className={`absolute top-4 right-4 p-1 rounded-lg transition-colors ${isDark ? 'text-zinc-500 hover:text-white hover:bg-white/10' : 'text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100'}`}
        >
          <X className="w-4 h-4" />
        </button>

        {/* Header badges */}
        <div className="flex items-center gap-2 mb-2">
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${cat.bg} ${cat.text} ${cat.border}`}
          >
            {categoryLabel(gene.category, t)}
          </span>
          {gene.is_seed && (
            <span
              className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${isDark ? 'bg-violet-500/15 text-violet-300' : 'bg-violet-100 text-violet-600'}`}
            >
              {t('evolution.common.seed')}
            </span>
          )}
          {totalUses > 0 && (
            <span
              className={`text-[10px] font-bold tabular-nums ${pqi >= 70 ? 'text-emerald-400' : pqi >= 40 ? 'text-amber-400' : 'text-zinc-500'}`}
            >
              PQI {pqi}
            </span>
          )}
        </div>

        {/* Title */}
        <h2 className={`text-xl font-bold mb-1 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
          {gene.title || signals[0] || t('evolution.common.untitled')}
        </h2>
        <p className={`text-sm leading-relaxed mb-4 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
          {gene.description || ''}
        </p>

        {/* Stats grid */}
        <div className={`grid grid-cols-3 gap-3 mb-4 p-3 rounded-lg ${isDark ? 'bg-zinc-800/50' : 'bg-zinc-50'}`}>
          <div className="text-center">
            <p className={`text-lg font-bold tabular-nums ${isDark ? 'text-white' : 'text-zinc-900'}`}>
              {totalUses.toLocaleString()}
            </p>
            <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
              {t('evolution.common.executions')}
            </p>
          </div>
          <div className="text-center">
            <p
              className={`text-lg font-bold tabular-nums ${successRate >= 70 ? 'text-emerald-400' : successRate >= 40 ? 'text-amber-400' : 'text-red-400'}`}
            >
              {successRate}%
            </p>
            <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
              {t('evolution.common.successRate')}
            </p>
          </div>
          <div className="text-center">
            <p className={`text-lg font-bold tabular-nums ${isDark ? 'text-white' : 'text-zinc-900'}`}>
              {gene.used_by_count || 0}
            </p>
            <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
              {t('evolution.common.agents')}
            </p>
          </div>
        </div>

        {/* Success rate bar */}
        {totalUses > 0 && (
          <div className="flex items-center gap-2 mb-4">
            <div className={`flex-1 h-2 rounded-full overflow-hidden ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`}>
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400"
                style={{ width: `${successRate}%` }}
              />
            </div>
            <span className={`text-xs font-semibold tabular-nums ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
              {successRate}%
            </span>
          </div>
        )}

        {/* Signals */}
        {signals.length > 0 && (
          <div className="mb-4">
            <h4
              className={`text-xs font-bold uppercase tracking-wider mb-2 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
            >
              {t('evolution.common.signals')}
            </h4>
            <div className="flex flex-wrap gap-1">
              {signals.map((sig) => (
                <span
                  key={sig}
                  className={`text-[10px] px-2 py-1 rounded font-mono ${isDark ? 'bg-zinc-800/60 text-zinc-400' : 'bg-zinc-100 text-zinc-500'}`}
                >
                  {sig}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Strategy steps */}
        {steps.length > 0 && (
          <div className="mb-4">
            <h4
              className={`text-xs font-bold uppercase tracking-wider mb-2 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
            >
              {t('evolution.common.strategy')} ({steps.length})
            </h4>
            <div className="space-y-1.5">
              {steps.map((step, i) => (
                <div key={i} className="flex gap-2">
                  <span
                    className={`text-xs font-semibold tabular-nums shrink-0 w-5 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                  >
                    {i + 1}.
                  </span>
                  <p className={`text-xs leading-relaxed ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>{step}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Preconditions */}
        {gene.preconditions && gene.preconditions.length > 0 && (
          <div className="mb-4">
            <h4
              className={`text-xs font-bold uppercase tracking-wider mb-2 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
            >
              {t('evolution.common.preconditions')}
            </h4>
            <div className="space-y-1">
              {gene.preconditions.map((p: string, i: number) => (
                <p key={i} className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                  {p}
                </p>
              ))}
            </div>
          </div>
        )}

        {/* Recent Executions (mini timeline) */}
        {capsules.length > 0 && (
          <div className="mt-4">
            <h4
              className={`text-xs font-bold uppercase tracking-wider mb-2 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
            >
              {t('evolution.common.recentExecutions')}
            </h4>
            <div className="flex gap-1 mb-2">
              {capsules.map((c, i) => (
                <div
                  key={i}
                  className={`w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold ${c.outcome === 'success' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}
                  title={`${c.outcome} ${c.score != null ? `(${Math.round(c.score * 100)}%)` : ''} by ${c.agentName}`}
                >
                  {c.outcome === 'success' ? '\u2713' : '\u2717'}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Lineage Tree Visualization */}
        {lineage && lineage.stats.totalVariants > 1 && (
          <LineageTree
            gene={lineage.gene}
            ancestors={lineage.ancestors}
            descendants={lineage.descendants}
            isDark={isDark}
            onGeneClick={(geneId) => {
              if (geneId !== id) {
                // Could navigate to another gene - for now just copy ID
                navigator.clipboard.writeText(geneId).catch(() => {});
              }
            }}
          />
        )}
        {/* Lineage stats fallback (when tree has only 1 node) */}
        {lineage && lineage.stats.totalVariants === 1 && lineage.stats.totalExecutions > 0 && (
          <div
            className={`mt-4 p-3 rounded-lg border ${isDark ? 'border-white/5 bg-zinc-800/30' : 'border-zinc-200/50 bg-zinc-50'}`}
          >
            <h4
              className={`text-xs font-bold uppercase tracking-wider mb-2 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
            >
              {t('evolution.common.lineage')}
            </h4>
            <div className={`flex gap-4 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              <span>{t('evolution.common.originalGene')}</span>
              <span>
                {t('evolution.common.totalExecutions', { count: lineage.stats.totalExecutions.toLocaleString() })}
              </span>
            </div>
          </div>
        )}

        {/* Attribution */}
        <div className={`pt-4 border-t ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}>
          <div className="flex items-center justify-between mb-3">
            <div>
              {(gene.published_by || gene.created_by) && (
                <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                  {t('evolution.common.publishedBy')}{' '}
                  <button
                    onClick={() => onAgentClick(gene.published_by || gene.created_by || '')}
                    className={`font-semibold underline decoration-dotted ${isDark ? 'text-cyan-400 hover:text-cyan-300' : 'text-cyan-600 hover:text-cyan-500'}`}
                  >
                    {gene.published_by || gene.created_by}
                  </button>
                </p>
              )}
              {gene.used_by_count != null && gene.used_by_count > 0 && (
                <p className={`text-xs mt-0.5 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                  {t('evolution.common.adoptedByAgents', {
                    count: gene.used_by_count,
                    suffix: gene.used_by_count > 1 ? 's' : '',
                  })}
                </p>
              )}
            </div>
            <button
              onClick={handleCopy}
              className={`flex items-center gap-1 text-[10px] font-mono transition-colors ${isDark ? 'text-zinc-600 hover:text-zinc-400' : 'text-zinc-400 hover:text-zinc-600'}`}
            >
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />} {id.slice(0, 12)}
              ...
            </button>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => onImport(id)}
              className="flex-1 text-sm font-semibold px-4 py-2.5 rounded-lg transition-all bg-gradient-to-r from-violet-600 to-violet-500 text-white hover:from-violet-500 hover:to-violet-400 shadow-lg shadow-violet-500/20"
            >
              {t('evolution.common.installGene')}
            </button>
            <button
              onClick={() => onFork(id)}
              className={`flex items-center gap-1.5 text-sm font-semibold px-4 py-2.5 rounded-lg transition-all ${isDark ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'}`}
            >
              <GitFork className="w-3.5 h-3.5" /> {t('evolution.common.fork')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
