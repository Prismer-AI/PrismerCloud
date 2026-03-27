/**
 * Evolution Map — Hit detection & hover state
 */

import type { MapLayout, MapViewState, HitResult, HoverState, EdgePath } from '../../types/evolution-map.types';
import { getPointOnBezier } from '../../map-layout';
import { screenToCanvas } from './viewport';

// ─── Hit Detection (circular nodes) ──────────────────────

export function hitTest(mouseX: number, mouseY: number, layout: MapLayout, view: MapViewState): HitResult | null {
  const { cx, cy } = screenToCanvas(mouseX, mouseY, view);

  // 1. Gene nodes first (larger, higher priority)
  for (const node of layout.geneNodes) {
    const dx = cx - node.x;
    const dy = cy - node.y;
    const r = node.width / 2 + 4; // 4px tolerance
    if (dx * dx + dy * dy <= r * r) {
      return { type: 'gene', geneId: node.id, node };
    }
  }

  // 2. Signal nodes
  for (const node of layout.signalNodes) {
    const dx = cx - node.x;
    const dy = cy - node.y;
    const r = node.radius + 4;
    if (dx * dx + dy * dy <= r * r) {
      return { type: 'signal', signalKey: node.key, node };
    }
  }

  // 3. Edges (distance threshold)
  const threshold = 8 / view.zoom;
  for (const edge of layout.edges) {
    if (distanceToBezier(cx, cy, edge) < threshold) {
      return { type: 'edge', signalKey: edge.signalKey, geneId: edge.geneId, edge };
    }
  }

  // 4. Clusters (only at L3 / full map zoom)
  if (view.zoomLevel >= 3 && layout.clusters) {
    for (const cluster of layout.clusters) {
      const dx = cx - cluster.center.x;
      const dy = cy - cluster.center.y;
      const r = 80 + cluster.geneIds.length * 20; // same radius as drawClusterHalo
      if (dx * dx + dy * dy <= r * r) {
        return { type: 'cluster', clusterId: String(cluster.communityId) };
      }
    }
  }

  return null;
}

function distanceToBezier(px: number, py: number, edge: EdgePath): number {
  let minDist = Infinity;
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const pt = getPointOnBezier(edge.sx, edge.sy, edge.cp1x, edge.cp1y, edge.cp2x, edge.cp2y, edge.gx, edge.gy, t);
    const dx = pt.x - px;
    const dy = pt.y - py;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < minDist) minDist = dist;
  }
  return minDist;
}

// ─── Hover State Computation ─────────────────────────────

export function computeHoverState(hit: HitResult | null, layout: MapLayout): HoverState {
  if (!hit) {
    return {
      active: false,
      hit: null,
      connectedSignals: new Set(),
      connectedGenes: new Set(),
      connectedEdges: new Set(),
    };
  }

  const connectedSignals = new Set<string>();
  const connectedGenes = new Set<string>();
  const connectedEdges = new Set<string>();

  // Two-hop highlight: selected node → direct neighbors → their neighbors
  if (hit.type === 'signal') {
    connectedSignals.add(hit.signalKey!);
    // Hop 1: signal → connected genes + edges
    for (const edge of layout.edges) {
      if (edge.signalKey === hit.signalKey) {
        connectedGenes.add(edge.geneId);
        connectedEdges.add(`${edge.signalKey}\u2192${edge.geneId}`);
      }
    }
    // Hop 2: those genes → their other signals + edges
    for (const edge of layout.edges) {
      if (connectedGenes.has(edge.geneId)) {
        connectedSignals.add(edge.signalKey);
        connectedEdges.add(`${edge.signalKey}\u2192${edge.geneId}`);
      }
    }
  } else if (hit.type === 'gene') {
    connectedGenes.add(hit.geneId!);
    // Hop 1: gene → connected signals + edges
    for (const edge of layout.edges) {
      if (edge.geneId === hit.geneId) {
        connectedSignals.add(edge.signalKey);
        connectedEdges.add(`${edge.signalKey}\u2192${edge.geneId}`);
      }
    }
    // Hop 2: those signals → their other genes + edges
    for (const edge of layout.edges) {
      if (connectedSignals.has(edge.signalKey)) {
        connectedGenes.add(edge.geneId);
        connectedEdges.add(`${edge.signalKey}\u2192${edge.geneId}`);
      }
    }
  } else if (hit.type === 'edge') {
    connectedSignals.add(hit.signalKey!);
    connectedGenes.add(hit.geneId!);
    connectedEdges.add(`${hit.signalKey}\u2192${hit.geneId}`);
    // Hop 2 from both ends
    for (const edge of layout.edges) {
      if (edge.geneId === hit.geneId || edge.signalKey === hit.signalKey) {
        connectedSignals.add(edge.signalKey);
        connectedGenes.add(edge.geneId);
        connectedEdges.add(`${edge.signalKey}\u2192${edge.geneId}`);
      }
    }
  }

  return { active: true, hit, connectedSignals, connectedGenes, connectedEdges };
}
