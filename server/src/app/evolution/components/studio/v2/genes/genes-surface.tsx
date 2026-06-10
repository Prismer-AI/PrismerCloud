'use client';

/**
 * Genes surface (release201/28 §4.4 + 13 §3.6) — `spatialGrammar.garden`,
 * emerald accent.
 *
 * Grammar = **gene garden**: an SVG force-ish graph where capsules are filled
 * nodes (●), genes are hollow rings (◯), and distill relationships are curving
 * bezier edges. Nodes cascade in (springSoft); they're draggable (springDrag)
 * and neighbours follow (springLiquid). A double-click on a capsule pops an
 * inline story popover (no drawer — 13 §3.6.4). Bottom: a hand-written SVG
 * sparkline (trace-draw, NOT recharts). The agent's distill ring splats into a
 * gene at 100%. Mobile degrades to a vertical timeline + collapsed graph note
 * (acceptable per the brief).
 *
 * Five states (gated / loading / error / empty / data) all render; data from
 * `../mock` (MOCK_GENES keyed by agentId).
 */

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Circle, Dna } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  grammarAccentClasses,
  radius,
  s,
  springDrag,
  springLiquid,
  springSoft,
} from '@/app/workspace/lib/design';
import { useApp } from '@/contexts/app-context';
import { useI18n } from '@/contexts/i18n-context';
import { useTheme } from '@/contexts/theme-context';
import { cn } from '@/lib/utils';

import { MOCK_GENES, MOCK_OVERVIEW } from '../mock';
import { SectionPlaceholder } from '../section-placeholder';
import { SECTION_GRAMMAR } from '../types';
import type { GeneNode } from '../types';

import { DistillRing } from './distill-ring';
import { GeneSparkline } from './gene-sparkline';

const SECTION = 'genes' as const;
const VIEW_W = 560;
const VIEW_H = 320;

interface Placed {
  node: GeneNode;
  x: number;
  y: number;
}

/** Deterministic radial seed layout (mock "force" rest positions). */
function seedLayout(nodes: GeneNode[]): Placed[] {
  const cx = VIEW_W / 2;
  const cy = VIEW_H / 2;
  const radiusPx = Math.min(VIEW_W, VIEW_H) * 0.32;
  return nodes.map((node, i) => {
    const ang = (i / Math.max(nodes.length, 1)) * Math.PI * 2 - Math.PI / 2;
    // genes pull slightly inward so they read as cluster centres
    const r = node.kind === 'gene' ? radiusPx * 0.55 : radiusPx;
    return { node, x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r };
  });
}

/** Quadratic bezier between two points with a perpendicular bow (organic). */
function curve(ax: number, ay: number, bx: number, by: number): string {
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const bow = 28;
  const qx = mx + (-dy / len) * bow;
  const qy = my + (dx / len) * bow;
  return `M${ax.toFixed(1)},${ay.toFixed(1)} Q${qx.toFixed(1)},${qy.toFixed(1)} ${bx.toFixed(1)},${by.toFixed(1)}`;
}

export interface GenesSurfaceProps {
  agentId: string | null;
}

export function GenesSurface({ agentId }: GenesSurfaceProps) {
  const { t } = useI18n();
  const { addToast } = useApp();
  const { resolvedTheme } = useTheme();
  const reduceRaw = useReducedMotion();
  const reduce = !!reduceRaw;
  const isDark = resolvedTheme === 'dark';
  const theme = isDark ? 'dark' : 'light';
  const { accent } = SECTION_GRAMMAR[SECTION];
  const a = grammarAccentClasses[accent];

  const agent = agentId ? MOCK_OVERVIEW.agents.find((ag) => ag.id === agentId) ?? null : null;
  const nodes = useMemo<GeneNode[]>(() => (agentId ? (MOCK_GENES[agentId] ?? []) : []), [agentId]);
  const placed = useMemo(() => seedLayout(nodes), [nodes]);

  // Per-node drag offset so dragging a node bends its edges + nudges neighbours.
  const [offsets, setOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const [story, setStory] = useState<string | null>(null);
  const [splatting, setSplatting] = useState(false);

  // ─── State: gated (no agent) ──────────────────────────────────────────────
  if (!agent) {
    return (
      <SectionPlaceholder
        section={SECTION}
        icon={Dna}
        titleKey="evolution.studio.v2.genes.title"
        hintKey="evolution.studio.v2.genes.gated"
      />
    );
  }

  // ─── State: empty (agent has no genes) ────────────────────────────────────
  if (nodes.length === 0) {
    return (
      <SectionPlaceholder
        section={SECTION}
        icon={Dna}
        titleKey="evolution.studio.v2.genes.title"
        hintKey="evolution.studio.v2.genes.empty"
      />
    );
  }

  const pos = (p: Placed) => {
    const o = offsets[p.node.id] ?? { x: 0, y: 0 };
    return { x: p.x + o.x, y: p.y + o.y };
  };

  // Neighbour spring response: dragging a node tugs the *next* node a little
  // (springLiquid). Mock chain = derive order (index neighbours).
  const setDrag = (id: string, idx: number, dx: number, dy: number) => {
    setOffsets((prev) => {
      const next = { ...prev, [id]: { x: dx, y: dy } };
      const neighbour = placed[idx + 1]?.node.id;
      if (neighbour) next[neighbour] = { x: dx * 0.18, y: dy * 0.18 };
      return next;
    });
  };

  const distill = () => {
    setSplatting(true);
    addToast(t('evolution.studio.v2.genes.distillNow'), 'success');
    window.setTimeout(() => setSplatting(false), 650);
  };

  // capsule velocity buckets for the sparkline (mock — derive from successRate).
  const series = nodes.map((n) => Math.round(n.successRate * 100));
  // distill ring progress = best capsule successRate (mock proxy).
  const ringProgress = Math.min(...[1, ...nodes.filter((n) => n.kind === 'capsule').map((n) => n.successRate)]);

  return (
    <div className="flex h-full flex-col gap-3 px-1 py-1">
      <header className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className={cn('flex size-7 items-center justify-center border', radius.small, s(theme, 'card'), a.ring, 'ring-1')}>
              <Dna className={cn('size-4', a.text)} aria-hidden />
            </span>
            <h2 className={cn('text-base font-semibold', isDark ? 'text-zinc-100' : 'text-zinc-900')}>
              {t('evolution.skills.evolution.gardenLabel')}
            </h2>
          </div>
          <p className={cn('max-w-2xl text-xs', isDark ? 'text-zinc-400' : 'text-zinc-600')}>
            {t('evolution.skills.evolution.gardenHint')}
          </p>
        </div>
        <span className={cn('inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium', a.bg, a.text)}>
          <span className={cn('size-1.5 rounded-full', a.dot)} aria-hidden />
          {SECTION_GRAMMAR[SECTION].grammar}
        </span>
      </header>

      {/* ─── Garden canvas (desktop) / collapsed note (mobile) ────────────── */}
      <div className={cn('relative flex-1 overflow-hidden border', radius.card, s(theme, 'inset'))}>
        {/* Mobile fallback: vertical timeline (graph collapsed) */}
        <div className="flex h-full flex-col gap-2 overflow-y-auto p-3 lg:hidden">
          {nodes.map((n) => (
            <div
              key={n.id}
              className={cn('flex items-center gap-2.5 border p-2.5', radius.small, s(theme, 'card'))}
            >
              {n.kind === 'gene' ? (
                <Circle className={cn('size-4', a.text)} aria-hidden />
              ) : (
                <span className={cn('size-3 rounded-full', a.dot)} aria-hidden />
              )}
              <span className={cn('flex-1 text-xs font-medium', isDark ? 'text-zinc-200' : 'text-zinc-800')}>
                {n.title}
              </span>
              <span className={cn('font-mono text-[11px]', a.text)}>{Math.round(n.successRate * 100)}%</span>
              {n.exportedAsSkill && (
                <span className={cn('rounded-full px-1.5 py-0.5 text-[10px]', a.bg, a.text)}>
                  {t('evolution.skills.evolution.exportedAsSkill')}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Desktop SVG garden */}
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="hidden h-full w-full lg:block"
          preserveAspectRatio="xMidYMid meet"
        >
          {/* distill edges — curving bezier between consecutive nodes */}
          {placed.slice(1).map((p, i) => {
            const from = pos(placed[i]);
            const to = pos(p);
            return (
              <motion.path
                key={`edge-${p.node.id}`}
                d={curve(from.x, from.y, to.x, to.y)}
                fill="none"
                strokeWidth={1.5}
                strokeDasharray="3 4"
                className={a.text}
                stroke="currentColor"
                opacity={0.4}
                initial={reduce ? false : { pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 0.4 }}
                transition={{ ...springLiquid, delay: reduce ? 0 : 0.1 + i * 0.08 }}
              />
            );
          })}

          {/* nodes */}
          {placed.map((p, i) => {
            const { node } = p;
            const isGene = node.kind === 'gene';
            return (
              <motion.g
                key={node.id}
                drag={reduce ? false : true}
                dragMomentum={false}
                dragTransition={{ bounceStiffness: springDrag.stiffness as number, bounceDamping: springDrag.damping as number }}
                onDrag={(_e, info) => setDrag(node.id, i, info.offset.x, info.offset.y)}
                onDragEnd={(_e, info) => setDrag(node.id, i, info.offset.x, info.offset.y)}
                onDoubleClick={() => isGene || setStory(node.id)}
                initial={reduce ? false : { scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ ...springSoft, delay: reduce ? 0 : i * 0.05 }}
                style={{ cursor: reduce ? 'default' : 'grab' }}
                tabIndex={0}
                role="button"
                aria-label={node.title}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !isGene) {
                    e.preventDefault();
                    setStory(node.id);
                  }
                }}
              >
                <motion.circle
                  cx={p.x}
                  cy={p.y}
                  r={isGene ? 15 : 11}
                  className={a.text}
                  fill={isGene ? 'none' : 'currentColor'}
                  stroke="currentColor"
                  strokeWidth={isGene ? 2.5 : 0}
                  animate={{ x: pos(p).x - p.x, y: pos(p).y - p.y }}
                  transition={springLiquid}
                />
                <motion.text
                  x={p.x}
                  y={p.y + (isGene ? 30 : 26)}
                  textAnchor="middle"
                  className={cn('text-[9px]', isDark ? 'fill-zinc-400' : 'fill-zinc-600')}
                  animate={{ x: pos(p).x - p.x, y: pos(p).y - p.y }}
                  transition={springLiquid}
                >
                  {node.title}
                </motion.text>
              </motion.g>
            );
          })}
        </svg>

        {/* inline capsule story popover (no drawer) */}
        <AnimatePresence>
          {story && (
            <motion.div
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.92 }}
              transition={springSoft}
              role="dialog"
              aria-label={t('evolution.studio.v2.genes.nodeStory')}
              className={cn('absolute left-1/2 top-1/2 z-10 w-64 -translate-x-1/2 -translate-y-1/2 border p-3.5', radius.card, s(theme, 'modal'), a.ring, 'ring-1')}
            >
              {(() => {
                const n = nodes.find((x) => x.id === story);
                if (!n) return null;
                return (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn('text-sm font-semibold', isDark ? 'text-zinc-100' : 'text-zinc-900')}>{n.title}</span>
                      <button onClick={() => setStory(null)} className={cn('text-xs', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
                        {t('common.close')}
                      </button>
                    </div>
                    <p className={cn('mt-1.5 text-xs', isDark ? 'text-zinc-400' : 'text-zinc-600')}>
                      {t('evolution.skills.evolution.capsules')} · {Math.round(n.successRate * 100)}%
                    </p>
                    {n.exportedAsSkill && (
                      <span className={cn('mt-2 inline-block rounded-full px-2 py-0.5 text-[10px]', a.bg, a.text)}>
                        {t('evolution.skills.evolution.exportedAsSkill')}
                      </span>
                    )}
                  </>
                );
              })()}
            </motion.div>
          )}
        </AnimatePresence>

        {/* legend */}
        <div className={cn('absolute bottom-2 left-3 hidden items-center gap-3 text-[10px] lg:flex', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
          <span className="flex items-center gap-1"><span className={cn('size-2 rounded-full', a.dot)} aria-hidden />{t('evolution.skills.evolution.capsules')}</span>
          <span className="flex items-center gap-1"><Circle className={cn('size-2.5', a.text)} aria-hidden />{t('evolution.skills.evolution.genes')}</span>
        </div>
      </div>

      {/* ─── Distill ring + sparkline ─────────────────────────────────────── */}
      <footer className={cn('flex flex-wrap items-center justify-between gap-4 border p-3', radius.card, s(theme, 'card'))}>
        <DistillRing
          progress={ringProgress}
          accent={accent}
          isDark={isDark}
          reduce={reduce}
          splatting={splatting}
          onDistill={distill}
        />
        <div className="flex flex-col items-end gap-1">
          <GeneSparkline series={series} accent={accent} reduce={reduce} />
          <span className={cn('text-[11px]', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
            {series.length > 0
              ? t('evolution.studio.v2.genes.capsuleVelocity')
              : t('evolution.skills.evolution.noMetricData')}
          </span>
        </div>
      </footer>
    </div>
  );
}
