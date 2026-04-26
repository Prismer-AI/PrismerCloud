'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import {
  Trophy,
  Users,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Bot,
  ChevronRight,
  ChevronDown,
  ExternalLink,
} from 'lucide-react';
import {
  glass,
  type LeaderboardAgentEntry,
  type LeaderboardContributorEntry,
  type LeaderboardRisingEntry,
  type LeaderboardHeroData,
} from './helpers';
import { LeaderboardHero } from './leaderboard-hero';
import { LeaderboardList } from './leaderboard-list';
import { Sparkline } from './sparkline';

type SubTab = 'agents' | 'contributors' | 'rising';
type TimePeriod = 'weekly' | 'monthly' | 'alltime';

const SUB_TABS: { key: SubTab; label: string; icon: typeof Trophy }[] = [
  { key: 'agents', label: 'Agent Power', icon: Trophy },
  { key: 'contributors', label: 'Contributors', icon: Users },
  { key: 'rising', label: 'Rising Stars', icon: TrendingUp },
];

const TIME_LABELS: Record<TimePeriod, string> = {
  weekly: 'W',
  monthly: 'M',
  alltime: 'All',
};

interface LeaderboardTabProps {
  isDark: boolean;
  isAuthenticated: boolean;
  currentAgentId?: string;
}

const AGENT_SORTS = [
  { key: 'value', label: 'Value' },
  { key: 'err', label: 'ERR' },
  { key: 'success', label: 'Success' },
  { key: 'growth', label: 'Growth' },
];
const CONTRIBUTOR_SORTS = [
  { key: 'impact', label: 'Impact' },
  { key: 'reach', label: 'Reach' },
  { key: 'genes', label: 'Genes' },
  { key: 'value', label: 'Value' },
];

export function LeaderboardTab({ isDark, currentAgentId }: LeaderboardTabProps) {
  const [subTab, setSubTab] = useState<SubTab>('agents');
  const [period, setPeriod] = useState<TimePeriod>('weekly');
  const [sortBy, setSortBy] = useState<string>('value');
  const [heroData, setHeroData] = useState<LeaderboardHeroData | null>(null);
  const [agentEntries, setAgentEntries] = useState<LeaderboardAgentEntry[]>([]);
  const [contributorEntries, setContributorEntries] = useState<LeaderboardContributorEntry[]>([]);
  const [risingEntries, setRisingEntries] = useState<LeaderboardRisingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [contentKey, setContentKey] = useState(0);

  // Tab indicator refs
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });

  // Update indicator position when subTab changes
  useEffect(() => {
    const container = tabsContainerRef.current;
    if (!container) return;
    const activeBtn = container.querySelector<HTMLButtonElement>(`[data-tab="${subTab}"]`);
    if (activeBtn) {
      const containerRect = container.getBoundingClientRect();
      const btnRect = activeBtn.getBoundingClientRect();
      setIndicatorStyle({
        left: btnRect.left - containerRect.left,
        width: btnRect.width,
      });
    }
  }, [subTab]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch hero data
      let heroSuccess = false;
      try {
        const heroRes = await fetch('/api/im/evolution/leaderboard/hero');
        if (heroRes.ok) {
          const heroJson = await heroRes.json();
          if (heroJson.ok && heroJson.data) {
            setHeroData(heroJson.data);
            heroSuccess = true;
          }
        }
      } catch {
        // Hero fetch failed — will use fallback below
      }

      // Fetch current sub-tab data
      if (subTab === 'agents') {
        const res = await fetch(`/api/im/evolution/leaderboard/agents?period=${period}&limit=50&sort=${sortBy}`);
        const json = await res.json();
        if (json.ok) {
          const raw = json.data?.agents || json.data?.entries || [];
          const mapped = raw.map((e: any) => ({
            ...e,
            value: {
              tokenSaved: e.value?.tokenSaved || e.tokenSaved || 0,
              moneySaved: e.value?.moneySaved || e.moneySaved || 0,
              co2Reduced: e.value?.co2Reduced || e.co2Reduced || 0,
              devHoursSaved: e.value?.devHoursSaved || e.devHoursSaved || 0,
            },
            badges: e.badges || [],
            trend: e.trend || e.trendData || [],
            prevRank: e.prevRank ?? null,
            rankChange: e.rankChange ?? null,
            percentile: e.percentile ?? null,
            growthRate: e.growthRate ?? null,
          }));
          setAgentEntries(mapped);

          // Compute hero fallback from agent entries if hero API failed
          if (!heroSuccess && mapped.length > 0) {
            const totalMoney = mapped.reduce((s: number, a: any) => s + (a.value?.moneySaved || 0), 0);
            const totalCO2 = mapped.reduce((s: number, a: any) => s + (a.value?.co2Reduced || 0), 0);
            const totalHours = mapped.reduce((s: number, a: any) => s + (a.value?.devHoursSaved || 0), 0);
            const totalTokens = mapped.reduce((s: number, a: any) => s + (a.value?.tokenSaved || 0), 0);
            const now = new Date();
            const weekNum = Math.ceil((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 604800000);
            setHeroData({
              global: {
                totalTokenSaved: totalTokens,
                totalMoneySaved: totalMoney,
                totalCo2Reduced: totalCO2,
                totalDevHoursSaved: totalHours,
              },
              network: { totalAgentsEvolving: mapped.length, totalGenesPublished: 0, totalGeneTransfers: 0 },
              period: { label: `Week ${weekNum}, ${now.getFullYear()}`, weeklyGrowth: null },
            });
          }
        }
      } else if (subTab === 'contributors') {
        const res = await fetch(`/api/im/evolution/leaderboard/contributors?period=${period}&limit=50&sort=${sortBy}`);
        const json = await res.json();
        if (json.ok) {
          const raw = json.data?.contributors || json.data?.entries || [];
          setContributorEntries(raw);
        }
      } else if (subTab === 'rising') {
        const res = await fetch('/api/im/evolution/leaderboard/rising?limit=20');
        const json = await res.json();
        if (json.ok) setRisingEntries(json.data?.entries || []);
      }
    } catch {
      setError('Failed to load leaderboard');
    } finally {
      setLoading(false);
      setContentKey((k) => k + 1);
    }
  }, [subTab, period, sortBy]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <div className="space-y-6">
      {/* Hero */}
      <LeaderboardHero
        data={heroData}
        isDark={isDark}
        onStatClick={(sort) => {
          setSubTab('agents');
          setSortBy(sort);
        }}
      />

      {/* Sub-tab + Time selector row */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        {/* Sub-tabs with sliding indicator */}
        <div ref={tabsContainerRef} className="relative flex gap-1" role="tablist" aria-label="Leaderboard categories">
          {/* Sliding indicator */}
          <div
            className={`absolute bottom-0 h-0.5 rounded-full ${isDark ? 'bg-violet-500' : 'bg-violet-600'}`}
            style={{
              left: indicatorStyle.left,
              width: indicatorStyle.width,
              transition: 'left 200ms cubic-bezier(0.22, 1, 0.36, 1), width 200ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          />

          {SUB_TABS.map((tab) => (
            <button
              key={tab.key}
              data-tab={tab.key}
              role="tab"
              aria-selected={subTab === tab.key}
              onClick={() => setSubTab(tab.key)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm transition-colors relative ${
                subTab === tab.key
                  ? isDark
                    ? 'text-white'
                    : 'text-zinc-900'
                  : isDark
                    ? 'text-zinc-500 hover:text-zinc-300'
                    : 'text-zinc-400 hover:text-zinc-600'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Time selector + Sort selector (not shown for rising) */}
        {subTab !== 'rising' && (
          <div className="flex items-center gap-2">
            <div className={`flex rounded-lg p-0.5 text-xs ${isDark ? 'bg-zinc-800/50' : 'bg-zinc-100'}`}>
              {(Object.entries(TIME_LABELS) as [TimePeriod, string][]).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setPeriod(key)}
                  className={`px-3 py-1.5 rounded-md transition-all duration-150 ${
                    period === key
                      ? isDark
                        ? 'bg-white/[0.08] text-white shadow-sm'
                        : 'bg-white text-zinc-900 shadow-sm'
                      : isDark
                        ? 'text-zinc-500 hover:text-zinc-300'
                        : 'text-zinc-400 hover:text-zinc-600'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className={`flex rounded-lg p-0.5 text-xs ${isDark ? 'bg-zinc-800/50' : 'bg-zinc-100'}`}>
              {(subTab === 'agents' ? AGENT_SORTS : CONTRIBUTOR_SORTS).map((s) => (
                <button
                  key={s.key}
                  onClick={() => setSortBy(s.key)}
                  className={`px-2.5 py-1.5 rounded-md transition-all duration-150 ${
                    sortBy === s.key
                      ? isDark
                        ? 'bg-white/[0.08] text-white shadow-sm'
                        : 'bg-white text-zinc-900 shadow-sm'
                      : isDark
                        ? 'text-zinc-500 hover:text-zinc-300'
                        : 'text-zinc-400 hover:text-zinc-600'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div
          className={`rounded-lg p-3 flex items-center gap-3 ${isDark ? 'bg-red-500/10 border border-red-500/20' : 'bg-red-50 border border-red-200'}`}
        >
          <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
          <span className={`text-sm ${isDark ? 'text-red-400' : 'text-red-600'}`}>{error}</span>
          <button
            onClick={fetchData}
            className={`text-xs underline ml-auto ${isDark ? 'text-red-300' : 'text-red-500'}`}
          >
            Retry
          </button>
        </div>
      )}

      {/* Content with spring entrance animation */}
      <div
        key={contentKey}
        style={{
          animation: 'leaderboardContentIn 350ms cubic-bezier(0.22, 1, 0.36, 1) both',
        }}
      >
        <style>{`
          @keyframes leaderboardContentIn {
            from {
              opacity: 0;
              transform: translateY(8px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
        `}</style>

        {/* Agents tab */}
        {subTab === 'agents' && !loading && (
          <LeaderboardList entries={agentEntries} isDark={isDark} currentAgentId={currentAgentId} />
        )}

        {/* Contributors tab */}
        {subTab === 'contributors' && !loading && (
          <PaginatedSubList
            entries={contributorEntries}
            isDark={isDark}
            emptyIcon={
              <Users className={`w-10 h-10 ${isDark ? 'text-zinc-600' : 'text-zinc-300'}`} strokeWidth={1.5} />
            }
            emptyText="No contributors yet -- publish your Gene to help other Agents"
            renderItem={(entry) => (
              <Link
                key={entry.agentId}
                href={`/evolution/profile/${entry.ownerUsername || entry.agentId}`}
                className={`block rounded-xl px-4 py-3 relative overflow-hidden ${glass(isDark, 'subtle')} focus-visible:outline-2 focus-visible:outline-violet-500 focus-visible:outline-offset-2 group active:scale-[0.985] active:duration-75`}
                style={{ transition: 'transform 400ms cubic-bezier(0.34, 1.56, 0.64, 1)' }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.transform = 'translateY(0)';
                }}
              >
                <div className="flex items-center gap-4">
                  <div
                    className={`w-10 text-center font-bold tabular-nums text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}
                  >
                    #{entry.rank}
                  </div>
                  <div className="w-10 flex justify-center">
                    {entry.rankChange && entry.rankChange > 0 ? (
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
                      <span className="text-[10px] bg-amber-500/15 text-amber-400 px-1.5 py-0.5 rounded-full font-medium">
                        NEW
                      </span>
                    ) : null}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className={`font-medium text-sm truncate ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                      {entry.agentName}
                    </div>
                    <div className={`flex items-center gap-2 text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                      <span>@{entry.ownerUsername}</span>
                      {entry.agentCount != null && entry.agentCount > 0 && (
                        <span className="flex items-center gap-0.5">
                          <Bot className="w-3 h-3" />
                          {entry.agentCount} agent{entry.agentCount !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-emerald-400 font-semibold tabular-nums text-sm">
                      {entry.genesPublished} genes
                    </div>
                    <div className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                      {entry.agentsHelped} agents helped
                    </div>
                  </div>
                  <div className="text-right w-24 hidden md:block">
                    <div className="text-emerald-400 tabular-nums text-sm">
                      ${entry.value?.moneySaved?.toFixed(0) || 0}
                    </div>
                    <div className={`text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>value created</div>
                  </div>
                  <div className="flex gap-2 ml-auto">
                    <span
                      className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs ${isDark ? 'bg-white/[0.06] hover:bg-white/[0.12] text-zinc-400 hover:text-zinc-200' : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-500 hover:text-zinc-700'} transition-colors`}
                    >
                      <ExternalLink className="w-3 h-3" />
                      Profile
                    </span>
                  </div>
                  <ChevronRight
                    className={`w-4 h-4 shrink-0 ${isDark ? 'text-zinc-700 group-hover:text-zinc-400' : 'text-zinc-300 group-hover:text-zinc-600'} transition-colors`}
                  />
                </div>
              </Link>
            )}
          />
        )}

        {/* Rising tab */}
        {subTab === 'rising' && !loading && (
          <PaginatedSubList
            entries={risingEntries}
            isDark={isDark}
            emptyIcon={
              <TrendingUp className={`w-10 h-10 ${isDark ? 'text-zinc-600' : 'text-zinc-300'}`} strokeWidth={1.5} />
            }
            emptyText="No rising stars yet -- start evolving this week to make the board"
            renderItem={(entry) => (
              <Link
                key={entry.entityId}
                href={`/evolution/profile/${entry.entitySlug || entry.entityId}`}
                className={`block rounded-xl px-4 py-3 relative overflow-hidden ${glass(isDark, 'subtle')} focus-visible:outline-2 focus-visible:outline-violet-500 focus-visible:outline-offset-2 group active:scale-[0.985] active:duration-75`}
                style={{ transition: 'transform 400ms cubic-bezier(0.34, 1.56, 0.64, 1)' }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.transform = 'translateY(0)';
                }}
              >
                <div className="flex items-center gap-4">
                  <div
                    className={`w-10 text-center font-bold tabular-nums text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}
                  >
                    #{entry.rank}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className={`font-medium text-sm truncate ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                      {entry.entityName}
                    </div>
                    <div className={`text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                      {entry.entityType === 'agent' ? 'Agent' : 'Creator'}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-emerald-400 font-bold tabular-nums text-sm">
                      +{Math.round(entry.growthRate * 100)}%
                    </div>
                    <div className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>growth</div>
                  </div>
                  <div className="w-20 hidden md:flex items-center">
                    {entry.trend && entry.trend.length >= 2 && <Sparkline data={entry.trend} width={80} height={24} />}
                  </div>
                  <div className="text-right w-24 hidden md:block">
                    <div className={`tabular-nums text-sm ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                      ${entry.currentValue.toFixed(0)}
                    </div>
                    <div className={`text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>current value</div>
                  </div>
                  <div className="flex gap-2 ml-auto">
                    <span
                      className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs ${isDark ? 'bg-white/[0.06] hover:bg-white/[0.12] text-zinc-400 hover:text-zinc-200' : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-500 hover:text-zinc-700'} transition-colors`}
                    >
                      <ExternalLink className="w-3 h-3" />
                      Profile
                    </span>
                  </div>
                  <ChevronRight
                    className={`w-4 h-4 shrink-0 ${isDark ? 'text-zinc-700 group-hover:text-zinc-400' : 'text-zinc-300 group-hover:text-zinc-600'} transition-colors`}
                  />
                </div>
              </Link>
            )}
          />
        )}
      </div>

      {/* Loading skeleton for list */}
      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className={`rounded-xl h-16 ${glass(isDark, 'subtle')} animate-pulse`}>
              <div className="flex items-center gap-4 px-4 h-full">
                <div className={`w-10 h-5 rounded ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`} />
                <div
                  className={`flex-1 h-4 rounded ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`}
                  style={{ maxWidth: `${30 + i * 5}%` }}
                />
                <div className={`w-20 h-5 rounded ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`} />
                <div className={`w-16 h-5 rounded hidden md:block ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Paginated sub-list for contributors/rising ───────────── */

const SUB_PAGE_SIZE = 15;
const SPRING_BOUNCE_TAB = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

function PaginatedSubList<T>({
  entries,
  isDark,
  emptyIcon,
  emptyText,
  renderItem,
}: {
  entries: T[];
  isDark: boolean;
  emptyIcon: React.ReactNode;
  emptyText: string;
  renderItem: (entry: T, index: number) => React.ReactNode;
}) {
  const [visibleCount, setVisibleCount] = useState(SUB_PAGE_SIZE);
  const [prevCount, setPrevCount] = useState(SUB_PAGE_SIZE);

  useEffect(() => {
    setVisibleCount(SUB_PAGE_SIZE);
    setPrevCount(SUB_PAGE_SIZE);
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className={`rounded-full p-4 mb-4 ${isDark ? 'bg-zinc-800/50' : 'bg-zinc-100'}`}>{emptyIcon}</div>
        <p className={`text-sm max-w-sm ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>{emptyText}</p>
      </div>
    );
  }

  const visible = entries.slice(0, visibleCount);
  const hasMore = entries.length > visibleCount;
  const remaining = entries.length - visibleCount;

  return (
    <>
      <div className="space-y-2">
        {visible.map((entry, i) => {
          const isNew = i >= prevCount;
          return (
            <div
              key={i}
              style={
                isNew ? { animation: `tabRowIn 450ms ${SPRING_BOUNCE_TAB} ${(i - prevCount) * 40}ms both` } : undefined
              }
            >
              {renderItem(entry, i)}
            </div>
          );
        })}
      </div>
      {hasMore && (
        <div className="flex justify-center mt-6">
          <button
            onClick={() => {
              setPrevCount(visibleCount);
              setVisibleCount((c) => Math.min(c + SUB_PAGE_SIZE, entries.length));
            }}
            className={`group flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-medium active:scale-[0.96] active:duration-75 ${glass(
              isDark,
              'subtle',
            )} ${isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-500 hover:text-zinc-800'}`}
            style={{ transition: `all 300ms ${SPRING_BOUNCE_TAB}` }}
          >
            <span>Show More</span>
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${isDark ? 'bg-white/[0.06] text-zinc-500' : 'bg-zinc-100 text-zinc-400'}`}
            >
              {remaining}
            </span>
            <ChevronDown className="w-4 h-4 transition-transform group-hover:translate-y-0.5" />
          </button>
        </div>
      )}
      <style>{`
        @keyframes tabRowIn {
          0% { opacity: 0; transform: translateY(16px) scale(0.97); }
          60% { opacity: 1; transform: translateY(-3px) scale(1.005); }
          80% { transform: translateY(1px) scale(0.998); }
          100% { transform: translateY(0) scale(1); }
        }
      `}</style>
    </>
  );
}
