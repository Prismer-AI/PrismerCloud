/**
 * Evolution Map — Signal Layout Engine
 *
 * Positions signals relative to their connected genes:
 *
 * - Single-gene signals: orbit around the primary gene at a distance
 *   inversely proportional to routing weight. Angles are distributed
 *   evenly among all signals orbiting the same gene.
 *
 * - Two-gene signals: placed at the weighted midpoint between the
 *   two genes (weighted by routing weight / confidence).
 *
 * - Three+ gene signals: placed at the weighted centroid of all
 *   connected genes, with a small deterministic offset.
 *
 * (See MAP-DESIGN doc section 2.3)
 */

import type { MapSignal, MapEdge } from '../../types/evolution-map.types';

// ─── Constants ───────────────────────────────────────────────

/** Base orbit radius for single-gene signals */
const BASE_R = 120;

/** Minimum separation between signal nodes */
const MIN_SEPARATION = 60;

// ─── Deterministic RNG ──────────────────────────────────────

function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

function createRng(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

// ─── Public interface ────────────────────────────────────────

export interface SignalPosition {
  x: number;
  y: number;
  primaryGeneId: string;
  orbitRadius: number;
  orbitAngle: number;
}

export function computeSignalLayout(
  signals: MapSignal[],
  edges: MapEdge[],
  genePositions: Map<string, { x: number; y: number }>,
): Map<string, SignalPosition> {
  const result = new Map<string, SignalPosition>();

  if (signals.length === 0) return result;

  // Index edges by signal key
  const signalEdges = new Map<string, MapEdge[]>();
  for (const e of edges) {
    const arr = signalEdges.get(e.signalKey) ?? [];
    arr.push(e);
    signalEdges.set(e.signalKey, arr);
  }

  // For single-gene signals, we need to distribute angles evenly per gene.
  // First pass: identify single-gene signals and group by primary gene.
  const singleGeneSignals = new Map<string, string[]>(); // geneId -> [signalKey, ...]

  for (const signal of signals) {
    const myEdges = signalEdges.get(signal.key) ?? [];
    const connectedGenes = myEdges.filter((e) => genePositions.has(e.geneId));

    if (connectedGenes.length === 1) {
      const geneId = connectedGenes[0].geneId;
      const arr = singleGeneSignals.get(geneId) ?? [];
      arr.push(signal.key);
      singleGeneSignals.set(geneId, arr);
    }
  }

  // Second pass: compute positions
  for (const signal of signals) {
    const myEdges = signalEdges.get(signal.key) ?? [];
    const connectedGenes = myEdges.filter((e) => genePositions.has(e.geneId));

    if (connectedGenes.length === 0) {
      // Orphan signal — place near origin with deterministic offset
      const rng = createRng(hashString(signal.key));
      result.set(signal.key, {
        x: (rng() - 0.5) * 400,
        y: (rng() - 0.5) * 400,
        primaryGeneId: '',
        orbitRadius: 0,
        orbitAngle: 0,
      });
      continue;
    }

    // Determine primary gene: highest routingWeight (fallback to confidence)
    let primaryEdge = connectedGenes[0];
    for (const e of connectedGenes) {
      const weight = e.routingWeight ?? e.confidence;
      const primaryWeight = primaryEdge.routingWeight ?? primaryEdge.confidence;
      if (weight > primaryWeight) {
        primaryEdge = e;
      }
    }
    const primaryGeneId = primaryEdge.geneId;

    if (connectedGenes.length === 1) {
      // Single-gene signal: orbit around the gene
      const genePos = genePositions.get(primaryGeneId)!;
      const weight = primaryEdge.routingWeight ?? primaryEdge.confidence;

      // Orbit radius inversely proportional to weight
      // Higher weight = closer to gene
      const orbitRadius = BASE_R * (1.5 - Math.min(weight, 1.0));

      // Distribute angles evenly among all signals orbiting this gene
      const siblings = singleGeneSignals.get(primaryGeneId) ?? [signal.key];
      const idx = siblings.indexOf(signal.key);
      const totalSiblings = siblings.length;
      const orbitAngle = (2 * Math.PI * idx) / totalSiblings;

      result.set(signal.key, {
        x: genePos.x + orbitRadius * Math.cos(orbitAngle),
        y: genePos.y + orbitRadius * Math.sin(orbitAngle),
        primaryGeneId,
        orbitRadius,
        orbitAngle,
      });
    } else if (connectedGenes.length === 2) {
      // Two-gene signal: weighted midpoint
      const geneA = connectedGenes[0];
      const geneB = connectedGenes[1];
      const posA = genePositions.get(geneA.geneId)!;
      const posB = genePositions.get(geneB.geneId)!;

      const wA = geneA.routingWeight ?? geneA.confidence;
      const wB = geneB.routingWeight ?? geneB.confidence;
      const wTotal = wA + wB || 1;

      const x = (posA.x * wA + posB.x * wB) / wTotal;
      const y = (posA.y * wA + posB.y * wB) / wTotal;

      // Compute orbit-like properties relative to primary gene
      const primaryPos = genePositions.get(primaryGeneId)!;
      const dx = x - primaryPos.x;
      const dy = y - primaryPos.y;
      const orbitRadius = Math.sqrt(dx * dx + dy * dy);
      const orbitAngle = Math.atan2(dy, dx);

      result.set(signal.key, {
        x,
        y,
        primaryGeneId,
        orbitRadius,
        orbitAngle,
      });
    } else {
      // Three+ gene signal: weighted centroid + small deterministic offset
      let wx = 0,
        wy = 0,
        wTotal = 0;

      for (const e of connectedGenes) {
        const pos = genePositions.get(e.geneId)!;
        const w = e.routingWeight ?? e.confidence;
        wx += pos.x * w;
        wy += pos.y * w;
        wTotal += w;
      }

      if (wTotal === 0) wTotal = 1;

      const rng = createRng(hashString(signal.key));
      const offsetX = (rng() - 0.5) * 60;
      const offsetY = (rng() - 0.5) * 60;

      const x = wx / wTotal + offsetX;
      const y = wy / wTotal + offsetY;

      // Compute orbit-like properties relative to primary gene
      const primaryPos = genePositions.get(primaryGeneId)!;
      const dx = x - primaryPos.x;
      const dy = y - primaryPos.y;
      const orbitRadius = Math.sqrt(dx * dx + dy * dy);
      const orbitAngle = Math.atan2(dy, dx);

      result.set(signal.key, {
        x,
        y,
        primaryGeneId,
        orbitRadius,
        orbitAngle,
      });
    }
  }

  // Post-processing: repulsion pass to separate overlapping signal nodes
  if (result.size > 1) {
    const entries = [...result.entries()];
    const REPULSION_ITERATIONS = 30;
    const REPULSION_FORCE = 2000;

    for (let iter = 0; iter < REPULSION_ITERATIONS; iter++) {
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const [, a] = entries[i];
          const [, b] = entries[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const distSq = dx * dx + dy * dy + 1;
          const dist = Math.sqrt(distSq);

          if (dist < MIN_SEPARATION) {
            const force = REPULSION_FORCE / distSq;
            const fx = (force * dx) / dist;
            const fy = (force * dy) / dist;
            a.x += fx;
            a.y += fy;
            b.x -= fx;
            b.y -= fy;
          }
        }
      }
    }
  }

  return result;
}
