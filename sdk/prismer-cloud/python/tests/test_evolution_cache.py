"""Unit tests for EvolutionCache — Thompson Sampling gene selection.

Ported from sdk/typescript/tests/unit/evolution-cache.test.ts.
"""

import pytest

from prismer.evolution_cache import EvolutionCache, GeneSelectionResult, SignalTag


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_signal(type_: str) -> SignalTag:
    return SignalTag(type=type_)


def make_gene(
    id: str,
    *,
    signals_match=None,
    success_count: int = 0,
    failure_count: int = 0,
    visibility: str = "published",
    strategy=None,
    title: str | None = None,
):
    return {
        "id": id,
        "category": "strategy",
        "title": title or f"Gene {id}",
        "visibility": visibility,
        "signals_match": signals_match if signals_match is not None else [{"type": "test:signal"}],
        "strategy": strategy or ["do something"],
        "success_count": success_count,
        "failure_count": failure_count,
    }


def make_snapshot(genes=None, edges=None, global_prior=None, cursor=42):
    return {
        "genes": genes or [],
        "edges": edges or [],
        "globalPrior": global_prior or {},
        "cursor": cursor,
    }


def make_delta(genes=None, edges=None, global_prior=None, quarantines=None, cursor=100):
    return {
        "pulled": {
            "genes": genes or [],
            "edges": edges or [],
            "globalPrior": global_prior or {},
            "quarantines": quarantines or [],
            "cursor": cursor,
        }
    }


# ===========================================================================
# Constructor / getters
# ===========================================================================

class TestConstructor:
    def test_cursor_starts_at_zero(self):
        cache = EvolutionCache()
        assert cache.cursor == 0

    def test_gene_count_starts_at_zero(self):
        cache = EvolutionCache()
        assert cache.gene_count == 0


# ===========================================================================
# loadSnapshot()
# ===========================================================================

class TestLoadSnapshot:
    def test_loads_genes(self):
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[make_gene("g1"), make_gene("g2")]))
        assert cache.gene_count == 2

    def test_sets_cursor(self):
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(cursor=99))
        assert cache.cursor == 99

    def test_clears_previous_data_on_reload(self):
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[make_gene("g1"), make_gene("g2")], cursor=10))
        assert cache.gene_count == 2
        assert cache.cursor == 10

        cache.load_snapshot(make_snapshot(genes=[make_gene("g3")], cursor=20))
        assert cache.gene_count == 1
        assert cache.cursor == 20

    def test_loads_global_prior(self):
        cache = EvolutionCache()
        prior = {"lang:ts": {"alpha": 5, "beta": 2}}
        cache.load_snapshot(make_snapshot(global_prior=prior, cursor=10))
        assert cache.cursor == 10

    def test_loads_edges(self):
        edges = [
            {"signal_key": "lang:ts", "gene_id": "g1"},
            {"signal_key": "lang:ts", "gene_id": "g2"},
            {"signal_key": "tool:vitest", "gene_id": "g1"},
        ]
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(
            genes=[make_gene("g1"), make_gene("g2")],
            edges=edges,
        ))
        assert cache.cursor == 42


# ===========================================================================
# applyDelta()
# ===========================================================================

class TestApplyDelta:
    def test_adds_new_genes(self):
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[make_gene("g1")], cursor=1))
        assert cache.gene_count == 1

        cache.apply_delta(make_delta(genes=[make_gene("g2")], cursor=2))
        assert cache.gene_count == 2

    def test_removes_quarantined_genes(self):
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(
            genes=[make_gene("g1"), make_gene("g2")], cursor=1
        ))
        assert cache.gene_count == 2

        cache.apply_delta(make_delta(quarantines=["g1"], cursor=2))
        assert cache.gene_count == 1

    def test_updates_cursor(self):
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(cursor=1))
        cache.apply_delta(make_delta(cursor=55))
        assert cache.cursor == 55

    def test_updates_global_prior(self):
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(
            global_prior={"lang:ts": {"alpha": 1, "beta": 1}}, cursor=1
        ))
        cache.apply_delta(make_delta(
            global_prior={"lang:ts": {"alpha": 10, "beta": 2}}, cursor=2
        ))

        gene = make_gene("g1", signals_match=[{"type": "lang:ts"}], success_count=1, failure_count=1)
        cache.apply_delta(make_delta(genes=[gene], cursor=3))

        result = cache.select_gene([make_signal("lang:ts")])
        assert result.action == "apply_gene"
        assert result.confidence > 0

    def test_updates_existing_edges(self):
        edge1 = {"signal_key": "lang:ts", "gene_id": "g1", "success_count": 1}
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(
            genes=[make_gene("g1")], edges=[edge1], cursor=1
        ))

        updated_edge = {"signal_key": "lang:ts", "gene_id": "g1", "success_count": 5}
        cache.apply_delta(make_delta(edges=[updated_edge], cursor=2))
        assert cache.cursor == 2

    def test_adds_new_edges_to_existing_signal_key_group(self):
        edge1 = {"signal_key": "lang:ts", "gene_id": "g1"}
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(
            genes=[make_gene("g1"), make_gene("g2")], edges=[edge1], cursor=1
        ))

        edge2 = {"signal_key": "lang:ts", "gene_id": "g2"}
        cache.apply_delta(make_delta(edges=[edge2], cursor=2))
        assert cache.cursor == 2


# ===========================================================================
# loadDelta() — alias for applyDelta
# ===========================================================================

class TestLoadDelta:
    def test_is_alias_for_apply_delta(self):
        gene = make_gene("g1")

        cache_a = EvolutionCache()
        cache_a.load_snapshot(make_snapshot(cursor=0))
        cache_a.apply_delta(make_delta(genes=[gene], cursor=10))

        cache_b = EvolutionCache()
        cache_b.load_snapshot(make_snapshot(cursor=0))
        cache_b.load_delta(make_delta(genes=[gene], cursor=10))

        assert cache_a.gene_count == cache_b.gene_count
        assert cache_a.cursor == cache_b.cursor

        result_a = cache_a.select_gene([make_signal("test:signal")])
        result_b = cache_b.select_gene([make_signal("test:signal")])
        assert result_a.action == result_b.action
        assert result_a.gene_id == result_b.gene_id


# ===========================================================================
# selectGene() — the most critical method
# ===========================================================================

class TestSelectGene:
    # ----- Empty cache -----
    def test_empty_cache_returns_none(self):
        cache = EvolutionCache()
        result = cache.select_gene([make_signal("anything")])
        assert result.action == "none"
        assert result.confidence == 0
        assert result.reason == "no genes in cache"
        assert result.from_cache is True

    # ----- No signal overlap -----
    def test_no_signal_overlap_returns_create_suggested(self):
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(
            genes=[make_gene("g1", signals_match=[{"type": "lang:rust"}])]
        ))
        result = cache.select_gene([make_signal("lang:python")])
        assert result.action == "create_suggested"
        assert result.from_cache is True

    # ----- Quarantined genes are skipped -----
    def test_skips_quarantined_genes(self):
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[
            make_gene("g1", signals_match=[{"type": "lang:ts"}],
                      visibility="quarantined", success_count=100, failure_count=0),
        ]))
        result = cache.select_gene([make_signal("lang:ts")])
        assert result.action == "create_suggested"

    # ----- Genes with empty signals_match are skipped -----
    def test_skips_genes_with_empty_signals_match(self):
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[
            make_gene("g1", signals_match=[]),
        ]))
        result = cache.select_gene([make_signal("lang:ts")])
        assert result.action == "create_suggested"

    # ----- Single matching gene -----
    def test_single_matching_gene(self):
        gene = make_gene("g1", signals_match=[{"type": "lang:ts"}],
                         success_count=5, failure_count=1)
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[gene]))

        result = cache.select_gene([make_signal("lang:ts")])
        assert result.action == "apply_gene"
        assert result.gene_id == "g1"
        assert result.gene == gene
        assert result.strategy == ["do something"]
        assert result.from_cache is True
        assert result.alternatives == []

    # ----- Multiple matching genes sorted by rankScore descending -----
    def test_sorts_by_rank_score_descending(self):
        g_high = make_gene("g-high", signals_match=[{"type": "lang:ts"}],
                           success_count=50, failure_count=2)
        g_low = make_gene("g-low", signals_match=[{"type": "lang:ts"}],
                          success_count=2, failure_count=10)
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[g_low, g_high]))

        result = cache.select_gene([make_signal("lang:ts")])
        assert result.action == "apply_gene"
        assert result.gene_id == "g-high"

    # ----- Thompson Sampling: high success ranks higher -----
    def test_thompson_sampling_high_success_wins(self):
        g_winner = make_gene("g-winner", signals_match=[{"type": "err:timeout"}],
                             success_count=40, failure_count=5)
        g_loser = make_gene("g-loser", signals_match=[{"type": "err:timeout"}],
                            success_count=5, failure_count=5)
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[g_loser, g_winner]))

        result = cache.select_gene([make_signal("err:timeout")])
        assert result.gene_id == "g-winner"
        assert result.confidence > 0

    # ----- Thompson Sampling: failure-heavy gene ranks lower -----
    def test_failure_heavy_gene_ranks_lower(self):
        g_good = make_gene("g-good", signals_match=[{"type": "task:build"}],
                           success_count=10, failure_count=2)
        g_bad = make_gene("g-bad", signals_match=[{"type": "task:build"}],
                          success_count=2, failure_count=20)
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[g_bad, g_good]))

        result = cache.select_gene([make_signal("task:build")])
        assert result.gene_id == "g-good"

    # ----- Ban threshold: >=10 obs and <18% success rate is skipped -----
    def test_ban_threshold_skips_low_success_rate(self):
        g_banned = make_gene("g-banned", signals_match=[{"type": "lang:ts"}],
                             success_count=1, failure_count=11)  # 1/12 = 8.3% < 18%
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[g_banned]))

        result = cache.select_gene([make_signal("lang:ts")])
        assert result.action == "create_suggested"
        assert result.reason == "no matching genes for signals"

    def test_ban_threshold_exactly_10_obs_and_10_percent(self):
        # 1/10 = 10% < 18% => banned
        g_border = make_gene("g-border", signals_match=[{"type": "lang:ts"}],
                             success_count=1, failure_count=9)
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[g_border]))

        result = cache.select_gene([make_signal("lang:ts")])
        assert result.action == "create_suggested"

    def test_ban_threshold_insufficient_data_not_skipped(self):
        # 0/9 = 0% but total < 10 => not banned
        g = make_gene("g-insufficient", signals_match=[{"type": "lang:ts"}],
                      success_count=0, failure_count=9)
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[g]))

        result = cache.select_gene([make_signal("lang:ts")])
        assert result.action == "apply_gene"
        assert result.gene_id == "g-insufficient"

    def test_ban_threshold_exactly_18_percent_not_skipped(self):
        # 18/100 = 0.18 => NOT < 0.18 => not banned
        gene = make_gene("g-boundary", signals_match=[{"type": "x"}],
                         success_count=18, failure_count=82)
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[gene]))

        result = cache.select_gene([make_signal("x")])
        assert result.action == "apply_gene"
        assert result.gene_id == "g-boundary"

    def test_ban_threshold_just_below_18_percent(self):
        # 179/1000 = 0.179 < 0.18 => banned
        gene = make_gene("g-just-below", signals_match=[{"type": "x"}],
                         success_count=179, failure_count=821)
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[gene]))

        result = cache.select_gene([make_signal("x")])
        assert result.action == "create_suggested"

    # ----- Global prior blending -----
    def test_global_prior_blending_affects_ranking(self):
        g_a = make_gene("g-a", signals_match=[{"type": "sig:a"}],
                        success_count=3, failure_count=3)
        g_b = make_gene("g-b", signals_match=[{"type": "sig:b"}],
                        success_count=3, failure_count=3)
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(
            genes=[g_a, g_b],
            global_prior={"sig:a": {"alpha": 50, "beta": 1}},
            cursor=1,
        ))

        result_a = cache.select_gene([make_signal("sig:a")])
        result_b = cache.select_gene([make_signal("sig:b")])
        assert result_a.confidence > result_b.confidence

    # ----- Coverage score: partial vs full -----
    def test_partial_coverage_reduces_score(self):
        gene = make_gene("g-partial",
                         signals_match=[{"type": "lang:ts"}, {"type": "err:type"}],
                         success_count=10, failure_count=1)
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[gene]))

        result = cache.select_gene([make_signal("lang:ts")])
        assert result.action == "apply_gene"
        assert result.coverage_score == 0.5

    def test_full_coverage_maximizes_score(self):
        gene = make_gene("g-full",
                         signals_match=[{"type": "lang:ts"}, {"type": "err:type"}],
                         success_count=10, failure_count=1)
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[gene]))

        result = cache.select_gene([make_signal("lang:ts"), make_signal("err:type")])
        assert result.action == "apply_gene"
        assert result.coverage_score == 1.0

    def test_full_coverage_beats_partial_coverage(self):
        g_full = make_gene("g-full", signals_match=[{"type": "lang:ts"}],
                           success_count=5, failure_count=2)
        g_partial = make_gene("g-partial",
                              signals_match=[{"type": "lang:ts"}, {"type": "err:type"}],
                              success_count=5, failure_count=2)
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[g_partial, g_full]))

        result = cache.select_gene([make_signal("lang:ts")])
        assert result.gene_id == "g-full"

    def test_coverage_one_third_rounds_to_0_33(self):
        gene = make_gene("g1",
                         signals_match=[{"type": "a"}, {"type": "b"}, {"type": "c"}],
                         success_count=5, failure_count=1)
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[gene]))

        result = cache.select_gene([make_signal("a")])
        assert result.coverage_score == 0.33

    def test_extra_input_signals_do_not_affect_coverage(self):
        gene = make_gene("g1", signals_match=[{"type": "lang:ts"}],
                         success_count=5, failure_count=1)
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[gene]))

        result = cache.select_gene([
            make_signal("lang:ts"),
            make_signal("err:type"),
            make_signal("tool:vitest"),
        ])
        assert result.coverage_score == 1.0

    # ----- Alternatives list: max 3 -----
    def test_alternatives_max_three(self):
        genes = [
            make_gene(f"g{i}", signals_match=[{"type": "lang:ts"}],
                      success_count=10 - i, failure_count=1)
            for i in range(6)
        ]
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=genes))

        result = cache.select_gene([make_signal("lang:ts")])
        assert result.action == "apply_gene"
        assert len(result.alternatives) == 3
        for alt in result.alternatives:
            assert "gene_id" in alt
            assert "confidence" in alt
            assert "title" in alt

    def test_alternatives_sorted_by_rank_score_descending(self):
        genes = [
            make_gene("g-best", signals_match=[{"type": "x"}], success_count=50, failure_count=1),
            make_gene("g-mid", signals_match=[{"type": "x"}], success_count=20, failure_count=5),
            make_gene("g-low", signals_match=[{"type": "x"}], success_count=5, failure_count=5),
            make_gene("g-worst", signals_match=[{"type": "x"}], success_count=2, failure_count=8),
        ]
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=genes))

        result = cache.select_gene([make_signal("x")])
        assert result.gene_id == "g-best"
        alt_confidences = [a["confidence"] for a in result.alternatives]
        for i in range(1, len(alt_confidences)):
            assert alt_confidences[i - 1] >= alt_confidences[i]

    # ----- Confidence rounding -----
    def test_confidence_rounded_to_2_decimals(self):
        gene = make_gene("g1", signals_match=[{"type": "lang:ts"}],
                         success_count=7, failure_count=3)
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[gene]))

        result = cache.select_gene([make_signal("lang:ts")])
        decimal_part = str(result.confidence).split(".")[1] if "." in str(result.confidence) else ""
        assert len(decimal_part) <= 2

    # ----- String signals_match compatibility -----
    def test_string_signals_match(self):
        gene = make_gene("g-string-signals",
                         signals_match=["lang:ts", "err:compile"],
                         success_count=5, failure_count=1)
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[gene]))

        result = cache.select_gene([make_signal("lang:ts")])
        assert result.action == "apply_gene"
        assert result.gene_id == "g-string-signals"

    def test_mixed_string_and_dict_signals_match(self):
        gene = make_gene("g-mixed",
                         signals_match=["lang:ts", {"type": "err:type"}],
                         success_count=5, failure_count=1)
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[gene]))

        result = cache.select_gene([make_signal("lang:ts"), make_signal("err:type")])
        assert result.action == "apply_gene"
        assert result.coverage_score == 1.0

    # ----- Reason includes gene count -----
    def test_reason_includes_gene_count(self):
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[
            make_gene("g1", signals_match=[{"type": "a"}]),
            make_gene("g2", signals_match=[{"type": "b"}]),
            make_gene("g3", signals_match=[{"type": "a"}]),
        ]))

        result = cache.select_gene([make_signal("a")])
        assert "3 genes" in result.reason

    # ----- Quarantined + banned + no overlap, one valid remains -----
    def test_single_valid_gene_among_excluded(self):
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[
            make_gene("g-q", signals_match=[{"type": "x"}],
                      visibility="quarantined", success_count=50),
            make_gene("g-banned", signals_match=[{"type": "x"}],
                      success_count=1, failure_count=11),
            make_gene("g-no-overlap", signals_match=[{"type": "y"}]),
            make_gene("g-empty", signals_match=[]),
            make_gene("g-valid", signals_match=[{"type": "x"}],
                      success_count=3, failure_count=1),
        ]))

        result = cache.select_gene([make_signal("x")])
        assert result.action == "apply_gene"
        assert result.gene_id == "g-valid"
        assert result.alternatives == []

    # ----- Canary and seed visibility are NOT skipped -----
    def test_canary_and_seed_not_skipped(self):
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[
            make_gene("g-canary", signals_match=[{"type": "x"}],
                      visibility="canary", success_count=3),
            make_gene("g-seed", signals_match=[{"type": "x"}],
                      visibility="seed", success_count=1),
        ]))

        result = cache.select_gene([make_signal("x")])
        assert result.action == "apply_gene"
        assert result.gene_id == "g-canary"
        assert len(result.alternatives) == 1

    # ----- Rank score formula: coverage * 0.4 + sampled * 0.6 -----
    def test_rank_score_formula(self):
        g_a = make_gene("g-a", signals_match=[{"type": "x"}],
                        success_count=1, failure_count=5)
        g_b = make_gene("g-b", signals_match=[{"type": "x"}, {"type": "y"}],
                        success_count=100, failure_count=1)
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[g_a, g_b]))

        # Input only has 'x': g_a coverage=1.0, g_b coverage=0.5
        # g_a sampled ~ 2/8 = 0.25, g_b sampled ~ 101/103 ~ 0.98
        # rank_a = 1.0*0.4 + 0.25*0.6 = 0.55
        # rank_b = 0.5*0.4 + 0.98*0.6 = 0.788
        # g_b should win because sampled score dominates
        result = cache.select_gene([make_signal("x")])
        assert result.gene_id == "g-b"

    # ----- Gene result includes strategy field -----
    def test_result_includes_strategy(self):
        gene = make_gene("g1", signals_match=[{"type": "x"}],
                         strategy=["step1", "step2", "step3"],
                         success_count=5)
        cache = EvolutionCache()
        cache.load_snapshot(make_snapshot(genes=[gene]))

        result = cache.select_gene([make_signal("x")])
        assert result.strategy == ["step1", "step2", "step3"]
