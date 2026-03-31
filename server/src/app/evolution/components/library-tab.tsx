'use client';

import { useState, useEffect } from 'react';
import {
  Search,
  Sparkles,
  Dna,
  Download,
  Star,
  Compass,
  ExternalLink,
  Users,
  ChevronDown,
  Loader2,
  GitFork,
} from 'lucide-react';
import { TiltCard } from '@/components/evolution/tilt-card';
import {
  type PublicGene,
  type Skill,
  type SkillCategory,
  type SkillStats,
  CAT_COLORS,
  GENE_CATEGORIES,
  SORT_OPTIONS,
  glass,
  getGeneId,
  getSignals,
  computePQI,
} from './helpers';

interface LibraryTabProps {
  isDark: boolean;
  onGeneClick: (geneId: string) => void;
  onSkillClick: (skillId: string) => void;
  onGeneImport?: (geneId: string) => void;
  onGeneFork?: (gene: PublicGene) => void;
  onSkillInstall?: (skillId: string) => void;
  onSkillStar?: (skillId: string) => void;
  isAuthenticated?: boolean;
}

type SubTab = 'all' | 'skills' | 'genes';

const LIMIT = 24;

export function LibraryTab({
  isDark,
  onGeneClick,
  onSkillClick,
  onGeneImport,
  onGeneFork,
  onSkillInstall,
  onSkillStar,
  isAuthenticated,
}: LibraryTabProps) {
  const [subTab, setSubTab] = useState<SubTab>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState('most_installed');
  const [page, setPage] = useState(1);

  // Skills data
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillTotal, setSkillTotal] = useState(0);
  const [skillCategories, setSkillCategories] = useState<SkillCategory[]>([]);
  const [skillLoading, setSkillLoading] = useState(false);

  // Genes data
  const [genes, setGenes] = useState<PublicGene[]>([]);
  const [geneTotal, setGeneTotal] = useState(0);
  const [geneLoading, setGeneLoading] = useState(false);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Fetch categories once
  useEffect(() => {
    fetch('/api/im/skills/categories')
      .then((r) => r.json())
      .then((d) => {
        const arr = d.data || d;
        setSkillCategories(Array.isArray(arr) ? arr : []);
      })
      .catch(() => {});
  }, []);

  // Fetch skills
  useEffect(() => {
    if (subTab === 'genes') return;
    setSkillLoading(true);
    const params = new URLSearchParams({ sort, page: String(page), limit: String(LIMIT) });
    if (search) params.set('query', search);
    if (category) params.set('category', category);
    fetch(`/api/im/skills/search?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setSkills(d.data || []);
        setSkillTotal(d.meta?.total || 0);
      })
      .catch(() => {})
      .finally(() => setSkillLoading(false));
  }, [subTab, search, category, sort, page]);

  // Fetch genes
  useEffect(() => {
    if (subTab === 'skills') return;
    setGeneLoading(true);
    const gSort = sort === 'most_installed' ? 'most_used' : sort === 'most_starred' ? 'highest_success' : sort;
    const params = new URLSearchParams({ sort: gSort, page: String(page), limit: String(LIMIT) });
    if (category) params.set('category', category);
    if (search) params.set('search', search);
    fetch(`/api/im/evolution/public/genes?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setGenes(d.data || []);
        setGeneTotal(d.meta?.total || d.total || 0);
      })
      .catch(() => {})
      .finally(() => setGeneLoading(false));
  }, [subTab, search, category, sort, page]);

  const loading = subTab === 'skills' ? skillLoading : subTab === 'genes' ? geneLoading : skillLoading || geneLoading;
  const total = subTab === 'skills' ? skillTotal : subTab === 'genes' ? geneTotal : skillTotal + geneTotal;
  const totalPages = Math.ceil(total / LIMIT);

  const maxExec = Math.max(...genes.map((g) => g.success_count + g.failure_count), 1);

  return (
    <div>
      {/* Sub-tabs + Search */}
      <div className={`flex flex-col gap-3 mb-4 p-3 rounded-xl ${glass(isDark)}`}>
        <div className="flex flex-col sm:flex-row gap-3">
          {/* Sub-tab toggle */}
          <div
            className={`flex p-0.5 rounded-lg shrink-0 ${isDark ? 'bg-zinc-900/60 border border-white/5' : 'bg-zinc-100/80 border border-zinc-200/60'}`}
          >
            {(['all', 'skills', 'genes'] as SubTab[]).map((t) => (
              <button
                key={t}
                onClick={() => {
                  setSubTab(t);
                  setPage(1);
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all capitalize ${
                  subTab === t
                    ? isDark
                      ? 'bg-zinc-800 text-white shadow-sm'
                      : 'bg-white text-zinc-900 shadow-sm'
                    : isDark
                      ? 'text-zinc-500 hover:text-zinc-300'
                      : 'text-zinc-500 hover:text-zinc-900'
                }`}
              >
                {t === 'all' ? 'All' : t === 'skills' ? 'Skills' : 'Genes'}
              </button>
            ))}
          </div>

          {/* Search */}
          <div
            className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border ${isDark ? 'bg-zinc-900/40 border-white/10' : 'bg-white/60 border-zinc-200/60'}`}
          >
            <Search className={`w-4 h-4 shrink-0 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
            <input
              type="text"
              placeholder={
                subTab === 'genes'
                  ? 'Search genes...'
                  : subTab === 'skills'
                    ? 'Search skills...'
                    : 'Search skills & genes...'
              }
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className={`w-full bg-transparent outline-none text-sm ${isDark ? 'text-white placeholder-zinc-600' : 'text-zinc-900 placeholder-zinc-400'}`}
            />
          </div>

          {/* Sort */}
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              setPage(1);
            }}
            className={`px-3 py-2 rounded-lg text-xs font-medium border shrink-0 ${isDark ? 'bg-zinc-900/60 border-white/10 text-zinc-300' : 'bg-white/60 border-zinc-200/60 text-zinc-700'}`}
          >
            <option value="most_installed">Most Popular</option>
            <option value="newest">Newest</option>
            <option value="most_starred">Highest Rated</option>
            <option value="name">Name</option>
          </select>
        </div>

        {/* Category pills */}
        <div className="flex gap-2 overflow-x-auto pb-1 custom-scrollbar">
          <button
            onClick={() => {
              setCategory('');
              setPage(1);
            }}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
              !category
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
          {(subTab === 'genes' ? GENE_CATEGORIES.filter((c) => c.key) : skillCategories.slice(0, 15)).map((cat) => {
            const key = 'key' in cat ? cat.key : cat.category;
            const label = 'label' in cat ? cat.label : cat.category;
            return (
              <button
                key={key}
                onClick={() => {
                  setCategory(key);
                  setPage(1);
                }}
                className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-all whitespace-nowrap ${
                  category === key
                    ? isDark
                      ? 'bg-white/10 text-white'
                      : 'bg-zinc-900 text-white'
                    : isDark
                      ? 'bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'
                      : 'bg-zinc-100 text-zinc-600 hover:text-zinc-900'
                }`}
              >
                {label} {'count' in cat ? `(${(cat as SkillCategory).count})` : ''}
              </button>
            );
          })}
        </div>
      </div>

      {/* Results */}
      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-violet-400" />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Skills */}
          {subTab !== 'genes' &&
            skills.map((skill) => (
              <TiltCard
                key={`s-${skill.id}`}
                glowColor="rgba(139,92,246,0.06)"
                maxTilt={3}
                scale={1.01}
                className="rounded-xl h-full"
              >
                <div
                  className={`rounded-xl p-4 h-full cursor-pointer ${glass(isDark)}`}
                  onClick={() => onSkillClick(skill.id)}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span
                      className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${isDark ? 'bg-violet-500/15 text-violet-300' : 'bg-violet-100 text-violet-600'}`}
                    >
                      Skill
                    </span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded ${isDark ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-100 text-zinc-500'}`}
                    >
                      {skill.category}
                    </span>
                  </div>
                  <h4 className={`font-bold text-sm mb-1 truncate ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                    {skill.name}
                  </h4>
                  <p
                    className={`text-xs leading-relaxed line-clamp-2 mb-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}
                  >
                    {skill.description}
                  </p>
                  <div className={`flex items-center gap-3 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    <span className="flex items-center gap-1">
                      <Download className="w-3 h-3" />
                      {(skill.installs || 0).toLocaleString()}
                    </span>
                    <span className="flex items-center gap-1">
                      <Star className="w-3 h-3" />
                      {(skill.stars || 0).toLocaleString()}
                    </span>
                  </div>
                  {/* Signals */}
                  {skill.signals &&
                    (() => {
                      try {
                        const parsed = JSON.parse(skill.signals) as Array<string | { type: string }>;
                        if (parsed.length > 0) {
                          return (
                            <div className="flex flex-wrap gap-1 mt-2">
                              {parsed.slice(0, 3).map((s, i) => (
                                <span
                                  key={i}
                                  className={`text-[9px] px-1.5 py-0.5 rounded ${isDark ? 'bg-violet-500/10 text-violet-300' : 'bg-violet-50 text-violet-600'}`}
                                >
                                  {typeof s === 'string' ? s : s.type}
                                </span>
                              ))}
                            </div>
                          );
                        }
                      } catch {
                        /* ignore parse errors */
                      }
                      return null;
                    })()}
                  {isAuthenticated && (
                    <div
                      className={`flex gap-2 mt-3 pt-3 border-t ${isDark ? 'border-white/5' : 'border-zinc-200/60'}`}
                    >
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onSkillInstall?.(skill.id);
                        }}
                        className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-md bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                      >
                        <Download className="w-3 h-3" /> Install
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onSkillStar?.(skill.id);
                        }}
                        className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-md bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-colors"
                      >
                        <Star className="w-3 h-3" /> Star
                      </button>
                    </div>
                  )}
                </div>
              </TiltCard>
            ))}

          {/* Genes */}
          {subTab !== 'skills' &&
            genes.map((gene) => {
              const cat = CAT_COLORS[gene.category] || CAT_COLORS.repair;
              const totalUses = gene.success_count + gene.failure_count;
              const successRate = totalUses > 0 ? Math.round((gene.success_count / totalUses) * 100) : 0;
              const pqi = computePQI(gene, maxExec);
              return (
                <TiltCard
                  key={`g-${getGeneId(gene)}`}
                  glowColor={cat.glow}
                  maxTilt={3}
                  scale={1.01}
                  className="rounded-xl h-full"
                >
                  <div
                    className={`rounded-xl p-4 h-full cursor-pointer ${glass(isDark)}`}
                    onClick={() => onGeneClick(getGeneId(gene))}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span
                        className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${cat.bg} ${cat.text} ${cat.border}`}
                      >
                        <Dna className="w-3 h-3" /> Gene
                      </span>
                      <span className={`text-xs font-bold tabular-nums ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
                        PQI {pqi}
                      </span>
                    </div>
                    <h4 className={`font-bold text-sm mb-1 truncate ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                      {gene.title || getSignals(gene)[0] || 'Untitled Gene'}
                    </h4>
                    <p
                      className={`text-xs leading-relaxed line-clamp-2 mb-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}
                    >
                      {gene.description ||
                        `When ${getSignals(gene).join(', ')}, this gene applies a ${gene.category} strategy.`}
                    </p>
                    <div
                      className={`flex items-center gap-3 pt-2 border-t ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}
                    >
                      {totalUses > 0 ? (
                        <>
                          <div
                            className={`flex-1 h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`}
                          >
                            <div className="h-full rounded-full bg-emerald-500" style={{ width: `${successRate}%` }} />
                          </div>
                          <span
                            className={`text-xs font-bold tabular-nums ${successRate >= 70 ? 'text-emerald-400' : successRate >= 40 ? 'text-amber-400' : 'text-red-400'}`}
                          >
                            {successRate}%
                          </span>
                          <span className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                            {totalUses} runs
                          </span>
                        </>
                      ) : (
                        <span className={`text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                          No executions yet
                        </span>
                      )}
                      {(gene.forkCount || 0) > 0 && (
                        <span
                          className={`flex items-center gap-0.5 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
                        >
                          <GitFork className="w-3 h-3" />
                          {gene.forkCount}
                        </span>
                      )}
                    </div>
                    {isAuthenticated && (
                      <div
                        className={`flex gap-2 mt-3 pt-3 border-t ${isDark ? 'border-white/5' : 'border-zinc-200/60'}`}
                      >
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onGeneImport?.(getGeneId(gene));
                          }}
                          className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-md bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 transition-colors"
                        >
                          <Download className="w-3 h-3" /> Import
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onGeneFork?.(gene);
                          }}
                          className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-md bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 transition-colors"
                        >
                          <GitFork className="w-3 h-3" /> Fork
                        </button>
                      </div>
                    )}
                  </div>
                </TiltCard>
              );
            })}
        </div>
      )}

      {/* Empty state */}
      {!loading && skills.length === 0 && genes.length === 0 && (
        <div className={`text-center py-20 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
          <Sparkles className="w-8 h-8 mx-auto mb-3 opacity-40" />
          <p className="text-sm">No results found. Try a different search or filter.</p>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-8">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 ${isDark ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'}`}
          >
            Prev
          </button>
          <span className={`text-xs tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            Page {page} of {totalPages} ({total.toLocaleString()} items)
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 ${isDark ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'}`}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
