package prismer

import (
	"fmt"
	"sort"
	"sync"
)

// ============================================================================
// EvolutionCache — local gene cache with Thompson Sampling selection.
// Enables <1ms gene selection without network calls.
// Port of sdk/typescript/src/evolution-cache.ts.
// ============================================================================

// GeneSelectionResult holds the result of a local gene selection.
type GeneSelectionResult struct {
	Action        string           `json:"action"`         // "apply_gene", "create_suggested", "none"
	GeneID        string           `json:"gene_id,omitempty"`
	Gene          map[string]any   `json:"gene,omitempty"`
	Strategy      []string         `json:"strategy,omitempty"`
	Confidence    float64          `json:"confidence"`
	CoverageScore float64          `json:"coverage_score,omitempty"`
	Alternatives  []map[string]any `json:"alternatives,omitempty"`
	Reason        string           `json:"reason,omitempty"`
	FromCache     bool             `json:"from_cache"`
}

// EvolutionCache is a local gene cache with Thompson Sampling selection.
// Thread-safe: all methods acquire the internal mutex.
type EvolutionCache struct {
	mu          sync.RWMutex
	genes       map[string]map[string]any
	edges       map[string][]map[string]any // key = signal_key
	globalPrior map[string]map[string]float64
	cursor      int64
}

// NewEvolutionCache creates a new empty evolution cache.
func NewEvolutionCache() *EvolutionCache {
	return &EvolutionCache{
		genes:       make(map[string]map[string]any),
		edges:       make(map[string][]map[string]any),
		globalPrior: make(map[string]map[string]float64),
	}
}

// GeneCount returns the number of genes in the cache.
func (c *EvolutionCache) GeneCount() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.genes)
}

// Cursor returns the current sync cursor.
func (c *EvolutionCache) Cursor() int64 {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.cursor
}

// LoadSnapshot loads a full sync snapshot into the cache, replacing all existing data.
func (c *EvolutionCache) LoadSnapshot(snapshot map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.genes = make(map[string]map[string]any)
	c.edges = make(map[string][]map[string]any)
	c.globalPrior = make(map[string]map[string]float64)

	// Load genes
	if genes, ok := snapshot["genes"].([]any); ok {
		for _, g := range genes {
			if gene, ok := g.(map[string]any); ok {
				id := strVal(gene, "id")
				if id == "" {
					id = strVal(gene, "gene_id")
				}
				if id != "" {
					c.genes[id] = gene
				}
			}
		}
	}

	// Load edges
	if edges, ok := snapshot["edges"].([]any); ok {
		for _, e := range edges {
			if edge, ok := e.(map[string]any); ok {
				key := strVal(edge, "signal_key")
				if key == "" {
					key = strVal(edge, "signalKey")
				}
				if key != "" {
					c.edges[key] = append(c.edges[key], edge)
				}
			}
		}
	}

	// Load global prior
	gp := mapVal(snapshot, "globalPrior")
	if gp == nil {
		gp = mapVal(snapshot, "global_prior")
	}
	if gp != nil {
		for key, val := range gp {
			if m, ok := val.(map[string]any); ok {
				c.globalPrior[key] = map[string]float64{
					"alpha": floatVal(m, "alpha"),
					"beta":  floatVal(m, "beta"),
				}
			} else {
				c.globalPrior[key] = map[string]float64{
					"alpha": toFloat64(val),
					"beta":  1.0,
				}
			}
		}
	}

	if cur, ok := snapshot["cursor"]; ok {
		c.cursor = toInt64(cur)
	}
}

// ApplyDelta applies an incremental sync delta to the cache.
func (c *EvolutionCache) ApplyDelta(delta map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()

	pulled := mapVal(delta, "pulled")
	if pulled == nil {
		pulled = delta
	}

	// Update genes
	if genes, ok := pulled["genes"].([]any); ok {
		for _, g := range genes {
			if gene, ok := g.(map[string]any); ok {
				id := strVal(gene, "id")
				if id == "" {
					id = strVal(gene, "gene_id")
				}
				if id != "" {
					c.genes[id] = gene
				}
			}
		}
	}

	// Remove quarantined genes
	if quarantines, ok := pulled["quarantines"].([]any); ok {
		for _, q := range quarantines {
			if qid, ok := q.(string); ok {
				delete(c.genes, qid)
			}
		}
	}

	// Update edges
	if edges, ok := pulled["edges"].([]any); ok {
		for _, e := range edges {
			if edge, ok := e.(map[string]any); ok {
				key := strVal(edge, "signal_key")
				if key == "" {
					key = strVal(edge, "signalKey")
				}
				geneID := strVal(edge, "gene_id")
				if geneID == "" {
					geneID = strVal(edge, "geneId")
				}
				if key == "" {
					continue
				}

				lst := c.edges[key]
				found := false
				for i, existing := range lst {
					eid := strVal(existing, "gene_id")
					if eid == "" {
						eid = strVal(existing, "geneId")
					}
					if eid == geneID {
						lst[i] = edge
						found = true
						break
					}
				}
				if !found {
					lst = append(lst, edge)
				}
				c.edges[key] = lst
			}
		}
	}

	// Update global prior
	gp := mapVal(pulled, "globalPrior")
	if gp == nil {
		gp = mapVal(pulled, "global_prior")
	}
	if gp != nil {
		for key, val := range gp {
			if m, ok := val.(map[string]any); ok {
				c.globalPrior[key] = map[string]float64{
					"alpha": floatVal(m, "alpha"),
					"beta":  floatVal(m, "beta"),
				}
			}
		}
	}

	if cur, ok := pulled["cursor"]; ok {
		c.cursor = toInt64(cur)
	}
}

// LoadDelta is an alias for ApplyDelta (API parity).
func (c *EvolutionCache) LoadDelta(delta map[string]any) {
	c.ApplyDelta(delta)
}

// SelectGene selects the best gene for the given signals using Thompson Sampling.
// Pure CPU, <1ms.
func (c *EvolutionCache) SelectGene(signals []SignalTag) GeneSelectionResult {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if len(c.genes) == 0 {
		return GeneSelectionResult{
			Action:    "none",
			Reason:    "no genes in cache",
			FromCache: true,
		}
	}

	// Build signal keys from input
	signalKeys := make([]string, len(signals))
	for i, s := range signals {
		signalKeys[i] = s.Type
	}

	// Score each gene
	type candidate struct {
		gene          map[string]any
		rankScore     float64
		coverageScore float64
		sampledScore  float64
	}
	var candidates []candidate

	for _, gene := range c.genes {
		// Skip quarantined
		if strVal(gene, "visibility") == "quarantined" {
			continue
		}

		// Extract gene signal types
		geneSignalTypes := extractGeneSignalTypes(gene)
		if len(geneSignalTypes) == 0 {
			continue
		}

		// Coverage score
		matchCount := 0
		for _, k := range signalKeys {
			for _, gs := range geneSignalTypes {
				if k == gs {
					matchCount++
					break
				}
			}
		}
		coverageScore := float64(matchCount) / float64(len(geneSignalTypes))
		if coverageScore == 0 {
			continue
		}

		// Thompson Sampling: Beta(alpha, beta) mean
		sc := floatVal(gene, "success_count")
		if sc == 0 {
			sc = floatVal(gene, "successCount")
		}
		fc := floatVal(gene, "failure_count")
		if fc == 0 {
			fc = floatVal(gene, "failureCount")
		}
		alpha := sc + 1.0
		beta := fc + 1.0

		// Blend with global prior (weight 0.3)
		for _, key := range signalKeys {
			if prior, ok := c.globalPrior[key]; ok {
				alpha += 0.3 * prior["alpha"]
				beta += 0.3 * prior["beta"]
			}
		}

		sampledScore := alpha / (alpha + beta)

		// Ban threshold: skip if success rate < 18% with enough data
		totalObs := sc + fc
		if totalObs >= 10 && sc/totalObs < 0.18 {
			continue
		}

		// Combined rank score
		rankScore := coverageScore*0.4 + sampledScore*0.6

		candidates = append(candidates, candidate{
			gene:          gene,
			rankScore:     rankScore,
			coverageScore: coverageScore,
			sampledScore:  sampledScore,
		})
	}

	if len(candidates) == 0 {
		return GeneSelectionResult{
			Action:    "create_suggested",
			Reason:    "no matching genes for signals",
			FromCache: true,
		}
	}

	// Sort by rank score descending
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].rankScore > candidates[j].rankScore
	})

	best := candidates[0]

	// Build alternatives (top 3 after best)
	var alternatives []map[string]any
	limit := len(candidates)
	if limit > 4 {
		limit = 4
	}
	for _, cand := range candidates[1:limit] {
		alternatives = append(alternatives, map[string]any{
			"gene_id":    strVal(cand.gene, "id"),
			"confidence": roundTo2(cand.rankScore),
			"title":      cand.gene["title"],
		})
	}

	// Extract strategy
	var strategy []string
	if s, ok := best.gene["strategy"].([]any); ok {
		for _, v := range s {
			if str, ok := v.(string); ok {
				strategy = append(strategy, str)
			}
		}
	}

	return GeneSelectionResult{
		Action:        "apply_gene",
		GeneID:        strVal(best.gene, "id"),
		Gene:          best.gene,
		Strategy:      strategy,
		Confidence:    roundTo2(best.rankScore),
		CoverageScore: roundTo2(best.coverageScore),
		Alternatives:  alternatives,
		Reason:        fmt.Sprintf("local cache selection (%d genes)", len(c.genes)),
		FromCache:     true,
	}
}

// ── helpers ──────────────────────────────────────────────────────────────

func extractGeneSignalTypes(gene map[string]any) []string {
	raw, ok := gene["signals_match"]
	if !ok {
		raw = gene["signalsMatch"]
	}
	arr, ok := raw.([]any)
	if !ok {
		return nil
	}
	var out []string
	for _, s := range arr {
		switch v := s.(type) {
		case string:
			out = append(out, v)
		case map[string]any:
			if t, ok := v["type"].(string); ok {
				out = append(out, t)
			}
		}
	}
	return out
}

func strVal(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func floatVal(m map[string]any, key string) float64 {
	return toFloat64(m[key])
}

func toFloat64(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case float32:
		return float64(n)
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case int32:
		return float64(n)
	default:
		return 0
	}
}

func toInt64(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case float32:
		return int64(n)
	case int:
		return int64(n)
	case int64:
		return n
	case int32:
		return int64(n)
	default:
		return 0
	}
}

func mapVal(m map[string]any, key string) map[string]any {
	if v, ok := m[key].(map[string]any); ok {
		return v
	}
	return nil
}

func roundTo2(v float64) float64 {
	return float64(int(v*100+0.5)) / 100.0
}
