<p align="center">
  <a href="./HYPERGRAPH-THEORY.md"><img alt="English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./zh/HYPERGRAPH-THEORY.md"><img alt="简体中文" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="./de/HYPERGRAPH-THEORY.md"><img alt="Deutsch" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="./fr/HYPERGRAPH-THEORY.md"><img alt="Français" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="./es/HYPERGRAPH-THEORY.md"><img alt="Español" src="https://img.shields.io/badge/Español-d9d9d9"></a>
  <a href="./ja/HYPERGRAPH-THEORY.md"><img alt="日本語" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
</p>

# Hypergraph Evolution Theory

> How Prismer models agent learning as an N-ary knowledge structure
> inspired by Wolfram Physics and causal set theory.

---

## The Problem with Pairwise Edges

Traditional agent learning systems model knowledge as **2-ary edges**: `(signal, gene)` pairs with success/failure counts.

```
Standard model:
  edge("error:500|openai|api_call", "Gene_X") → { success: 12, failure: 3 }
```

This works — until it doesn't. The signal key is a **collapsed string** that bakes multiple dimensions into one. Consider:

```
Real event:
  Agent A encounters error:500 from OpenAI during api_call stage,
  applies Gene_X (500 Error Triage), outcome: success.

Stored as:
  signal_key = "error:500|openai|api_call"
  gene_id    = "Gene_X"
```

Now Agent B encounters `error:500` from OpenAI during `parsing` stage. The standard model sees a completely different signal key — `"error:500|openai|parsing"` — and returns zero matches. But `Gene_X` would likely work here too, because the `error:500 + openai` combination is what matters, not the stage.

**The 2-ary model destroys dimensional relationships by collapsing them into strings.**

---

## Hypergraph: Preserving Full Context

A [hypergraph](https://en.wikipedia.org/wiki/Hypergraph) generalizes graphs by allowing edges to connect **any number of nodes** (not just 2). In Prismer's evolution engine, we use hypergraphs to model agent execution events as N-ary relations.

### Core Components

#### Atoms — Normalized Dimensions

Each dimension of an execution event is stored as an independent **atom**:

| Kind | Examples | What it captures |
|------|----------|-----------------|
| `signal_type` | `error:500`, `error:timeout`, `perf:high_latency` | The error or performance signal |
| `provider` | `openai`, `exa`, `anthropic` | External service involved |
| `stage` | `api_call`, `network_request`, `parsing` | Execution phase |
| `severity` | `transient`, `critical`, `degraded` | Error severity |
| `gene` | `seed_timeout_retry_v1`, `500_Error_Triage` | Strategy applied |
| `agent` | `agent_alice`, `agent_bob` | Executing agent |
| `outcome` | `success`, `failed` | Result |

Atoms are **unique by (kind, value)** — the same atom node is reused across all hyperedges that share it.

#### Hyperedges — N-ary Execution Events

A single hyperedge captures the **complete context** of one capsule execution:

```
Hyperedge #cap_001 connects 7 atoms:
  ┌─ signal_type: "error:500"
  ├─ provider: "openai"
  ├─ stage: "api_call"
  ├─ severity: "transient"
  ├─ gene: "500_Error_Triage"
  ├─ agent: "agent_alice"
  └─ outcome: "success"
```

This is a **single 7-ary relation**, not 7 separate edges. The distinction matters for queries.

#### Causal Links — Learning Chains

When Agent B selects a gene because Agent A's outcome updated the posterior, we record an explicit **causal link**:

```
Capsule_A (alice, Gene_X, success)
    │
    │  learning link (strength: 1.0)
    │  "A's success updated Gene_X's Beta posterior,
    │   which influenced B's Thompson Sampling draw"
    ▼
Capsule_B (bob, Gene_X, success)
```

Causal links are **invisible in the standard model** — you can't trace why an agent selected a particular gene. With the hypergraph, you can reconstruct the full influence chain.

---

## Query: Set Intersection on Atoms

The key advantage of the hypergraph is **dimensional decomposition** during queries.

### Standard Mode (String Match)

```
Query: "error:500|openai|parsing"
Result: No match (exact string differs from "error:500|openai|api_call")
```

### Hypergraph Mode (Atom Intersection)

```
Query atoms: {signal_type: "error:500", provider: "openai", stage: "parsing"}

Step 1: Find all hyperedges containing atom "error:500" → {cap_001, cap_007, cap_012}
Step 2: Find all hyperedges containing atom "openai"    → {cap_001, cap_003, cap_007}
Step 3: Intersection: {cap_001, cap_007}
Step 4: Extract gene atoms from matched hyperedges → {"500_Error_Triage", "API_Retry_Backoff"}
Step 5: These are candidates for Thompson Sampling selection
```

The query matched `cap_001` even though the `stage` differs — because it shares 2 of 3 query atoms. This is **soft matching** by structural overlap, not exact string equality.

### Performance

The inverted index (`atom → hyperedges`) makes this efficient:

| Gene Count | Standard Mode | Hypergraph Mode |
|-----------|--------------|-----------------|
| 50 (current) | O(G × T) full scan | O(postings) inverted index |
| 1,000 | Needs LIMIT + ORDER BY | Same inverted index |
| 10,000 | Needs materialized views | Atom cardinality stays bounded |

Atom cardinality grows logarithmically (there are only so many unique error types, providers, and stages), while gene count grows linearly. The hypergraph scales better.

---

## Bimodality Detection

The hypergraph enables a detection mechanism impossible in the standard model: **bimodality index**.

### The Hidden Context Problem

```
Gene_X overall success rate: 50%  (looks mediocre)

Actually:
  When provider=openai:  90% success  (Gene_X is excellent here)
  When provider=anthropic: 10% success (Gene_X is terrible here)
```

The 2-ary model sees 50% and moves on. The hypergraph sees that outcomes cluster by the `provider` atom and flags this as **bimodal**.

### Algorithm: Overdispersion Detection

```
1. Compute global success rate p from recent outcomes
2. Split outcomes into time windows of size W
3. Compute success rate per window → [r₁, r₂, ..., rₖ]
4. Compute cross-window variance: Var(rᵢ)
5. Compute expected variance if i.i.d.: p(1-p)/W
6. Overdispersion ratio = Var(rᵢ) / expected_var
7. Bimodality index = clamp((ratio - 1) / 9, 0, 1)
```

| Index | Interpretation | Action |
|-------|---------------|--------|
| 0.0 | Homogeneous outcomes | Standard Thompson Sampling works fine |
| 0.3 | Mild heterogeneity | Monitor, may benefit from context splitting |
| 0.7 | Strong bimodality | Signal likely needs dimensional decomposition |
| 1.0 | Extreme bimodality | Hypergraph atom-level analysis recommended |

When bimodality is detected, the system can decompose the signal into atom-level sub-signals and select genes per-context — a capability that only exists in hypergraph mode.

---

## North Star Metrics

Six quantitative indicators evaluate evolution engine performance, computed independently for standard and hypergraph modes:

| Metric | Symbol | Formula | Measures |
|--------|--------|---------|----------|
| **System Success Rate** | SSR | `success / total capsules` | Overall effectiveness |
| **Convergence Speed** | CS | Capsules for new agent to reach SSR ≥ 0.7 | Cold start efficiency |
| **Routing Precision** | RP | `capsules with coverage ≥ 1 / total` | Signal-gene matching quality |
| **Regret Proxy** | RegP | `1 - (SSR_actual / SSR_oracle)` | Opportunity cost of suboptimal selection |
| **Gene Diversity** | GD | `1 - HHI(gene usage shares)` | Avoiding monoculture |
| **Exploration Rate** | ER | `edges with < 10 executions / total edges` | Exploration vs exploitation balance |

### A/B Comparison

Both modes accumulate metrics in parallel. When both have ≥ 200 capsules:

```
If hypergraph.SSR - standard.SSR > 0.05  →  hypergraph is better
If delta < -0.05                          →  standard is better
Otherwise                                 →  no significant difference
```

The 0.05 threshold is conservative — we want strong evidence before switching modes.

---

## Wolfram Physics Connection

The hypergraph model draws inspiration from [Wolfram Physics](https://www.wolframphysics.org/), which proposes that the universe is a hypergraph evolving via rewrite rules. The mapping:

| Wolfram Concept | Evolution Engine Analog |
|----------------|----------------------|
| **Atoms** (discrete tokens) | Signal dimensions, genes, agents — the vocabulary of evolution |
| **Hyperedges** (N-ary relations) | Capsule executions — complete context preserved |
| **Rewrite rules** (state transitions) | Gene strategy execution — transforms error state into resolved state |
| **Causal graph** (reachability) | Learning chains — which capsules influenced which decisions |
| **Multiway system** (parallel branches) | Different agents trying different strategies simultaneously |
| **Branchial space** (branch distances) | Agent strategy similarity — how close are two agents' approaches |

### What This Enables (Future)

- **Causal attribution**: "This gene's success rate improved because Agent A's 3 successful capsules propagated through 2 causal links to influence Agent B's selection"
- **Strategy similarity**: Measure distance between agents in branchial space to find natural clusters
- **Structural gene similarity**: Two genes that co-occur with the same atom patterns are likely interchangeable
- **MAP-Elites diversity**: Ensure the gene pool covers the full atom space, not just high-traffic regions

---

## Data Model

```
┌──────────┐       ┌───────────────────┐       ┌──────────┐
│  IMAtom  │◄──────│  IMHyperedgeAtom  │──────►│IMHyperedge│
│          │       │  (inverted index) │       │          │
│  id      │       │                   │       │  id      │
│  kind    │       │  atomId           │       │  type    │
│  value   │       │  hyperedgeId      │       │  created │
│          │       │  role             │       │          │
└──────────┘       └───────────────────┘       └──────┬───┘
                                                      │
                                               ┌──────┴───────┐
                                               │IMCausalLink   │
                                               │               │
                                               │  causeId  ────┤ (hyperedge)
                                               │  effectId ────┤ (hyperedge)
                                               │  linkType     │
                                               │  strength     │
                                               └───────────────┘
```

### Table Sizes (Expected)

| Table | Growth Pattern | At 10K capsules |
|-------|---------------|-----------------|
| `im_atoms` | Logarithmic (bounded vocabulary) | ~500 rows |
| `im_hyperedges` | Linear (1 per capsule) | 10,000 rows |
| `im_hyperedge_atoms` | Linear × fan-out (~7 per edge) | 70,000 rows |
| `im_causal_links` | Sublinear (not all capsules are linked) | ~3,000 rows |

The inverted index is the largest table but remains well within single-machine MySQL capacity up to millions of capsules.

---

## Implementation Status

| Phase | Scope | Status |
|-------|-------|--------|
| **Phase 0** | North star metrics + mode column + data isolation | Done |
| **Phase 1** | Atom/hyperedge/causal link write + inverted index query + bimodality | Done (feature-gated) |
| **Phase 2** | A/B evaluation at ≥200 capsules/mode + mode expansion decision | Awaiting data |
| **Phase 3** | Branchial distance + causal decay + MAP-Elites + gene similarity | Planned |

The hypergraph layer is **additive** — it writes new tables without modifying the existing edge/capsule logic. Both modes run in parallel, isolated by the `mode` column in shared tables.

---

## Further Reading

- [Wolfram Physics Project](https://www.wolframphysics.org/) — The theoretical foundation
- [Thompson Sampling for Bernoulli Bandits](https://arxiv.org/abs/1707.02038) — The selection algorithm
- [Hierarchical Bayesian Models](https://en.wikipedia.org/wiki/Bayesian_hierarchical_modeling) — Pooled priors for cold start
- [Herfindahl-Hirschman Index](https://en.wikipedia.org/wiki/Herfindahl%E2%80%93Hirschman_index) — Gene diversity measurement
- [MAP-Elites](https://arxiv.org/abs/1504.04909) — Quality-diversity optimization (Phase 3)

---

<p align="center">
  <sub>Part of the <a href="https://github.com/Prismer-AI/PrismerCloud">Prismer Cloud</a> Evolution Engine</sub>
</p>
