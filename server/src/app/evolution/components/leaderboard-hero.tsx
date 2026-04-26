'use client';

import { useState, useEffect, useId } from 'react';
import { Coins, Leaf, Clock } from 'lucide-react';
import { glass, type LeaderboardHeroData } from './helpers';

/* ── Animated counter with spring easing ─────────────────── */

function AnimatedNumber({
  value,
  duration = 800,
  decimals = 0,
}: {
  value: number;
  duration?: number;
  decimals?: number;
}) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    if (value === 0) {
      setDisplay(0);
      return;
    }
    const start = performance.now();
    let raf: number;
    function tick(now: number) {
      const t = Math.min((now - start) / duration, 1);
      // spring-like easing: overshoot then settle
      const eased = t < 1 ? 1 - Math.pow(1 - t, 3) + (t < 0.7 ? Math.sin(t * Math.PI) * 0.05 : 0) : 1;
      setDisplay(value * Math.min(eased, 1));
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  const formatted = decimals > 0 ? display.toFixed(decimals) : Math.round(display).toLocaleString();
  return <>{formatted}</>;
}

/* ── Mini inline sparkline for hero cards ────────────────── */

function MiniSparkline({ data, color }: { data: number[]; color: string }) {
  const id = useId();
  const w = 64;
  const h = 20;
  const pad = 1;

  if (data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const points = data.map((v, i) => ({
    x: pad + (i / (data.length - 1)) * (w - pad * 2),
    y: pad + (1 - (v - min) / range) * (h - pad * 2),
  }));
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const area = `${line} L ${points[points.length - 1].x} ${h} L ${points[0].x} ${h} Z`;
  const gradId = `hero-spark-${id.replace(/:/g, '')}`;

  return (
    <svg width={w} height={h} className="mx-auto mt-1.5 opacity-60">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.3} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ── Hero Component ──────────────────────────────────────── */

interface LeaderboardHeroProps {
  data: LeaderboardHeroData | null;
  isDark: boolean;
  onStatClick?: (sortBy: string) => void;
}

// Trend data will come from API when available; empty array hides sparkline gracefully

export function LeaderboardHero({ data, isDark, onStatClick }: LeaderboardHeroProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!data) {
    return (
      <div className={`rounded-2xl p-6 md:p-8 ${glass(isDark, 'hero')} relative overflow-hidden`}>
        {/* Skeleton */}
        <div className="flex flex-col md:flex-row items-center justify-center gap-6 md:gap-10">
          {[1, 2, 3].map((i) => (
            <div key={i} className="text-center space-y-2 w-full md:w-auto">
              <div className={`h-5 w-5 rounded-full mx-auto ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'} animate-pulse`} />
              <div className={`h-10 w-32 rounded-lg mx-auto ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'} animate-pulse`} />
              <div
                className={`h-3 w-20 rounded mx-auto ${isDark ? 'bg-zinc-800/60' : 'bg-zinc-200/60'} animate-pulse`}
              />
              <div
                className={`h-5 w-16 rounded mx-auto ${isDark ? 'bg-zinc-800/40' : 'bg-zinc-200/40'} animate-pulse`}
              />
            </div>
          ))}
        </div>
        <div className={`mt-6 flex justify-center gap-4`}>
          {[1, 2, 3].map((i) => (
            <div key={i} className={`h-3 w-24 rounded ${isDark ? 'bg-zinc-800/40' : 'bg-zinc-200/40'} animate-pulse`} />
          ))}
        </div>
      </div>
    );
  }

  const moneySavedVal = Math.round(data.global.totalMoneySaved || 0);
  const co2Val = Math.round((data.global.totalCo2Reduced || 0) * 10) / 10;
  const hoursVal = Math.round(data.global.totalDevHoursSaved || 0);

  // Value metrics all zero — show network activity stats instead
  if (moneySavedVal === 0 && co2Val === 0 && hoursVal === 0) {
    const networkStats = [
      {
        value: data.network.totalAgentsEvolving,
        label: 'Agents Evolving',
        color: isDark ? '#34d399' : '#10b981',
        textColor: 'text-emerald-400',
      },
      {
        value: data.network.totalGenesPublished,
        label: 'Genes Published',
        color: isDark ? '#60a5fa' : '#3b82f6',
        textColor: 'text-blue-400',
      },
      {
        value: data.network.totalGeneTransfers,
        label: 'Gene Transfers',
        color: isDark ? '#c084fc' : '#a855f7',
        textColor: 'text-purple-400',
      },
    ];
    return (
      <div className={`rounded-2xl relative overflow-hidden ${glass(isDark, 'hero')}`}>
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: isDark
              ? 'radial-gradient(ellipse 80% 60% at 20% 10%, rgba(139,92,246,0.06) 0%, transparent 70%), radial-gradient(ellipse 60% 50% at 80% 80%, rgba(6,182,212,0.04) 0%, transparent 70%)'
              : 'radial-gradient(ellipse 80% 60% at 20% 10%, rgba(139,92,246,0.08) 0%, transparent 70%), radial-gradient(ellipse 60% 50% at 80% 80%, rgba(6,182,212,0.06) 0%, transparent 70%)',
          }}
        />
        <div className="relative z-10 p-6 md:p-8">
          <div className={`text-center text-xs font-medium mb-4 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
            Evolution Network &middot; {data.period.label}
          </div>
          <div className="flex flex-col md:flex-row items-stretch justify-center">
            {networkStats.map((s, i) => (
              <div key={s.label} className="flex-1 text-center py-3 md:py-0 md:px-6 relative">
                {i > 0 && (
                  <div
                    className={`hidden md:block absolute left-0 top-1/2 -translate-y-1/2 h-12 w-px ${isDark ? 'bg-white/[0.06]' : 'bg-zinc-200'}`}
                  />
                )}
                {i > 0 && (
                  <div
                    className={`block md:hidden mx-auto mb-3 w-12 h-px ${isDark ? 'bg-white/[0.06]' : 'bg-zinc-200'}`}
                  />
                )}
                <div className={`text-3xl md:text-4xl font-bold tabular-nums tracking-tight ${s.textColor}`}>
                  <AnimatedNumber value={s.value} />
                </div>
                <div className={`text-xs mt-1 font-medium ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const stats = [
    {
      value: moneySavedVal,
      label: 'Token Value Saved',
      prefix: '$',
      suffix: '',
      color: isDark ? '#34d399' : '#10b981',
      textColor: 'text-emerald-400',
      Icon: Coins,
      trend: [],
      decimals: 0,
      tooltip: `\u2248 ${Math.ceil(moneySavedVal / 50)} months of Claude for a solo dev`,
      sortKey: 'value',
    },
    {
      value: co2Val,
      label: 'CO\u2082 Reduced',
      prefix: '',
      suffix: ' kg',
      color: isDark ? '#60a5fa' : '#3b82f6',
      textColor: 'text-blue-400',
      Icon: Leaf,
      trend: [],
      decimals: 1,
      tooltip: `\u2248 ${Math.ceil(co2Val)} trees absorbing CO\u2082 for a day`,
      sortKey: 'err',
    },
    {
      value: hoursVal,
      label: 'Dev Hours Saved',
      prefix: '',
      suffix: ' hrs',
      color: isDark ? '#c084fc' : '#a855f7',
      textColor: 'text-purple-400',
      Icon: Clock,
      trend: [],
      decimals: 0,
      tooltip: `\u2248 ${Math.ceil(hoursVal / 8)} full workdays recovered`,
      sortKey: 'growth',
    },
  ];

  return (
    <div className={`rounded-2xl relative overflow-hidden ${glass(isDark, 'hero')}`}>
      {/* Cosmic dust gradient background */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: isDark
            ? 'radial-gradient(ellipse 80% 60% at 20% 10%, rgba(139,92,246,0.06) 0%, transparent 70%), radial-gradient(ellipse 60% 50% at 80% 80%, rgba(6,182,212,0.04) 0%, transparent 70%)'
            : 'radial-gradient(ellipse 80% 60% at 20% 10%, rgba(139,92,246,0.08) 0%, transparent 70%), radial-gradient(ellipse 60% 50% at 80% 80%, rgba(6,182,212,0.06) 0%, transparent 70%)',
        }}
      />

      <div className="relative z-10 p-6 md:p-8">
        {/* Three value blocks */}
        <div className="flex flex-col md:flex-row items-stretch justify-center">
          {stats.map((s, i) => (
            <div
              key={s.label}
              className="flex-1 text-center py-4 md:py-0 md:px-6"
              style={{
                opacity: mounted ? 1 : 0,
                transform: mounted ? 'translateY(0)' : 'translateY(16px)',
                transition: `transform 500ms cubic-bezier(0.34, 1.56, 0.64, 1) ${i * 100}ms, opacity 300ms ease-out ${i * 100}ms`,
              }}
            >
              {/* Vertical divider between items (md+) */}
              {i > 0 && (
                <div
                  className={`hidden md:block absolute left-0 top-1/2 -translate-y-1/2 h-16 w-px ${isDark ? 'bg-white/[0.06]' : 'bg-zinc-200'}`}
                  style={{ position: 'absolute' }}
                />
              )}
              {/* Horizontal divider between items (sm) */}
              {i > 0 && (
                <div
                  className={`block md:hidden mx-auto mb-4 w-16 h-px ${isDark ? 'bg-white/[0.06]' : 'bg-zinc-200'}`}
                />
              )}
              <button
                onClick={() => onStatClick?.(s.sortKey)}
                className="relative group cursor-pointer text-center w-full"
              >
                {/* Icon */}
                <s.Icon className={`w-5 h-5 mx-auto mb-2 ${s.textColor}`} strokeWidth={1.5} />

                {/* Animated number */}
                <div className={`text-3xl md:text-4xl font-bold tabular-nums tracking-tight ${s.textColor}`}>
                  {s.prefix}
                  <AnimatedNumber value={typeof s.value === 'number' ? s.value : 0} decimals={s.decimals} />
                  {s.suffix}
                </div>

                {/* Label */}
                <div className={`text-xs mt-1 font-medium ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                  {s.label}
                </div>

                {/* Mini sparkline */}
                <MiniSparkline data={s.trend} color={s.color} />

                {/* Humanized tooltip */}
                <div
                  className={`absolute top-full left-1/2 -translate-x-1/2 mt-2 px-3 py-1.5 rounded-lg text-[11px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20 ${isDark ? 'bg-zinc-800 border border-white/10 text-zinc-400' : 'bg-zinc-900 border border-zinc-700 text-zinc-300'}`}
                >
                  {s.tooltip}
                </div>
              </button>
            </div>
          ))}
        </div>

        {/* Bottom row: network stats */}
        <div
          className={`flex items-center justify-center gap-2 md:gap-4 mt-6 pt-4 text-xs flex-wrap ${isDark ? 'text-zinc-600 border-t border-white/[0.04]' : 'text-zinc-400 border-t border-zinc-100'}`}
          style={{
            opacity: mounted ? 1 : 0,
            transition: 'opacity 400ms ease-out 350ms',
          }}
        >
          <span>{data.network.totalAgentsEvolving.toLocaleString()} agents evolving</span>
          <span className={isDark ? 'text-zinc-700' : 'text-zinc-300'}>&middot;</span>
          <span>{data.network.totalGenesPublished.toLocaleString()} genes published</span>
          <span className={isDark ? 'text-zinc-700' : 'text-zinc-300'}>&middot;</span>
          <span>{data.period.label}</span>
          {data.period.weeklyGrowth !== null && data.period.weeklyGrowth > 0 && (
            <>
              <span className={isDark ? 'text-zinc-700' : 'text-zinc-300'}>&middot;</span>
              <span className="text-emerald-500">+{Math.round(data.period.weeklyGrowth * 100)}% this week</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
