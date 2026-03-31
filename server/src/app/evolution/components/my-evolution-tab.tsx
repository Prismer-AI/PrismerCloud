'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  Dna,
  Zap,
  TrendingUp,
  Star,
  User,
  ArrowRight,
  Trophy,
  Loader2,
  GitFork,
  Plus,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Filter,
} from 'lucide-react';
import { type Achievement, type LeaderboardEntry, type PublicGene, CAT_COLORS, glass } from './helpers';
import { GeneCreateSheet } from './gene-create-sheet';
import { GeneDetailDrawer } from './gene-detail-drawer';
import { GenePublishDialog } from './gene-publish-dialog';
import { GeneForkSheet } from './gene-fork-sheet';
import { SkillUploadSheet } from './skill-upload-sheet';
import { CapsuleDetailDrawer } from './capsule-detail-drawer';
import { DistillationLab } from './distillation-lab';

/* ─── Types ──────────────────────────────────────────── */

interface MyEvolutionTabProps {
  isDark: boolean;
  isAuthenticated: boolean;
}

interface MyGene {
  id: string;
  category: string;
  title?: string;
  signals_match?: Array<string | { type: string; provider?: string; stage?: string }>;
  success_count: number;
  failure_count: number;
  visibility?: string;
}

interface MySkill {
  id: string;
  name: string;
  description?: string;
  category: string;
  tags?: string[];
  installs?: number;
  status?: string;
  gene?: {
    id: string;
    category: string;
    successCount: number;
    failureCount: number;
  } | null;
}

/* ─── Helpers ────────────────────────────────────────── */

function getToken(): string | null {
  try {
    return JSON.parse(localStorage.getItem('prismer_auth') || '{}')?.token ?? null;
  } catch {
    return null;
  }
}

function catIcon(category: string) {
  const colors = CAT_COLORS[category] || CAT_COLORS.repair;
  return colors.text;
}

const GENE_CAT_PILLS = [
  { key: '', label: 'All' },
  { key: 'repair', label: 'Repair' },
  { key: 'optimize', label: 'Optimize' },
  { key: 'innovate', label: 'Innovate' },
  { key: 'diagnostic', label: 'Diagnostic' },
] as const;

/* ─── Component ──────────────────────────────────────── */

export function MyEvolutionTab({ isDark, isAuthenticated }: MyEvolutionTabProps) {
  // Data state
  const [loading, setLoading] = useState(true);
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const [capsules, setCapsules] = useState<Record<string, unknown>[]>([]);
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  const [myGenes, setMyGenes] = useState<MyGene[]>([]);
  const [mySkills, setMySkills] = useState<MySkill[]>([]);
  const [rank, setRank] = useState<number | null>(null);

  // Sheet/drawer state
  const [createGeneOpen, setCreateGeneOpen] = useState(false);
  const [geneDetailId, setGeneDetailId] = useState<string | null>(null);
  const [publishGene, setPublishGene] = useState<MyGene | null>(null);
  const [forkGene, setForkGene] = useState<MyGene | null>(null);
  const [uploadSkillOpen, setUploadSkillOpen] = useState(false);
  const [capsuleDetail, setCapsuleDetail] = useState<Record<string, unknown> | null>(null);

  // Filter state
  const [geneCategoryFilter, setGeneCategoryFilter] = useState('');
  const [geneVisibilityFilter, setGeneVisibilityFilter] = useState<'all' | 'published' | 'private'>('all');
  const [capsuleOutcomeFilter, setCapsuleOutcomeFilter] = useState<'all' | 'success' | 'failed'>('all');

  // Collapsible sections
  const [achievementsExpanded, setAchievementsExpanded] = useState(false);
  const [personalityExpanded, setPersonalityExpanded] = useState(false);

  // Data fetching
  const fetchData = useCallback(() => {
    const token = getToken();
    if (!token) {
      setLoading(false);
      return;
    }
    const headers: HeadersInit = { Authorization: `Bearer ${token}` };

    setLoading(true);
    Promise.all([
      fetch('/api/im/evolution/report', { headers })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch('/api/im/evolution/capsules?limit=30', { headers })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch('/api/im/evolution/achievements', { headers })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch('/api/im/credits/balance', { headers })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch('/api/im/evolution/genes', { headers })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch('/api/im/evolution/public/leaderboard?limit=50')
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch('/api/im/skills/installed', { headers })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])
      .then(([rpt, caps, ach, cred, genes, lb, skillsRes]) => {
        if (rpt?.ok) setReport(rpt.data);
        if (caps?.ok) setCapsules(caps.data || []);
        if (ach?.ok) setAchievements(ach.data || []);
        if (cred?.ok || cred?.data) setCreditBalance(cred.data?.balance ?? cred.balance ?? null);
        if (genes?.ok) setMyGenes(genes.data || []);
        if (lb?.ok && lb.data) {
          const myAgentId = rpt?.data?.agent_id;
          if (myAgentId) {
            const idx = (lb.data as LeaderboardEntry[]).findIndex((e: LeaderboardEntry) => e.agentId === myAgentId);
            if (idx >= 0) setRank(idx + 1);
          }
        }
        if (skillsRes?.ok) {
          const installed = (skillsRes.data || []).map((r: any) => ({
            id: r.skill?.id || r.agentSkill?.skillId,
            name: r.skill?.name || 'Unknown',
            description: r.skill?.description,
            category: r.skill?.category || 'general',
            tags: r.skill?.tags ? (typeof r.skill.tags === 'string' ? JSON.parse(r.skill.tags) : r.skill.tags) : [],
            installs: r.skill?.installs,
            status: r.agentSkill?.status,
            gene: r.gene
              ? {
                  id: r.gene.id,
                  category: r.gene.category,
                  successCount: r.gene.successCount ?? r.gene.success_count ?? 0,
                  failureCount: r.gene.failureCount ?? r.gene.failure_count ?? 0,
                }
              : null,
          }));
          setMySkills(installed);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    fetchData();
  }, [isAuthenticated, fetchData]);

  // Targeted refresh — only refetch what changed, not 7 parallel requests
  const refreshGenes = useCallback(() => {
    const token = getToken();
    if (!token) return;
    fetch('/api/im/evolution/genes', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.ok) setMyGenes(d.data || []);
      })
      .catch(() => {});
  }, []);

  const refreshCapsules = useCallback(() => {
    const token = getToken();
    if (!token) return;
    fetch('/api/im/evolution/capsules?limit=30', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.ok) setCapsules(d.data || []);
      })
      .catch(() => {});
  }, []);

  const refreshSkills = useCallback(() => {
    const token = getToken();
    if (!token) return;
    fetch('/api/im/skills/installed', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.ok) {
          const installed = (d.data || []).map((r: any) => ({
            id: r.skill?.id || r.agentSkill?.skillId,
            name: r.skill?.name || 'Unknown',
            description: r.skill?.description,
            category: r.skill?.category || 'general',
            tags: r.skill?.tags ? (typeof r.skill.tags === 'string' ? JSON.parse(r.skill.tags) : r.skill.tags) : [],
            installs: r.skill?.installs,
            status: r.agentSkill?.status,
            gene: r.gene
              ? {
                  id: r.gene.id,
                  category: r.gene.category,
                  successCount: r.gene.successCount ?? r.gene.success_count ?? 0,
                  failureCount: r.gene.failureCount ?? r.gene.failure_count ?? 0,
                }
              : null,
          }));
          setMySkills(installed);
        }
      })
      .catch(() => {});
  }, []);

  // Callbacks for gene operations — targeted refresh only
  const handleGeneCreated = useCallback(() => {
    refreshGenes();
  }, [refreshGenes]);

  const handleGeneDeleted = useCallback(() => {
    setGeneDetailId(null);
    refreshGenes();
  }, [refreshGenes]);

  const handlePublishFromDetail = useCallback(
    (geneId: string) => {
      const gene = myGenes.find((g) => g.id === geneId);
      if (gene) {
        setGeneDetailId(null);
        setPublishGene(gene);
      }
    },
    [myGenes],
  );

  const handleForkFromDetail = useCallback((_geneId: string, gene: PublicGene) => {
    setGeneDetailId(null);
    setForkGene(gene as unknown as MyGene);
  }, []);

  const handlePublished = useCallback(() => {
    setPublishGene(null);
    refreshGenes();
  }, [refreshGenes]);

  const handleForked = useCallback(() => {
    setForkGene(null);
    refreshGenes();
  }, [refreshGenes]);

  const handleSkillCreated = useCallback(() => {
    refreshSkills();
  }, [refreshSkills]);

  // ─── Unauthenticated state ───
  if (!isAuthenticated) {
    return (
      <div className={`text-center py-20 rounded-2xl ${glass(isDark)}`}>
        <User className="w-10 h-10 mx-auto mb-4 opacity-40" />
        <h3 className={`text-lg font-bold mb-2 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
          Sign in to see your evolution
        </h3>
        <p className={`text-sm mb-6 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
          Track your agent&apos;s genes, executions, personality, and credits.
        </p>
        <Link
          href="/auth"
          className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-bold text-white bg-[var(--prismer-primary)] hover:bg-[var(--prismer-primary-light)] transition-colors"
        >
          Sign In <ArrowRight className="w-4 h-4" />
        </Link>
      </div>
    );
  }

  // ─── Loading state ───
  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-violet-400" />
      </div>
    );
  }

  // ─── Derived data ───
  const rpt = report as Record<string, unknown> | null;
  const totalCapsules = Number(rpt?.total_capsules || 0);
  const successRate = Number(rpt?.success_rate || 0);
  const geneCount = myGenes.length || Number(rpt?.gene_count || 0);
  const personality = rpt?.personality as Record<string, number> | undefined;

  // Filtered genes
  const filteredGenes = myGenes.filter((g) => {
    if (geneCategoryFilter && g.category !== geneCategoryFilter) return false;
    if (geneVisibilityFilter === 'published' && g.visibility !== 'published') return false;
    if (geneVisibilityFilter === 'private' && g.visibility === 'published') return false;
    return true;
  });

  // Filtered capsules
  const filteredCapsules = capsules.filter((c) => {
    if (capsuleOutcomeFilter === 'success' && c.outcome !== 'success') return false;
    if (capsuleOutcomeFilter === 'failed' && c.outcome === 'success') return false;
    return true;
  });

  return (
    <div className="space-y-6">
      {/* ─── 1. Overview Strip ─── */}
      <div className="grid grid-cols-5 gap-3">
        {[
          { label: 'Genes', value: geneCount, icon: Dna, accent: 'text-violet-400' },
          { label: 'Executions', value: totalCapsules, icon: Zap, accent: 'text-amber-400' },
          {
            label: 'Success',
            value: `${Math.round(successRate * 100)}%`,
            icon: TrendingUp,
            accent: 'text-emerald-400',
          },
          {
            label: 'Credits',
            value: creditBalance != null ? creditBalance.toLocaleString() : '\u2014',
            icon: Star,
            accent: 'text-cyan-400',
          },
          { label: 'Rank', value: rank != null ? `#${rank}` : '\u2014', icon: Trophy, accent: 'text-amber-400' },
        ].map(({ label, value, icon: Icon, accent }) => (
          <div key={label} className={`rounded-xl px-3 py-3 text-center ${glass(isDark)}`}>
            <Icon className={`w-4 h-4 mx-auto mb-1.5 ${accent}`} />
            <div className={`text-xl font-bold tabular-nums leading-tight ${isDark ? 'text-white' : 'text-zinc-900'}`}>
              {value}
            </div>
            <div className="text-[9px] uppercase tracking-wider mt-0.5 text-zinc-500">{label}</div>
          </div>
        ))}
      </div>

      {/* ─── 2. My Genes ─── */}
      <div className={`rounded-xl overflow-hidden ${glass(isDark)}`}>
        {/* Header */}
        <div
          className={`flex items-center justify-between px-5 py-3 border-b ${
            isDark ? 'border-white/5' : 'border-zinc-200/50'
          }`}
        >
          <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>My Genes ({geneCount})</h3>
          <button
            type="button"
            onClick={() => setCreateGeneOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-violet-600 hover:bg-violet-500 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            New Gene
          </button>
        </div>

        {/* Filter row */}
        <div
          className={`flex items-center gap-2 px-5 py-2 border-b overflow-x-auto ${
            isDark ? 'border-white/5' : 'border-zinc-200/50'
          }`}
        >
          {/* Category pills */}
          {GENE_CAT_PILLS.map((pill) => (
            <button
              key={pill.key}
              type="button"
              onClick={() => setGeneCategoryFilter(pill.key)}
              className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all ${
                geneCategoryFilter === pill.key
                  ? isDark
                    ? 'bg-violet-500/20 text-violet-300 ring-1 ring-violet-500/30'
                    : 'bg-violet-100 text-violet-700 ring-1 ring-violet-200'
                  : isDark
                    ? 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]'
                    : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100'
              }`}
            >
              {pill.label}
            </button>
          ))}

          <div className="flex-1" />

          {/* Visibility dropdown */}
          <div className="relative shrink-0">
            <select
              value={geneVisibilityFilter}
              onChange={(e) => setGeneVisibilityFilter(e.target.value as 'all' | 'published' | 'private')}
              className={`appearance-none text-[11px] pr-5 pl-2 py-1 rounded-md border cursor-pointer outline-none ${
                isDark ? 'bg-zinc-900/60 border-zinc-700 text-zinc-400' : 'bg-white border-zinc-200 text-zinc-500'
              }`}
            >
              <option value="all">All</option>
              <option value="published">Published</option>
              <option value="private">Private</option>
            </select>
            <Filter
              className={`absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 pointer-events-none ${
                isDark ? 'text-zinc-600' : 'text-zinc-400'
              }`}
            />
          </div>
        </div>

        {/* Gene list */}
        {filteredGenes.length === 0 ? (
          <div className={`text-center py-12 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
            <Dna className="w-6 h-6 mx-auto mb-2 opacity-40" />
            <p className="text-sm">
              {myGenes.length === 0
                ? 'No genes yet. Create your first gene to start evolving.'
                : 'No genes match your filter.'}
            </p>
            {myGenes.length === 0 && (
              <button
                type="button"
                onClick={() => setCreateGeneOpen(true)}
                className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-bold text-white bg-violet-600 hover:bg-violet-500 transition-colors"
              >
                <Plus className="w-4 h-4" />
                Create First Gene
              </button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-transparent">
            {filteredGenes.map((gene) => {
              const total = gene.success_count + gene.failure_count;
              const sr = total > 0 ? Math.round((gene.success_count / total) * 100) : 0;
              const catColor = catIcon(gene.category);
              return (
                <button
                  key={gene.id}
                  type="button"
                  onClick={() => setGeneDetailId(gene.id)}
                  className={`flex items-center gap-3 px-5 py-3 w-full text-left transition-colors ${
                    isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-black/[0.03]'
                  }`}
                >
                  <Dna className={`w-4 h-4 shrink-0 ${catColor}`} />
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium truncate ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                      {gene.title ||
                        (typeof gene.signals_match?.[0] === 'string'
                          ? gene.signals_match[0]
                          : ((gene.signals_match?.[0] as unknown as Record<string, unknown>)?.type as string)) ||
                        gene.id}
                    </p>
                    <div className={`flex gap-2 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                      <span>{gene.category}</span>
                      {total > 0 && <span>{total} runs</span>}
                      {gene.visibility === 'published' ? (
                        <span className="flex items-center gap-0.5 text-violet-400">
                          <Eye className="w-3 h-3" /> Published
                        </span>
                      ) : (
                        <span className="flex items-center gap-0.5">
                          <EyeOff className="w-3 h-3" /> Private
                        </span>
                      )}
                    </div>
                  </div>
                  {total > 0 && (
                    <span
                      className={`text-xs font-bold tabular-nums ${
                        sr >= 70 ? 'text-emerald-400' : sr >= 40 ? 'text-amber-400' : 'text-red-400'
                      }`}
                    >
                      {sr}%
                    </span>
                  )}
                  <ChevronRight className={`w-4 h-4 shrink-0 ${isDark ? 'text-zinc-700' : 'text-zinc-300'}`} />
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ─── 3. My Skills ─── */}
      <div className={`rounded-xl overflow-hidden ${glass(isDark)}`}>
        <div
          className={`flex items-center justify-between px-5 py-3 border-b ${
            isDark ? 'border-white/5' : 'border-zinc-200/50'
          }`}
        >
          <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            My Skills ({mySkills.length})
          </h3>
          <button
            type="button"
            onClick={() => setUploadSkillOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-violet-600 hover:bg-violet-500 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Upload Skill
          </button>
        </div>

        {mySkills.length === 0 ? (
          <div className={`text-center py-12 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
            <Sparkles className="w-6 h-6 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No skills yet. Upload your first skill to share knowledge.</p>
          </div>
        ) : (
          <div className="divide-y divide-transparent">
            {mySkills.slice(0, 10).map((skill) => (
              <div
                key={skill.id}
                className={`flex items-center gap-3 px-5 py-3 ${
                  isDark ? 'hover:bg-white/[0.02]' : 'hover:bg-black/[0.02]'
                }`}
              >
                <Sparkles className={`w-4 h-4 shrink-0 ${isDark ? 'text-cyan-400' : 'text-cyan-500'}`} />
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium truncate ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                    {skill.name}
                  </p>
                  <div className={`flex gap-2 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    <span>{skill.category}</span>
                    {skill.installs != null && skill.installs > 0 && <span>{skill.installs} installs</span>}
                    {skill.status && skill.status !== 'active' && (
                      <span className="text-amber-400">{skill.status}</span>
                    )}
                  </div>
                </div>
                {skill.gene &&
                  (() => {
                    const total = skill.gene.successCount + skill.gene.failureCount;
                    if (total === 0) return null;
                    const rate = Math.round((skill.gene.successCount / total) * 100);
                    return (
                      <span
                        className={`text-xs font-bold tabular-nums ${
                          rate >= 70 ? 'text-emerald-400' : rate >= 40 ? 'text-amber-400' : 'text-red-400'
                        }`}
                      >
                        {rate}%
                      </span>
                    );
                  })()}
                {skill.tags && skill.tags.length > 0 && (
                  <div className="hidden sm:flex gap-1">
                    {skill.tags.slice(0, 2).map((tag) => (
                      <span
                        key={tag}
                        className={`text-[10px] px-1.5 py-0.5 rounded ${
                          isDark ? 'bg-zinc-800 text-zinc-500' : 'bg-zinc-100 text-zinc-400'
                        }`}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ─── 4. Distillation Lab ─── */}
      <DistillationLab isDark={isDark} isAuthenticated={isAuthenticated} />

      {/* ─── 5. Execution Log ─── */}
      <div className={`rounded-xl overflow-hidden ${glass(isDark)}`}>
        <div
          className={`flex items-center justify-between px-5 py-3 border-b ${
            isDark ? 'border-white/5' : 'border-zinc-200/50'
          }`}
        >
          <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>Execution Log</h3>
          {/* Outcome filter tabs */}
          <div className="flex gap-1">
            {(
              [
                { key: 'all' as const, label: 'All' },
                { key: 'success' as const, label: 'Pass' },
                { key: 'failed' as const, label: 'Fail' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setCapsuleOutcomeFilter(tab.key)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                  capsuleOutcomeFilter === tab.key
                    ? isDark
                      ? 'bg-violet-500/20 text-violet-300'
                      : 'bg-violet-100 text-violet-700'
                    : isDark
                      ? 'text-zinc-500 hover:text-zinc-300'
                      : 'text-zinc-400 hover:text-zinc-600'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {filteredCapsules.length === 0 ? (
          <div className={`text-center py-12 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
            <Zap className="w-6 h-6 mx-auto mb-2 opacity-40" />
            <p className="text-sm">
              {capsules.length === 0
                ? 'No executions yet. Install a gene and start evolving.'
                : 'No executions match the selected filter.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-transparent">
            {filteredCapsules.map((c, i) => {
              const ok = c.outcome === 'success';
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setCapsuleDetail(c)}
                  className={`flex items-center gap-3 px-5 py-3 w-full text-left transition-colors ${
                    isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-black/[0.03]'
                  }`}
                >
                  <span
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                      ok ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
                    }`}
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
                  <ChevronRight className={`w-4 h-4 shrink-0 ${isDark ? 'text-zinc-700' : 'text-zinc-300'}`} />
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ─── 6. Achievements (collapsible) ─── */}
      <div className={`rounded-xl overflow-hidden ${glass(isDark)}`}>
        <button
          type="button"
          onClick={() => setAchievementsExpanded((prev) => !prev)}
          className={`flex items-center justify-between w-full px-5 py-3 text-left transition-colors ${
            isDark ? 'hover:bg-white/[0.02]' : 'hover:bg-black/[0.02]'
          }`}
        >
          <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            Achievements ({achievements.length}/6)
          </h3>
          {achievementsExpanded ? (
            <ChevronDown className={`w-4 h-4 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
          ) : (
            <ChevronRight className={`w-4 h-4 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
          )}
        </button>
        {achievementsExpanded && (
          <div className={`px-5 pb-4 border-t ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 pt-4">
              {[
                { key: 'first_gene', icon: '\u{1F331}', name: 'Gene Pioneer' },
                { key: 'first_execution', icon: '\u26A1', name: 'First Strike' },
                { key: 'first_publish', icon: '\u{1F9EC}', name: 'Open Source' },
                { key: 'streak_10', icon: '\u{1F525}', name: 'Reliable' },
                { key: 'diversity_3', icon: '\u{1F308}', name: 'Generalist' },
                { key: 'gene_adopted', icon: '\u{1F3C6}', name: 'Influential' },
              ].map((badge) => {
                const unlocked = achievements.find((a) => a.badgeKey === badge.key);
                return (
                  <div
                    key={badge.key}
                    className={`text-center p-3 rounded-lg transition-all ${
                      unlocked
                        ? isDark
                          ? 'bg-white/5 ring-1 ring-violet-500/30'
                          : 'bg-violet-50 ring-1 ring-violet-200'
                        : isDark
                          ? 'bg-zinc-900/40 opacity-40'
                          : 'bg-zinc-100/60 opacity-40'
                    }`}
                    title={
                      unlocked ? `Unlocked ${new Date(unlocked.unlockedAt).toLocaleDateString()}` : 'Not yet unlocked'
                    }
                  >
                    <div className="text-2xl mb-1">{badge.icon}</div>
                    <div className={`text-[10px] font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                      {badge.name}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ─── 6b. Personality (collapsible) ─── */}
      {personality && (
        <div className={`rounded-xl overflow-hidden ${glass(isDark)}`}>
          <button
            type="button"
            onClick={() => setPersonalityExpanded((prev) => !prev)}
            className={`flex items-center justify-between w-full px-5 py-3 text-left transition-colors ${
              isDark ? 'hover:bg-white/[0.02]' : 'hover:bg-black/[0.02]'
            }`}
          >
            <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>Personality</h3>
            {personalityExpanded ? (
              <ChevronDown className={`w-4 h-4 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
            ) : (
              <ChevronRight className={`w-4 h-4 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
            )}
          </button>
          {personalityExpanded && (
            <div className={`px-5 pb-4 border-t ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}>
              <div className="space-y-3 pt-4">
                {[
                  { label: 'Rigor', value: personality.rigor ?? 0.7, color: 'bg-orange-500' },
                  {
                    label: 'Creativity',
                    value: personality.creativity ?? 0.35,
                    color: 'bg-cyan-500',
                  },
                  {
                    label: 'Risk Tolerance',
                    value: personality.risk_tolerance ?? 0.4,
                    color: 'bg-violet-500',
                  },
                ].map(({ label, value, color }) => (
                  <div key={label} className="flex items-center gap-3">
                    <span className={`text-xs w-28 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>{label}</span>
                    <div
                      className={`flex-1 h-2 rounded-full overflow-hidden ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`}
                    >
                      <div className={`h-full rounded-full ${color}`} style={{ width: `${value * 100}%` }} />
                    </div>
                    <span
                      className={`text-xs font-semibold tabular-nums w-8 text-right ${
                        isDark ? 'text-zinc-300' : 'text-zinc-700'
                      }`}
                    >
                      {value.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── Sheets & Drawers ─── */}
      <GeneCreateSheet
        open={createGeneOpen}
        onOpenChange={setCreateGeneOpen}
        isDark={isDark}
        onCreated={handleGeneCreated}
      />
      <GeneDetailDrawer
        open={!!geneDetailId}
        onOpenChange={(open) => {
          if (!open) setGeneDetailId(null);
        }}
        geneId={geneDetailId}
        isDark={isDark}
        onPublish={handlePublishFromDetail}
        onFork={handleForkFromDetail}
        onDelete={handleGeneDeleted}
      />
      <GenePublishDialog
        open={!!publishGene}
        onOpenChange={(open) => {
          if (!open) setPublishGene(null);
        }}
        gene={publishGene}
        isDark={isDark}
        onPublished={handlePublished}
      />
      <GeneForkSheet
        open={!!forkGene}
        onOpenChange={(open) => {
          if (!open) setForkGene(null);
        }}
        parentGene={forkGene}
        isDark={isDark}
        onForked={handleForked}
      />
      <SkillUploadSheet
        open={uploadSkillOpen}
        onOpenChange={setUploadSkillOpen}
        isDark={isDark}
        onCreated={handleSkillCreated}
      />
      <CapsuleDetailDrawer
        open={!!capsuleDetail}
        onOpenChange={(open) => {
          if (!open) setCapsuleDetail(null);
        }}
        capsule={capsuleDetail}
        isDark={isDark}
      />
    </div>
  );
}
