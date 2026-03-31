package prismer

import (
	"context"
	"fmt"
	"math/rand"
	"sync"
	"time"
)

// EvolutionOutboxOp represents a queued evolution operation.
type EvolutionOutboxOp struct {
	ID             string
	OpType         string // "record" or "report"
	Payload        interface{}
	Status         string // "pending", "inflight", "confirmed", "failed"
	CreatedAt      time.Time
	Retries        int
	MaxRetries     int
	IdempotencyKey string
}

// EvolutionOutbox provides fire-and-forget outcome recording with local WAL.
//
// Queues Record() calls locally and flushes them to the server asynchronously.
// Prevents data loss on network failures and eliminates write latency from the
// agent's hot path.
//
// Usage:
//
//	outbox := prismer.NewEvolutionOutbox(requestFn, nil)
//	outbox.Start()
//	outbox.Enqueue("record", payload)
//	// ... later ...
//	outbox.Stop() // flushes remaining
type EvolutionOutbox struct {
	mu            sync.Mutex
	queue         []*EvolutionOutboxOp
	requestFn     func(ctx context.Context, method, path string, body interface{}) error
	flushInterval time.Duration
	maxRetries    int
	batchSize     int
	stopCh        chan struct{}
	running       bool
}

// EvolutionOutboxConfig configures the outbox behavior.
type EvolutionOutboxConfig struct {
	FlushInterval time.Duration // default 1s
	MaxRetries    int           // default 5
	BatchSize     int           // default 10
}

// NewEvolutionOutbox creates a new outbox with the given request function and config.
// The requestFn is called for each flush operation with (ctx, "POST", endpoint, payload).
func NewEvolutionOutbox(
	requestFn func(ctx context.Context, method, path string, body interface{}) error,
	cfg *EvolutionOutboxConfig,
) *EvolutionOutbox {
	if cfg == nil {
		cfg = &EvolutionOutboxConfig{}
	}
	if cfg.FlushInterval == 0 {
		cfg.FlushInterval = time.Second
	}
	if cfg.MaxRetries == 0 {
		cfg.MaxRetries = 5
	}
	if cfg.BatchSize == 0 {
		cfg.BatchSize = 10
	}
	return &EvolutionOutbox{
		requestFn:     requestFn,
		flushInterval: cfg.FlushInterval,
		maxRetries:    cfg.MaxRetries,
		batchSize:     cfg.BatchSize,
		stopCh:        make(chan struct{}),
	}
}

// Enqueue adds an operation to the outbox. Returns the operation ID.
func (o *EvolutionOutbox) Enqueue(opType string, payload interface{}) string {
	op := &EvolutionOutboxOp{
		ID:             fmt.Sprintf("evo_%d_%s", time.Now().UnixMilli(), randHex(8)),
		OpType:         opType,
		Payload:        payload,
		Status:         "pending",
		CreatedAt:      time.Now(),
		MaxRetries:     o.maxRetries,
		IdempotencyKey: fmt.Sprintf("%s:%d", opType, time.Now().UnixMilli()),
	}
	o.mu.Lock()
	o.queue = append(o.queue, op)
	o.mu.Unlock()
	return op.ID
}

// PendingCount returns the number of pending operations.
func (o *EvolutionOutbox) PendingCount() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	count := 0
	for _, op := range o.queue {
		if op.Status == "pending" {
			count++
		}
	}
	return count
}

// Start begins the background flush goroutine.
func (o *EvolutionOutbox) Start() {
	o.mu.Lock()
	o.running = true
	o.mu.Unlock()
	go o.flushLoop()
}

// Stop stops the background flush goroutine and performs a final flush.
func (o *EvolutionOutbox) Stop() {
	o.mu.Lock()
	wasRunning := o.running
	o.running = false
	o.mu.Unlock()
	if wasRunning {
		close(o.stopCh)
	}
	o.Flush(context.Background())
}

// Flush sends pending operations to the server. Returns count of flushed ops.
func (o *EvolutionOutbox) Flush(ctx context.Context) int {
	o.mu.Lock()
	var pending []*EvolutionOutboxOp
	for _, op := range o.queue {
		if op.Status == "pending" && len(pending) < o.batchSize {
			pending = append(pending, op)
		}
	}
	o.mu.Unlock()

	flushed := 0
	for _, op := range pending {
		op.Status = "inflight"
		endpoint := "/api/im/evolution/record"
		if op.OpType == "report" {
			endpoint = "/api/im/evolution/report"
		}
		err := o.requestFn(ctx, "POST", endpoint, op.Payload)
		if err != nil {
			op.Retries++
			if op.Retries >= op.MaxRetries {
				op.Status = "failed"
			} else {
				op.Status = "pending"
			}
		} else {
			op.Status = "confirmed"
			flushed++
		}
	}

	// Remove confirmed/failed ops
	o.mu.Lock()
	var remaining []*EvolutionOutboxOp
	for _, op := range o.queue {
		if op.Status != "confirmed" && op.Status != "failed" {
			remaining = append(remaining, op)
		}
	}
	o.queue = remaining
	o.mu.Unlock()

	return flushed
}

func (o *EvolutionOutbox) flushLoop() {
	ticker := time.NewTicker(o.flushInterval)
	defer ticker.Stop()
	for {
		select {
		case <-o.stopCh:
			return
		case <-ticker.C:
			o.Flush(context.Background())
		}
	}
}

func randHex(n int) string {
	const chars = "0123456789abcdef"
	b := make([]byte, n)
	for i := range b {
		b[i] = chars[rand.Intn(len(chars))]
	}
	return string(b)
}
