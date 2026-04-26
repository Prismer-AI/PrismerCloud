/**
 * Evolution Map — Layout Orchestrator
 *
 * Ties together community detection, gene layout, and signal layout
 * into a single `computeLayout()` call that produces a complete MapLayout.
 *
 * Also exports `getPointOnBezier()` for hit-testing along edge curves.
 */

import type {
  EvolutionMapData,
  LayoutConfig,
  MapLayout,
  GeneNode,
  SignalNode,
  EdgePath,
  CommunityInfo,
  CommunityPhase,
} from '../../types/evolution-map.types';
import { categoryToShape } from '../../types/evolution-map.types';
import { detectDomains } from './community-detect';
import { computeGeneLayout } from './gene-layout';
import { computeSignalLayout } from './signal-layout';
import { confidenceToColor, CLUSTER_HALO_COLORS } from '../renderer/colors';

// ─── Constants ───────────────────────────────────────────────

/** Default dimensions for gene and signal nodes */
const GENE_NODE_WIDTH = 120;
const GENE_NODE_HEIGHT = 60;
const SIGNAL_NODE_WIDTH = 100;
const SIGNAL_NODE_HEIGHT = 40;
const SIGNAL_NODE_RADIUS = 20;

/** Edge visual limits */
const MAX_LINE_WIDTH = 5;
const MAX_OPACITY = 0.75;
const MIN_OPACITY = 0.12;

/** Bezier control point offset range */
const BEZIER_OFFSET_BASE = 15;
const BEZIER_OFFSET_VARIANCE = 10;

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

// ─── Main layout function ────────────────────────────────────

export function computeLayout(data: EvolutionMapData, _config: LayoutConfig): MapLayout {
  const { signals, genes, edges } = data;

  // Handle empty data
  if (genes.length === 0 && signals.length === 0) {
    return {
      signalNodes: [],
      geneNodes: [],
      edges: [],
      clusters: [],
      contentWidth: 0,
      contentHeight: 0,
      bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
      phase: 'cold',
    };
  }

  // Step 1: Community detection
  const communities = detectDomains(edges, genes, signals);

  // Step 2: Gene layout
  const { positions: genePositions, clusterCenters } = computeGeneLayout(genes, communities, edges);

  // Step 3: Signal layout
  const signalPositions = computeSignalLayout(signals, edges, genePositions);

  // Step 4: Build GeneNode[]
  const geneNodes: GeneNode[] = genes.map((gene) => {
    const pos = genePositions.get(gene.id) ?? { x: 0, y: 0 };
    const communityId = communities.geneCommunities.get(gene.id);
    const membership = communities.communityMembership.get(gene.id);

    return {
      id: gene.id,
      title: gene.title,
      category: gene.category,
      shape: categoryToShape(gene.category),
      successRate: gene.successRate,
      totalExecutions: gene.totalExecutions,
      agentCount: gene.agentCount,
      pqi: gene.pqi,
      communityId,
      communityMembership: membership,
      x: pos.x,
      y: pos.y,
      width: GENE_NODE_WIDTH,
      height: GENE_NODE_HEIGHT,
    };
  });

  // Step 5: Build SignalNode[]
  const signalNodes: SignalNode[] = signals.map((signal) => {
    const pos = signalPositions.get(signal.key);
    return {
      key: signal.key,
      category: signal.category,
      frequency: signal.frequency,
      lastSeen: signal.lastSeen,
      x: pos?.x ?? 0,
      y: pos?.y ?? 0,
      width: SIGNAL_NODE_WIDTH,
      height: SIGNAL_NODE_HEIGHT,
      radius: SIGNAL_NODE_RADIUS,
      primaryGeneId: pos?.primaryGeneId,
      orbitRadius: pos?.orbitRadius,
      orbitAngle: pos?.orbitAngle,
    };
  });

  // Build lookup maps for edge construction
  const signalPosMap = new Map<string, { x: number; y: number }>();
  for (const sn of signalNodes) {
    signalPosMap.set(sn.key, { x: sn.x, y: sn.y });
  }
  const genePosMap = new Map<string, { x: number; y: number }>();
  for (const gn of geneNodes) {
    genePosMap.set(gn.id, { x: gn.x, y: gn.y });
  }

  // Step 6: Build EdgePath[] with bezier control points and visual properties
  const edgePaths: EdgePath[] = [];
  for (const edge of edges) {
    const sPos = signalPosMap.get(edge.signalKey);
    const gPos = genePosMap.get(edge.geneId);
    if (!sPos || !gPos) continue;

    const sx = sPos.x;
    const sy = sPos.y;
    const gx = gPos.x;
    const gy = gPos.y;

    // Bezier control points: midpoint with perpendicular offset
    const { cp1x, cp1y, cp2x, cp2y } = computeBezierControlPoints(sx, sy, gx, gy, edge.signalKey, edge.geneId);

    // Visual properties
    const lineWidth = Math.min(1 + Math.log2(edge.totalObs + 1) * 1.2, MAX_LINE_WIDTH);
    const color = confidenceToColor(edge.confidence);
    const opacity = Math.min(MIN_OPACITY + Math.min(edge.totalObs / 30, 0.6), MAX_OPACITY);

    const edgePath: EdgePath = {
      signalKey: edge.signalKey,
      geneId: edge.geneId,
      confidence: edge.confidence,
      routingWeight: edge.routingWeight,
      totalObs: edge.totalObs,
      isExploring: edge.isExploring,
      alpha: edge.alpha,
      beta: edge.beta,
      bimodalityIndex: edge.bimodalityIndex,
      coverageLevel: edge.coverageLevel,
      taskSuccessRate: edge.taskSuccessRate,
      sx,
      sy,
      gx,
      gy,
      cp1x,
      cp1y,
      cp2x,
      cp2y,
      lineWidth,
      color,
      opacity,
    };
    edgePaths.push(edgePath);
  }

  // Step 7: Build CommunityInfo[]
  const clusters: CommunityInfo[] = buildCommunityInfo(
    communities.geneCommunities,
    communities.communityLabels,
    clusterCenters,
    communities.phase,
  );

  // Compute content bounds
  const bounds = computeBounds(geneNodes, signalNodes);
  const totalSpan = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1);

  return {
    signalNodes,
    geneNodes,
    edges: edgePaths,
    clusters,
    contentWidth: bounds.maxX - bounds.minX,
    contentHeight: bounds.maxY - bounds.minY,
    bounds,
    phase: communities.phase,
    totalSpan,
  };
}

// ─── Bezier control points ───────────────────────────────────

/**
 * Compute cubic bezier control points for an edge from (sx, sy) to (gx, gy).
 *
 * Control points are placed at 1/3 and 2/3 along the line, offset
 * perpendicularly by a deterministic amount seeded by the edge identity.
 */
function computeBezierControlPoints(
  sx: number,
  sy: number,
  gx: number,
  gy: number,
  signalKey: string,
  geneId: string,
): { cp1x: number; cp1y: number; cp2x: number; cp2y: number } {
  const rng = createRng(hashString(signalKey + ':' + geneId));

  // Midpoint and perpendicular direction
  const dx = gx - sx;
  const dy = gy - sy;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;

  // Unit perpendicular vector
  const perpX = -dy / len;
  const perpY = dx / len;

  // Deterministic offset with controlled variance
  const offset1 = BEZIER_OFFSET_BASE + (rng() - 0.5) * 2 * BEZIER_OFFSET_VARIANCE;
  const offset2 = BEZIER_OFFSET_BASE + (rng() - 0.5) * 2 * BEZIER_OFFSET_VARIANCE;

  // Randomly flip direction for visual variety (but deterministic)
  const sign = rng() > 0.5 ? 1 : -1;

  return {
    cp1x: sx + dx * (1 / 3) + perpX * offset1 * sign,
    cp1y: sy + dy * (1 / 3) + perpY * offset1 * sign,
    cp2x: sx + dx * (2 / 3) + perpX * offset2 * sign,
    cp2y: sy + dy * (2 / 3) + perpY * offset2 * sign,
  };
}

// ─── Cubic Bezier evaluation ─────────────────────────────────

/**
 * Evaluate a cubic bezier curve at parameter t (0-1).
 *
 * P(t) = (1-t)^3 * P0 + 3(1-t)^2 * t * P1 + 3(1-t) * t^2 * P2 + t^3 * P3
 *
 * Used by hit-testing to find the closest point on an edge path.
 */
export function getPointOnBezier(
  sx: number,
  sy: number,
  cp1x: number,
  cp1y: number,
  cp2x: number,
  cp2y: number,
  gx: number,
  gy: number,
  t: number,
): { x: number; y: number } {
  const t2 = t * t;
  const t3 = t2 * t;
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;

  return {
    x: mt3 * sx + 3 * mt2 * t * cp1x + 3 * mt * t2 * cp2x + t3 * gx,
    y: mt3 * sy + 3 * mt2 * t * cp1y + 3 * mt * t2 * cp2y + t3 * gy,
  };
}

// ─── Community info builder ──────────────────────────────────

function buildCommunityInfo(
  geneCommunities: Map<string, number>,
  communityLabels: Map<number, string>,
  clusterCenters: Map<number, { x: number; y: number }>,
  _phase: CommunityPhase,
): CommunityInfo[] {
  // Group genes by community
  const communityGeneIds = new Map<number, string[]>();
  for (const [geneId, cId] of geneCommunities) {
    const arr = communityGeneIds.get(cId) ?? [];
    arr.push(geneId);
    communityGeneIds.set(cId, arr);
  }

  const result: CommunityInfo[] = [];

  for (const [communityId, geneIds] of communityGeneIds) {
    const center = clusterCenters.get(communityId) ?? { x: 0, y: 0 };
    const label = communityLabels.get(communityId) ?? `domain-${communityId}`;
    const color = CLUSTER_HALO_COLORS[communityId % CLUSTER_HALO_COLORS.length];

    result.push({
      communityId,
      label,
      geneIds,
      center: { x: center.x, y: center.y },
      color,
    });
  }

  return result;
}

// ─── Bounds computation ──────────────────────────────────────

function computeBounds(
  geneNodes: GeneNode[],
  signalNodes: SignalNode[],
): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity,
    maxX = -Infinity;
  let minY = Infinity,
    maxY = -Infinity;

  for (const node of geneNodes) {
    const left = node.x - node.width / 2;
    const right = node.x + node.width / 2;
    const top = node.y - node.height / 2;
    const bottom = node.y + node.height / 2;
    if (left < minX) minX = left;
    if (right > maxX) maxX = right;
    if (top < minY) minY = top;
    if (bottom > maxY) maxY = bottom;
  }

  for (const node of signalNodes) {
    const left = node.x - node.width / 2;
    const right = node.x + node.width / 2;
    const top = node.y - node.height / 2;
    const bottom = node.y + node.height / 2;
    if (left < minX) minX = left;
    if (right > maxX) maxX = right;
    if (top < minY) minY = top;
    if (bottom > maxY) maxY = bottom;
  }

  // Handle empty case
  if (!isFinite(minX)) {
    return { minX: -100, maxX: 100, minY: -100, maxY: 100 };
  }

  // Add padding
  const padding = 200;
  return {
    minX: minX - padding,
    maxX: maxX + padding,
    minY: minY - padding,
    maxY: maxY + padding,
  };
}

// ─── Re-exports for convenience ──────────────────────────────

export { detectDomains } from './community-detect';
export type { CommunityResult } from './community-detect';
export { computeGeneLayout } from './gene-layout';
export { computeSignalLayout } from './signal-layout';
export type { SignalPosition } from './signal-layout';
