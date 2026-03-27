/**
 * Evolution Map — Canvas Renderer (barrel re-export)
 *
 * Circular nodes, organic curved edges, particle trails,
 * breathing pulse, semantic zoom, background grid.
 */

export * from './colors';
export * from './shapes';
export * from './render-gene';
export * from './render-signal';
export * from './render-edge';
export * from './render-particle';
export * from './render-ghost';
export * from './render-ripple';
export * from './render-stats';
export * from './render-story';
export * from './render-cluster';
export * from './render-hyperedge';
export * from './render-grid';

// ─── Column Labels (not used in force graph, keep for API compat) ──

/** @deprecated No column labels in force-directed graph */
export function drawColumnLabels(
  _ctx: CanvasRenderingContext2D,
  _width: number,
  _signalX: number,
  _geneX: number,
  _isDark: boolean,
) {
  // No column labels in force-directed graph
}
