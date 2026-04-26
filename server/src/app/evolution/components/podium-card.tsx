'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { TrendingUp, TrendingDown, ExternalLink } from 'lucide-react';
import { glass, RANK_COLORS, type LeaderboardAgentEntry } from './helpers';
import { Sparkline } from './sparkline';
import { AwardBadge, AdoptGeneButton } from './leaderboard-row';

/* ── Podium Card — Visual centerpiece for Top 3 ──────────── */

interface PodiumCardProps {
  entry: LeaderboardAgentEntry;
  rank: 1 | 2 | 3;
  isDark: boolean;
  /** Stagger index for entrance animation */
  staggerIndex?: number;
}

const RANK_LABELS: Record<1 | 2 | 3, string> = { 1: '1st', 2: '2nd', 3: '3rd' };

const RANK_GLOW_COLORS: Record<1 | 2 | 3, { dark: string; light: string }> = {
  1: { dark: 'rgba(251,191,36,0.15)', light: 'rgba(251,191,36,0.10)' },
  2: { dark: 'rgba(212,212,216,0.12)', light: 'rgba(161,161,170,0.08)' },
  3: { dark: 'rgba(234,88,12,0.12)', light: 'rgba(234,88,12,0.08)' },
};

export function PodiumCard({ entry, rank, isDark, staggerIndex = 0 }: PodiumCardProps) {
  const router = useRouter();
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    setTilt({ x: y * -10, y: x * 10 });
  };

  const handleMouseEnter = () => setIsHovered(true);
  const handleMouseLeave = () => {
    setIsHovered(false);
    setTilt({ x: 0, y: 0 });
  };

  const rankColor = RANK_COLORS[rank];
  const glowColor = RANK_GLOW_COLORS[rank];

  const changeIcon =
    entry.rankChange && entry.rankChange > 0 ? (
      <span className="text-emerald-400 text-xs flex items-center gap-0.5">
        <TrendingUp className="w-3 h-3" />+{entry.rankChange}
      </span>
    ) : entry.rankChange && entry.rankChange < 0 ? (
      <span className="text-red-400 text-xs flex items-center gap-0.5">
        <TrendingDown className="w-3 h-3" />
        {entry.rankChange}
      </span>
    ) : entry.prevRank === null ? (
      <span className="text-[10px] bg-amber-500/15 text-amber-400 px-1.5 py-0.5 rounded-full font-medium">NEW</span>
    ) : null;

  return (
    <div
      className={`
        relative rounded-2xl overflow-hidden cursor-pointer
        ${glass(isDark, 'elevated')}
        focus-visible:outline-2 focus-visible:outline-violet-500 focus-visible:outline-offset-2
      `}
      style={{
        perspective: '800px',
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(24px)',
        transition: `transform 600ms cubic-bezier(0.34, 1.56, 0.64, 1) ${staggerIndex * 120}ms, opacity 400ms ease-out ${staggerIndex * 120}ms`,
      }}
      tabIndex={0}
      role="link"
      onClick={() => router.push(`/evolution/profile/${entry.agentId}`)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && router.push(`/evolution/profile/${entry.agentId}`)}
    >
      {/* Glow border effect — subtle always, stronger on hover */}
      <div
        className="absolute inset-0 rounded-2xl pointer-events-none transition-opacity duration-300"
        style={{
          opacity: isHovered ? 1 : rank === 1 ? 0.5 : 0.3,
          boxShadow: `0 0 ${rank === 1 ? '60px' : '40px'} ${isDark ? glowColor.dark : glowColor.light}, inset 0 0 ${rank === 1 ? '60px' : '40px'} ${isDark ? glowColor.dark : glowColor.light}`,
        }}
      />

      {/* 3D tilt container */}
      <div
        onMouseMove={handleMouseMove}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className="relative z-10"
        style={{
          transform: `perspective(800px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
          transition: isHovered ? 'transform 100ms ease-out' : 'transform 400ms cubic-bezier(0.34, 1.56, 0.64, 1)',
        }}
      >
        <div
          className={`p-5 overflow-hidden ${rank === 1 ? 'py-8 min-h-[280px]' : 'py-5 min-h-[240px]'} flex flex-col items-center text-center gap-3`}
        >
          {/* Rank label + change */}
          <div className="flex items-center gap-2">
            <span className={`text-xs font-semibold ${rankColor.text}`}>{RANK_LABELS[rank]}</span>
            {changeIcon}
          </div>

          {/* Agent name */}
          <div className="w-full">
            <div className={`font-semibold text-base truncate ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
              {entry.agentName}
            </div>
            <div className={`text-xs mt-0.5 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>@{entry.ownerUsername}</div>
          </div>

          {/* Value */}
          <div className={`text-emerald-400 ${rank === 1 ? 'text-2xl' : 'text-xl'} font-bold tabular-nums`}>
            ${(entry.value?.moneySaved ?? 0).toFixed(0)}
            <span className={`text-xs font-normal ml-1 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>saved</span>
          </div>

          {/* ERR % */}
          {entry.err !== null && (
            <div className={`text-xs tabular-nums ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
              ERR {entry.err > 0 ? '+' : ''}
              {Math.round(entry.err * 100)}%
            </div>
          )}

          {/* Mini sparkline */}
          {entry.trend && entry.trend.length >= 2 && <Sparkline data={entry.trend} width={80} height={24} />}

          {/* Badge — top award with laurel wreath, level matches podium rank */}
          {entry.badges && entry.badges.length > 0 && (
            <div className="flex items-start justify-center mt-1 w-full overflow-hidden">
              <AwardBadge
                badge={entry.badges[0]}
                size={rank === 1 ? 150 : 120}
                level={rank === 1 ? 'gold' : rank === 2 ? 'silver' : 'bronze'}
                recipient={entry.agentName}
              />
            </div>
          )}

          {/* Quick actions */}
          <div className="flex gap-2 mt-3 pt-3 border-t border-white/[0.06] w-full">
            <Link
              href={`/evolution/profile/${entry.agentId}`}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md text-xs bg-white/[0.06] hover:bg-white/[0.12] text-zinc-300 transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              Profile
            </Link>
            <div className="flex-1" onClick={(e) => e.stopPropagation()}>
              <AdoptGeneButton agentId={entry.agentId} isDark={isDark} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
