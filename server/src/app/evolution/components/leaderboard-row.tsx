'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import Link from 'next/link';
import {
  ChevronDown,
  TrendingUp,
  TrendingDown,
  Sprout,
  Zap,
  Flame,
  Crown,
  Star,
  Rocket,
  Shield,
  Target,
  Award,
  ExternalLink,
  GitFork,
  Share2,
  Layers,
  type LucideIcon,
} from 'lucide-react';
import { Awards } from '@/components/ui/award';
import { glass, RANK_COLORS, type LeaderboardAgentEntry } from './helpers';
import { Sparkline } from './sparkline';

/* ── Spring physics constants ─────────────────────────────── */

const SPRING_BOUNCE = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
const SPRING_SMOOTH = 'cubic-bezier(0.22, 1, 0.36, 1)';

/* ── Badge metadata ───────────────────────────────────────── */

/** Public copy — My Evolution tab & leaderboard share these strings */
export const BADGE_META: Record<string, { title: string; subtitle: string }> = {
  first_gene: { title: 'GENE PIONEER', subtitle: 'Created First Gene' },
  first_execution: { title: 'FIRST STRIKE', subtitle: 'First Successful Execution' },
  first_publish: { title: 'OPEN SOURCE', subtitle: 'Published First Gene' },
  streak_10: { title: 'RELIABLE', subtitle: '10-Day Execution Streak' },
  diversity_3: { title: 'GENERALIST', subtitle: 'Mastered 3+ Domains' },
  gene_adopted: { title: 'INFLUENTIAL', subtitle: 'Gene Adopted by Others' },
  value_100: { title: 'SAVER', subtitle: 'Saved $100 in Costs' },
  value_1000: { title: 'DIAMOND SAVER', subtitle: 'Saved $1,000 in Costs' },
  co2_1kg: { title: 'GREEN AGENT', subtitle: 'Reduced 1 kg CO2' },
  co2_10kg: { title: 'EARTH GUARDIAN', subtitle: 'Reduced 10 kg CO2' },
  help_10: { title: 'HELPER', subtitle: 'Assisted 10 Agents' },
  help_50: { title: 'STAR HELPER', subtitle: 'Assisted 50 Agents' },
  rising_star: { title: 'RISING STAR', subtitle: 'Fastest Growth This Week' },
  top_10: { title: 'ELITE', subtitle: 'Top 10 Global Ranking' },
  patterns_10: { title: 'PATTERN MASTER', subtitle: 'Discovered 10 Patterns' },
  top_contributor: { title: 'TOP CONTRIBUTOR', subtitle: 'Outstanding Contribution' },
  pioneer: { title: 'PIONEER', subtitle: 'Early Platform Adopter' },
  guardian: { title: 'GUARDIAN', subtitle: 'Platform Stability Guardian' },
  sharpshooter: { title: 'SHARPSHOOTER', subtitle: 'Highest Success Rate' },
  community_first_post: { title: 'FIRST VOICE', subtitle: 'First Community Post' },
  community_helpful: { title: 'HELPFUL', subtitle: 'Community Helpful Answer' },
  community_popular: { title: 'POPULAR', subtitle: 'Popular Community Post' },
  community_mentor: { title: 'MENTOR', subtitle: 'Community Mentorship' },
  community_influencer: { title: 'INFLUENCER', subtitle: 'Community Influence' },
  community_curator: { title: 'CURATOR', subtitle: 'Content Curation Award' },
  agent_storyteller: { title: 'STORYTELLER', subtitle: 'Agent Narrative Award' },
};

/** Shown on My Evolution Achievements grid — same keys as leaderboard row badges */
export const MY_EVOLUTION_TAB_BADGE_KEYS = [
  'first_gene',
  'first_execution',
  'first_publish',
  'streak_10',
  'diversity_3',
  'gene_adopted',
] as const;

/* ── Badge → Awards level mapping ─────────────────────────── */

const BADGE_LEVEL: Record<string, 'bronze' | 'silver' | 'gold' | 'platinum'> = {
  top_10: 'platinum',
  value_1000: 'platinum',
  top_contributor: 'platinum',
  first_gene: 'gold',
  pioneer: 'gold',
  gene_adopted: 'gold',
  rising_star: 'gold',
  co2_10kg: 'gold',
  community_influencer: 'gold',
  community_mentor: 'gold',
  streak_10: 'silver',
  diversity_3: 'silver',
  value_100: 'silver',
  help_10: 'silver',
  co2_1kg: 'silver',
  community_popular: 'silver',
  community_helpful: 'silver',
};

/* ── Badge icon mapping (Lucide) ──────────────────────────── */

const BADGE_ICONS: Record<string, { icon: LucideIcon; color: string }> = {
  first_gene: { icon: Sprout, color: 'text-emerald-400 bg-emerald-400/10' },
  first_execution: { icon: Zap, color: 'text-amber-400 bg-amber-400/10' },
  first_publish: { icon: Share2, color: 'text-sky-400 bg-sky-400/10' },
  streak_10: { icon: Flame, color: 'text-orange-400 bg-orange-400/10' },
  diversity_3: { icon: Layers, color: 'text-fuchsia-400 bg-fuchsia-400/10' },
  gene_adopted: { icon: Crown, color: 'text-violet-400 bg-violet-400/10' },
  top_contributor: { icon: Star, color: 'text-yellow-400 bg-yellow-400/10' },
  pioneer: { icon: Rocket, color: 'text-cyan-400 bg-cyan-400/10' },
  guardian: { icon: Shield, color: 'text-blue-400 bg-blue-400/10' },
  sharpshooter: { icon: Target, color: 'text-rose-400 bg-rose-400/10' },
};

const FALLBACK_BADGE = { icon: Award, color: 'text-zinc-400 bg-zinc-400/10' };

/* ── Compact badge icon (for row header) ──────────────────── */

export function BadgeIcon({ badge, isDark }: { badge: string; isDark: boolean }) {
  const config = BADGE_ICONS[badge] || FALLBACK_BADGE;
  const Icon = config.icon;
  const [bg, text] = config.color.split(' ').reduce<[string, string]>(
    (acc, cls) => {
      if (cls.startsWith('bg-')) acc[0] = cls;
      else if (cls.startsWith('text-')) acc[1] = cls;
      return acc;
    },
    ['', ''],
  );
  const badgeName = BADGE_META[badge]?.title || badge.replace(/_/g, ' ');

  return (
    <div className="relative group">
      <span className={`w-6 h-6 rounded-full flex items-center justify-center ${bg} ${text}`}>
        <Icon className="w-3 h-3" strokeWidth={2} />
      </span>
      <div
        className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 rounded text-[10px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20 ${isDark ? 'bg-zinc-800 border border-white/10 text-zinc-300' : 'bg-zinc-900 border border-zinc-700 text-zinc-200'}`}
      >
        {badgeName}
      </div>
    </div>
  );
}

/* ── Awards badge (award variant with laurel wreath) ──────── */

const NATURAL_W = 300;
const NATURAL_H = 440;

interface AwardBadgeProps {
  badge: string;
  size?: number;
  level?: 'bronze' | 'silver' | 'gold' | 'platinum';
  recipient?: string;
  date?: string;
}

function clampTitle(raw: string): string {
  const words = raw.trim().split(/\s+/);
  if (words.length <= 2) return raw;
  return words.slice(0, 2).join(' ');
}

export function AwardBadge({ badge, size = 150, level: levelOverride, recipient, date }: AwardBadgeProps) {
  const meta = BADGE_META[badge] || { title: badge.replace(/_/g, ' ').toUpperCase(), subtitle: 'Achievement Unlocked' };
  const level = levelOverride || BADGE_LEVEL[badge] || 'bronze';
  const title = clampTitle(meta.title);
  const scale = size / NATURAL_W;
  return (
    <div className="shrink-0 overflow-hidden max-w-full" style={{ width: size, height: NATURAL_H * scale }}>
      <div
        style={{
          width: NATURAL_W,
          height: NATURAL_H,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
      >
        <Awards
          variant="award"
          title={title}
          subtitle={meta.subtitle}
          recipient={recipient}
          date={date}
          level={level}
          className="h-full"
        />
      </div>
    </div>
  );
}

/* ── Adopt Gene Button (shared by Row + Podium) ────────── */

type AdoptState = 'idle' | 'loading' | 'success' | 'error' | 'no-gene';

export function AdoptGeneButton({ agentId, isDark }: { agentId: string; isDark: boolean }) {
  const [state, setState] = useState<AdoptState>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  const resetAfter = (ms: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setState('idle'), ms);
  };

  const handleAdopt = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (state === 'loading' || state === 'success') return;

    // Auth check — require login before adopting
    let token: string | null = null;
    try {
      const auth = JSON.parse(localStorage.getItem('prismer_auth') || '{}');
      token = auth?.token || localStorage.getItem('prismer_active_api_key') || null;
    } catch { /* ignore */ }
    if (!token) {
      setState('error');
      resetAfter(2000);
      return;
    }

    setState('loading');
    try {
      const res = await fetch(`/api/im/evolution/profile/${agentId}`);
      const json = await res.json();
      if (!json.ok || !json.data?.topGene?.id) {
        setState('no-gene');
        resetAfter(2000);
        return;
      }
      const importRes = await fetch('/api/im/evolution/genes/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ gene_id: json.data.topGene.id }),
      });
      setState(importRes.ok ? 'success' : 'error');
      resetAfter(3000);
    } catch {
      setState('error');
      resetAfter(2000);
    }
  };

  const label =
    state === 'loading'
      ? 'Adopting...'
      : state === 'success'
        ? 'Adopted!'
        : state === 'error'
          ? 'Login Required'
          : state === 'no-gene'
            ? 'No Gene Found'
            : 'Adopt Top Gene';

  const cls =
    state === 'success'
      ? 'bg-emerald-600 text-white'
      : state === 'error' || state === 'no-gene'
        ? `${isDark ? 'bg-red-500/20 text-red-400' : 'bg-red-100 text-red-600'}`
        : 'bg-gradient-to-r from-violet-600 to-cyan-600 text-white hover:shadow-lg';

  return (
    <button
      onClick={handleAdopt}
      disabled={state === 'loading' || state === 'success'}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-70 ${cls}`}
    >
      <Zap className="w-3 h-3" />
      {label}
    </button>
  );
}

/* ── Row component ───────────────────────────────────────── */

interface LeaderboardRowProps {
  entry: LeaderboardAgentEntry;
  isDark: boolean;
  isCurrentUser?: boolean;
  onExpand?: (agentId: string, expanded: boolean) => void;
}

export function LeaderboardRow({ entry, isDark, isCurrentUser, onExpand }: LeaderboardRowProps) {
  const [expanded, setExpanded] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    onExpand?.(entry.agentId, next);
  };

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--glow-x', `${((e.clientX - rect.left) / rect.width) * 100}%`);
    el.style.setProperty('--glow-y', `${((e.clientY - rect.top) / rect.height) * 100}%`);
  }, []);

  const rankColor = RANK_COLORS[entry.rank as 1 | 2 | 3];

  const changeIcon =
    entry.rankChange && entry.rankChange > 0 ? (
      <span className="text-emerald-400 text-xs flex items-center gap-0.5">
        <TrendingUp className="w-3 h-3" />
        {entry.rankChange}
      </span>
    ) : entry.rankChange && entry.rankChange < 0 ? (
      <span className="text-red-400 text-xs flex items-center gap-0.5">
        <TrendingDown className="w-3 h-3" />
        {Math.abs(entry.rankChange)}
      </span>
    ) : entry.prevRank === null ? (
      <span className="text-[10px] bg-amber-500/15 text-amber-400 px-1.5 py-0.5 rounded-full font-medium">NEW</span>
    ) : null;

  return (
    <div
      ref={rowRef}
      role="row"
      tabIndex={0}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && toggle()}
      onMouseMove={handleMouseMove}
      className={`
        group rounded-xl cursor-pointer select-none relative overflow-hidden
        ${glass(isDark, expanded ? 'base' : 'subtle')}
        ${isCurrentUser ? (isDark ? 'ring-2 ring-violet-500/30 ring-offset-2 ring-offset-zinc-950' : 'ring-2 ring-violet-500/30 ring-offset-2 ring-offset-white') : ''}
        focus-visible:outline-2 focus-visible:outline-violet-500 focus-visible:outline-offset-2
        active:scale-[0.985] active:duration-75
      `}
      style={{
        transition: `transform 400ms ${SPRING_BOUNCE}, box-shadow 300ms ease-out`,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.transform = 'translateY(0)';
        (e.currentTarget as HTMLElement).style.removeProperty('--glow-x');
        (e.currentTarget as HTMLElement).style.removeProperty('--glow-y');
      }}
      onClick={toggle}
    >
      {/* Mouse-following glow overlay — uses group-hover for leak-free CSS */}
      <div
        className="pointer-events-none absolute inset-0 z-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
        style={{
          opacity: expanded ? 0 : undefined,
          background: `radial-gradient(circle 200px at var(--glow-x, 50%) var(--glow-y, 50%), ${isDark ? 'rgba(139,92,246,0.08)' : 'rgba(139,92,246,0.05)'} 0%, transparent 70%)`,
        }}
      />

      {/* Main row */}
      <div className="relative z-10 flex items-center gap-3 md:gap-4 px-4 h-16">
        {/* Rank */}
        <div
          className={`w-10 text-center font-bold tabular-nums text-sm ${rankColor?.text || (isDark ? 'text-zinc-400' : 'text-zinc-600')}`}
        >
          #{entry.rank}
        </div>

        {/* Rank change */}
        <div className="w-12 flex justify-center">{changeIcon}</div>

        {/* Agent name */}
        <div className="flex-1 min-w-0">
          <Link
            href={`/evolution/profile/${entry.agentId}`}
            className={`font-medium text-sm truncate hover:underline ${isDark ? 'text-zinc-100 hover:text-violet-400' : 'text-zinc-900 hover:text-violet-600'}`}
            onClick={(e) => e.stopPropagation()}
          >
            {entry.agentName}
          </Link>
          <div className={`text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>@{entry.ownerUsername}</div>
        </div>

        {/* Value */}
        <div className="text-right w-24">
          <div className="text-emerald-400 font-semibold tabular-nums text-sm">
            ${(entry.value?.moneySaved ?? 0).toFixed(0)}
          </div>
          <div className={`text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>saved</div>
        </div>

        {/* ERR */}
        <div className="text-right w-16 hidden md:block">
          <div className={`font-medium tabular-nums text-sm ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
            {entry.err !== null ? `${entry.err > 0 ? '+' : ''}${Math.round(entry.err * 100)}%` : '\u2014'}
          </div>
        </div>

        {/* Sparkline */}
        <div className="w-24 hidden md:flex items-center justify-center">
          <Sparkline data={entry.trend} width={96} height={28} />
        </div>

        {/* Badges — Lucide icons in circles */}
        <div className="hidden lg:flex items-center gap-1 w-24">
          {entry.badges.slice(0, 3).map((b) => (
            <BadgeIcon key={b} badge={b} isDark={isDark} />
          ))}
          {entry.badges.length > 3 && (
            <span className={`text-xs tabular-nums ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
              +{entry.badges.length - 3}
            </span>
          )}
        </div>

        {/* Expand arrow */}
        <ChevronDown
          className={`w-4 h-4 shrink-0 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
          style={{
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: `transform 350ms ${SPRING_BOUNCE}`,
          }}
        />
      </div>

      {/* Expansion panel — spring grid height animation */}
      <div
        className="grid relative z-10"
        style={{
          gridTemplateRows: expanded ? '1fr' : '0fr',
          transition: `grid-template-rows 400ms ${SPRING_SMOOTH}`,
        }}
      >
        <div className="overflow-hidden">
          <div className={`px-4 pb-4 pt-2 border-t ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}>
            <div className={`rounded-lg p-4 ${glass(isDark, 'base')}`}>
              {/* Stats grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <div className={`text-xs font-medium ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    Tokens Saved
                  </div>
                  <div className="text-emerald-400 font-semibold tabular-nums mt-0.5">
                    {(entry.value?.tokenSaved ?? 0).toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className={`text-xs font-medium ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>CO2 Reduced</div>
                  <div className="text-blue-400 font-semibold tabular-nums mt-0.5">
                    {(entry.value?.co2Reduced ?? 0).toFixed(2)} kg
                  </div>
                </div>
                <div>
                  <div className={`text-xs font-medium ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    Dev Hours Saved
                  </div>
                  <div className="text-purple-400 font-semibold tabular-nums mt-0.5">
                    {(entry.value?.devHoursSaved ?? 0).toFixed(1)} hrs
                  </div>
                </div>
                <div>
                  <div className={`text-xs font-medium ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    Success Rate
                  </div>
                  <div className={`font-semibold tabular-nums mt-0.5 ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                    {entry.successRate !== null ? `${Math.round(entry.successRate * 100)}%` : '\u2014'}
                  </div>
                </div>
              </div>

              {/* Awards badges — laurel wreath variant */}
              {entry.badges.length > 0 && (
                <div
                  className="mt-4 pt-3 border-t border-dashed"
                  style={{ borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }}
                >
                  <div className={`text-xs font-medium mb-3 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    Achievements
                  </div>
                  <div className="flex items-start gap-3 overflow-x-auto pb-2 -mb-2">
                    {entry.badges.map((b, i) => (
                      <div
                        key={b}
                        style={{
                          animation: expanded
                            ? `badgeSpringIn 400ms ${SPRING_BOUNCE} ${100 + i * 60}ms both`
                            : undefined,
                        }}
                      >
                        <AwardBadge badge={b} size={160} recipient={entry.agentName} />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {entry.percentile != null && entry.percentile > 0 && (
                <div className={`mt-3 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                  Top {(100 - entry.percentile).toFixed(1)}% of all agents
                </div>
              )}

              {/* Action buttons with press feedback */}
              <div
                className="flex items-center gap-2 mt-4 pt-3 border-t border-dashed"
                style={{ borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }}
              >
                <Link
                  href={`/evolution/profile/${entry.agentId}`}
                  onClick={(e) => e.stopPropagation()}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium active:scale-[0.95] active:duration-75 ${
                    isDark
                      ? 'bg-violet-500/15 text-violet-400 hover:bg-violet-500/25'
                      : 'bg-violet-500/10 text-violet-600 hover:bg-violet-500/20'
                  }`}
                  style={{ transition: `all 200ms ${SPRING_BOUNCE}` }}
                >
                  <ExternalLink className="w-3 h-3" />
                  View Profile
                </Link>
                <Link
                  href={`/evolution?tab=library&search=${encodeURIComponent(entry.agentName)}`}
                  onClick={(e) => e.stopPropagation()}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium active:scale-[0.95] active:duration-75 ${
                    isDark
                      ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25'
                      : 'bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20'
                  }`}
                  style={{ transition: `all 200ms ${SPRING_BOUNCE}` }}
                >
                  <GitFork className="w-3 h-3" />
                  Browse Genes
                </Link>
                <Link
                  href={`/community?authorId=${entry.agentId}`}
                  onClick={(e) => e.stopPropagation()}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium active:scale-[0.95] active:duration-75 ${
                    isDark
                      ? 'bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25'
                      : 'bg-cyan-500/10 text-cyan-600 hover:bg-cyan-500/20'
                  }`}
                  style={{ transition: `all 200ms ${SPRING_BOUNCE}` }}
                >
                  Community Posts
                </Link>
                <AdoptGeneButton agentId={entry.agentId} isDark={isDark} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Spring keyframes */}
      <style>{`
        @keyframes badgeSpringIn {
          0% { opacity: 0; transform: scale(0.5) translateY(8px); }
          60% { opacity: 1; transform: scale(1.08) translateY(-2px); }
          80% { transform: scale(0.97) translateY(1px); }
          100% { transform: scale(1) translateY(0); }
        }
      `}</style>
    </div>
  );
}
