/**
 * Evolution Map — Gene Layout Engine
 *
 * Positions genes using a two-level approach:
 * 1. Cluster centers via lightweight force-directed simulation
 * 2. Genes within each cluster via Archimedean spiral (high-mass near center)
 *
 * Cross-domain genes (membership < 0.5) are placed at the weighted
 * centroid of their connected communities.
 *
 * Output coordinates are normalized to an adaptive range based on gene count.
 */

import type { MapGene, MapEdge } from '../../types/evolution-map.types';
import type { CommunityResult } from './community-detect';

// ─── Constants ───────────────────────────────────────────────

/** Golden angle in radians (~137.508 degrees) */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Spiral spacing parameters */
const SPIRAL_A = 0; // initial radius offset

/** Force-directed simulation parameters for cluster layout */
const CLUSTER_REPULSION = 600_000;
const CLUSTER_ATTRACTION = 0.0015;
const CLUSTER_DAMPING = 0.85;
const CLUSTER_ITERATIONS = 120;

// ─── Adaptive helpers ───────────────────────────────────────

/** Adaptive coordinate range — keeps density constant as gene count changes */
function getCoordRange(geneCount: number): number {
  // Wider spread for large gene counts to prevent L3 overlap
  return Math.max(600, Math.sqrt(geneCount) * 280);
}

/** Adaptive spiral spacing — tighter when a cluster has more genes */
function getSpiralB(genesInCluster: number): number {
  // Wider spacing within clusters to reduce overlap
  return Math.max(45, Math.min(90, 350 / Math.sqrt(Math.max(1, genesInCluster))));
}

// ─── Deterministic RNG ──────────────────────────────────────

/** Simple seeded PRNG (xorshift32) for deterministic layouts. */
function createRng(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

/** Hash a string to a 32-bit integer for seeding. */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

// ─── Public interface ────────────────────────────────────────

export function computeGeneLayout(
  genes: MapGene[],
  communities: CommunityResult,
  edges: MapEdge[],
): {
  positions: Map<string, { x: number; y: number }>;
  clusterCenters: Map<number, { x: number; y: number }>;
} {
  if (genes.length === 0) {
    return { positions: new Map(), clusterCenters: new Map() };
  }

  // Group genes by community
  const communityGenes = new Map<number, MapGene[]>();
  for (const gene of genes) {
    const cId = communities.geneCommunities.get(gene.id) ?? 0;
    const arr = communityGenes.get(cId) ?? [];
    arr.push(gene);
    communityGenes.set(cId, arr);
  }

  const communityIds = [...communityGenes.keys()].sort((a, b) => a - b);

  // Step 1: Compute cluster centers via force-directed simulation
  const clusterCenters = computeClusterCenters(communityIds, edges, communities);

  // Step 2: Place genes within each cluster using spiral init + intra-cluster force simulation
  const positions = new Map<string, { x: number; y: number }>();

  // Build signal→gene adjacency for intra-cluster attraction
  const signalToGenes = new Map<string, string[]>();
  for (const e of edges) {
    const arr = signalToGenes.get(e.signalKey) ?? [];
    arr.push(e.geneId);
    signalToGenes.set(e.signalKey, arr);
  }
  const geneToSignals = new Map<string, string[]>();
  for (const e of edges) {
    const arr = geneToSignals.get(e.geneId) ?? [];
    arr.push(e.signalKey);
    geneToSignals.set(e.geneId, arr);
  }

  for (const cId of communityIds) {
    const center = clusterCenters.get(cId)!;
    const clusterGenes = communityGenes.get(cId) ?? [];
    const spiralB = getSpiralB(clusterGenes.length);

    // Sort by totalExecutions descending — highest mass near center
    const sorted = [...clusterGenes].sort((a, b) => b.totalExecutions - a.totalExecutions);

    // Initial placement: Archimedean spiral
    const localPos = new Map<string, { x: number; y: number }>();
    for (let i = 0; i < sorted.length; i++) {
      const gene = sorted[i];
      const membership = communities.communityMembership.get(gene.id) ?? 1.0;
      if (membership < 0.5) continue;

      const theta = i * GOLDEN_ANGLE;
      const r = SPIRAL_A + spiralB * theta;
      localPos.set(gene.id, {
        x: center.x + r * Math.cos(theta),
        y: center.y + r * Math.sin(theta),
      });
    }

    // Intra-cluster force-directed refinement (spread nodes apart)
    if (localPos.size > 1) {
      const ids = [...localPos.keys()];
      const n = ids.length;
      const vel = new Map<string, { x: number; y: number }>();
      for (const id of ids) vel.set(id, { x: 0, y: 0 });

      const NODE_REPULSION = 18000;
      const SIGNAL_ATTRACTION = 0.003;
      const CENTER_GRAVITY = 0.0008;
      const DAMPING = 0.8;
      const ITERATIONS = 80;

      for (let iter = 0; iter < ITERATIONS; iter++) {
        const forces = new Map<string, { x: number; y: number }>();
        for (const id of ids) forces.set(id, { x: 0, y: 0 });

        // Repulsion between all pairs in this cluster
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            const pi = localPos.get(ids[i])!;
            const pj = localPos.get(ids[j])!;
            const dx = pi.x - pj.x;
            const dy = pi.y - pj.y;
            const distSq = dx * dx + dy * dy + 1;
            const dist = Math.sqrt(distSq);
            const f = NODE_REPULSION / distSq;
            const fx = (f * dx) / dist;
            const fy = (f * dy) / dist;
            forces.get(ids[i])!.x += fx;
            forces.get(ids[i])!.y += fy;
            forces.get(ids[j])!.x -= fx;
            forces.get(ids[j])!.y -= fy;
          }
        }

        // Attraction between genes sharing a signal
        for (const id of ids) {
          const sigs = geneToSignals.get(id) ?? [];
          for (const sig of sigs) {
            const neighbors = signalToGenes.get(sig) ?? [];
            for (const nbr of neighbors) {
              if (nbr === id || !localPos.has(nbr)) continue;
              const pi = localPos.get(id)!;
              const pj = localPos.get(nbr)!;
              const dx = pj.x - pi.x;
              const dy = pj.y - pi.y;
              const dist = Math.sqrt(dx * dx + dy * dy + 1);
              forces.get(id)!.x += SIGNAL_ATTRACTION * dx;
              forces.get(id)!.y += SIGNAL_ATTRACTION * dy;
            }
          }
        }

        // Gravity toward cluster center (prevent drift)
        for (const id of ids) {
          const p = localPos.get(id)!;
          forces.get(id)!.x += (center.x - p.x) * CENTER_GRAVITY;
          forces.get(id)!.y += (center.y - p.y) * CENTER_GRAVITY;
        }

        // Apply forces
        for (const id of ids) {
          const v = vel.get(id)!;
          const f = forces.get(id)!;
          v.x = (v.x + f.x) * DAMPING;
          v.y = (v.y + f.y) * DAMPING;
          const p = localPos.get(id)!;
          p.x += v.x;
          p.y += v.y;
        }
      }
    }

    // Copy to global positions
    for (const [id, pos] of localPos) {
      positions.set(id, pos);
    }
  }

  // Step 3: Position cross-domain genes at weighted centroid of their communities
  placeCrossDomainGenes(genes, communities, edges, clusterCenters, positions);

  // Step 4: Normalize all positions to adaptive [-coordRange, coordRange]
  const coordRange = getCoordRange(genes.length);
  normalizePositions(positions, coordRange);

  // Also normalize cluster centers to the same range
  normalizeClusterCenters(clusterCenters, positions, communityGenes);

  return { positions, clusterCenters };
}

// ─── Cluster-level force-directed layout ─────────────────────

/**
 * Position N_clusters nodes using a simple force-directed simulation.
 * Clusters connected by shared signals attract; all clusters repel.
 */
function computeClusterCenters(
  communityIds: number[],
  edges: MapEdge[],
  communities: CommunityResult,
): Map<number, { x: number; y: number }> {
  const n = communityIds.length;
  const centers = new Map<number, { x: number; y: number }>();

  if (n === 0) return centers;

  // Single cluster — place at origin
  if (n === 1) {
    centers.set(communityIds[0], { x: 0, y: 0 });
    return centers;
  }

  // Initialize positions on a circle
  const rng = createRng(42);
  const initRadius = 500 * Math.sqrt(n);
  const positions: { x: number; y: number }[] = [];
  const velocities: { x: number; y: number }[] = [];

  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n + (rng() - 0.5) * 0.3;
    positions.push({
      x: initRadius * Math.cos(angle),
      y: initRadius * Math.sin(angle),
    });
    velocities.push({ x: 0, y: 0 });
  }

  // Build cluster-level adjacency: weight = number of shared signals
  // Two clusters share a signal if the signal connects to genes in both clusters
  const clusterAdj = new Map<string, number>();
  const signalClusters = new Map<string, Set<number>>();

  for (const e of edges) {
    if (e.totalObs <= 0) continue;
    const cId = communities.geneCommunities.get(e.geneId);
    if (cId === undefined) continue;
    const set = signalClusters.get(e.signalKey) ?? new Set();
    set.add(cId);
    signalClusters.set(e.signalKey, set);
  }

  for (const [, clusterSet] of signalClusters) {
    const arr = [...clusterSet];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = arr[i] < arr[j] ? `${arr[i]}:${arr[j]}` : `${arr[j]}:${arr[i]}`;
        clusterAdj.set(key, (clusterAdj.get(key) ?? 0) + 1);
      }
    }
  }

  const idxOf = new Map<number, number>();
  for (let i = 0; i < n; i++) idxOf.set(communityIds[i], i);

  // Force-directed simulation
  for (let iter = 0; iter < CLUSTER_ITERATIONS; iter++) {
    // Reset forces
    const forces = positions.map(() => ({ x: 0, y: 0 }));

    // Repulsion between all pairs
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = positions[i].x - positions[j].x;
        const dy = positions[i].y - positions[j].y;
        const distSq = dx * dx + dy * dy + 1; // +1 to avoid division by zero
        const force = CLUSTER_REPULSION / distSq;
        const dist = Math.sqrt(distSq);
        const fx = (force * dx) / dist;
        const fy = (force * dy) / dist;
        forces[i].x += fx;
        forces[i].y += fy;
        forces[j].x -= fx;
        forces[j].y -= fy;
      }
    }

    // Attraction along connected cluster edges
    for (const [key, weight] of clusterAdj) {
      const [aStr, bStr] = key.split(':');
      const aIdx = idxOf.get(Number(aStr));
      const bIdx = idxOf.get(Number(bStr));
      if (aIdx === undefined || bIdx === undefined) continue;

      const dx = positions[bIdx].x - positions[aIdx].x;
      const dy = positions[bIdx].y - positions[aIdx].y;
      const dist = Math.sqrt(dx * dx + dy * dy + 1);
      const force = CLUSTER_ATTRACTION * weight * dist;
      const fx = (force * dx) / dist;
      const fy = (force * dy) / dist;
      forces[aIdx].x += fx;
      forces[aIdx].y += fy;
      forces[bIdx].x -= fx;
      forces[bIdx].y -= fy;
    }

    // Apply forces with damping
    for (let i = 0; i < n; i++) {
      velocities[i].x = (velocities[i].x + forces[i].x) * CLUSTER_DAMPING;
      velocities[i].y = (velocities[i].y + forces[i].y) * CLUSTER_DAMPING;
      positions[i].x += velocities[i].x;
      positions[i].y += velocities[i].y;
    }
  }

  for (let i = 0; i < n; i++) {
    centers.set(communityIds[i], { x: positions[i].x, y: positions[i].y });
  }

  return centers;
}

// ─── Cross-domain gene placement ─────────────────────────────

/**
 * Position cross-domain genes (membership < 0.5) at the weighted
 * centroid of the communities they connect to via edges.
 */
function placeCrossDomainGenes(
  genes: MapGene[],
  communities: CommunityResult,
  edges: MapEdge[],
  clusterCenters: Map<number, { x: number; y: number }>,
  positions: Map<string, { x: number; y: number }>,
): void {
  // Index edges by gene
  const geneEdges = new Map<string, MapEdge[]>();
  for (const e of edges) {
    const arr = geneEdges.get(e.geneId) ?? [];
    arr.push(e);
    geneEdges.set(e.geneId, arr);
  }

  // Index edges by signal to find connected genes per signal
  const signalGenes = new Map<string, string[]>();
  for (const e of edges) {
    const arr = signalGenes.get(e.signalKey) ?? [];
    arr.push(e.geneId);
    signalGenes.set(e.signalKey, arr);
  }

  for (const gene of genes) {
    const membership = communities.communityMembership.get(gene.id) ?? 1.0;
    if (membership >= 0.5) continue; // already placed
    if (positions.has(gene.id)) continue; // already placed

    // Find all communities this gene connects to (via shared signals with other genes)
    const communityWeights = new Map<number, number>();
    const myEdges = geneEdges.get(gene.id) ?? [];

    for (const e of myEdges) {
      // All genes connected to the same signal
      const otherGenes = signalGenes.get(e.signalKey) ?? [];
      for (const otherGeneId of otherGenes) {
        if (otherGeneId === gene.id) continue;
        const otherComm = communities.geneCommunities.get(otherGeneId);
        if (otherComm !== undefined) {
          communityWeights.set(otherComm, (communityWeights.get(otherComm) ?? 0) + 1);
        }
      }
    }

    if (communityWeights.size === 0) {
      // Fallback: place near own community center
      const ownComm = communities.geneCommunities.get(gene.id) ?? 0;
      const center = clusterCenters.get(ownComm) ?? { x: 0, y: 0 };
      const rng = createRng(hashString(gene.id));
      positions.set(gene.id, {
        x: center.x + (rng() - 0.5) * 200,
        y: center.y + (rng() - 0.5) * 200,
      });
      continue;
    }

    // Weighted centroid of connected community centers
    let wx = 0,
      wy = 0,
      wTotal = 0;
    for (const [cId, weight] of communityWeights) {
      const center = clusterCenters.get(cId);
      if (!center) continue;
      wx += center.x * weight;
      wy += center.y * weight;
      wTotal += weight;
    }

    if (wTotal > 0) {
      // Add small deterministic offset to avoid overlap
      const rng = createRng(hashString(gene.id));
      positions.set(gene.id, {
        x: wx / wTotal + (rng() - 0.5) * 100,
        y: wy / wTotal + (rng() - 0.5) * 100,
      });
    } else {
      positions.set(gene.id, { x: 0, y: 0 });
    }
  }
}

// ─── Normalization ───────────────────────────────────────────

/**
 * Normalize all gene positions to fit within [-coordRange, coordRange].
 */
function normalizePositions(positions: Map<string, { x: number; y: number }>, coordRange: number): void {
  if (positions.size === 0) return;

  let minX = Infinity,
    maxX = -Infinity;
  let minY = Infinity,
    maxY = -Infinity;

  for (const pos of positions.values()) {
    if (pos.x < minX) minX = pos.x;
    if (pos.x > maxX) maxX = pos.x;
    if (pos.y < minY) minY = pos.y;
    if (pos.y > maxY) maxY = pos.y;
  }

  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const scale = Math.min((2 * coordRange) / rangeX, (2 * coordRange) / rangeY);

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  for (const pos of positions.values()) {
    pos.x = (pos.x - centerX) * scale;
    pos.y = (pos.y - centerY) * scale;
  }
}

/**
 * Recompute cluster centers as the centroid of their member genes
 * (after normalization).
 */
function normalizeClusterCenters(
  clusterCenters: Map<number, { x: number; y: number }>,
  positions: Map<string, { x: number; y: number }>,
  communityGenes: Map<number, MapGene[]>,
): void {
  for (const [cId, genes] of communityGenes) {
    let sx = 0,
      sy = 0,
      count = 0;
    for (const gene of genes) {
      const pos = positions.get(gene.id);
      if (pos) {
        sx += pos.x;
        sy += pos.y;
        count++;
      }
    }
    if (count > 0) {
      clusterCenters.set(cId, { x: sx / count, y: sy / count });
    }
  }
}
