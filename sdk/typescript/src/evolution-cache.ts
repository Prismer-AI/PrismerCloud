/**
 * EvolutionCache — local gene cache with Thompson Sampling selection.
 * Enables <1ms gene selection without network calls.
 */
import type {
  IMGene,
  IMEvolutionEdge,
  SignalTag,
  GeneSelectionResult,
  EvolutionSyncSnapshot,
  EvolutionSyncDelta,
} from './types';

export class EvolutionCache {
  private _genes = new Map<string, IMGene>();
  private _edges = new Map<string, IMEvolutionEdge[]>(); // key = signal_key
  private _globalPrior = new Map<string, { alpha: number; beta: number }>();
  private _cursor = 0;

  get cursor(): number { return this._cursor; }
  get geneCount(): number { return this._genes.size; }

  /** Load from a full snapshot */
  loadSnapshot(snapshot: EvolutionSyncSnapshot): void {
    this._genes.clear();
    this._edges.clear();
    this._globalPrior.clear();
    for (const gene of snapshot.genes) {
      this._genes.set(gene.id, gene);
    }
    for (const edge of snapshot.edges) {
      const list = this._edges.get(edge.signal_key) ?? [];
      list.push(edge);
      this._edges.set(edge.signal_key, list);
    }
    for (const [key, val] of Object.entries(snapshot.globalPrior)) {
      this._globalPrior.set(key, val);
    }
    this._cursor = snapshot.cursor;
  }

  /** Apply incremental delta */
  applyDelta(delta: EvolutionSyncDelta): void {
    const pulled = delta.pulled;
    // Update genes
    for (const gene of pulled.genes) {
      this._genes.set(gene.id, gene);
    }
    // Remove quarantined
    for (const id of pulled.quarantines) {
      this._genes.delete(id);
    }
    // Update edges
    for (const edge of pulled.edges) {
      const list = this._edges.get(edge.signal_key) ?? [];
      const idx = list.findIndex(e => e.gene_id === edge.gene_id);
      if (idx >= 0) list[idx] = edge;
      else list.push(edge);
      this._edges.set(edge.signal_key, list);
    }
    // Update global prior
    for (const [key, val] of Object.entries(pulled.globalPrior)) {
      this._globalPrior.set(key, val);
    }
    this._cursor = pulled.cursor;
  }

  /** Select best gene locally using Thompson Sampling — pure CPU, <1ms */
  selectGene(signals: SignalTag[]): GeneSelectionResult {
    if (this._genes.size === 0) {
      return { action: 'none', confidence: 0, reason: 'no genes in cache', fromCache: true };
    }

    // Build signal keys from input
    const signalKeys = signals.map(s => s.type);

    // Score each gene
    const candidates: Array<{
      gene: IMGene;
      rankScore: number;
      coverageScore: number;
      sampledScore: number;
    }> = [];

    for (const gene of this._genes.values()) {
      if (gene.visibility === 'quarantined') continue;

      // 1. Tag coverage score
      const geneSignalTypes = (gene.signals_match || []).map((s: SignalTag | string) =>
        typeof s === 'string' ? s : s.type
      );
      if (geneSignalTypes.length === 0) continue;

      const matchCount = signalKeys.filter(k => geneSignalTypes.includes(k)).length;
      const coverageScore = matchCount / geneSignalTypes.length;
      if (coverageScore === 0) continue; // No signal overlap

      // 2. Thompson Sampling: sample from Beta(alpha, beta)
      let alpha = gene.success_count + 1;
      let beta = gene.failure_count + 1;

      // Blend with global prior (weight 0.3)
      for (const key of signalKeys) {
        const prior = this._globalPrior.get(key);
        if (prior) {
          alpha += 0.3 * prior.alpha;
          beta += 0.3 * prior.beta;
        }
      }

      // Simple Beta mean as score (deterministic for caching; use betaSample for exploration)
      const sampledScore = alpha / (alpha + beta);

      // 3. Ban threshold: skip if success rate < 18% with enough data
      const totalObs = gene.success_count + gene.failure_count;
      if (totalObs >= 10 && gene.success_count / totalObs < 0.18) continue;

      // Combined rank score
      const rankScore = coverageScore * 0.4 + sampledScore * 0.6;

      candidates.push({ gene, rankScore, coverageScore, sampledScore });
    }

    if (candidates.length === 0) {
      return {
        action: 'create_suggested',
        confidence: 0,
        reason: 'no matching genes for signals',
        fromCache: true,
      };
    }

    // Sort by rank score descending
    candidates.sort((a, b) => b.rankScore - a.rankScore);

    const best = candidates[0];
    const alternatives = candidates.slice(1, 4).map(c => ({
      gene_id: c.gene.id,
      confidence: Math.round(c.rankScore * 100) / 100,
      title: c.gene.title,
    }));

    return {
      action: 'apply_gene',
      gene_id: best.gene.id,
      gene: best.gene,
      strategy: best.gene.strategy,
      confidence: Math.round(best.rankScore * 100) / 100,
      coverageScore: Math.round(best.coverageScore * 100) / 100,
      alternatives,
      reason: `local cache selection (${this._genes.size} genes)`,
      fromCache: true,
    };
  }
}
