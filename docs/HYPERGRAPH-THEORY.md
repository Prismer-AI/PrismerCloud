# Hypergraph Evolution Theory

> **Version:** 1.0
> **Date:** 2026-03-30
> **Status:** Production (A/B experiment alongside standard mode)
> **Implementation:** `src/im/services/evolution-hypergraph.ts`, `src/im/services/evolution-selector.ts`, `src/im/services/evolution-metrics.ts`

---

## 1. Theoretical Foundation

Prismer's evolution engine draws its structural model from **Wolfram Physics**
([wolframphysics.org](https://www.wolframphysics.org/)), where the universe is
modeled as a hypergraph that evolves through local rewriting rules. Each
rewriting step produces a causal edge — the set of all such edges forms a
**causal graph** that encodes which events could have influenced which others.

The same principle applies to agent knowledge:

```
Wolfram Physics                     Prismer Evolution
────────────────                    ─────────────────
Hypergraph nodes    ───────────►    Atoms (signal type, provider, gene, ...)
Rewriting rules     ───────────►    Agent executions (apply gene → observe outcome)
Causal edges        ───────────►    Causal links (which outcome influenced which decision)
Convergent states   ───────────►    Optimal gene rankings per signal context
```

In **causal set theory**, spacetime is replaced by a partially ordered set of
events where the ordering encodes causality. Prismer's `im_causal_links` table
implements exactly this: a partial order over execution hyperedges, where
`causeId → effectId` means the outcome of the cause execution was available to
the system when the effect execution's gene was selected.

The key insight: just as Wolfram's multiway system explores all possible
rewriting paths and converges on observer-consistent states, Prismer's Thompson
Sampling explores all candidate genes in parallel and converges on the
empirically best strategy per signal context.

---

## 2. Why Hypergraphs

### The Problem with Flat Matching

Standard evolution systems store knowledge as flat `(signal, gene)` pairs using
string keys:

```
Signal Key                        Gene
───────────────────────────────   ──────────────────
"error:500|openai|api_call"   →   Retry with Backoff
"error:500|openai|parsing"    →   (no match)
```

The second signal shares two of three dimensions with the first — same error
code, same provider — but flat string matching finds zero overlap. This is the
**curse of concatenation**: every dimension is fused into a single opaque key.

### The Hypergraph Solution

Prismer decomposes every execution context into **independent atoms** and
connects them as **N-ary hyperedges**:

```
                    ┌─────────────────────────────────────────┐
                    │            Hyperedge (execution)         │
                    │                                         │
  ┌──────────┐     │   ┌──────────┐  ┌──────────┐            │
  │error:500 │─────┼──►│ openai   │  │ api_call │            │
  │(signal)  │     │   │(provider)│  │ (stage)  │            │
  └──────────┘     │   └──────────┘  └──────────┘            │
                    │   ┌──────────┐  ┌──────────┐            │
                    │   │ Gene_X   │  │ success  │            │
                    │   │  (gene)  │  │(outcome) │            │
                    │   └──────────┘  └──────────┘            │
                    └─────────────────────────────────────────┘

Now a query for {error:500, openai} finds Gene_X through dimensional
overlap — even though the original execution was in a different stage.
```

Each atom is stored once (`im_atoms`) and referenced by many hyperedges
(`im_hyperedge_atoms`), forming an **inverted index** that enables set-overlap
queries instead of string equality checks.

---

## 3. Core Concepts

### 3.1 Atoms

An atom is an `(kind, value)` pair representing a single independent dimension
of an execution context:

| Kind          | Example Values                          | Role                         |
|---------------|-----------------------------------------|------------------------------|
| `signal_type` | `error:timeout`, `error:429`, `perf:p99`| What happened                |
| `provider`    | `openai`, `anthropic`, `mysql`          | Where it happened            |
| `stage`       | `api_call`, `parsing`, `validation`     | When in the pipeline         |
| `severity`    | `critical`, `warning`, `info`           | How bad it was               |
| `gene`        | `gene_abc123`                           | Which strategy was applied   |
| `agent`       | `agent_xyz789`                          | Who executed it              |
| `outcome`     | `success`, `failed`                     | What resulted                |

Atoms are deduplicated via a unique index on `(kind, value)`. The `im_atoms`
table acts as a dictionary: each unique dimension value exists exactly once.

### 3.2 Hyperedges

A hyperedge is an N-ary connection that represents a **complete execution
context** — one agent applying one gene to one signal and observing one outcome.
Unlike a graph edge (which connects exactly 2 nodes), a hyperedge connects an
arbitrary number of atoms simultaneously.

```
Schema: im_hyperedges
  id        VARCHAR(30) PRIMARY KEY     -- same as capsule ID
  type      VARCHAR(20) DEFAULT 'execution'
  createdAt DATETIME(3)
```

Each hyperedge is linked to its atoms via the junction table `im_hyperedge_atoms`:

```
Schema: im_hyperedge_atoms
  hyperedgeId  VARCHAR(30)  -- FK → im_hyperedges
  atomId       INT          -- FK → im_atoms
  role         VARCHAR(20)  -- e.g. 'participant'
  PRIMARY KEY (hyperedgeId, atomId)
```

### 3.3 Inverted Index for Dimensional Overlap

The `im_hyperedge_atoms` table, indexed on `(atomId, hyperedgeId)`, functions as
an **inverted index**. Given a set of query atoms Q, finding relevant hyperedges
is a set-intersection operation:

```
QUERY: { signal_type:error:500, provider:openai }

Step 1: Look up atom IDs
  signal_type:error:500  →  atom #42
  provider:openai        →  atom #17

Step 2: Find hyperedges containing these atoms
  atom #42  →  { he_001, he_005, he_012 }
  atom #17  →  { he_001, he_003, he_005, he_019 }

Step 3: Count overlap per hyperedge
  he_001: 2/2  ← full match
  he_005: 2/2  ← full match
  he_003: 1/2  ← partial match
  he_012: 1/2  ← partial match
  he_019: 1/2  ← partial match

Step 4: Extract gene atoms from matching hyperedges
  he_001 → Gene_X    he_005 → Gene_Y
```

### 3.4 Soft Matching vs Exact String Matching

```
                Exact String Match          Hypergraph Soft Match
                ──────────────────          ─────────────────────
Query:          "error:500|openai|          { error:500, openai }
                 api_call"

Matches:        Only identical strings      Any hyperedge sharing
                                            ≥1 query atom

Recall:         Low (misses partial         High (finds related
                overlap)                    executions)

Precision:      Perfect (by definition)     Tunable via minimum
                                            overlap threshold

Cold-start:     Needs exact prior           Works with partial
                experience                  dimensional data
```

---

## 4. Key Capabilities

### 4.1 Soft Matching by Structural Overlap

The `queryHypergraphCandidates()` function implements soft matching. Given a set
of signal tags, it:

1. Resolves each tag dimension to atom IDs
2. Queries the inverted index for hyperedges containing those atoms
3. Ranks hyperedges by the number of overlapping atoms (coverage count)
4. Extracts gene IDs from matching hyperedges

This means `{error:500, openai, parsing}` will find genes that worked for
`{error:500, openai, api_call}` because they share 2 of 3 dimensions.

### 4.2 Bimodality Detection

A gene may succeed in one context but fail in another. The bimodality index
detects this hidden context dependency using **overdispersion analysis**:

```
Given: N recent outcomes for a (signal, gene) pair as a 0/1 sequence

1. Split into time windows of size W
2. Compute success rate per window: r_1, r_2, ..., r_k
3. Compute cross-window variance:   Var_obs = Var(r_1..r_k)
4. Compute expected i.i.d. variance: Var_exp = p(1-p) / W
5. Overdispersion ratio:             D = Var_obs / Var_exp
6. Bimodality index:                 B = clamp((D - 1) / 9, 0, 1)
```

When B is near 0, the gene behaves consistently (pure random variation).
When B approaches 1, there is a hidden context variable causing the gene to
alternate between working and failing — a signal to decompose further.

```
B ≈ 0.0   Stable:   ✓✓✓✓✗✓✓✓✓✓   (random noise)
B ≈ 0.8   Bimodal:  ✓✓✓✓✓✗✗✗✗✗   (context-dependent)
                     ▲             ▲
                     openai        anthropic
                     (works)       (fails)
```

### 4.3 Causal Chains

The `im_causal_links` table records directed edges between hyperedges:

```
Schema: im_causal_links
  causeId    VARCHAR(30)   -- FK → im_hyperedges
  effectId   VARCHAR(30)   -- FK → im_hyperedges
  linkType   VARCHAR(20)   -- 'learning'
  strength   FLOAT         -- default 1.0
  PRIMARY KEY (causeId, effectId)
```

When an agent records an outcome, the system finds the previous execution for
the same `(agent, signal, gene)` triple and creates a causal link:

```
  execution_001          execution_005          execution_012
  (agent_A, timeout,     (agent_A, timeout,     (agent_B, timeout,
   Gene_X, failed)        Gene_X, success)       Gene_X, success)
        │                      │                      │
        └──── learning ───────►│                      │
                               └──── learning ───────►│
                                     (cross-agent
                                      propagation)
```

This trace answers: "Why did agent_B choose Gene_X for timeout?" — because
agent_A's success with the same gene propagated through the evolution network.

### 4.4 Convergence Guarantees: Thompson Sampling

Gene selection uses **Thompson Sampling** with a Beta-Bernoulli model:

```
For each candidate gene g with s successes and f failures:

  Prior:      Beta(alpha_0, beta_0)     -- hierarchical prior from global data
  Posterior:  Beta(alpha_0 + s, beta_0 + f)

  Selection:  Sample theta_g ~ Beta(alpha_0 + s, beta_0 + f) for each g
              Choose g* = argmax(theta_g)
```

The implementation uses **Jöhnk's algorithm** for small alpha, beta (cold-start
exploration phase) and the **Marsaglia-Tsang gamma-ratio method** for larger
parameters (exploitation phase). This is numerically stable across the full
parameter range.

**Hierarchical Bayesian priors**: each agent's local Beta parameters are blended
with global edge statistics using a configurable weight `w_global`:

```
  alpha_combined = (1 - w) * alpha_local + w * alpha_global
  beta_combined  = (1 - w) * beta_local  + w * beta_global
```

This ensures new agents inherit the network's collective knowledge while still
adapting to their local context.

**Convergence property**: Thompson Sampling achieves Bayesian regret bound
O(sqrt(K * T * log(T))) where K is the number of genes and T is the number of
trials, guaranteeing convergence to the optimal gene as data accumulates.

---

## 5. North-Star Metrics

Six metrics evaluate evolution quality. Each is computed independently for
standard and hypergraph modes, enabling controlled A/B comparison.

| #  | Metric                          | Symbol | Formula / Definition                                                        | Target     |
|----|---------------------------------|--------|-----------------------------------------------------------------------------|------------|
| 1  | **System Success Rate**         | SSR    | `success_capsules / total_capsules`                                         | > 0.70     |
| 2  | **Convergence Speed**           | CS     | Capsules until agent reaches SSR >= 0.70 (min 5 capsules, avg over agents)  | < 20       |
| 3  | **Routing Precision**           | RP     | `edges_with_coverage >= 1 / total_edges`                                    | > 0.80     |
| 4  | **Regret Proxy**                | RegP   | `1 - (SSR_actual / SSR_oracle)` where oracle picks the best gene per signal | < 0.10     |
| 5  | **Gene Diversity**              | GD     | `1 - HHI` where HHI = sum of squared gene usage shares                     | 0.30-0.80  |
| 6  | **Exploration Rate**            | ER     | `edges_with_trials < 10 / total_edges`                                      | 0.10-0.40  |

```
Metric Relationships:

  SSR ◄──── RP (better routing → higher success)
   ▲         ▲
   │         │
   CS ──────►│  (faster convergence → better routing sooner)
   ▲         │
   │         │
   ER ──────►GD (exploration discovers diverse genes)
              │
              ▼
            RegP (diversity + precision → lower regret)
```

**Regret Proxy formula (detailed)**:

```
For each capsule c in the evaluation window:
  signal_type = c.signalKey.split('|')[0]
  oracle_ssr  = max SSR across all genes for this signal_type (min 3 trials)

  If c.outcome == 'failed':
    regret_c = oracle_ssr    (oracle would have succeeded with this probability)
  Else:
    regret_c = 0

RegP = mean(regret_c for all c)
```

**Gene Diversity (Herfindahl-Hirschman Index)**:

```
Given gene usage counts n_1, n_2, ..., n_K and total N = sum(n_i):

  HHI = sum( (n_i / N)^2 )
  GD  = 1 - HHI

  GD = 0    →  one gene monopolizes all usage (degenerate)
  GD = 1    →  perfectly uniform usage across all genes
  GD ∈ [0.3, 0.8]  →  healthy: a few genes dominate but alternatives are explored
```

---

## 6. Database Schema

Four tables implement the hypergraph layer:

```
┌──────────────────┐       ┌────────────────────────┐
│    im_atoms      │       │    im_hyperedges       │
├──────────────────┤       ├────────────────────────┤
│ id       INT PK  │       │ id       VARCHAR(30) PK│
│ kind     VARCHAR │       │ type     VARCHAR(20)   │
│ value    VARCHAR │       │ createdAt DATETIME(3)  │
│ createdAt        │       └────────┬───────────────┘
│ UNIQUE(kind,val) │                │
└────────┬─────────┘                │
         │                          │
         │    ┌─────────────────────┴──────────────┐
         │    │     im_hyperedge_atoms             │
         │    ├────────────────────────────────────┤
         └────┤ hyperedgeId  VARCHAR(30) FK        │
              │ atomId       INT         FK        │
              │ role         VARCHAR(20)           │
              │ PK(hyperedgeId, atomId)            │
              │ INDEX(atomId, hyperedgeId)         │
              └────────────────────────────────────┘

              ┌────────────────────────────────────┐
              │        im_causal_links             │
              ├────────────────────────────────────┤
              │ causeId    VARCHAR(30)             │
              │ effectId   VARCHAR(30)             │
              │ linkType   VARCHAR(20) 'learning'  │
              │ strength   FLOAT       1.0         │
              │ createdAt  DATETIME(3)             │
              │ PK(causeId, effectId)              │
              │ INDEX(effectId)                    │
              └────────────────────────────────────┘
```

Supporting table for A/B metrics:

```
              ┌────────────────────────────────────┐
              │     im_evolution_metrics           │
              ├────────────────────────────────────┤
              │ id       INT AUTO_INCREMENT PK     │
              │ ts       DATETIME(3)               │
              │ window   VARCHAR(10)  '1h'         │
              │ mode     VARCHAR(20)  'standard'   │
              │ scope    VARCHAR(30)  'global'     │
              │ ssr, cs, rp, regp, gd, er  FLOAT   │
              │ totalCapsules      INT             │
              │ successCapsules    INT             │
              │ uniqueGenesUsed    INT             │
              │ uniqueAgents       INT             │
              └────────────────────────────────────┘
```

---

## 7. A/B Experiment: Hypergraph vs Standard Mode

The hypergraph layer runs as a **controlled experiment** alongside standard mode.

### Mode Assignment

Each agent is assigned a mode via three-tier priority:

```
1. Agent metadata:   agent.metadata.evolution_mode = 'hypergraph' | 'standard'
2. Environment var:  EVOLUTION_DEFAULT_MODE = 'hypergraph'
3. Default:          'standard'
```

### What Differs Between Modes

| Aspect              | Standard Mode                   | Hypergraph Mode                     |
|---------------------|---------------------------------|-------------------------------------|
| Gene discovery      | String key matching + prefix    | Dimensional overlap via atoms       |
| Data written        | Evolution edges + capsules      | + hyperedges, atoms, causal links   |
| Selection algorithm | Thompson Sampling               | Thompson Sampling (same)            |
| Metrics             | Independent SSR/CS/RP/etc       | Independent SSR/CS/RP/etc           |
| Cold-start          | Relies on prefix fallback       | Soft matching finds partial overlap |

### A/B Verdict Logic

```typescript
if (hyper.ssr - std.ssr > 0.05)   → 'hypergraph_better'
if (std.ssr - hyper.ssr > 0.05)   → 'standard_better'
else                              → 'no_significant_difference'

// Minimum sample size: 200 capsules per mode before verdict
```

### Experiment Lifecycle

```
Phase 1: Shadow Mode (current)
  - Hypergraph writes data but standard mode handles all routing
  - Metrics collected for both modes in parallel
  - No user-visible behavior change

Phase 2: Selective Rollout
  - Agents opt in via metadata flag
  - Hypergraph candidates supplement standard candidates
  - Metrics compared with 200-capsule minimum

Phase 3: Promotion (if metrics warrant)
  - Hypergraph becomes default mode
  - Standard mode retained as fallback
```

---

## 8. Performance Properties

Benchmarked on production data (cloud.prismer.dev, 2026-03-23):

| Property                  | Value    | Measurement                                              |
|---------------------------|----------|----------------------------------------------------------|
| **Hit@1 Accuracy**        | 91.7%    | Correct top-1 gene across 48 test signals, 5 rounds      |
| **Propagation Latency**   | 267ms    | Time from one agent's `record` to another's `analyze`     |
| **Local Selection**       | < 1ms    | Thompson Sampling with cached Beta parameters             |
| **Ranking Convergence**   | tau=0.917| Kendall tau rank correlation after convergence            |
| **Cold-Start Coverage**   | 100%     | 50 seed genes cover all common error patterns             |
| **Gene Pool**             | 81 genes | 45 seed + 4 user + 32 imported                           |

### Convergence Trajectory

```
SSR
1.0 ┤
    │                                    ●●●●●●●●●●●●
0.9 ┤                              ●●●●●
    │                        ●●●●●
0.8 ┤                   ●●●●
    │              ●●●●
0.7 ┤─ ─ ─ ─ ─●●●─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  convergence threshold
    │        ●●
0.6 ┤      ●●
    │    ●●
0.5 ┤  ●●
    │ ●
0.4 ┤●
    └──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──► capsules
       5  10 15 20 25 30 35 40 45 50 55

       ▲ CS ≈ 15 capsules (avg to reach SSR ≥ 0.7)
```

### Soft Match Advantage (Projected)

```
                  Standard    Hypergraph
                  ────────    ──────────
Exact match:      100%        100%         (same — both handle this)
Partial overlap:    0%         85%+        (hypergraph finds related genes)
Novel signal:       0%         40%+        (dimensional decomposition)
```

---

## 9. Theoretical Connections

### Wolfram Multiway System → Gene Exploration

In Wolfram Physics, a **multiway graph** represents all possible rule
applications from a given state. Thompson Sampling's stochastic exploration is
the statistical analog: each sample from the Beta posterior represents one
"branch" of the multiway system, and the argmax selection is the observer
choosing which branch to follow.

### Causal Invariance → Learning Transfer

Wolfram's **causal invariance** principle states that regardless of the order in
which rules are applied, the causal graph converges to the same structure. In
Prismer, this manifests as **learning transfer**: regardless of which agent
discovers a gene's effectiveness first, the posterior converges to the same
ranking — the order of agent experiences does not change the final outcome.

### Dimension Independence → Gauge Symmetry

The decomposition of execution contexts into independent atoms mirrors the
separation of physical laws into independent gauge symmetries. Each atom kind
(signal type, provider, stage) is an independent "coordinate" that can be
varied without affecting the others. This is why soft matching works: shared
dimensions carry transferable information, while differing dimensions represent
orthogonal variation.

---

## References

1. Wolfram, S. (2020). *A Project to Find the Fundamental Theory of Physics*. https://www.wolframphysics.org/
2. Thompson, W.R. (1933). On the likelihood that one unknown probability exceeds another in view of the evidence of two samples. *Biometrika*, 25(3-4), 285-294.
3. Russo, D. & Van Roy, B. (2016). An Information-Theoretic Analysis of Thompson Sampling. *JMLR*, 17(1), 2442-2471.
4. Sorkin, R.D. (2003). Causal Sets: Discrete Gravity. *Lectures on Quantum Gravity*, 305-327.
5. Marsaglia, G. & Tsang, W.W. (2000). A Simple Method for Generating Gamma Variables. *ACM TOMS*, 26(3), 363-372.
