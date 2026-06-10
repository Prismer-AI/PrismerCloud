'use client';

/**
 * Skills · Evolution sub-tab — release201/13 §3.6 (S22) + release201/20 §9.2 V2.
 *
 * Workspace-owner-scoped capsule + gene listing for an agent (the BFF
 * endpoints `/api/im/studio/evolution/{capsules,genes}` add the
 * permission check; we never reuse user-scoped `/evolution/capsules`).
 *
 * V2 (Wave 2 v2.0.8) — release201/20 §9.2:
 *   - Garden uses a REAL d3-force layout via <GardenForceGraph> instead of
 *     the prior hash-based static x/y (no physics).
 *   - Sparkline reads `task.completed` from `/api/im/metrics/aggregate`
 *     (bucket=1d, range=7d). When the metric returns no data the sparkline
 *     hides and an empty hint surfaces (no synthetic sin-wave fake).
 *   - Distilled genes wear a pulsing splash ring via the existing
 *     `animate-prismer-gene-pulse` CSS keyframe.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Sparkles, Workflow } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useI18n } from '@/contexts/i18n-context';
import { glass } from '../../helpers';
import {
  type AggregateResult,
  type StudioCapsule,
  type StudioGene,
  fetchMetricAggregate,
  fetchStudioCapsules,
  fetchStudioGenes,
  localizedTimeAgo,
  readActiveWorkspaceId,
} from '../types';
import { grammarAccentClasses, spatialGrammar } from '@/app/workspace/lib/design';
import { GardenForceGraph, type GardenForceNode } from './garden-force-graph';

interface EvolutionViewProps {
  isDark: boolean;
  agentId: string | null;
}

export function EvolutionView({ isDark, agentId }: EvolutionViewProps) {
  const { t } = useI18n();
  const [capsules, setCapsules] = useState<StudioCapsule[]>([]);
  const [genes, setGenes] = useState<StudioGene[]>([]);
  const [distilled, setDistilled] = useState<
    Array<{ geneId: string; skillId: string; status: string; installedAt: string }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [taskSeries, setTaskSeries] = useState<AggregateResult | null>(null);

  const reload = useCallback(async () => {
    if (!agentId) {
      setCapsules([]);
      setGenes([]);
      setDistilled([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const [capData, geneData] = await Promise.all([fetchStudioCapsules(agentId, 1, 20), fetchStudioGenes(agentId)]);
    setCapsules(capData?.capsules ?? []);
    setGenes(geneData?.genes ?? []);
    setDistilled(geneData?.distilled ?? []);
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // V2 §9.2 — pull real `task.completed` 1d series for the sparkline.
  // The metric endpoint requires a workspaceId; we read the active one
  // from localStorage/URL (no prop drilling per Wave 2 scope).
  useEffect(() => {
    let cancelled = false;
    const workspaceId = readActiveWorkspaceId();
    if (!workspaceId) {
      setTaskSeries(null);
      return;
    }
    void fetchMetricAggregate({
      namespace: 'task',
      name: 'completed',
      agg: 'count',
      range: '7d',
      bucket: '1d',
      workspaceId,
    }).then((r) => {
      if (!cancelled) setTaskSeries(r);
    });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const distilledByGene = useMemo(() => new Map(distilled.map((d) => [d.geneId, d])), [distilled]);

  // ── Garden grammar (doc 13 §3.6 — gene-node cluster + sparkline) ──
  const grammar = spatialGrammar.garden;
  const accent = grammarAccentClasses[grammar.accentColor];

  // Build force-graph node list. Capsule + gene radius differ slightly so
  // the two clusters read as distinct visual species.
  const forceNodes: GardenForceNode[] = useMemo(() => {
    const all: GardenForceNode[] = [];
    capsules.slice(0, 12).forEach((c) => {
      all.push({
        id: `cap-${c.id}`,
        kind: 'capsule',
        label: (c.title as string) ?? (c.intent as string) ?? c.id.slice(0, 8),
        r: 3.5,
        distilled: false,
      });
    });
    genes.slice(0, 12).forEach((g) => {
      all.push({
        id: `gene-${g.id}`,
        kind: 'gene',
        label: g.name ?? g.id.slice(0, 8),
        r: 4.2,
        distilled: distilledByGene.has(g.id),
      });
    });
    return all;
  }, [capsules, genes, distilledByGene]);

  // Real sparkline from `task.completed` per-day buckets. When buckets are
  // empty (no data yet / pre-S23 env) we set availableValue.available=false
  // and surface the empty hint instead of faking the curve.
  const sparkline = useMemo<{ available: boolean; points: number[] }>(() => {
    if (!taskSeries || !Array.isArray(taskSeries.buckets) || taskSeries.buckets.length === 0) {
      return { available: false, points: [] };
    }
    const raw = taskSeries.buckets.map((b) => {
      let sum = 0;
      for (const g of b.groups) sum += typeof g.value === 'number' ? g.value : 0;
      return sum;
    });
    if (raw.every((v) => v === 0)) return { available: false, points: [] };
    const max = Math.max(...raw, 1);
    return { available: true, points: raw.map((v) => v / max) };
  }, [taskSeries]);

  if (!agentId) {
    return (
      <div
        data-spatial-grammar="garden"
        data-grammar-accent={grammar.accentColor}
        className={`rounded-2xl px-6 py-12 text-center ${glass(isDark, 'base')}`}
      >
        <p className={`text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
          {t('evolution.studio.skills.evolution.pickAgent')}
        </p>
      </div>
    );
  }

  // ViewBox space for the force graph — matches the prior 16:9 aspect.
  const FG_W = 100;
  const FG_H = 56;

  return (
    <div data-spatial-grammar="garden" data-grammar-accent={grammar.accentColor} className="space-y-4">
      <div className={`flex items-center justify-between gap-3 rounded-2xl border px-4 py-3 backdrop-blur-md ${accent.bg}`}>
        <div>
          <p className={`text-[10px] font-semibold uppercase tracking-wider ${accent.text}`}>
            {t('evolution.studio.skills.evolution.gardenLabel')}
          </p>
          <p className={`mt-0.5 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            {t('evolution.studio.skills.evolution.gardenHint')}
          </p>
        </div>
        {!loading && (
          <div className={`flex items-center gap-3 text-[11px] ${accent.text}`}>
            <span className="inline-flex items-center gap-1">
              <Workflow className="h-3 w-3" /> {capsules.length}
            </span>
            <span className="inline-flex items-center gap-1">
              <Sparkles className="h-3 w-3" /> {genes.length}
            </span>
          </div>
        )}
      </div>

      {loading ? (
        <div className={`flex items-center justify-center rounded-2xl px-6 py-16 ${glass(isDark, 'base')}`}>
          <Loader2 className={`h-5 w-5 animate-spin ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
        </div>
      ) : forceNodes.length === 0 ? (
        <div
          data-pane="garden-canvas"
          className={`animate-idle-breathing rounded-2xl px-6 py-16 text-center text-xs ${glass(isDark, 'base')} ${
            isDark ? 'text-zinc-500' : 'text-zinc-500'
          }`}
        >
          {t('evolution.studio.skills.evolution.noCapsules')} · {t('evolution.studio.skills.evolution.noGenes')}
        </div>
      ) : (
        <div
          data-pane="garden-canvas"
          data-testid="evolution-garden"
          className={`relative aspect-[16/9] overflow-hidden rounded-2xl border ring-1 ${glass(isDark, 'base')} ${accent.ring}`}
        >
          <GardenForceGraph nodes={forceNodes} width={FG_W} height={FG_H} isDark={isDark} accentGlow={accent.glow} />
          {/* Bottom sparkline — real task.completed/day or empty hint. */}
          {sparkline.available ? (
            <svg
              viewBox="0 0 100 12"
              preserveAspectRatio="none"
              className="absolute bottom-0 left-0 h-8 w-full"
              data-testid="evolution-sparkline"
            >
              <polyline
                points={sparkline.points
                  .map((v, i) => `${(i / Math.max(1, sparkline.points.length - 1)) * 100},${12 - v * 10}`)
                  .join(' ')}
                fill="none"
                stroke={accent.glow}
                strokeWidth="0.5"
                className="animate-trace-draw"
                style={{ ['--len' as string]: 200 }}
              />
            </svg>
          ) : (
            <div
              data-testid="evolution-sparkline-empty"
              className={`absolute bottom-1 right-2 text-[9px] font-mono ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
            >
              {t('evolution.studio.skills.evolution.noMetricData') ?? 'no metric data yet'}
            </div>
          )}
        </div>
      )}

      {/* Compact gene list — keyboard nav fallback for the canvas above */}
      {!loading && genes.length > 0 && (
        <ul
          data-pane="garden-list"
          className={`grid gap-1 rounded-2xl border p-3 sm:grid-cols-2 ${glass(isDark, 'base')}`}
        >
          {genes.slice(0, 8).map((g) => {
            const exp = distilledByGene.get(g.id);
            return (
              <li
                key={g.id}
                className={`flex items-center gap-2 text-xs ${isDark ? 'text-zinc-200' : 'text-zinc-700'}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${accent.dot}`} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{g.name ?? g.id}</span>
                {exp && (
                  <Badge variant="secondary" className={`text-[10px] ${accent.text}`}>
                    {t('evolution.studio.skills.evolution.exportedAsSkill')}
                  </Badge>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* hidden recent capsule timestamps for screen readers */}
      <ul className="sr-only">
        {capsules.slice(0, 5).map((c) => (
          <li key={c.id}>{localizedTimeAgo(c.createdAt as string, t)}</li>
        ))}
      </ul>
    </div>
  );
}
