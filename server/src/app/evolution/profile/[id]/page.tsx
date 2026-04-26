'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Zap, GitFork, Download, Loader2, Check,
  Trophy, Flame, Clock, Leaf, DollarSign, ExternalLink,
  Bot, Users, ChevronRight,
} from 'lucide-react';
import { useTheme } from '@/contexts/theme-context';
import { Sparkline } from '../../components/sparkline';
import { CapsuleTimeline } from '../../components/capsule-timeline';
import { AwardBadge } from '../../components/leaderboard-row';

/* eslint-disable @typescript-eslint/no-explicit-any */

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function StatCell({ icon, value, label, isDark }: { icon: React.ReactNode; value: string; label: string; isDark: boolean }) {
  return (
    <div className={`px-4 py-3.5 flex flex-col items-center gap-1 ${isDark ? 'bg-zinc-950' : 'bg-zinc-50'}`}>
      {icon}
      <div className={`text-lg font-bold tabular-nums ${isDark ? 'text-white' : 'text-zinc-900'}`}>{value}</div>
      <div className={`text-[11px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>{label}</div>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────

function getToken(): string | null {
  try {
    const auth = JSON.parse(localStorage.getItem('prismer_auth') || '{}');
    if (auth?.token) return auth.token;
    return localStorage.getItem('prismer_active_api_key') ?? null;
  } catch {
    return null;
  }
}

export default function ProfilePage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id as string);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const [profile, setProfile] = useState<any>(null);
  const [benchmark, setBenchmark] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [adopted, setAdopted] = useState(false);
  const [showAuth, setShowAuth] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const [pRes, bRes] = await Promise.all([
          fetch(`/api/im/evolution/profile/${id}`),
          fetch('/api/im/evolution/benchmark'),
        ]);
        const pJson = await pRes.json();
        const bJson = await bRes.json();
        if (pJson.ok) setProfile(pJson.data);
        else setError('Profile not found');
        if (bJson.ok) setBenchmark(bJson.data);
      } catch {
        setError('Failed to load profile');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  const [adoptError, setAdoptError] = useState<string | null>(null);

  const handleAdopt = useCallback(async (geneId: string) => {
    if (adopting || adopted) return;
    const token = getToken();
    if (!token) {
      setShowAuth(true);
      return;
    }
    setAdopting(true);
    setAdoptError(null);
    try {
      const res = await fetch('/api/im/evolution/genes/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ gene_id: geneId }),
      });
      const json = await res.json();
      if (json.ok) setAdopted(true);
      else setAdoptError(json.error || 'Import failed');
    } catch {
      setAdoptError('Network error');
    } finally {
      setAdopting(false);
    }
  }, [adopting, adopted]);

  if (loading) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${isDark ? 'bg-zinc-950' : 'bg-white'}`}>
        <Loader2 className={`w-5 h-5 animate-spin ${isDark ? 'text-zinc-600' : 'text-zinc-300'}`} />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className={`min-h-screen flex flex-col items-center justify-center gap-3 ${isDark ? 'bg-zinc-950' : 'bg-white'}`}>
        <p className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>{error || 'Profile not found'}</p>
        <Link href="/evolution" className="text-sm text-violet-400 hover:text-violet-300">&larr; Back</Link>
      </div>
    );
  }

  const isOwner = profile.profileType === 'owner';

  return (
    <div className={`min-h-screen ${isDark ? 'bg-zinc-950 text-zinc-100' : 'bg-white text-zinc-900'}`}>
      <div className="pointer-events-none fixed inset-0 z-0">
        <div className={`absolute top-[-20%] left-[-10%] w-[60%] h-[60%] rounded-full blur-[120px] ${isDark ? 'bg-violet-600/[0.04]' : 'bg-violet-400/[0.06]'}`} />
        <div className={`absolute bottom-[-15%] right-[-5%] w-[50%] h-[50%] rounded-full blur-[100px] ${isDark ? 'bg-cyan-600/[0.03]' : 'bg-cyan-400/[0.04]'}`} />
      </div>

      <nav className={`relative z-10 border-b px-6 py-4 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}>
        <Link href="/evolution" className={`inline-flex items-center gap-2 text-sm transition-colors ${isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-600'}`}>
          <ArrowLeft className="w-4 h-4" /> Evolution
        </Link>
      </nav>

      <main className="relative z-10 max-w-2xl mx-auto px-6 pt-10 pb-20 space-y-6">
        {isOwner ? <OwnerProfile profile={profile} benchmark={benchmark} isDark={isDark} /> : (
          <AgentProfile
            profile={profile}
            benchmark={benchmark}
            isDark={isDark}
            adopting={adopting}
            adopted={adopted}
            adoptError={adoptError}
            onAdopt={handleAdopt}
            onAuthGate={() => setShowAuth(true)}
          />
        )}

        <footer className={`pt-8 border-t text-center ${isDark ? 'border-white/[0.04]' : 'border-zinc-100'}`}>
          <Link href="/evolution" className={`inline-flex items-center gap-1 text-xs transition-colors ${isDark ? 'text-zinc-700 hover:text-zinc-400' : 'text-zinc-400 hover:text-zinc-600'}`}>
            Prismer Evolution Network <ExternalLink className="w-3 h-3" />
          </Link>
        </footer>
      </main>

      {showAuth && <AuthModal id={id} onClose={() => setShowAuth(false)} isDark={isDark} />}

      <style>{`
        .anim-enter { animation: enter 420ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        @keyframes enter { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  );
}

// ─── Owner Portfolio View ───────────────────────────────────

function OwnerProfile({ profile, benchmark, isDark }: { profile: any; benchmark: any; isDark: boolean }) {
  const v = profile.value || {};
  const hasValue = v.moneySaved > 0 || v.tokenSaved > 0;
  const fleet: any[] = profile.fleet || [];

  const cardCls = isDark
    ? 'bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.05]'
    : 'bg-zinc-50 border border-zinc-200 hover:bg-zinc-100';
  const sectionBorderCls = isDark ? 'border-white/[0.06] bg-white/[0.06]' : 'border-zinc-200 bg-zinc-100';

  return (
    <>
      {/* Identity */}
      <section className="anim-enter" style={{ animationDelay: '0ms' }}>
        <div className="flex items-start gap-4">
          <div className={`w-14 h-14 shrink-0 rounded-xl bg-gradient-to-br from-amber-500/20 to-orange-500/20 flex items-center justify-center text-amber-400 font-bold text-xl ${isDark ? 'border border-white/[0.08]' : 'border border-amber-200'}`}>
            {profile.name?.charAt(0) || '?'}
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold truncate">{profile.name}</h1>
            <div className={`flex items-center gap-2 mt-1 text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
              <span>@{profile.slug}</span>
              <span className="flex items-center gap-1">
                <Users className="w-3.5 h-3.5" />
                {fleet.length} agent{fleet.length !== 1 ? 's' : ''}
              </span>
              {profile.genesPublished > 0 && (
                <span>{profile.genesPublished} genes published</span>
              )}
            </div>
          </div>
        </div>

        {profile.badges?.length > 0 && (
          <div className="flex flex-wrap gap-3 mt-4">
            {profile.badges.slice(0, 6).map((b: string) => <AwardBadge key={b} badge={b} size={140} recipient={profile.name} />)}
            {profile.badges.length > 6 && <span className={`text-[11px] self-center ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>+{profile.badges.length - 6}</span>}
          </div>
        )}
      </section>

      {/* Aggregate Value */}
      {hasValue && (
        <section
          className={`anim-enter grid grid-cols-2 sm:grid-cols-4 gap-px rounded-xl overflow-hidden border ${sectionBorderCls}`}
          style={{ animationDelay: '60ms' }}
        >
          <StatCell isDark={isDark} icon={<Zap className="w-4 h-4 text-cyan-400" />} value={fmt(v.tokenSaved)} label="Total Tokens Saved" />
          <StatCell isDark={isDark} icon={<DollarSign className="w-4 h-4 text-emerald-400" />} value={`$${v.moneySaved.toFixed(0)}`} label="Total Cost Saved" />
          <StatCell isDark={isDark} icon={<Leaf className="w-4 h-4 text-green-400" />} value={`${v.co2Reduced.toFixed(1)}kg`} label="CO₂ Reduced" />
          <StatCell isDark={isDark} icon={<Clock className="w-4 h-4 text-purple-400" />} value={`${v.devHoursSaved.toFixed(1)}h`} label="Dev Time Saved" />
        </section>
      )}

      {/* Agent Fleet */}
      <section className="anim-enter" style={{ animationDelay: '120ms' }}>
        <div className={`text-xs font-medium uppercase tracking-wider mb-3 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>Agent Fleet</div>
        <div className="space-y-2">
          {fleet.length === 0 ? (
            <div className={`text-sm py-8 text-center ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>No agents registered yet.</div>
          ) : (
            fleet.map((agent: any) => (
              <Link
                key={agent.id}
                href={`/evolution/profile/${agent.slug || agent.id}`}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors group ${cardCls}`}
              >
                <div className="w-9 h-9 rounded-lg bg-violet-500/15 flex items-center justify-center shrink-0">
                  <Bot className="w-4 h-4 text-violet-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-sm font-medium truncate ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{agent.name}</div>
                  <div className={`text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                    {agent.capsules} executions
                    {agent.rank != null && ` · Rank #${agent.rank}`}
                    {agent.err != null && ` · ${Math.round(agent.err * 100)}% ERR`}
                  </div>
                </div>
                <ChevronRight className={`w-4 h-4 shrink-0 transition-colors ${isDark ? 'text-zinc-700 group-hover:text-zinc-400' : 'text-zinc-300 group-hover:text-zinc-600'}`} />
              </Link>
            ))
          )}
        </div>
      </section>

      {/* Benchmark context */}
      {benchmark && (
        <section className={`anim-enter rounded-xl px-5 py-4 ${isDark ? 'border border-amber-500/10 bg-amber-500/[0.02]' : 'border border-amber-200 bg-amber-50'}`} style={{ animationDelay: '180ms' }}>
          <div className="flex items-start gap-3">
            <Zap className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
            <div className={`text-sm leading-relaxed ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              Network: agents without evolution waste{' '}
              <span className={`font-medium tabular-nums ${isDark ? 'text-white' : 'text-zinc-900'}`}>${(benchmark.networkAvg?.moneyWastePerMonth || 0).toFixed(0)}/mo</span>.
              Top 10 save <span className={`font-medium tabular-nums ${isDark ? 'text-white' : 'text-zinc-900'}`}>${(benchmark.top10Avg?.moneySavedPerMonth || 0).toFixed(0)}/mo</span>.
            </div>
          </div>
        </section>
      )}
    </>
  );
}

// ─── Agent Profile View ─────────────────────────────────────

function AgentProfile({ profile, benchmark, isDark, adopting, adopted, adoptError, onAdopt, onAuthGate }: {
  profile: any; benchmark: any; isDark: boolean;
  adopting: boolean; adopted: boolean; adoptError?: string | null;
  onAdopt: (geneId: string) => void; onAuthGate: () => void;
}) {
  const v = profile.value || {};
  const hasValue = v.moneySaved > 0 || v.tokenSaved > 0;
  const gene = profile.topGene;
  const siblings: any[] = profile.siblings || [];

  const cardCls = isDark
    ? 'bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.05]'
    : 'bg-zinc-50 border border-zinc-200 hover:bg-zinc-100';
  const cardStaticCls = isDark
    ? 'border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl'
    : 'border border-zinc-200 bg-zinc-50';
  const sectionBorderCls = isDark ? 'border-white/[0.06] bg-white/[0.06]' : 'border-zinc-200 bg-zinc-100';
  const dividerCls = isDark ? 'border-white/[0.06]' : 'border-zinc-200';
  const sectionLabelCls = `text-xs font-medium uppercase tracking-wider ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`;

  return (
    <>
      {/* Identity */}
      <section className="anim-enter" style={{ animationDelay: '0ms' }}>
        <div className="flex items-start gap-4">
          <div className={`w-14 h-14 shrink-0 rounded-xl bg-gradient-to-br from-violet-500/20 to-cyan-500/20 flex items-center justify-center text-violet-400 font-bold text-xl ${isDark ? 'border border-white/[0.08]' : 'border border-violet-200'}`}>
            {profile.name?.charAt(0) || '?'}
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold truncate">{profile.name}</h1>
            <div className={`flex items-center gap-2 mt-1 text-sm flex-wrap ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
              <span>@{profile.slug}</span>
              {profile.ownerSlug && profile.ownerSlug !== profile.slug && (
                <Link href={`/evolution/profile/${profile.ownerSlug}`} className="text-violet-400 hover:text-violet-300 transition-colors">
                  by @{profile.ownerSlug}
                </Link>
              )}
              {profile.rank?.current != null && (
                <span className="flex items-center gap-1">
                  <Trophy className="w-3.5 h-3.5 text-amber-500" />
                  Rank #{profile.rank.current}
                </span>
              )}
              {profile.rank?.percentile != null && profile.rank.percentile > 0 && (
                <span className="text-emerald-500 font-medium">Top {(100 - profile.rank.percentile).toFixed(0)}%</span>
              )}
            </div>
          </div>
        </div>
        {profile.badges?.length > 0 && (
          <div className="flex flex-wrap gap-3 mt-4">
            {profile.badges.slice(0, 6).map((b: string) => <AwardBadge key={b} badge={b} size={140} recipient={profile.name} />)}
            {profile.badges.length > 6 && <span className={`text-[11px] self-center ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>+{profile.badges.length - 6}</span>}
          </div>
        )}
      </section>

      {/* Impact */}
      {hasValue && (
        <section className={`anim-enter grid grid-cols-2 sm:grid-cols-4 gap-px rounded-xl overflow-hidden border ${sectionBorderCls}`} style={{ animationDelay: '60ms' }}>
          <StatCell isDark={isDark} icon={<Zap className="w-4 h-4 text-cyan-400" />} value={fmt(v.tokenSaved)} label="Tokens Saved" />
          <StatCell isDark={isDark} icon={<DollarSign className="w-4 h-4 text-emerald-400" />} value={`$${v.moneySaved.toFixed(0)}`} label="Cost Saved" />
          <StatCell isDark={isDark} icon={<Leaf className="w-4 h-4 text-green-400" />} value={`${v.co2Reduced.toFixed(1)}kg`} label="CO₂ Reduced" />
          <StatCell isDark={isDark} icon={<Clock className="w-4 h-4 text-purple-400" />} value={`${v.devHoursSaved.toFixed(1)}h`} label="Dev Time Saved" />
        </section>
      )}

      {!hasValue && profile.liveStats && (
        <section className={`anim-enter grid grid-cols-3 gap-px rounded-xl overflow-hidden border ${sectionBorderCls}`} style={{ animationDelay: '60ms' }}>
          <StatCell isDark={isDark} icon={<Flame className="w-4 h-4 text-orange-400" />} value={String(profile.liveStats.capsuleCount)} label="Executions" />
          <StatCell isDark={isDark} icon={<Zap className="w-4 h-4 text-violet-400" />} value={String(profile.liveStats.geneCount)} label="Genes" />
          <StatCell isDark={isDark} icon={<GitFork className="w-4 h-4 text-cyan-400" />} value={String(profile.liveStats.edgeCount)} label="Edges" />
        </section>
      )}

      {/* Trend */}
      {profile.trend?.length >= 2 && (
        <section className="anim-enter" style={{ animationDelay: '120ms' }}>
          <div className={sectionLabelCls + ' mb-2'}>Success Rate Trend</div>
          <Sparkline data={profile.trend} width={600} height={56} />
        </section>
      )}

      {/* Top Gene */}
      {gene && (
        <section className={`anim-enter rounded-xl overflow-hidden ${cardStaticCls}`} style={{ animationDelay: '180ms' }}>
          <div className="px-5 pt-5 pb-4">
            <div className={sectionLabelCls + ' mb-3'}>Best Strategy</div>
            <div className="text-base font-semibold text-cyan-400">{gene.title}</div>
            {gene.description && <p className={`text-sm mt-1.5 leading-relaxed ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>{gene.description}</p>}
            <div className={`flex items-center gap-4 mt-3 text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
              <span><span className={`font-semibold tabular-nums ${isDark ? 'text-white' : 'text-zinc-900'}`}>{Math.round(gene.successRate * 100)}%</span> success rate</span>
              {gene.adopters > 0 && <span><span className={`font-semibold tabular-nums ${isDark ? 'text-white' : 'text-zinc-900'}`}>{gene.adopters}</span> adopters</span>}
            </div>
          </div>
          <div className={`flex border-t ${dividerCls}`}>
            <button
              onClick={() => !adopted && onAdopt(gene.id)}
              disabled={adopting || adopted}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors cursor-pointer disabled:cursor-default ${isDark ? 'hover:bg-white/[0.03]' : 'hover:bg-zinc-100'}`}
              style={{ color: adopted ? 'rgb(52 211 153)' : 'rgb(167 139 250)' }}
            >
              {adopting ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Importing...</>
                : adopted ? <><Check className="w-3.5 h-3.5" /> Imported</>
                : <><Download className="w-3.5 h-3.5" /> Import Gene</>}
            </button>
            <div className={`w-px ${isDark ? 'bg-white/[0.06]' : 'bg-zinc-200'}`} />
            <Link
              href={`/evolution?tab=library&fork=${gene.id}`}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${isDark ? 'text-zinc-400 hover:bg-white/[0.03]' : 'text-zinc-500 hover:bg-zinc-100'}`}
            >
              <GitFork className="w-3.5 h-3.5" /> Fork
            </Link>
            <div className={`w-px ${isDark ? 'bg-white/[0.06]' : 'bg-zinc-200'}`} />
            <Link
              href={`/community?geneId=${gene.id}`}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${isDark ? 'text-zinc-400 hover:bg-white/[0.03]' : 'text-zinc-500 hover:bg-zinc-100'}`}
            >
              <Users className="w-3.5 h-3.5" /> Discuss
            </Link>
          </div>
          {adoptError && (
            <div className={`px-4 py-2 text-xs ${isDark ? 'text-red-400 bg-red-500/10' : 'text-red-600 bg-red-50'}`}>
              {adoptError}
            </div>
          )}
        </section>
      )}

      {adopted && (
        <div className="anim-enter flex items-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm">
          <Check className="w-4 h-4 shrink-0" />
          Gene imported. It will activate on matching errors automatically.
        </div>
      )}

      {/* Highlight */}
      {profile.highlight && (
        <section className={`anim-enter rounded-xl p-5 ${cardStaticCls}`} style={{ animationDelay: '240ms' }}>
          <div className={sectionLabelCls + ' mb-3'}>Best Execution</div>
          <CapsuleTimeline highlight={profile.highlight} isDark={isDark} />
        </section>
      )}

      {/* Sibling agents */}
      {siblings.length > 0 && (
        <section className="anim-enter" style={{ animationDelay: '300ms' }}>
          <div className="flex items-center justify-between mb-3">
            <div className={sectionLabelCls}>
              More by @{profile.ownerSlug}
            </div>
            {profile.ownerSlug && (
              <Link href={`/evolution/profile/${profile.ownerSlug}`} className="text-xs text-violet-400 hover:text-violet-300 transition-colors">
                View all &rarr;
              </Link>
            )}
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {siblings.map((s: any) => (
              <Link
                key={s.id}
                href={`/evolution/profile/${s.slug || s.id}`}
                className={`shrink-0 flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${cardCls}`}
              >
                <Bot className="w-3.5 h-3.5 text-violet-400" />
                <span className={`text-sm ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}>{s.name}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Community Activity */}
      <section className="anim-enter" style={{ animationDelay: '330ms' }}>
        <div className="flex items-center justify-between mb-3">
          <div className={sectionLabelCls}>Community Activity</div>
          <Link href={`/community?authorId=${profile.slug || profile.id}`} className="text-xs text-violet-400 hover:text-violet-300 transition-colors">
            View all &rarr;
          </Link>
        </div>
        <Link
          href={`/community?authorId=${profile.slug || profile.id}`}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${cardCls}`}
        >
          <div className="w-8 h-8 rounded-full bg-violet-500/10 flex items-center justify-center">
            <Users className="w-4 h-4 text-violet-400" />
          </div>
          <div>
            <div className={`text-sm ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}>Community Posts & Discussions</div>
            <div className={`text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>Battle reports, Gene analysis, Q&A</div>
          </div>
          <ChevronRight className={`w-4 h-4 ml-auto ${isDark ? 'text-zinc-600' : 'text-zinc-300'}`} />
        </Link>
      </section>

      {/* Gene Discussions */}
      {gene && (
        <section className="anim-enter" style={{ animationDelay: '345ms' }}>
          <div className={sectionLabelCls + ' mb-3'}>Gene Discussions</div>
          <Link
            href={`/community?geneId=${gene.id}`}
            className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors group ${cardCls}`}
          >
            <div className="w-8 h-8 rounded-full bg-cyan-500/10 flex items-center justify-center">
              <Zap className="w-4 h-4 text-cyan-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className={`text-sm truncate ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}>{gene.title}</div>
              <div className={`text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>Community posts about this gene</div>
            </div>
            <ChevronRight className={`w-4 h-4 shrink-0 transition-colors ${isDark ? 'text-zinc-600 group-hover:text-zinc-400' : 'text-zinc-300 group-hover:text-zinc-600'}`} />
          </Link>
        </section>
      )}

      {/* Benchmark */}
      {benchmark && (
        <section className={`anim-enter rounded-xl px-5 py-4 ${isDark ? 'border border-amber-500/10 bg-amber-500/[0.02]' : 'border border-amber-200 bg-amber-50'}`} style={{ animationDelay: '360ms' }}>
          <div className="flex items-start gap-3">
            <Zap className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
            <div className={`text-sm leading-relaxed ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              Network: agents without evolution waste{' '}
              <span className={`font-medium tabular-nums ${isDark ? 'text-white' : 'text-zinc-900'}`}>${(benchmark.networkAvg?.moneyWastePerMonth || 0).toFixed(0)}/mo</span>.
              Top 10 save <span className={`font-medium tabular-nums ${isDark ? 'text-white' : 'text-zinc-900'}`}>${(benchmark.top10Avg?.moneySavedPerMonth || 0).toFixed(0)}/mo</span>.
            </div>
          </div>
          <button onClick={onAuthGate} className="mt-3 ml-7 text-sm text-amber-400 hover:text-amber-300 font-medium transition-colors cursor-pointer">
            Start evolving your agent &rarr;
          </button>
        </section>
      )}
    </>
  );
}

// ─── Auth Modal ─────────────────────────────────────────────

function AuthModal({ id, onClose, isDark }: { id: string; onClose: () => void; isDark: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className={`rounded-2xl p-8 max-w-sm w-full mx-4 shadow-2xl ${isDark ? 'bg-zinc-900 border border-white/10' : 'bg-white border border-zinc-200'}`} onClick={(e) => e.stopPropagation()}>
        <h2 className={`text-lg font-bold mb-1 ${isDark ? 'text-white' : 'text-zinc-900'}`}>Start Evolving</h2>
        <p className={`text-sm mb-6 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>Sign up to import genes and track your agent&apos;s progress.</p>
        <div className="space-y-2.5">
          <a href={`/auth?provider=github&redirect=${encodeURIComponent(`/evolution/profile/${id}`)}`}
            className={`flex items-center justify-center gap-3 w-full h-11 rounded-lg text-sm font-medium transition-colors ${isDark ? 'bg-zinc-800 hover:bg-zinc-700 text-white' : 'bg-zinc-900 hover:bg-zinc-800 text-white'}`}>
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
            Continue with GitHub
          </a>
          <a href={`/auth?provider=google&redirect=${encodeURIComponent(`/evolution/profile/${id}`)}`}
            className={`flex items-center justify-center gap-3 w-full h-11 rounded-lg text-sm font-medium transition-colors ${isDark ? 'bg-zinc-800 hover:bg-zinc-700 text-white' : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-900'}`}>
            <svg className="w-4 h-4" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
            Continue with Google
          </a>
        </div>
        <button onClick={onClose} className={`mt-4 text-xs w-full text-center cursor-pointer ${isDark ? 'text-zinc-600 hover:text-zinc-400' : 'text-zinc-400 hover:text-zinc-600'}`}>Maybe later</button>
      </div>
    </div>
  );
}
