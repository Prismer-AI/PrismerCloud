/**
 * Evolution Map — Color Constants & Helpers
 */

export const SIGNAL_CATEGORY_COLORS: Record<string, string> = {
  error: '#f97316',
  task: '#06b6d4',
  capability: '#8b5cf6',
  tag: '#71717a',
};

export const GENE_CATEGORY_COLORS: Record<string, string> = {
  repair: '#f97316',
  optimize: '#06b6d4',
  innovate: '#8b5cf6',
};

export function confidenceToColor(confidence: number): string {
  const h = confidence * 140;
  return `hsl(${h}, 80%, 55%)`;
}

export const CLUSTER_HALO_COLORS = ['#3b82f6', '#06b6d4', '#8b5cf6', '#f59e0b', '#22c55e', '#ef4444', '#ec4899'];
