"""EvolutionCache — local gene cache with Thompson Sampling selection.

Enables <1ms gene selection without network calls.
Port of sdk/typescript/src/evolution-cache.ts.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class SignalTag:
    type: str
    provider: Optional[str] = None
    stage: Optional[str] = None
    severity: Optional[str] = None


@dataclass
class GeneSelectionResult:
    action: str  # 'apply_gene' | 'create_suggested' | 'none'
    confidence: float = 0.0
    gene_id: Optional[str] = None
    gene: Optional[Dict[str, Any]] = None
    strategy: Optional[List[str]] = None
    coverage_score: Optional[float] = None
    alternatives: Optional[List[Dict[str, Any]]] = None
    reason: Optional[str] = None
    from_cache: bool = True


class EvolutionCache:
    """Local gene cache with Thompson Sampling selection.

    Usage:
        cache = EvolutionCache()
        cache.load_snapshot(snapshot_data)
        result = cache.select_gene([SignalTag(type='error:timeout')])
    """

    def __init__(self) -> None:
        self._genes: Dict[str, Dict[str, Any]] = {}
        self._edges: Dict[str, List[Dict[str, Any]]] = {}
        self._global_prior: Dict[str, Dict[str, float]] = {}
        self._cursor: int = 0

    @property
    def cursor(self) -> int:
        return self._cursor

    @property
    def gene_count(self) -> int:
        return len(self._genes)

    def load_snapshot(self, snapshot: Dict[str, Any]) -> None:
        """Load from a full sync snapshot."""
        self._genes.clear()
        self._edges.clear()
        self._global_prior.clear()

        for gene in snapshot.get("genes", []):
            gid = gene.get("id") or gene.get("gene_id", "")
            self._genes[gid] = gene

        for edge in snapshot.get("edges", []):
            key = edge.get("signal_key") or edge.get("signalKey", "")
            self._edges.setdefault(key, []).append(edge)

        for key, val in (snapshot.get("globalPrior") or snapshot.get("global_prior") or {}).items():
            if isinstance(val, dict):
                self._global_prior[key] = val
            else:
                self._global_prior[key] = {"alpha": float(val), "beta": 1.0}

        self._cursor = snapshot.get("cursor", 0)

    def apply_delta(self, delta: Dict[str, Any]) -> None:
        """Apply incremental sync delta."""
        pulled = delta.get("pulled", delta)

        for gene in pulled.get("genes", []):
            gid = gene.get("id") or gene.get("gene_id", "")
            self._genes[gid] = gene

        for qid in pulled.get("quarantines", []):
            self._genes.pop(qid, None)

        for edge in pulled.get("edges", []):
            key = edge.get("signal_key") or edge.get("signalKey", "")
            lst = self._edges.setdefault(key, [])
            gene_id = edge.get("gene_id") or edge.get("geneId", "")
            found = False
            for i, e in enumerate(lst):
                if (e.get("gene_id") or e.get("geneId", "")) == gene_id:
                    lst[i] = edge
                    found = True
                    break
            if not found:
                lst.append(edge)

        for key, val in (pulled.get("globalPrior") or pulled.get("global_prior") or {}).items():
            if isinstance(val, dict):
                self._global_prior[key] = val

        self._cursor = pulled.get("cursor", self._cursor)

    def load_delta(self, delta: Dict[str, Any]) -> None:
        """Alias for apply_delta (API parity)."""
        self.apply_delta(delta)

    def select_gene(self, signals: List[SignalTag]) -> GeneSelectionResult:
        """Select best gene locally using Thompson Sampling — pure CPU, <1ms."""
        if not self._genes:
            return GeneSelectionResult(action="none", reason="no genes in cache")

        signal_keys = [s.type for s in signals]

        candidates: List[Dict[str, Any]] = []

        for gene in self._genes.values():
            if gene.get("visibility") == "quarantined":
                continue

            # Signal match types
            raw_match = gene.get("signals_match") or gene.get("signalsMatch") or []
            gene_signal_types = []
            for s in raw_match:
                if isinstance(s, str):
                    gene_signal_types.append(s)
                elif isinstance(s, dict):
                    gene_signal_types.append(s.get("type", ""))
            if not gene_signal_types:
                continue

            match_count = sum(1 for k in signal_keys if k in gene_signal_types)
            coverage_score = match_count / len(gene_signal_types)
            if coverage_score == 0:
                continue

            # Thompson Sampling: Beta(alpha, beta) mean
            sc = gene.get("success_count") or gene.get("successCount") or 0
            fc = gene.get("failure_count") or gene.get("failureCount") or 0
            alpha = sc + 1.0
            beta = fc + 1.0

            for key in signal_keys:
                prior = self._global_prior.get(key)
                if prior:
                    alpha += 0.3 * prior.get("alpha", 0)
                    beta += 0.3 * prior.get("beta", 0)

            sampled_score = alpha / (alpha + beta)

            # Ban threshold
            total_obs = sc + fc
            if total_obs >= 10 and sc / total_obs < 0.18:
                continue

            rank_score = coverage_score * 0.4 + sampled_score * 0.6
            candidates.append({
                "gene": gene,
                "rank_score": rank_score,
                "coverage_score": coverage_score,
                "sampled_score": sampled_score,
            })

        if not candidates:
            return GeneSelectionResult(
                action="create_suggested",
                reason="no matching genes for signals",
            )

        candidates.sort(key=lambda c: c["rank_score"], reverse=True)
        best = candidates[0]
        gene = best["gene"]

        alternatives = [
            {
                "gene_id": c["gene"].get("id", ""),
                "confidence": round(c["rank_score"], 2),
                "title": c["gene"].get("title"),
            }
            for c in candidates[1:4]
        ]

        return GeneSelectionResult(
            action="apply_gene",
            gene_id=gene.get("id", ""),
            gene=gene,
            strategy=gene.get("strategy"),
            confidence=round(best["rank_score"], 2),
            coverage_score=round(best["coverage_score"], 2),
            alternatives=alternatives,
            reason=f"local cache selection ({len(self._genes)} genes)",
        )
