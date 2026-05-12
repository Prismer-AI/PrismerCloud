'use client';

import { useState, useEffect, useCallback } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter, SheetDescription } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dna,
  Loader2,
  GitFork,
  Trash2,
  Share2,
  CheckCircle2,
  XCircle,
  ArrowRight,
  Clock,
  Eye,
  EyeOff,
  ChevronRight,
  AlertTriangle,
} from 'lucide-react';
import { type PublicGene, CAT_COLORS, glass, timeAgo, getSignals, getSteps, getGeneId } from './helpers';

/* ─── Types ──────────────────────────────────────────── */

interface EdgeData {
  id: string;
  signal_tag: string;
  match_count?: number;
  success_rate?: number;
  gene_id?: string;
}

interface CapsuleData {
  id: string;
  outcome: string;
  score?: number;
  summary?: string;
  created_at?: string;
  createdAt?: string;
  gene_id?: string;
  geneId?: string;
}

interface LineageNode {
  gene_id: string;
  title?: string;
  category?: string;
  generation?: number;
  children?: LineageNode[];
}

interface LineageData {
  parent?: LineageNode | null;
  current?: LineageNode;
  children?: LineageNode[];
}

/* ─── Props ──────────────────────────────────────────── */

interface GeneDetailDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  geneId: string | null;
  isDark: boolean;
  onPublish?: (geneId: string) => void;
  onFork?: (geneId: string, gene: PublicGene) => void;
  onDelete?: (geneId: string) => void;
}

/* ─── Helpers ────────────────────────────────────────── */

function getToken(): string | null {
  try {
    // Try JWT first, then API key
    const auth = JSON.parse(localStorage.getItem('prismer_auth') || '{}');
    if (auth?.token) return auth.token;
    const apiKey = localStorage.getItem('prismer_active_api_key');
    if (apiKey) return apiKey;
    return null;
  } catch {
    return null;
  }
}

function catColor(category: string) {
  return CAT_COLORS[category] || CAT_COLORS.repair;
}

/* ─── Component ──────────────────────────────────────── */

export function GeneDetailDrawer({
  open,
  onOpenChange,
  geneId,
  isDark,
  onPublish,
  onFork,
  onDelete,
}: GeneDetailDrawerProps) {
  const [gene, setGene] = useState<PublicGene | null>(null);
  const [edges, setEdges] = useState<EdgeData[]>([]);
  const [capsules, setCapsules] = useState<CapsuleData[]>([]);
  const [lineage, setLineage] = useState<LineageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [deleting, setDeleting] = useState(false);

  // Reset state when drawer closes or geneId changes
  useEffect(() => {
    if (!open || !geneId) {
      setGene(null);
      setEdges([]);
      setCapsules([]);
      setLineage(null);
      setActiveTab('overview');
      setDeleting(false);
      return;
    }

    setLoading(true);
    const token = getToken();
    const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};

    // Fetch gene detail
    fetch(`/api/im/evolution/public/genes/${geneId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.ok || d?.data) setGene(d.data || d);
      })
      .catch(() => {});

    // Fetch edges for this gene (requires auth)
    if (token) {
      fetch(`/api/im/evolution/edges?gene_id=${geneId}`, { headers })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d?.ok || d?.data) setEdges(d.data || []);
          else if (Array.isArray(d)) setEdges(d);
        })
        .catch(() => {});
    }

    // Fetch capsules
    fetch(`/api/im/evolution/public/genes/${geneId}/capsules`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.ok || d?.data) setCapsules(d.data || []);
        else if (Array.isArray(d)) setCapsules(d);
      })
      .catch(() => {});

    // Fetch lineage
    fetch(`/api/im/evolution/public/genes/${geneId}/lineage`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.ok || d?.data) setLineage(d.data || d);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open, geneId]);

  const handleDelete = useCallback(async () => {
    if (!geneId) return;
    setDeleting(true);
    try {
      const token = getToken();
      const res = await fetch(`/api/im/evolution/genes/${geneId}`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        onDelete?.(geneId);
        onOpenChange(false);
      }
    } catch {
      // silent
    } finally {
      setDeleting(false);
    }
  }, [geneId, onDelete, onOpenChange]);

  /* ─── Derived data ─── */
  const signals = gene ? getSignals(gene) : [];
  const steps = gene ? getSteps(gene) : [];
  const totalRuns = gene ? gene.success_count + gene.failure_count : 0;
  const successRate = totalRuns > 0 && gene ? Math.round((gene.success_count / totalRuns) * 100) : 0;
  const cat = gene ? catColor(gene.category) : catColor('repair');

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={`w-full sm:max-w-lg flex flex-col ${
          isDark ? 'bg-zinc-950 border-zinc-800 text-white' : 'bg-white border-zinc-200 text-zinc-900'
        }`}
      >
        {/* Header */}
        <SheetHeader className="px-6 pt-6 pb-0">
          <SheetTitle className={`text-lg font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            Gene Detail
          </SheetTitle>
          <SheetDescription className="sr-only">View gene details, signals, history, and lineage</SheetDescription>
        </SheetHeader>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 pb-4">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-6 h-6 animate-spin text-violet-400" />
            </div>
          ) : !gene ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
              <AlertTriangle className={`w-8 h-8 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />
              <p className={`text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>Gene not found</p>
            </div>
          ) : (
            <>
              {/* Gene header card */}
              <div className={`rounded-xl p-4 mb-4 ${glass(isDark)}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <h3 className={`font-bold text-base mb-1 truncate ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                      {gene.title || signals[0] || 'Untitled Gene'}
                    </h3>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge className={`text-[10px] ${cat.bg} ${cat.text} border ${cat.border}`} variant="outline">
                        {gene.category}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${
                          gene.visibility === 'published'
                            ? isDark
                              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                              : 'bg-emerald-50 text-emerald-600 border-emerald-200'
                            : isDark
                              ? 'bg-zinc-800 text-zinc-400 border-zinc-700'
                              : 'bg-zinc-100 text-zinc-500 border-zinc-200'
                        }`}
                      >
                        {gene.visibility === 'published' ? (
                          <>
                            <Eye className="w-3 h-3 mr-0.5" /> Published
                          </>
                        ) : (
                          <>
                            <EyeOff className="w-3 h-3 mr-0.5" /> Private
                          </>
                        )}
                      </Badge>
                    </div>
                  </div>
                  <Dna className={`w-8 h-8 shrink-0 ${cat.text} opacity-60`} />
                </div>

                {/* Stats row */}
                <div
                  className={`flex items-center gap-4 mt-3 pt-3 border-t text-xs ${
                    isDark ? 'border-white/5 text-zinc-400' : 'border-zinc-200/50 text-zinc-500'
                  }`}
                >
                  <span>{totalRuns} runs</span>
                  <span
                    className={`font-bold tabular-nums ${
                      successRate >= 70 ? 'text-emerald-400' : successRate >= 40 ? 'text-amber-400' : 'text-red-400'
                    }`}
                  >
                    {successRate}% success
                  </span>
                  {(gene.forkCount ?? 0) > 0 && (
                    <span className="flex items-center gap-0.5">
                      <GitFork className="w-3 h-3" /> {gene.forkCount}
                    </span>
                  )}
                  {gene.is_seed && <span className="text-violet-400 font-medium">Seed</span>}
                </div>
              </div>

              {/* Tabs */}
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className={`w-full ${isDark ? 'bg-zinc-900/60' : 'bg-zinc-100/80'}`}>
                  <TabsTrigger value="overview" className="flex-1 text-xs">
                    Overview
                  </TabsTrigger>
                  <TabsTrigger value="signals" className="flex-1 text-xs">
                    Signals
                  </TabsTrigger>
                  <TabsTrigger value="history" className="flex-1 text-xs">
                    History
                  </TabsTrigger>
                  <TabsTrigger value="lineage" className="flex-1 text-xs">
                    Lineage
                  </TabsTrigger>
                </TabsList>

                {/* ─── Overview Tab ─── */}
                <TabsContent value="overview" className="mt-4 space-y-4">
                  {/* Strategy Steps */}
                  {steps.length > 0 && (
                    <div>
                      <h4
                        className={`text-xs font-semibold uppercase tracking-wider mb-2 ${
                          isDark ? 'text-zinc-500' : 'text-zinc-400'
                        }`}
                      >
                        Strategy Steps
                      </h4>
                      <ol className="space-y-1.5">
                        {steps.map((step, i) => (
                          <li key={i} className={`flex gap-2 text-sm ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                            <span
                              className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                                isDark ? 'bg-violet-500/15 text-violet-400' : 'bg-violet-100 text-violet-600'
                              }`}
                            >
                              {i + 1}
                            </span>
                            <span>{step}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {/* Preconditions */}
                  {gene.preconditions && gene.preconditions.length > 0 && (
                    <div>
                      <h4
                        className={`text-xs font-semibold uppercase tracking-wider mb-2 ${
                          isDark ? 'text-zinc-500' : 'text-zinc-400'
                        }`}
                      >
                        Preconditions
                      </h4>
                      <ul className="space-y-1">
                        {gene.preconditions.map((pc, i) => (
                          <li
                            key={i}
                            className={`text-sm flex items-start gap-1.5 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}
                          >
                            <ChevronRight className="w-3.5 h-3.5 mt-0.5 shrink-0 text-violet-400" />
                            {pc}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Signals list */}
                  {signals.length > 0 && (
                    <div>
                      <h4
                        className={`text-xs font-semibold uppercase tracking-wider mb-2 ${
                          isDark ? 'text-zinc-500' : 'text-zinc-400'
                        }`}
                      >
                        Signals
                      </h4>
                      <div className="flex flex-wrap gap-1.5">
                        {signals.map((s) => (
                          <Badge
                            key={s}
                            variant="outline"
                            className={`text-[11px] ${
                              isDark
                                ? 'bg-zinc-800/60 text-zinc-300 border-zinc-700'
                                : 'bg-zinc-100 text-zinc-700 border-zinc-200'
                            }`}
                          >
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Description */}
                  {gene.description && (
                    <div>
                      <h4
                        className={`text-xs font-semibold uppercase tracking-wider mb-2 ${
                          isDark ? 'text-zinc-500' : 'text-zinc-400'
                        }`}
                      >
                        Description
                      </h4>
                      <p className={`text-sm leading-relaxed ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                        {gene.description}
                      </p>
                    </div>
                  )}

                  {/* Metadata */}
                  <div className={`space-y-2 pt-3 border-t ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}>
                    {gene.created_by && (
                      <div className="flex justify-between text-xs">
                        <span className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>Created by</span>
                        <span className={`font-mono ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                          {gene.created_by.length > 16
                            ? `${gene.created_by.slice(0, 8)}...${gene.created_by.slice(-4)}`
                            : gene.created_by}
                        </span>
                      </div>
                    )}
                    {gene.generation != null && (
                      <div className="flex justify-between text-xs">
                        <span className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>Generation</span>
                        <span className={isDark ? 'text-zinc-300' : 'text-zinc-700'}>{gene.generation}</span>
                      </div>
                    )}
                    {gene.parentGeneId && (
                      <div className="flex justify-between text-xs">
                        <span className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>Parent</span>
                        <span className={`font-mono ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                          {gene.parentGeneId.length > 16
                            ? `${gene.parentGeneId.slice(0, 8)}...${gene.parentGeneId.slice(-4)}`
                            : gene.parentGeneId}
                        </span>
                      </div>
                    )}
                    {(gene.used_by_count ?? 0) > 0 && (
                      <div className="flex justify-between text-xs">
                        <span className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>Used by</span>
                        <span className={isDark ? 'text-zinc-300' : 'text-zinc-700'}>{gene.used_by_count} agents</span>
                      </div>
                    )}
                  </div>
                </TabsContent>

                {/* ─── Signals Tab ─── */}
                <TabsContent value="signals" className="mt-4">
                  {edges.length === 0 ? (
                    <div className={`text-center py-12 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                      <Dna className="w-6 h-6 mx-auto mb-2 opacity-40" />
                      <p className="text-sm">No signal edges found</p>
                      <p className="text-xs mt-1 opacity-60">Signal data requires authentication</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {edges.map((edge) => {
                        const sr = edge.success_rate != null ? Math.round(edge.success_rate * 100) : null;
                        return (
                          <div key={edge.id || edge.signal_tag} className={`rounded-lg p-3 ${glass(isDark)}`}>
                            <div className="flex items-center justify-between">
                              <span className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                                {edge.signal_tag}
                              </span>
                              {sr != null && (
                                <span
                                  className={`text-xs font-bold tabular-nums ${
                                    sr >= 70 ? 'text-emerald-400' : sr >= 40 ? 'text-amber-400' : 'text-red-400'
                                  }`}
                                >
                                  {sr}%
                                </span>
                              )}
                            </div>
                            {edge.match_count != null && (
                              <p className={`text-xs mt-1 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                                {edge.match_count} matches
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </TabsContent>

                {/* ─── History Tab ─── */}
                <TabsContent value="history" className="mt-4">
                  {capsules.length === 0 ? (
                    <div className={`text-center py-12 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                      <Clock className="w-6 h-6 mx-auto mb-2 opacity-40" />
                      <p className="text-sm">No execution history</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {capsules.map((c, i) => {
                        const ok = c.outcome === 'success';
                        const ts = c.created_at || c.createdAt;
                        return (
                          <div key={c.id || i} className={`flex items-start gap-3 rounded-lg p-3 ${glass(isDark)}`}>
                            <span
                              className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                                ok ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
                              }`}
                            >
                              {ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                            </span>
                            <div className="flex-1 min-w-0">
                              <p className={`text-sm truncate ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                                {c.summary || (ok ? 'Execution succeeded' : 'Execution failed')}
                              </p>
                              <div
                                className={`flex items-center gap-2 mt-1 text-xs ${
                                  isDark ? 'text-zinc-500' : 'text-zinc-400'
                                }`}
                              >
                                {ts && <span>{timeAgo(ts)}</span>}
                                {c.score != null && (
                                  <span className="tabular-nums">Score: {Math.round(Number(c.score) * 100)}%</span>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </TabsContent>

                {/* ─── Lineage Tab ─── */}
                <TabsContent value="lineage" className="mt-4">
                  {!lineage ? (
                    <div className={`text-center py-12 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                      <GitFork className="w-6 h-6 mx-auto mb-2 opacity-40" />
                      <p className="text-sm">No lineage data available</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {/* Parent */}
                      {lineage.parent && (
                        <div>
                          <h4
                            className={`text-xs font-semibold uppercase tracking-wider mb-2 ${
                              isDark ? 'text-zinc-500' : 'text-zinc-400'
                            }`}
                          >
                            Parent
                          </h4>
                          <LineageNodeRow node={lineage.parent} isDark={isDark} indent={0} />
                        </div>
                      )}

                      {/* Current */}
                      {lineage.current && (
                        <div>
                          <h4
                            className={`text-xs font-semibold uppercase tracking-wider mb-2 ${
                              isDark ? 'text-zinc-500' : 'text-zinc-400'
                            }`}
                          >
                            This Gene
                          </h4>
                          <LineageNodeRow node={lineage.current} isDark={isDark} indent={0} isCurrent />
                        </div>
                      )}

                      {/* Children */}
                      {lineage.children && lineage.children.length > 0 && (
                        <div>
                          <h4
                            className={`text-xs font-semibold uppercase tracking-wider mb-2 ${
                              isDark ? 'text-zinc-500' : 'text-zinc-400'
                            }`}
                          >
                            Children ({lineage.children.length})
                          </h4>
                          <div className="space-y-1.5">
                            {lineage.children.map((child) => (
                              <LineageNodeRow key={child.gene_id} node={child} isDark={isDark} indent={1} />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </>
          )}
        </div>

        {/* Footer actions */}
        {gene && (
          <SheetFooter className={`px-6 py-4 border-t ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}>
            <div className="flex items-center gap-2 w-full">
              {onPublish && gene.visibility !== 'published' && (
                <Button
                  variant="default"
                  size="sm"
                  className="bg-violet-600 hover:bg-violet-700 text-white"
                  onClick={() => {
                    const id = getGeneId(gene);
                    if (id) onPublish(id);
                  }}
                >
                  <Share2 className="w-3.5 h-3.5 mr-1" />
                  Publish to Market
                </Button>
              )}
              {onFork && (
                <Button
                  variant="outline"
                  size="sm"
                  className={isDark ? 'border-zinc-700 text-zinc-300 hover:bg-zinc-800' : ''}
                  onClick={() => {
                    const id = getGeneId(gene);
                    if (id) onFork(id, gene);
                  }}
                >
                  <GitFork className="w-3.5 h-3.5 mr-1" />
                  Fork
                </Button>
              )}
              <div className="flex-1" />
              {onDelete && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                  disabled={deleting}
                  onClick={handleDelete}
                >
                  {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                </Button>
              )}
            </div>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}

/* ─── Sub-components ─────────────────────────────────── */

function LineageNodeRow({
  node,
  isDark,
  indent,
  isCurrent = false,
}: {
  node: LineageNode;
  isDark: boolean;
  indent: number;
  isCurrent?: boolean;
}) {
  const cat = catColor(node.category || 'repair');
  return (
    <div
      className={`flex items-center gap-2 rounded-lg px-3 py-2 ${
        isCurrent
          ? isDark
            ? 'bg-violet-500/10 border border-violet-500/20'
            : 'bg-violet-50 border border-violet-200'
          : glass(isDark)
      }`}
      style={{ marginLeft: indent * 16 }}
    >
      {indent > 0 && <ArrowRight className={`w-3 h-3 shrink-0 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />}
      <Dna className={`w-4 h-4 shrink-0 ${cat.text}`} />
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium truncate ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
          {node.title || node.gene_id}
        </p>
        {node.category && <span className={`text-[10px] ${cat.text}`}>{node.category}</span>}
      </div>
      {node.generation != null && (
        <span className={`text-[10px] tabular-nums ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
          gen {node.generation}
        </span>
      )}
      {isCurrent && (
        <Badge variant="outline" className="text-[9px] bg-violet-500/10 text-violet-400 border-violet-500/20">
          Current
        </Badge>
      )}
    </div>
  );
}
