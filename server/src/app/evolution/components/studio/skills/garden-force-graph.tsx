'use client';

/**
 * Garden force-graph — release201/13 §3.6 + release201/20 §9.2 V2.
 *
 * Real d3-force physics layout for the Evolution sub-tab garden:
 *   - forceManyBody   — mutual repulsion keeps nodes from clumping
 *   - forceLink       — edges between capsules and distilled genes
 *   - forceCenter     — pull cluster to viewport centre
 *   - forceCollide    — radius-aware collision avoidance
 *
 * Reduced-motion fallback (release201/12 §8.8.6.6): simulation is never
 * started; nodes are placed via a deterministic hash → x/y seed so the
 * visual still renders without animation.
 *
 * Distilled genes wear a pulsing splash ring via the `animate-prismer-gene-pulse`
 * keyframe declared in globals.css (Wave 13 / S44 motion vocab).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { useReducedMotion } from 'framer-motion';

export interface GardenForceNode {
  id: string;
  kind: 'capsule' | 'gene';
  label: string;
  /** Base render radius (px in the viewBox-equivalent space). */
  r: number;
  /** True when a gene has been distilled into an installed skill. */
  distilled: boolean;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  kind: 'capsule' | 'gene';
  label: string;
  r: number;
  distilled: boolean;
}

type SimLink = SimulationLinkDatum<SimNode>;

interface PositionedNode extends GardenForceNode {
  x: number;
  y: number;
}

interface GardenForceGraphProps {
  nodes: GardenForceNode[];
  width: number;
  height: number;
  isDark: boolean;
  /** Edge colour + node fill — accent.glow from grammarAccentClasses. */
  accentGlow: string;
}

/**
 * Deterministic seed → [0, 1) — used when reduced-motion is on so the
 * static layout is stable across renders.
 */
function seed(s: string, mul: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i) * mul) >>> 0;
  return (h % 1000) / 1000;
}

function staticPositions(nodes: GardenForceNode[], width: number, height: number): PositionedNode[] {
  return nodes.map((n) => {
    // Capsules on the left band, genes on the right band — matches the
    // pre-V2 layout so the reduced-motion view does not visually break.
    const baseX = n.kind === 'capsule' ? 0.15 : 0.55;
    return {
      ...n,
      x: (baseX + seed(n.id, 7) * 0.35) * width,
      y: (0.15 + seed(n.id, 13) * 0.7) * height,
    };
  });
}

export function GardenForceGraph({ nodes, width, height, isDark, accentGlow }: GardenForceGraphProps) {
  const prefersReducedMotion = useReducedMotion();
  const simulationRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  // Stable identity for nodes between renders so React keys stay consistent.
  const nodeIdsKey = useMemo(() => nodes.map((n) => n.id).join('|'), [nodes]);

  // Links: every distilled gene → the first capsule (best-effort cluster
  // anchor matching the storyboard "distilled gene radiates back to its
  // capsule diaspora").
  const links = useMemo<Array<{ source: string; target: string }>>(() => {
    const firstCapsule = nodes.find((n) => n.kind === 'capsule');
    if (!firstCapsule) return [];
    return nodes.filter((n) => n.distilled).map((g) => ({ source: firstCapsule.id, target: g.id }));
  }, [nodes]);

  const [positions, setPositions] = useState<PositionedNode[]>(() => staticPositions(nodes, width, height));

  useEffect(() => {
    // Reduced-motion: never run the simulation. Render static layout.
    if (prefersReducedMotion) {
      setPositions(staticPositions(nodes, width, height));
      return;
    }
    if (nodes.length === 0) {
      setPositions([]);
      return;
    }

    // Seed initial positions so the first paint is not a singular point.
    const simNodes: SimNode[] = nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      label: n.label,
      r: n.r,
      distilled: n.distilled,
      x: (n.kind === 'capsule' ? 0.3 : 0.7) * width + (seed(n.id, 7) - 0.5) * width * 0.15,
      y: (0.2 + seed(n.id, 13) * 0.6) * height,
    }));
    const simLinks: SimLink[] = links.map((l) => ({ source: l.source, target: l.target }));

    const sim = forceSimulation(simNodes)
      .force('charge', forceManyBody<SimNode>().strength(-40))
      .force(
        'link',
        forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance(width * 0.25)
          .strength(0.4),
      )
      .force('center', forceCenter(width / 2, height / 2))
      .force(
        'collide',
        forceCollide<SimNode>().radius((d) => d.r * 1.6 + 4),
      )
      .alpha(0.9)
      .alphaDecay(0.04);

    simulationRef.current = sim;

    sim.on('tick', () => {
      setPositions(
        simNodes.map((n) => ({
          id: n.id,
          kind: n.kind,
          label: n.label,
          r: n.r,
          distilled: n.distilled,
          x: Math.max(n.r, Math.min(width - n.r, n.x ?? width / 2)),
          y: Math.max(n.r, Math.min(height - n.r, n.y ?? height / 2)),
        })),
      );
    });

    return () => {
      sim.stop();
      simulationRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeIdsKey, width, height, prefersReducedMotion, links]);

  // Edge endpoints — recomputed from positions so they track simulation tick.
  const edges = useMemo(() => {
    const byId = new Map(positions.map((p) => [p.id, p]));
    return links
      .map((l) => {
        const a = byId.get(l.source);
        const b = byId.get(l.target);
        if (!a || !b) return null;
        return { id: `${l.source}->${l.target}`, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
      })
      .filter((e): e is { id: string; x1: number; y1: number; x2: number; y2: number } => !!e);
  }, [links, positions]);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="absolute inset-0 h-full w-full"
      data-testid="garden-force-svg"
      data-reduced-motion={prefersReducedMotion ? 'true' : 'false'}
    >
      {edges.map((e) => (
        <line
          key={e.id}
          x1={e.x1}
          y1={e.y1}
          x2={e.x2}
          y2={e.y2}
          stroke={accentGlow}
          strokeWidth="0.4"
          strokeDasharray="2 2"
          opacity={0.55}
        />
      ))}
      {positions.map((n) => (
        <g key={n.id} data-node-id={n.id} data-node-kind={n.kind}>
          {/* Distill splash ring — only on distilled genes. */}
          {n.distilled && (
            <circle
              cx={n.x}
              cy={n.y}
              r={n.r * 1.8}
              fill="none"
              stroke={accentGlow}
              strokeWidth="0.4"
              opacity={0.55}
              className="animate-prismer-gene-pulse"
              style={{ ['--prismer-glow' as string]: accentGlow }}
              data-testid="distill-splash"
            />
          )}
          <circle
            cx={n.x}
            cy={n.y}
            r={n.r}
            fill={accentGlow}
            stroke={n.distilled ? accentGlow : 'none'}
            strokeWidth={n.distilled ? '0.5' : '0'}
            className={`animate-prismer-gene-pulse ${n.kind === 'capsule' ? 'opacity-70' : ''}`}
            style={{ ['--prismer-glow' as string]: accentGlow }}
          />
          <text
            x={n.x}
            y={n.y + n.r + 6}
            textAnchor="middle"
            fontSize="3"
            fontFamily="monospace"
            fill={isDark ? '#e4e4e7' : '#3f3f46'}
            opacity={0.85}
            style={{ pointerEvents: 'none' }}
          >
            {n.label.slice(0, 14)}
          </text>
        </g>
      ))}
    </svg>
  );
}
