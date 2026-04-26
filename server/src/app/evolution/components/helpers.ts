// Types
export interface PublicGene {
  gene_id?: string;
  id?: string;
  category: string;
  title?: string;
  description?: string;
  visibility?: string;
  signals?: Array<string | { type: string; provider?: string; stage?: string }>;
  signals_match?: Array<string | { type: string; provider?: string; stage?: string }>;
  strategy?: { steps?: string[] } | string[];
  preconditions?: string[];
  success_count: number;
  failure_count: number;
  published_by?: string;
  created_by?: string;
  used_by_count?: number;
  is_seed?: boolean;
  forkCount?: number;
  parentGeneId?: string | null;
  generation?: number;
  qualityScore?: number;
  createdAt?: string;
}

export interface FeedEvent {
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

export interface Skill {
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
  signals?: string;
  qualityScore?: number;
}

export interface SkillCategory {
  category: string;
  count: number;
}

export interface EvolutionStats {
  total_genes: number;
  total_capsules: number;
  avg_success_rate: number;
  active_agents: number;
}

export interface AdvancedMetrics extends EvolutionStats {
  evolution_velocity_24h: number;
  evolution_velocity_7d: number;
  gene_diversity_index: number;
  exploration_rate: number;
  information_gain: number;
  surprise_score: number;
}

export interface SkillStats {
  total: number;
  by_source: Record<string, number>;
  by_category: Record<string, number>;
  total_installs: number;
}

export interface Achievement {
  badgeKey: string;
  badge: { key: string; name: string; description: string; icon: string };
  unlockedAt: string;
}

export interface LeaderboardEntry {
  agentId: string;
  agentName: string;
  badges: string[];
  badgeCount: number;
  capsuleCount: number;
  score: number;
}

// Constants
export const CAT_COLORS: Record<string, { text: string; bg: string; border: string; glow: string; hex: string }> = {
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

export const GENE_CATEGORIES = [
  { key: '', label: 'All' },
  { key: 'repair', label: 'Repair' },
  { key: 'optimize', label: 'Optimize' },
  { key: 'innovate', label: 'Innovate' },
] as const;

export const SORT_OPTIONS = [
  { key: 'newest', label: 'Newest' },
  { key: 'most_used', label: 'Most Used' },
  { key: 'highest_success', label: 'Highest Success' },
  { key: 'impact', label: 'Impact Score' },
  { key: 'rising', label: 'Rising' },
] as const;

export const FEED_ICONS: Record<string, { color: string }> = {
  capsule: { color: 'text-emerald-400' },
  distill: { color: 'text-violet-400' },
  publish: { color: 'text-amber-400' },
  milestone: { color: 'text-cyan-400' },
  import: { color: 'text-blue-400' },
};

// Helpers
export const glass = (isDark: boolean, level: 'subtle' | 'base' | 'elevated' | 'hero' = 'base') => {
  if (!isDark) {
    const map = {
      subtle: 'bg-white/60 border border-zinc-200/60',
      base: 'bg-white shadow-sm border border-zinc-200',
      elevated: 'bg-white shadow-md border border-zinc-200',
      hero: 'bg-gradient-to-br from-violet-50/80 to-cyan-50/50 border border-violet-100',
    };
    return map[level];
  }
  const map = {
    subtle: 'backdrop-blur-md bg-white/[0.02] border border-white/[0.04]',
    base: 'backdrop-blur-xl bg-white/[0.03] border border-white/[0.06] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)]',
    elevated:
      'backdrop-blur-xl bg-white/[0.05] border border-white/[0.08] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]',
    hero: 'backdrop-blur-2xl bg-white/[0.04] border border-white/[0.08] shadow-[0_0_80px_rgba(139,92,246,0.04)]',
  };
  return map[level];
};

export interface CreatedSkill {
  id: string;
  name: string;
  category: string;
  installs: number;
  stars: number;
  sourceUrl: string;
}

/** Source badge config for skill cards and detail modals. */
export const SOURCE_BADGE: Record<string, { label: string; dark: string; light: string }> = {
  clawhub: { label: 'ClawHub', dark: 'bg-blue-500/15 text-blue-300', light: 'bg-blue-100 text-blue-600' },
  'awesome-openclaw': {
    label: 'Verified',
    dark: 'bg-emerald-500/15 text-emerald-300',
    light: 'bg-emerald-100 text-emerald-600',
  },
  gstack: { label: 'gstack', dark: 'bg-amber-500/15 text-amber-300', light: 'bg-amber-100 text-amber-600' },
};

export function getSourceBadge(source: string, isDark: boolean): { label: string; className: string } | null {
  const badge = SOURCE_BADGE[source];
  if (!badge) {
    if (source === 'community') return null; // don't badge community (default)
    return { label: source, className: isDark ? 'bg-zinc-700/60 text-zinc-400' : 'bg-zinc-100 text-zinc-500' };
  }
  return { label: badge.label, className: isDark ? badge.dark : badge.light };
}

export function timeAgo(ts: string): string {
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

export function computePQI(g: PublicGene, maxExecutions: number): number {
  const total = g.success_count + g.failure_count;
  const successRate = total > 0 ? g.success_count / total : 0;
  const normalizedExec = maxExecutions > 0 ? Math.min(total / maxExecutions, 1) : 0;
  const adoptionRate = (g.used_by_count || 0) > 0 ? Math.min((g.used_by_count || 0) / 50, 1) : 0;
  const freshness = 0.5;
  return Math.round((successRate * 0.4 + normalizedExec * 0.3 + adoptionRate * 0.2 + freshness * 0.1) * 100);
}

export function getGeneId(g: PublicGene): string {
  return g.gene_id || g.id || '';
}
export function getSignals(g: PublicGene): string[] {
  const raw: unknown[] = g.signals || g.signals_match || [];
  return raw
    .map((s) => (typeof s === 'string' ? s : ((s as Record<string, unknown>)?.type as string) || ''))
    .filter(Boolean);
}
export function getSteps(g: PublicGene): string[] {
  if (Array.isArray(g.strategy)) return g.strategy as string[];
  if (g.strategy && typeof g.strategy === 'object' && Array.isArray((g.strategy as { steps?: string[] }).steps))
    return (g.strategy as { steps: string[] }).steps;
  return [];
}

// ─── Leaderboard V2 Types ──────────────────────────────

export interface LeaderboardAgentEntry {
  rank: number;
  prevRank: number | null;
  rankChange: number | null;
  agentId: string;
  agentName: string;
  ownerUsername: string;
  err: number | null;
  sessionCount: number;
  successRate: number | null;
  value: { tokenSaved: number; moneySaved: number; co2Reduced: number; devHoursSaved: number };
  trend: number[];
  badges: string[];
  domain: string;
  percentile: number | null;
  growthRate: number | null;
}

export interface LeaderboardContributorEntry {
  rank: number;
  prevRank: number | null;
  rankChange: number | null;
  agentId: string;
  agentName: string;
  ownerUsername: string;
  genesPublished: number;
  genesAdopted: number;
  agentsHelped: number;
  agentCount?: number;
  value: { tokenSaved: number; moneySaved: number; co2Reduced: number };
  topGene: { id: string; title: string; adopters: number; successRate: number } | null;
  percentile: number | null;
}

export interface LeaderboardRisingEntry {
  rank: number;
  entityType: string;
  entityId: string;
  entitySlug?: string;
  entityName: string;
  ownerUsername: string;
  growthRate: number;
  currentValue: number;
  trend: number[];
  daysActive: number;
}

export interface LeaderboardHeroData {
  global: { totalTokenSaved: number; totalMoneySaved: number; totalCo2Reduced: number; totalDevHoursSaved: number };
  network: { totalAgentsEvolving: number; totalGenesPublished: number; totalGeneTransfers: number };
  period: { label: string; weeklyGrowth: number | null };
}

export const RANK_COLORS = {
  1: { text: 'text-amber-400', bg: 'bg-amber-400/10', border: 'border-amber-400/30', glow: 'rgba(251,191,36,0.12)' },
  2: { text: 'text-zinc-300', bg: 'bg-zinc-300/10', border: 'border-zinc-300/30', glow: 'rgba(212,212,216,0.12)' },
  3: { text: 'text-orange-500', bg: 'bg-orange-500/10', border: 'border-orange-500/30', glow: 'rgba(234,88,12,0.12)' },
} as const;

export const VALUE_COLORS = {
  tokenSaved: 'text-emerald-500',
  co2Reduced: 'text-blue-500',
  timeSaved: 'text-purple-500',
  moneySaved: 'text-yellow-500',
} as const;
