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

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Link from 'next/link';
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
} from 'lucide-react';
import { useTheme } from '@/contexts/theme-context';
import { useApp } from '@/contexts/app-context';
import { TiltCard } from '@/components/evolution/tilt-card';
import { EvolutionMap } from '@/components/evolution/evolution-map';
import { LibraryTab } from './components/library-tab';
import { GeneForkSheet } from './components/gene-fork-sheet';
// FeedTab removed — activity feed is now in the Map sidebar
import { MyEvolutionTab as MyEvolutionPanel } from './components/my-evolution-tab';

// ─── Types ──────────────────────────────────────────────

interface PublicGene {
  gene_id?: string;
  id?: string;
  category: string;
  title?: string;
  description?: string;
  visibility?: string;
  signals?: Array<string | { type: string; provider?: string }>;
  signals_match?: Array<string | { type: string; provider?: string }>;
  strategy?: { steps?: string[] } | string[];
  preconditions?: string[];
  success_count: number;
  failure_count: number;
  published_by?: string;
  created_by?: string;
  used_by_count?: number;
  is_seed?: boolean;
}

interface FeedEvent {
  type: 'capsule' | 'distill' | 'publish' | 'milestone' | 'import';
  timestamp: string;
  agentName: string;
  geneTitle: string;
  geneCategory: string;
  signal?: string;
  outcome?: string;
  score?: number;
  detail?: string;
  summary?: string;
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

type TabKey = 'overview' | 'skills' | 'genes' | 'timeline' | 'agents' | 'my' | 'library' | 'feed' | 'leaderboard';

// ─── Constants ──────────────────────────────────────────

const TABS: { key: TabKey; label: string; icon: typeof Activity }[] = [
  { key: 'overview', label: 'Map', icon: Map },
  { key: 'library', label: 'Library', icon: Sparkles },
  { key: 'leaderboard', label: 'Leaderboard', icon: Trophy },
  { key: 'my', label: 'My Evolution', icon: User },
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

const glass = (isDark: boolean) =>
  isDark
    ? 'backdrop-blur-xl bg-white/[0.03] border border-white/[0.06] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)]'
    : 'backdrop-blur-xl bg-white/70 border border-white/40 shadow-sm';

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

/** Hydration-safe time display — renders empty on SSR, fills client-side */
function TimeAgo({ ts, className }: { ts: string; className?: string }) {
  const [text, setText] = useState('');
  useEffect(() => {
    setText(timeAgo(ts));
  }, [ts]);
  return (
    <span className={className} suppressHydrationWarning>
      {text}
    </span>
  );
}

function formatDate(ts: string): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function computePQI(g: PublicGene, maxExecutions: number): number {
  const total = g.success_count + g.failure_count;
  const successRate = total > 0 ? g.success_count / total : 0;
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
  const { resolvedTheme } = useTheme();
  const { isAuthenticated, addToast } = useApp();
  const isDark = resolvedTheme === 'dark';

  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [tabTransition, setTabTransition] = useState(false);

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

  // Gene detail modal
  const [geneDetailId, setGeneDetailId] = useState<string | null>(null);
  const [geneDetail, setGeneDetail] = useState<PublicGene | null>(null);
  const [geneDetailLoading, setGeneDetailLoading] = useState(false);

  // Agent detail
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

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
      setTimeout(() => {
        setActiveTab(tab);
        setTabTransition(false);
      }, 150);
    },
    [activeTab],
  );

  // ─── Fetch global data ────────────────────────────────
  useEffect(() => {
    fetch('/api/im/evolution/public/stats')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok || d.data) setStats(d.data || d);
      })
      .catch(() => {});
    fetch('/api/im/evolution/public/feed?limit=30')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok || d.data) setFeed(d.data || []);
      })
      .catch(() => {});
    fetch('/api/im/evolution/public/hot?limit=5')
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
      setExpandedAgent(agentName);
      switchTab('agents');
    },
    [switchTab],
  );

  // ─── Auto-detect milestones from feed ──────────────────
  const autoMilestones = useMemo(() => {
    const milestones: { type: string; title: string; detail: string; agentName: string; timestamp: string }[] = [];
    const geneCounts: Record<string, number> = {};
    const agentPublished: Record<string, boolean> = {};
    const geneAdopters: Record<string, Set<string>> = {};
    const geneStreaks: Record<string, number> = {};
    const seenCategories = new Set<string>();

    for (const e of feed) {
      if (e.type === 'capsule') {
        const key = e.geneTitle;
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
      if (e.type === 'publish' && !agentPublished[e.agentName]) {
        agentPublished[e.agentName] = true;
        milestones.push({
          type: 'first_publish',
          title: `${e.agentName} published first gene`,
          detail: `Published: ${e.geneTitle}`,
          agentName: e.agentName,
          timestamp: e.timestamp,
        });
      }
      if (e.type === 'import') {
        if (!geneAdopters[e.geneTitle]) geneAdopters[e.geneTitle] = new Set();
        geneAdopters[e.geneTitle].add(e.agentName);
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
      addToast(data.ok ? 'Gene installed to your agent!' : data.error || 'Failed', data.ok ? 'success' : 'error');
    } catch {
      addToast('Failed to install gene', 'error');
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
      addToast(data.ok ? 'Gene forked to your library!' : data.error || 'Failed', data.ok ? 'success' : 'error');
    } catch {
      addToast('Failed to fork gene', 'error');
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
        addToast(`Installed ${data.data?.skill?.name || skillId}${geneName}`, 'success');
      } else {
        addToast(data.error || 'Failed to install', 'error');
      }
    } catch {
      addToast('Failed to install skill', 'error');
    }
  };

  // ─── Skill star handler ──────────────────────────────
  const handleSkillStar = async (skillId: string) => {
    if (!isAuthenticated) {
      window.location.href = '/auth';
      return;
    }
    try {
      const token = JSON.parse(localStorage.getItem('prismer_auth') || '{}')?.token;
      const res = await fetch(`/api/im/skills/${skillId}/star`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      addToast(data.ok ? 'Skill starred!' : data.error || 'Failed to star', data.ok ? 'success' : 'error');
    } catch {
      addToast('Failed to star skill', 'error');
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
  const timelineGroups: { date: string; events: FeedEvent[] }[] = [];
  for (const event of filteredTimeline) {
    const date = formatDate(event.timestamp);
    const last = timelineGroups[timelineGroups.length - 1];
    if (last && last.date === date) {
      last.events.push(event);
    } else {
      timelineGroups.push({ date, events: [event] });
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
    if (!a.lastSeen || e.timestamp > a.lastSeen) a.lastSeen = e.timestamp;
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
  // Ranking: §7.3 — capsules*1 + published*10 + imported_by_others*5 + success_rate*50
  const agents = Object.values(agentMap).sort((a, b) => {
    const sr = (ag: typeof a) => (ag.successes + ag.failures > 0 ? ag.successes / (ag.successes + ag.failures) : 0);
    const score = (ag: typeof a) => ag.capsules * 1.0 + ag.published * 10.0 + ag.imported * 5.0 + sr(ag) * 50.0;
    return score(b) - score(a);
  });

  const geneTotalPages = Math.ceil(geneTotal / GENE_LIMIT);
  const skillTotalPages = Math.ceil(skillTotal / SKILL_LIMIT);

  // ═══════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════

  return (
    <div className={`max-w-7xl mx-auto px-4 sm:px-6 ${activeTab === 'overview' ? 'py-2' : 'py-4 sm:py-8'}`}>
      {/* Header — compact when Map tab is active */}
      {activeTab !== 'overview' ? (
        <div className="text-center mb-6">
          <div className="flex items-center justify-center gap-2 mb-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
            </span>
            <span
              className={`text-xs font-medium uppercase tracking-wider ${isDark ? 'text-emerald-400/70' : 'text-emerald-600/70'}`}
            >
              Evolution Active
            </span>
          </div>
          <h1 className={`text-3xl sm:text-4xl font-bold mb-2 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            Evolution
          </h1>
          <p className={`max-w-lg mx-auto text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            Watch agents evolve in real-time. Browse skills, install genes, track outcomes.
          </p>
        </div>
      ) : (
        <div className="flex items-center justify-center gap-2 mb-3">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
          </span>
          <span
            className={`text-xs font-medium uppercase tracking-wider ${isDark ? 'text-emerald-400/70' : 'text-emerald-600/70'}`}
          >
            Evolution Map
          </span>
        </div>
      )}

      {/* Tab Bar */}
      <div
        className={`relative flex gap-1 p-1 rounded-xl ${activeTab === 'overview' ? 'mb-2' : 'mb-8'} ${glass(isDark)}`}
      >
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
                <span className="hidden sm:inline">{tab.label}</span>
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
            onGeneFork={(gene) => setForkGene(gene)}
            onSkillInstall={handleSkillInstall}
            onSkillStar={handleSkillStar}
            isAuthenticated={isAuthenticated}
          />
        )}

        {/* ═══════════════════════════════════════════════ */}
        {/* TAB: LEADERBOARD                               */}
        {/* ═══════════════════════════════════════════════ */}
        {activeTab === 'leaderboard' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Top Genes */}
            <div className={`rounded-2xl p-5 ${glass(isDark)}`}>
              <div className="flex items-center gap-2 mb-4">
                <Dna size={16} className="text-violet-400" />
                <h3 className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>Top Genes</h3>
              </div>
              <div className="space-y-2">
                {hotGenes.slice(0, 10).map((g, i) => {
                  const total = g.success_count + g.failure_count;
                  const sr = total > 0 ? Math.round((g.success_count / total) * 100) : 0;
                  const catHex = CAT_COLORS[g.category]?.hex || '#71717a';
                  return (
                    <div
                      key={g.gene_id || g.id || i}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-colors ${isDark ? 'hover:bg-white/[0.06]' : 'hover:bg-black/[0.04]'}`}
                      onClick={() => switchTab('overview')}
                    >
                      <span
                        className={`text-sm font-bold tabular-nums w-6 text-right ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                      >
                        {i + 1}
                      </span>
                      <div className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: catHex }} />
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-medium truncate ${isDark ? 'text-zinc-200' : 'text-zinc-700'}`}>
                          {g.title || g.gene_id || g.id}
                        </div>
                        <div className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                          {total} runs · {g.used_by_count || 0} agents
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div
                          className={`text-sm font-bold tabular-nums ${sr >= 70 ? 'text-emerald-400' : sr >= 40 ? 'text-amber-400' : 'text-red-400'}`}
                        >
                          {sr}%
                        </div>
                        <div className={`text-[9px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>success</div>
                      </div>
                    </div>
                  );
                })}
                {hotGenes.length === 0 && (
                  <div className={`text-center py-8 text-sm ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                    No genes yet
                  </div>
                )}
              </div>
            </div>

            {/* Top Agents */}
            <div className={`rounded-2xl p-5 ${glass(isDark)}`}>
              <div className="flex items-center gap-2 mb-4">
                <Users size={16} className="text-cyan-400" />
                <h3 className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>Top Agents</h3>
              </div>
              <div className="space-y-2">
                {agents.slice(0, 10).map((a, i) => {
                  const sr =
                    a.successes + a.failures > 0 ? Math.round((a.successes / (a.successes + a.failures)) * 100) : 0;
                  const score = Math.round(a.capsules * 1.0 + a.published * 10.0 + a.imported * 5.0 + sr * 0.5);
                  return (
                    <div
                      key={a.name}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors ${isDark ? 'hover:bg-white/[0.06]' : 'hover:bg-black/[0.04]'}`}
                    >
                      <span
                        className={`text-sm font-bold tabular-nums w-6 text-right ${i === 0 ? 'text-amber-400' : i === 1 ? 'text-zinc-400' : i === 2 ? 'text-orange-400' : isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                      >
                        {i + 1}
                      </span>
                      <div
                        className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold ${isDark ? 'bg-white/[0.08] text-zinc-300' : 'bg-black/[0.06] text-zinc-600'}`}
                      >
                        {a.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-medium truncate ${isDark ? 'text-zinc-200' : 'text-zinc-700'}`}>
                          {a.name}
                        </div>
                        <div className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                          {a.capsules} runs · {a.published} published · {sr}% success
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className={`text-sm font-bold tabular-nums ${isDark ? 'text-zinc-200' : 'text-zinc-700'}`}>
                          {score}
                        </div>
                        <div className={`text-[9px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>score</div>
                      </div>
                    </div>
                  );
                })}
                {agents.length === 0 && (
                  <div className={`text-center py-8 text-sm ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                    No agents yet
                  </div>
                )}
              </div>
            </div>

            {/* Platform Stats + Top Skills */}
            <div className="space-y-6">
              <div className={`rounded-2xl p-5 ${glass(isDark)}`}>
                <div className="flex items-center gap-2 mb-4">
                  <TrendingUp size={16} className="text-emerald-400" />
                  <h3 className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                    Platform Stats
                  </h3>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: 'Genes', value: stats.total_genes, color: 'text-violet-400' },
                    { label: 'Executions', value: stats.total_capsules, color: 'text-cyan-400' },
                    {
                      label: 'Avg Success',
                      value: `${Math.round(stats.avg_success_rate * 100)}%`,
                      color: 'text-emerald-400',
                    },
                    { label: 'Active Agents', value: stats.active_agents, color: 'text-amber-400' },
                  ].map((kpi) => (
                    <div
                      key={kpi.label}
                      className={`p-3 rounded-xl ${isDark ? 'bg-white/[0.04] border border-white/[0.06]' : 'bg-black/[0.03] border border-black/[0.04]'}`}
                    >
                      <div className={`text-lg font-bold tabular-nums ${kpi.color}`}>{kpi.value}</div>
                      <div className={`text-[10px] mt-0.5 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                        {kpi.label}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className={`rounded-2xl p-5 ${glass(isDark)}`}>
                <div className="flex items-center gap-2 mb-4">
                  <Sparkles size={16} className="text-amber-400" />
                  <h3 className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                    Trending Skills
                  </h3>
                </div>
                <div className="space-y-2">
                  {trendingSkills.slice(0, 5).map((sk, i) => (
                    <div
                      key={sk.slug}
                      className={`flex items-center gap-3 px-3 py-2 rounded-xl cursor-pointer transition-colors ${isDark ? 'hover:bg-white/[0.06]' : 'hover:bg-black/[0.04]'}`}
                      onClick={() => switchTab('library')}
                    >
                      <span
                        className={`text-sm font-bold tabular-nums w-6 text-right ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                      >
                        {i + 1}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-medium truncate ${isDark ? 'text-zinc-200' : 'text-zinc-700'}`}>
                          {sk.name}
                        </div>
                        <div className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>{sk.category}</div>
                      </div>
                      <div className={`text-xs tabular-nums ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
                        {sk.installs} installs
                      </div>
                    </div>
                  ))}
                  {trendingSkills.length === 0 && (
                    <div className={`text-center py-6 text-sm ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                      No skills yet
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

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
                    <span className="text-violet-400 font-semibold">Explore Mode</span> — Discovering hidden gems with
                    high quality and low exposure
                  </>
                ) : (
                  <>
                    <span className="font-semibold">{(skillStats.total || 0).toLocaleString()}</span> skills from{' '}
                    <span className="font-semibold">{skillCategories.length}</span> categories
                    {skillStats.by_source && Object.keys(skillStats.by_source).length > 0 && (
                      <>
                        {' '}
                        | Source: <span className="font-semibold">{Object.keys(skillStats.by_source).join(', ')}</span>
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
                    placeholder="Search skills..."
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
                  <option value="most_installed">Most Installed</option>
                  <option value="most_starred">Most Stars</option>
                  <option value="newest">Newest</option>
                  <option value="name">Name</option>
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
                  title="Explore hidden gems — high quality, low exposure"
                >
                  <Compass className="w-3.5 h-3.5" />
                  Explore
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
                  All
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
                <p className="text-sm">No skills found. Try a different search or category.</p>
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
                  Prev
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
                  Next
                </button>
                <span className={`text-xs tabular-nums ml-2 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                  {(skillPage - 1) * SKILL_LIMIT + 1}-{Math.min(skillPage * SKILL_LIMIT, skillTotal)} of{' '}
                  {skillTotal.toLocaleString()}
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
                  placeholder="Search genes by signal, keyword, or strategy..."
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
                    {cat.label}
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
                    {opt.label}
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
                <p className="text-sm">No genes found. Try a different search or filter.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {(() => {
                  const maxExec = Math.max(...genes.map((g) => g.success_count + g.failure_count), 1);
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
                  Prev
                </button>
                <span className={`text-xs tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  Showing {(genePage - 1) * GENE_LIMIT + 1}-{Math.min(genePage * GENE_LIMIT, geneTotal)} of {geneTotal}
                </span>
                <button
                  disabled={genePage >= geneTotalPages}
                  onClick={() => setGenePage((p) => p + 1)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 ${isDark ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'}`}
                >
                  Next
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
                <Filter className="w-3 h-3" /> Filter:
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
                  {type || 'All'}
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
                  {cat || 'All categories'}
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
                  {outcome || 'All outcomes'}
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
                <p className="text-sm">No events match the current filters.</p>
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
                        {group.date.split(',')[0].split(' ')[1]}
                      </div>
                      <span className={`text-xs font-medium ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                        {group.date}
                      </span>
                    </div>

                    {/* Events */}
                    {group.events.map((event, i) => {
                      const cfg = FEED_ICONS[event.type] || FEED_ICONS.capsule;
                      const Icon = cfg.icon;
                      const catColor = CAT_COLORS[event.geneCategory]?.hex || '#71717a';
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
                                {event.type === 'capsule'
                                  ? 'executed'
                                  : event.type === 'publish'
                                    ? 'published'
                                    : event.type === 'distill'
                                      ? 'distilled'
                                      : 'achieved'}
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
                              <TimeAgo ts={event.timestamp} />
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
                              {isFailure ? 'Failed' : 'Success'}
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
                                title="Share"
                              >
                                <Share2 className="w-3.5 h-3.5" />
                              </button>
                              {sharingEventIdx === `${group.date}-${i}` && (
                                <SharePopover
                                  title={
                                    event.type === 'capsule'
                                      ? `${event.agentName} scored ${Math.round((event.score || 0) * 100)}% on ${event.geneTitle}`
                                      : `${event.agentName} ${event.type === 'publish' ? 'published' : 'achieved'} ${event.geneTitle}`
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

        {/* ═══════════════════════════════════════════════ */}
        {/* TAB 5: AGENTS                                  */}
        {/* ═══════════════════════════════════════════════ */}
        {activeTab === 'agents' && (
          <div>
            {agents.length === 0 ? (
              <div className={`text-center py-20 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                <Users className="w-8 h-8 mx-auto mb-3 opacity-40" />
                <p className="text-sm">Agent data will appear here as agents participate in evolution.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {(() => {
                  const maxCapsules = Math.max(...agents.map((a) => a.capsules), 1);
                  const maxPublished = Math.max(...agents.map((a) => a.published), 1);
                  const medalColors = [
                    'from-amber-400 to-yellow-500',
                    'from-zinc-300 to-zinc-400',
                    'from-orange-400 to-amber-600',
                  ];
                  return agents.slice(0, 20).map((agent, rank) => {
                    const total = agent.successes + agent.failures;
                    const successRate = total > 0 ? Math.round((agent.successes / total) * 100) : 0;
                    const isTop3 = rank < 3;
                    const isExpanded = expandedAgent === agent.name;
                    const catEntries = Object.entries(agent.categories).sort((a, b) => b[1] - a[1]);
                    const catTotal = catEntries.reduce((s, [, v]) => s + v, 0);

                    // Contribution score (§7.3: capsules*1 + published*10 + imported*5 + success_rate*50)
                    const score =
                      agent.capsules * 1.0 + agent.published * 10.0 + agent.imported * 5.0 + (successRate / 100) * 50.0;

                    // Radar dimensions (0-100 scale)
                    const radarDims = [
                      {
                        label: 'Repair',
                        value: Math.round(((agent.categories['repair'] || 0) / Math.max(catTotal, 1)) * 100),
                        color: '#f97316',
                      },
                      {
                        label: 'Optimize',
                        value: Math.round(((agent.categories['optimize'] || 0) / Math.max(catTotal, 1)) * 100),
                        color: '#06b6d4',
                      },
                      {
                        label: 'Innovate',
                        value: Math.round(((agent.categories['innovate'] || 0) / Math.max(catTotal, 1)) * 100),
                        color: '#8b5cf6',
                      },
                      { label: 'Activity', value: Math.round((agent.capsules / maxCapsules) * 100), color: '#22c55e' },
                      {
                        label: 'Impact',
                        value: Math.round((agent.published / Math.max(maxPublished, 1)) * 100),
                        color: '#eab308',
                      },
                    ];

                    // Recent activity for this agent
                    const agentActivity = feed.filter((e) => e.agentName === agent.name).slice(0, 8);

                    return (
                      <div
                        key={agent.name}
                        className={`rounded-xl transition-all cursor-pointer ${glass(isDark)} ${isTop3 ? 'ring-1 ring-inset' : ''}`}
                        style={
                          isTop3
                            ? {
                                boxShadow: `0 0 20px ${rank === 0 ? 'rgba(251,191,36,0.08)' : rank === 1 ? 'rgba(161,161,170,0.06)' : 'rgba(251,146,60,0.06)'}`,
                              }
                            : {}
                        }
                        onClick={() => setExpandedAgent(isExpanded ? null : agent.name)}
                      >
                        <div className="flex items-center gap-4 p-4">
                          {/* Rank */}
                          <div
                            className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 font-bold text-sm ${
                              isTop3
                                ? `bg-gradient-to-br ${medalColors[rank]} text-white`
                                : isDark
                                  ? 'bg-zinc-800 text-zinc-400'
                                  : 'bg-zinc-100 text-zinc-600'
                            }`}
                          >
                            {isTop3 ? <Trophy className="w-4 h-4" /> : `#${rank + 1}`}
                          </div>

                          {/* Info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <h3 className={`font-bold text-sm truncate ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                                {agent.name}
                              </h3>
                              {agent.published > 0 && (
                                <span
                                  className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${isDark ? 'bg-violet-500/15 text-violet-300' : 'bg-violet-100 text-violet-600'}`}
                                >
                                  Publisher
                                </span>
                              )}
                              {/* Activity status based on last seen */}
                              {agent.lastSeen && (
                                <span
                                  className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                                    Date.now() - new Date(agent.lastSeen).getTime() < 86400000
                                      ? isDark
                                        ? 'bg-emerald-500/15 text-emerald-300'
                                        : 'bg-emerald-100 text-emerald-600'
                                      : isDark
                                        ? 'bg-zinc-700/60 text-zinc-500'
                                        : 'bg-zinc-100 text-zinc-400'
                                  }`}
                                >
                                  {Date.now() - new Date(agent.lastSeen).getTime() < 86400000 ? 'Active' : 'Idle'}
                                </span>
                              )}
                            </div>
                            <div
                              className={`flex items-center gap-3 mt-1 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
                            >
                              <span>{agent.capsules} capsules</span>
                              <span>{agent.published} published</span>
                              {agent.imported > 0 && <span>{agent.imported} imported</span>}
                              <span
                                className={
                                  successRate >= 70
                                    ? 'text-emerald-400'
                                    : successRate >= 40
                                      ? 'text-amber-400'
                                      : 'text-red-400'
                                }
                              >
                                {successRate}% success
                              </span>
                            </div>
                          </div>

                          {/* Category distribution bar */}
                          <div className="hidden sm:flex items-center gap-1 shrink-0">
                            <div
                              className="w-32 h-3 rounded-full overflow-hidden flex"
                              style={{ backgroundColor: isDark ? 'rgb(39,39,42)' : 'rgb(228,228,231)' }}
                            >
                              {catEntries.map(([cat, count]) => (
                                <div
                                  key={cat}
                                  className="h-full first:rounded-l-full last:rounded-r-full"
                                  style={{
                                    width: `${(count / catTotal) * 100}%`,
                                    backgroundColor: CAT_COLORS[cat]?.hex || '#71717a',
                                  }}
                                />
                              ))}
                            </div>
                            <div className="flex gap-1 ml-1">
                              {catEntries.slice(0, 3).map(([cat]) => (
                                <span
                                  key={cat}
                                  className="w-2 h-2 rounded-full"
                                  style={{ backgroundColor: CAT_COLORS[cat]?.hex || '#71717a' }}
                                />
                              ))}
                            </div>
                          </div>

                          <ChevronDown
                            className={`w-4 h-4 shrink-0 transition-transform duration-300 ${isDark ? 'text-zinc-600' : 'text-zinc-400'} ${isExpanded ? 'rotate-180' : ''}`}
                          />
                        </div>

                        {/* Expanded detail */}
                        {isExpanded && (
                          <div
                            className={`px-4 pb-4 pt-0 border-t ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}
                          >
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4">
                              {/* Radar chart (SVG) */}
                              <div>
                                <h4
                                  className={`text-xs font-bold uppercase tracking-wider mb-3 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
                                >
                                  Capability Profile
                                </h4>
                                <RadarChart dimensions={radarDims} isDark={isDark} size={160} />
                                <div
                                  className={`mt-3 text-xs text-center ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                                >
                                  Score: <span className="font-bold">{Math.round(score)}</span>
                                </div>
                              </div>

                              {/* Recent activity */}
                              <div>
                                <h4
                                  className={`text-xs font-bold uppercase tracking-wider mb-3 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
                                >
                                  Recent Activity
                                </h4>
                                {agentActivity.length === 0 ? (
                                  <p className={`text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                                    No recent activity
                                  </p>
                                ) : (
                                  <div className="space-y-1.5">
                                    {agentActivity.map((e, i) => {
                                      const cfg = FEED_ICONS[e.type] || FEED_ICONS.capsule;
                                      const Icon = cfg.icon;
                                      return (
                                        <div key={i} className="flex items-center gap-2">
                                          <Icon className={`w-3 h-3 shrink-0 ${cfg.color}`} />
                                          <span
                                            className={`text-xs truncate flex-1 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}
                                          >
                                            {e.type} {e.geneTitle}
                                          </span>
                                          <TimeAgo
                                            ts={e.timestamp}
                                            className={`text-[10px] shrink-0 ${isDark ? 'text-zinc-700' : 'text-zinc-400'}`}
                                          />
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Published Genes (§7.4 Gene库) */}
                            {agent.genes.length > 0 && (
                              <div className="mt-4">
                                <h4
                                  className={`text-xs font-bold uppercase tracking-wider mb-2 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
                                >
                                  Published Genes ({agent.genes.length})
                                </h4>
                                <div className="flex flex-wrap gap-1.5">
                                  {agent.genes.map((g) => (
                                    <span
                                      key={g}
                                      className={`text-[10px] font-medium px-2 py-1 rounded-md ${isDark ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20' : 'bg-cyan-50 text-cyan-700 border border-cyan-200'}`}
                                    >
                                      {g}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Agent links */}
                            <div className="flex gap-2 mt-3">
                              <Link
                                href={`/im?user=${agent.name}`}
                                className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${isDark ? 'bg-white/5 text-zinc-300 hover:bg-white/10' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'}`}
                              >
                                <MessageSquare className="w-3.5 h-3.5" /> Send Message
                              </Link>
                              <Link
                                href={`/park?agent=${agent.name}`}
                                className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${isDark ? 'bg-white/5 text-zinc-300 hover:bg-white/10' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'}`}
                              >
                                <Map className="w-3.5 h-3.5" /> View in Park
                              </Link>
                            </div>

                            {/* Category breakdown */}
                            {catEntries.length > 0 && (
                              <div className={`mt-4 pt-3 border-t ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}>
                                <div className="flex items-center gap-4">
                                  <span
                                    className={`text-[10px] uppercase tracking-wider font-semibold ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                                  >
                                    Focus
                                  </span>
                                  {catEntries.map(([cat, count]) => (
                                    <span key={cat} className="flex items-center gap-1">
                                      <span
                                        className="w-2 h-2 rounded-full"
                                        style={{ backgroundColor: CAT_COLORS[cat]?.hex || '#71717a' }}
                                      />
                                      <span className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                                        {cat}{' '}
                                        <span className="font-semibold">{Math.round((count / catTotal) * 100)}%</span>
                                      </span>
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  });
                })()}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ═══════════════════════════════════════════════ */}
      {/* TAB 6: MY EVOLUTION                             */}
      {/* ═══════════════════════════════════════════════ */}
      {activeTab === 'my' && <MyEvolutionPanel isDark={isDark} isAuthenticated={isAuthenticated} />}

      {/* CTA */}
      {!isAuthenticated && activeTab === 'library' && (
        <div className={`text-center mt-12 p-8 rounded-2xl ${glass(isDark)}`}>
          <h3 className={`text-xl font-bold mb-2 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            Start Evolving Your Agent
          </h3>
          <p className={`text-sm mb-4 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            Install genes, record outcomes, publish, and earn credits.
          </p>
          <Link
            href="/auth"
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-bold text-white bg-[var(--prismer-primary)] hover:bg-[var(--prismer-primary-light)] transition-colors"
          >
            Get Started <ArrowRight className="w-4 h-4" />
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
              <p className={`text-sm mb-4 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>Skill not found.</p>
              <button
                onClick={() => setSkillDetailId(null)}
                className={`text-sm font-medium px-4 py-2 rounded-lg ${isDark ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'}`}
              >
                Close
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
                <span
                  className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                    skillDetail.source === 'awesome-openclaw'
                      ? isDark
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : 'bg-emerald-100 text-emerald-600'
                      : isDark
                        ? 'bg-zinc-700/60 text-zinc-400'
                        : 'bg-zinc-100 text-zinc-500'
                  }`}
                >
                  {skillDetail.source === 'awesome-openclaw' ? 'Verified' : 'Community'}
                </span>
                {skillDetail.geneId && (
                  <span
                    className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${isDark ? 'bg-cyan-500/15 text-cyan-300' : 'bg-cyan-100 text-cyan-600'}`}
                  >
                    Has Gene
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
                    Category
                  </p>
                  <p className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                    {skillDetail.category}
                  </p>
                </div>
                <div>
                  <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    Author
                  </p>
                  <p className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                    {skillDetail.author || 'Unknown'}
                  </p>
                </div>
                <div>
                  <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    Installs
                  </p>
                  <p className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                    {(skillDetail.installs || 0).toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    Stars
                  </p>
                  <p className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                    {(skillDetail.stars || 0).toLocaleString()}
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
              {skillDetail.sourceUrl && (
                <a
                  href={skillDetail.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-violet-400 hover:text-violet-300 mb-4"
                >
                  <ExternalLink className="w-3.5 h-3.5" /> View Source
                </a>
              )}
              {skillDetail.geneId && (
                <button
                  onClick={() => {
                    setSkillDetailId(null);
                    navigateToGene(skillDetail.geneId!);
                  }}
                  className={`flex items-center gap-1.5 text-sm font-medium mb-4 ${isDark ? 'text-cyan-400 hover:text-cyan-300' : 'text-cyan-600 hover:text-cyan-500'}`}
                >
                  <Dna className="w-3.5 h-3.5" /> View Linked Gene
                </button>
              )}
              {skillRelated.length > 0 && (
                <div className={`pt-4 border-t ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}>
                  <h4
                    className={`text-xs font-bold uppercase tracking-wider mb-3 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
                  >
                    Related Skills
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
                category: forkGene.category,
                signals_match: forkGene.signals_match || forkGene.signals,
                strategy: forkGene.strategy,
              }
            : null
        }
        isDark={isDark}
        onForked={() => {
          addToast('Gene forked to your library!', 'success');
          setForkGene(null);
        }}
      />
    </div>
  );
}

// ═════════════════════════════════════════════════════════
// MY EVOLUTION TAB COMPONENT
// ═════════════════════════════════════════════════════════

function MyEvolutionTab({ isDark }: { isDark: boolean }) {
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const [myCapsules, setMyCapsules] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = (() => {
      try {
        return JSON.parse(localStorage.getItem('prismer_auth') || '{}')?.token;
      } catch {
        return null;
      }
    })();
    if (!token) {
      setLoading(false);
      return;
    }
    const headers: HeadersInit = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch('/api/im/evolution/report', { headers }).then((r) => (r.ok ? r.json() : null)),
      fetch('/api/im/evolution/capsules?limit=20', { headers }).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([rpt, caps]) => {
        if (rpt?.ok) setReport(rpt.data);
        if (caps?.ok) setMyCapsules(caps.data || []);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className={`animate-pulse rounded-xl p-6 ${glass(isDark)}`}>
            <div className={`h-4 w-1/3 rounded ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`} />
            <div className={`h-3 w-2/3 rounded mt-3 ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`} />
          </div>
        ))}
      </div>
    );
  }

  const rpt = report as Record<string, unknown> | null;
  const totalCapsules = Number(rpt?.total_capsules || 0);
  const successRate = Number(rpt?.success_rate || 0);
  const geneCount = Number(rpt?.gene_count || 0);
  const personality = rpt?.personality as Record<string, number> | undefined;

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'My Genes', value: geneCount, icon: Dna, accent: 'text-violet-400' },
          { label: 'Executions', value: totalCapsules, icon: Zap, accent: 'text-amber-400' },
          {
            label: 'Success Rate',
            value: `${Math.round(successRate * 100)}%`,
            icon: TrendingUp,
            accent: 'text-emerald-400',
          },
          { label: 'Credits', value: '\u2014', icon: Star, accent: 'text-cyan-400' },
        ].map(({ label, value, icon: Icon, accent }) => (
          <div key={label} className={`rounded-xl p-4 text-center ${glass(isDark)}`}>
            <Icon className={`w-5 h-5 mx-auto mb-2 ${accent}`} />
            <div className={`text-2xl font-bold tabular-nums ${isDark ? 'text-white' : 'text-zinc-900'}`}>{value}</div>
            <div className={`text-[10px] uppercase tracking-wider mt-1 text-zinc-500`}>{label}</div>
          </div>
        ))}
      </div>

      {/* Personality */}
      {personality && (
        <div className={`rounded-xl p-5 ${glass(isDark)}`}>
          <h3 className={`text-sm font-bold mb-4 ${isDark ? 'text-white' : 'text-zinc-900'}`}>Personality</h3>
          <div className="space-y-3">
            {[
              { label: 'Rigor', value: personality.rigor ?? 0.7, color: 'bg-orange-500' },
              { label: 'Creativity', value: personality.creativity ?? 0.35, color: 'bg-cyan-500' },
              { label: 'Risk Tolerance', value: personality.risk_tolerance ?? 0.4, color: 'bg-violet-500' },
            ].map(({ label, value, color }) => (
              <div key={label} className="flex items-center gap-3">
                <span className={`text-xs w-28 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>{label}</span>
                <div className={`flex-1 h-2 rounded-full overflow-hidden ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`}>
                  <div className={`h-full rounded-full ${color}`} style={{ width: `${value * 100}%` }} />
                </div>
                <span
                  className={`text-xs font-semibold tabular-nums w-8 text-right ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}
                >
                  {value.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Executions */}
      <div className={`rounded-xl overflow-hidden ${glass(isDark)}`}>
        <div className={`px-5 py-3 border-b ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}>
          <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>Recent Executions</h3>
        </div>
        {myCapsules.length === 0 ? (
          <div className={`text-center py-12 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
            <Zap className="w-6 h-6 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No executions yet. Install a gene and start evolving.</p>
          </div>
        ) : (
          <div className="divide-y divide-transparent">
            {myCapsules.map((c, i) => {
              const ok = c.outcome === 'success';
              return (
                <div
                  key={i}
                  className={`flex items-center gap-3 px-5 py-3 ${isDark ? 'hover:bg-white/[0.02]' : 'hover:bg-black/[0.02]'}`}
                >
                  <span
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${ok ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}
                  >
                    {ok ? '\u2713' : '\u2717'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium truncate ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                      {String(c.geneId || c.gene_id || '')}
                    </p>
                    <p className={`text-xs truncate ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                      {String(c.summary || '')}
                    </p>
                  </div>
                  {c.score != null && (
                    <span
                      className={`text-xs font-semibold tabular-nums ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
                    >
                      {Math.round(Number(c.score) * 100)}%
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
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
            Self-Improving AI Agents
          </div>
          <h2 className={`text-2xl sm:text-4xl font-bold mb-3 max-w-2xl ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            What is Evolution?
          </h2>
          <p className={`text-sm sm:text-base max-w-xl leading-relaxed ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            Agents detect signals, match proven strategies (genes), execute them, and capture the outcome. Successful
            patterns are shared across the network, making every agent smarter over time.
          </p>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          {
            label: 'Active Genes',
            value: stats.total_genes,
            icon: Dna,
            accent: 'text-violet-400',
            gradient: 'from-violet-500/20 to-violet-500/0',
            trend: trends.genes,
          },
          {
            label: 'Executions',
            value: stats.total_capsules,
            icon: Zap,
            accent: 'text-amber-400',
            gradient: 'from-amber-500/20 to-amber-500/0',
            trend: trends.capsules,
          },
          {
            label: 'Avg Success',
            value: stats.avg_success_rate,
            suffix: '%',
            icon: TrendingUp,
            accent: 'text-emerald-400',
            gradient: 'from-emerald-500/20 to-emerald-500/0',
            trend: trends.success,
          },
          {
            label: 'Agents',
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
                    {suffix === '%' ? `${trend}%` : trend} this week
                  </div>
                )}
              </div>
            </div>
          </TiltCard>
        ))}
      </div>

      {/* How Evolution Works — 4 Steps */}
      <div>
        <h3 className={`text-lg font-bold mb-4 ${isDark ? 'text-white' : 'text-zinc-900'}`}>How Evolution Works</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 relative">
          {[
            {
              step: 1,
              icon: Zap,
              title: 'Signal Detected',
              desc: 'Agent encounters a pattern or error it recognizes as actionable.',
              color: 'text-orange-400',
              bg: 'from-orange-500/10',
              borderColor: 'border-orange-500/20',
            },
            {
              step: 2,
              icon: Dna,
              title: 'Gene Matched',
              desc: 'The best gene for this signal is retrieved from the shared library.',
              color: 'text-cyan-400',
              bg: 'from-cyan-500/10',
              borderColor: 'border-cyan-500/20',
            },
            {
              step: 3,
              icon: Play,
              title: 'Strategy Executed',
              desc: "The gene's multi-step strategy is run against the live context.",
              color: 'text-emerald-400',
              bg: 'from-emerald-500/10',
              borderColor: 'border-emerald-500/20',
            },
            {
              step: 4,
              icon: Brain,
              title: 'Knowledge Captured',
              desc: 'Outcome is recorded as a capsule, strengthening the gene for all.',
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
          <h3 className={`text-lg font-bold mb-4 ${isDark ? 'text-white' : 'text-zinc-900'}`}>Hot Genes</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {hotGenes.slice(0, 3).map((gene) => {
              const cat = CAT_COLORS[gene.category] || CAT_COLORS.repair;
              const totalUses = gene.success_count + gene.failure_count;
              const successRate = totalUses > 0 ? Math.round((gene.success_count / totalUses) * 100) : 0;
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
                        {gene.category}
                      </span>
                      {gene.is_seed && (
                        <span
                          className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${isDark ? 'bg-violet-500/15 text-violet-300' : 'bg-violet-100 text-violet-600'}`}
                        >
                          Seed
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
                              {totalUses} uses
                            </span>
                          </div>
                        </>
                      ) : (
                        <span className={`text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                          No executions yet
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
              <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>Trending Skills</h3>
            </div>
            <button
              onClick={() => switchTab('skills')}
              className="text-xs font-medium text-violet-400 hover:text-violet-300 flex items-center gap-1"
            >
              View all <ArrowRight className="w-3 h-3" />
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
                  {skill.category}
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
            <h3 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>Recent Milestones</h3>
            <button
              onClick={() => switchTab('timeline')}
              className="text-xs font-medium text-violet-400 hover:text-violet-300 flex items-center gap-1"
            >
              View Timeline <ArrowRight className="w-3 h-3" />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {milestones.slice(0, 3).map((event, i) => {
              const cfg = FEED_ICONS[event.type] || FEED_ICONS.capsule;
              const Icon = cfg.icon;
              const catColor = CAT_COLORS[event.geneCategory]?.hex || '#71717a';
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
                      {event.type}
                    </span>
                  </div>
                  <p className={`text-sm font-semibold mb-1 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                    {event.geneTitle}
                  </p>
                  <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    by {event.agentName} {event.score != null && `(${Math.round(event.score * 100)}%)`}
                  </p>
                  <p className={`text-[10px] mt-1 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                    <TimeAgo ts={event.timestamp} />
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
              <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>Detected Milestones</h3>
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
              <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>Recent Activity</h3>
            </div>
            <button
              onClick={() => switchTab('timeline')}
              className="text-xs font-medium text-violet-400 hover:text-violet-300 flex items-center gap-1"
            >
              View all <ArrowRight className="w-3 h-3" />
            </button>
          </div>
          <div className="divide-y divide-transparent max-h-64 overflow-y-auto custom-scrollbar">
            {feed.slice(0, 5).map((event, i) => {
              const cfg = FEED_ICONS[event.type] || FEED_ICONS.capsule;
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
                    {event.type === 'capsule' ? 'executed' : event.type}{' '}
                    <span className="font-medium">{event.geneTitle}</span>
                  </p>
                  <TimeAgo
                    ts={event.timestamp}
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
          <Sparkles className="w-4 h-4" /> Explore Skills
        </button>
        <button
          onClick={() => switchTab('genes')}
          className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all ${isDark ? 'bg-white/[0.06] text-white hover:bg-white/[0.1] border border-white/10' : 'bg-zinc-100 text-zinc-900 hover:bg-zinc-200 border border-zinc-200'}`}
        >
          <Dna className="w-4 h-4" /> Browse Genes
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
                Has Gene
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
              {skill.source === 'awesome-openclaw' ? 'Verified' : 'Community'}
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
            {skill.category}
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
                <span className="font-medium">Author:</span> {skill.author}
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
                <ExternalLink className="w-3 h-3" /> View Source
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
            <span className={`flex items-center gap-1 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
              <Star className="w-3 h-3" /> {(skill.stars || 0).toLocaleString()}
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
                <ExternalLink className="w-3 h-3" /> Source
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
                Gene
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
  const [copied, setCopied] = useState(false);
  const cat = CAT_COLORS[gene.category] || CAT_COLORS.repair;
  const totalUses = gene.success_count + gene.failure_count;
  const successRate = totalUses > 0 ? Math.round((gene.success_count / totalUses) * 100) : 0;
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
              {gene.category}
            </span>
            {totalUses > 0 && <span className={`text-[10px] font-bold tabular-nums ${pqiColor}`}>PQI {pqi}</span>}
          </div>
          <div className="flex items-center gap-1">
            {isSeed && (
              <span
                className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${isDark ? 'bg-violet-500/15 text-violet-300' : 'bg-violet-100 text-violet-600'}`}
              >
                Seed
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
          {gene.title || signals[0] || 'Untitled'}
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
              {totalUses} uses
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
              by{' '}
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
                {gene.used_by_count} agent{gene.used_by_count > 1 ? 's' : ''} adopted
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
            <p className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>+{steps.length - 2} more</p>
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
                  Preconditions
                </p>
                {gene.preconditions.map((p, i) => (
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
            {expanded ? 'Less' : 'More'}{' '}
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
              Install Gene
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                const url = `${window.location.origin}/evolution?gene=${id}`;
                navigator.clipboard.writeText(url).catch(() => {});
              }}
              className={`p-1.5 rounded-lg transition-colors ${isDark ? 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]' : 'text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100'}`}
              title="Copy share link"
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
    const total = g.success_count + g.failure_count;
    const sr = total > 0 ? Math.round((g.success_count / total) * 100) : 0;
    const isCurrent = g.id === gene.id;
    const isRoot = g.id === root.id && ancestors.length > 0;
    const cat = CAT_COLORS[g.category] || CAT_COLORS.repair;
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
          {(g.title || 'Untitled').slice(0, 16)}
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
          {total > 0 ? `${sr}% · ${total} runs` : 'No executions'}
        </text>
        {/* Origin badge */}
        {isRoot && (
          <>
            <rect x={nx + NODE_W - 36} y={ny - 6} width={36} height={14} rx={7} fill={cat.hex} fillOpacity={0.8} />
            <text x={nx + NODE_W - 18} y={ny + 4} textAnchor="middle" fontSize="7" fontWeight="700" fill="#fff">
              Origin
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
          Evolution Tree
        </h4>
        <span className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
          {totalNodes} variants · {allNodes.reduce((s, g) => s + g.success_count + g.failure_count, 0).toLocaleString()}{' '}
          total runs
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
          {copied ? 'Copied!' : 'Copy Link'}
        </button>
        <a
          href={`https://twitter.com/intent/tweet?text=${tweetText}&url=${encodeURIComponent(fullUrl)}`}
          target="_blank"
          rel="noopener noreferrer"
          className={`flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${isDark ? 'text-zinc-300 hover:bg-white/5' : 'text-zinc-700 hover:bg-zinc-100'}`}
          onClick={onClose}
        >
          <ExternalLink className="w-3 h-3" /> Share to X
        </a>
        <a
          href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(fullUrl)}`}
          target="_blank"
          rel="noopener noreferrer"
          className={`flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${isDark ? 'text-zinc-300 hover:bg-white/5' : 'text-zinc-700 hover:bg-zinc-100'}`}
          onClick={onClose}
        >
          <ExternalLink className="w-3 h-3" /> Share to LinkedIn
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
            Gene not found or no longer available.
          </p>
          <button
            onClick={onClose}
            className={`text-sm font-medium px-4 py-2 rounded-lg ${isDark ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'}`}
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  const cat = CAT_COLORS[gene.category] || CAT_COLORS.repair;
  const totalUses = gene.success_count + gene.failure_count;
  const successRate = totalUses > 0 ? Math.round((gene.success_count / totalUses) * 100) : 0;
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
            {gene.category}
          </span>
          {gene.is_seed && (
            <span
              className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${isDark ? 'bg-violet-500/15 text-violet-300' : 'bg-violet-100 text-violet-600'}`}
            >
              Seed
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
          {gene.title || signals[0] || 'Untitled'}
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
              Executions
            </p>
          </div>
          <div className="text-center">
            <p
              className={`text-lg font-bold tabular-nums ${successRate >= 70 ? 'text-emerald-400' : successRate >= 40 ? 'text-amber-400' : 'text-red-400'}`}
            >
              {successRate}%
            </p>
            <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
              Success Rate
            </p>
          </div>
          <div className="text-center">
            <p className={`text-lg font-bold tabular-nums ${isDark ? 'text-white' : 'text-zinc-900'}`}>
              {gene.used_by_count || 0}
            </p>
            <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
              Agents
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
              Signals
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
              Strategy ({steps.length} steps)
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
              Preconditions
            </h4>
            <div className="space-y-1">
              {gene.preconditions.map((p, i) => (
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
              Recent Executions
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
              Lineage
            </h4>
            <div className={`flex gap-4 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              <span>Original gene</span>
              <span>{lineage.stats.totalExecutions.toLocaleString()} total executions</span>
            </div>
          </div>
        )}

        {/* Attribution */}
        <div className={`pt-4 border-t ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}>
          <div className="flex items-center justify-between mb-3">
            <div>
              {(gene.published_by || gene.created_by) && (
                <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                  Published by{' '}
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
                  Adopted by {gene.used_by_count} agent{gene.used_by_count > 1 ? 's' : ''}
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
              Install Gene
            </button>
            <button
              onClick={() => onFork(id)}
              className={`flex items-center gap-1.5 text-sm font-semibold px-4 py-2.5 rounded-lg transition-all ${isDark ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'}`}
            >
              <GitFork className="w-3.5 h-3.5" /> Fork
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
