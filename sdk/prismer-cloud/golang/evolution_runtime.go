package prismer

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// ============================================================================
// EvolutionRuntime — High-level evolution API for Go agents.
//
// Composes EvolutionCache + SignalEnrichment + async outbox into two methods:
//   - Suggest(ctx, error, opts...) → strategy recommendation (<1ms local, fallback to server)
//   - Learned(error, outcome, summary, geneID...) → fire-and-forget outcome recording
//
// Port of sdk/typescript/src/evolution-runtime.ts and sdk/python/prismer/evolution_runtime.py.
//
// Usage:
//
//	client := prismer.NewClient("sk-prismer-...")
//	rt := prismer.NewEvolutionRuntime(client.IM().Evolution, nil)
//	rt.Start(ctx)
//	defer rt.Stop()
//
//	fix, _ := rt.Suggest(ctx, "ETIMEDOUT: connection timed out")
//	// ... agent applies fix.Strategy ...
//	rt.Learned("ETIMEDOUT", "success", "Fixed by increasing timeout")
// ============================================================================

// EvolutionRuntimeConfig configures the evolution runtime.
type EvolutionRuntimeConfig struct {
	SyncIntervalMs int    // default: 60000 (60s)
	Scope          string // default: "global"
	OutboxMaxSize  int    // default: 50
	OutboxFlushMs  int    // default: 5000 (5s)
}

func (c *EvolutionRuntimeConfig) withDefaults() EvolutionRuntimeConfig {
	out := *c
	if out.SyncIntervalMs <= 0 {
		out.SyncIntervalMs = 60000
	}
	if out.Scope == "" {
		out.Scope = "global"
	}
	if out.OutboxMaxSize <= 0 {
		out.OutboxMaxSize = 50
	}
	if out.OutboxFlushMs <= 0 {
		out.OutboxFlushMs = 5000
	}
	return out
}

// Suggestion holds the result of a Suggest() call.
type Suggestion struct {
	Action       string           `json:"action"`
	GeneID       string           `json:"gene_id,omitempty"`
	Gene         map[string]any   `json:"gene,omitempty"`
	Strategy     []string         `json:"strategy,omitempty"`
	Confidence   float64          `json:"confidence"`
	Signals      []map[string]any `json:"signals,omitempty"`
	FromCache    bool             `json:"from_cache"`
	Reason       string           `json:"reason,omitempty"`
	Alternatives []map[string]any `json:"alternatives,omitempty"`
}

// SuggestOptions holds optional parameters for Suggest().
type SuggestOptions struct {
	Provider string
	Stage    string
	Severity string
	Tags     []string
}

type outboxEntry struct {
	geneID    string
	signals   []map[string]any
	outcome   string
	summary   string
	ts        time.Time
	sessionID string
}

// EvolutionSession tracks a single suggest→learned cycle.
type EvolutionSession struct {
	ID               string    `json:"id"`
	SuggestedAt      time.Time `json:"suggested_at"`
	SuggestedGeneID  string    `json:"suggested_gene_id,omitempty"`
	UsedGeneID       string    `json:"used_gene_id,omitempty"`
	Adopted          bool      `json:"adopted"`
	CompletedAt      time.Time `json:"completed_at,omitempty"`
	Outcome          string    `json:"outcome,omitempty"`
	DurationMs       int64     `json:"duration_ms,omitempty"`
	Confidence       float64   `json:"confidence"`
	FromCache        bool      `json:"from_cache"`
}

// SessionMetrics holds aggregate session metrics for benchmarking.
type SessionMetrics struct {
	TotalSuggestions      int     `json:"total_suggestions"`
	SuggestionsWithGene   int     `json:"suggestions_with_gene"`
	TotalLearned          int     `json:"total_learned"`
	AdoptedCount          int     `json:"adopted_count"`
	GeneUtilizationRate   float64 `json:"gene_utilization_rate"`
	AvgDurationMs         float64 `json:"avg_duration_ms"`
	AdoptedSuccessRate    float64 `json:"adopted_success_rate"`
	NonAdoptedSuccessRate float64 `json:"non_adopted_success_rate"`
	CacheHitRate          float64 `json:"cache_hit_rate"`
}

// EvolutionRuntime provides high-level, cache-first evolution for Go agents.
type EvolutionRuntime struct {
	cache  *EvolutionCache
	client *EvolutionClient
	config EvolutionRuntimeConfig

	mu                  sync.Mutex
	outbox              []outboxEntry
	lastSuggestedGeneID string
	sessions            []EvolutionSession
	activeSession       *EvolutionSession
	sessionCounter      int64

	cancel  context.CancelFunc
	started bool
}

// NewEvolutionRuntime creates a new runtime backed by the given evolution client.
func NewEvolutionRuntime(client *EvolutionClient, config *EvolutionRuntimeConfig) *EvolutionRuntime {
	cfg := EvolutionRuntimeConfig{}
	if config != nil {
		cfg = *config
	}
	cfg = cfg.withDefaults()

	return &EvolutionRuntime{
		cache:  NewEvolutionCache(),
		client: client,
		config: cfg,
	}
}

// Start loads the initial snapshot and starts background sync + flush goroutines.
func (r *EvolutionRuntime) Start(ctx context.Context) error {
	if r.started {
		return nil
	}
	r.started = true

	// Load initial snapshot
	res, err := r.client.GetSyncSnapshot(ctx, 0)
	if err == nil && res != nil && res.OK {
		data := r.extractData(res)
		if data != nil {
			r.cache.LoadSnapshot(data)
		}
	}

	// Start background goroutines
	bgCtx, cancel := context.WithCancel(ctx)
	r.cancel = cancel

	// Sync loop
	go r.syncLoop(bgCtx)
	// Flush loop
	go r.flushLoop(bgCtx)

	return nil
}

// Stop cancels background goroutines and performs a final flush.
func (r *EvolutionRuntime) Stop() {
	r.started = false
	if r.cancel != nil {
		r.cancel()
	}
	r.flush(context.Background())
}

// Suggest gets a strategy recommendation. Cache first (<1ms), server fallback.
func (r *EvolutionRuntime) Suggest(ctx context.Context, errorStr string, opts ...SuggestOptions) (*Suggestion, error) {
	var opt SuggestOptions
	if len(opts) > 0 {
		opt = opts[0]
	}

	signals := ExtractSignals(SignalExtractionContext{
		Error:    errorStr,
		Provider: opt.Provider,
		Stage:    opt.Stage,
		Severity: opt.Severity,
		Tags:     opt.Tags,
	})

	if len(signals) == 0 {
		return &Suggestion{
			Action: "none",
			Reason: "no signals extracted from error",
		}, nil
	}

	signalMaps := signalTagsToMaps(signals)

	// Try local cache first
	if r.cache.GeneCount() > 0 {
		local := r.cache.SelectGene(signals)
		if local.Action == "apply_gene" && local.Confidence > 0.3 {
			r.mu.Lock()
			r.lastSuggestedGeneID = local.GeneID
			r.startSession(local.GeneID, local.Confidence, true)
			r.mu.Unlock()
			return &Suggestion{
				Action:       local.Action,
				GeneID:       local.GeneID,
				Gene:         local.Gene,
				Strategy:     local.Strategy,
				Confidence:   local.Confidence,
				Signals:      signalMaps,
				FromCache:    true,
				Reason:       local.Reason,
				Alternatives: local.Alternatives,
			}, nil
		}
	}

	// Fallback to server
	analyzeSignals := make([]string, len(signals))
	for i, s := range signals {
		analyzeSignals[i] = s.Type
	}

	res, err := r.client.Analyze(ctx, &AnalyzeOptions{
		Signals: analyzeSignals,
		Scope:   r.config.Scope,
	})
	if err != nil {
		// Server unreachable — use cache even if low confidence
		local := r.cache.SelectGene(signals)
		r.mu.Lock()
		r.lastSuggestedGeneID = local.GeneID
		r.startSession(local.GeneID, local.Confidence, true)
		r.mu.Unlock()
		return &Suggestion{
			Action:     local.Action,
			GeneID:     local.GeneID,
			Gene:       local.Gene,
			Strategy:   local.Strategy,
			Confidence: local.Confidence,
			Signals:    signalMaps,
			FromCache:  true,
			Reason:     "server unreachable, using cache fallback",
		}, nil
	}

	data := r.extractData(res)
	if data != nil {
		geneID := strVal(data, "gene_id")
		r.mu.Lock()
		r.lastSuggestedGeneID = geneID
		r.startSession(geneID, floatVal(data, "confidence"), false)
		r.mu.Unlock()

		var strategy []string
		if s, ok := data["strategy"].([]any); ok {
			for _, v := range s {
				if str, ok := v.(string); ok {
					strategy = append(strategy, str)
				}
			}
		}

		var gene map[string]any
		if g, ok := data["gene"].(map[string]any); ok {
			gene = g
		}

		var alternatives []map[string]any
		if alts, ok := data["alternatives"].([]any); ok {
			for _, a := range alts {
				if am, ok := a.(map[string]any); ok {
					alternatives = append(alternatives, am)
				}
			}
		}

		action := strVal(data, "action")
		if action == "" {
			action = "none"
		}

		return &Suggestion{
			Action:       action,
			GeneID:       geneID,
			Gene:         gene,
			Strategy:     strategy,
			Confidence:   floatVal(data, "confidence"),
			Signals:      signalMaps,
			FromCache:    false,
			Reason:       strVal(data, "reason"),
			Alternatives: alternatives,
		}, nil
	}

	return &Suggestion{
		Action:  "none",
		Signals: signalMaps,
		Reason:  "no recommendation",
	}, nil
}

// Learned records an outcome. Fire-and-forget — never blocks, never panics.
func (r *EvolutionRuntime) Learned(errorStr, outcome, summary string, geneID ...string) {
	signals := ExtractSignals(SignalExtractionContext{Error: errorStr})

	r.mu.Lock()
	resolved := ""
	if len(geneID) > 0 && geneID[0] != "" {
		resolved = geneID[0]
	} else {
		resolved = r.lastSuggestedGeneID
	}
	if resolved == "" {
		r.mu.Unlock()
		return
	}

	r.completeSession(resolved, outcome)

	sessionID := ""
	if len(r.sessions) > 0 {
		sessionID = r.sessions[len(r.sessions)-1].ID
	}
	r.outbox = append(r.outbox, outboxEntry{
		geneID:    resolved,
		signals:   signalTagsToMaps(signals),
		outcome:   outcome,
		summary:   summary,
		ts:        time.Now(),
		sessionID: sessionID,
	})

	shouldFlush := len(r.outbox) >= r.config.OutboxMaxSize
	r.mu.Unlock()

	if shouldFlush {
		go r.flush(context.Background())
	}
}

// ── internal ────────────────────────────────────────────────────────────

func (r *EvolutionRuntime) syncLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Duration(r.config.SyncIntervalMs) * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			res, err := r.client.Sync(ctx, nil, r.cache.Cursor())
			if err != nil {
				continue
			}
			data := r.extractData(res)
			if data != nil {
				if _, ok := data["pulled"]; ok {
					r.cache.ApplyDelta(data)
				}
			}
		}
	}
}

func (r *EvolutionRuntime) flushLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Duration(r.config.OutboxFlushMs) * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.flush(ctx)
		}
	}
}

func (r *EvolutionRuntime) flush(ctx context.Context) {
	r.mu.Lock()
	if len(r.outbox) == 0 {
		r.mu.Unlock()
		return
	}
	batch := make([]outboxEntry, len(r.outbox))
	copy(batch, r.outbox)
	r.outbox = r.outbox[:0]
	r.mu.Unlock()

	for _, entry := range batch {
		signalTypes := make([]string, len(entry.signals))
		for i, s := range entry.signals {
			if t, ok := s["type"].(string); ok {
				signalTypes[i] = t
			}
		}
		_, err := r.client.Record(ctx, &RecordOutcomeOptions{
			GeneID:  entry.geneID,
			Signals: signalTypes,
			Outcome: entry.outcome,
			Summary: entry.summary,
			Scope:   r.config.Scope,
		})
		if err != nil {
			// Re-enqueue on failure
			r.mu.Lock()
			r.outbox = append(r.outbox, entry)
			r.mu.Unlock()
		}
	}
}

func (r *EvolutionRuntime) extractData(res *IMResult) map[string]any {
	if res == nil || len(res.Data) == 0 {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal(res.Data, &m); err != nil {
		return nil
	}
	// Unwrap nested {"data": {...}} if present
	if inner, ok := m["data"].(map[string]any); ok {
		return inner
	}
	return m
}

// startSession begins tracking a new suggest→learned cycle. Must be called with mu held.
func (r *EvolutionRuntime) startSession(geneID string, confidence float64, fromCache bool) {
	r.sessionCounter++
	r.activeSession = &EvolutionSession{
		ID:              fmt.Sprintf("ses_%d_%d", r.sessionCounter, time.Now().UnixMilli()),
		SuggestedAt:     time.Now(),
		SuggestedGeneID: geneID,
		Confidence:      confidence,
		FromCache:       fromCache,
	}
}

// completeSession finishes the active session. Must be called with mu held.
func (r *EvolutionRuntime) completeSession(usedGeneID, outcome string) {
	if r.activeSession == nil {
		return
	}
	s := r.activeSession
	s.UsedGeneID = usedGeneID
	s.Adopted = usedGeneID == s.SuggestedGeneID
	s.CompletedAt = time.Now()
	s.Outcome = outcome
	s.DurationMs = time.Since(s.SuggestedAt).Milliseconds()
	r.sessions = append(r.sessions, *s)
	r.activeSession = nil
}

// Sessions returns all completed sessions.
func (r *EvolutionRuntime) Sessions() []EvolutionSession {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]EvolutionSession, len(r.sessions))
	copy(out, r.sessions)
	return out
}

// GetMetrics returns aggregate session metrics for benchmarking.
func (r *EvolutionRuntime) GetMetrics() SessionMetrics {
	r.mu.Lock()
	defer r.mu.Unlock()

	ss := r.sessions
	total := len(ss)
	if total == 0 {
		return SessionMetrics{}
	}

	withGene := 0
	learned := 0
	adoptedCount := 0
	adoptedSuccess := 0
	nonAdoptedCount := 0
	nonAdoptedSuccess := 0
	cacheHits := 0
	var totalDuration int64

	for _, s := range ss {
		if s.SuggestedGeneID != "" {
			withGene++
		}
		if !s.CompletedAt.IsZero() {
			learned++
			totalDuration += s.DurationMs
			if s.Adopted {
				adoptedCount++
				if s.Outcome == "success" {
					adoptedSuccess++
				}
			} else {
				nonAdoptedCount++
				if s.Outcome == "success" {
					nonAdoptedSuccess++
				}
			}
		}
		if s.FromCache {
			cacheHits++
		}
	}

	m := SessionMetrics{
		TotalSuggestions:    total,
		SuggestionsWithGene: withGene,
		TotalLearned:        learned,
		AdoptedCount:        adoptedCount,
	}
	if withGene > 0 {
		m.GeneUtilizationRate = float64(adoptedCount) / float64(withGene)
	}
	if learned > 0 {
		m.AvgDurationMs = float64(totalDuration) / float64(learned)
	}
	if adoptedCount > 0 {
		m.AdoptedSuccessRate = float64(adoptedSuccess) / float64(adoptedCount)
	}
	if nonAdoptedCount > 0 {
		m.NonAdoptedSuccessRate = float64(nonAdoptedSuccess) / float64(nonAdoptedCount)
	}
	if total > 0 {
		m.CacheHitRate = float64(cacheHits) / float64(total)
	}
	return m
}

// ResetMetrics clears session history.
func (r *EvolutionRuntime) ResetMetrics() {
	r.mu.Lock()
	r.sessions = nil
	r.mu.Unlock()
}

func signalTagsToMaps(tags []SignalTag) []map[string]any {
	result := make([]map[string]any, len(tags))
	for i, t := range tags {
		m := map[string]any{"type": t.Type}
		if t.Provider != "" {
			m["provider"] = t.Provider
		}
		if t.Stage != "" {
			m["stage"] = t.Stage
		}
		if t.Severity != "" {
			m["severity"] = t.Severity
		}
		result[i] = m
	}
	return result
}
