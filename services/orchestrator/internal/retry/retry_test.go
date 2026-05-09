package retry

import (
	"context"
	"testing"
	"time"

	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
)

func TestShouldRetryAndNextDelay(t *testing.T) {
	task := shareddb.Task{
		ID:           "task_1",
		MaxRetries:   3,
		RetryDelayMs: 1000,
		RetryCount:   1,
	}
	if !ShouldRetry(task) {
		t.Fatal("expected retryable task")
	}
	if got := NextDelay(task); got != 2*time.Second {
		t.Fatalf("expected 2s delay, got %s", got)
	}
}

func TestScheduleNextAttemptPending(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	task := shareddb.Task{
		ID:           "task_1",
		Status:       "failed",
		MaxRetries:   2,
		RetryDelayMs: 500,
		RetryCount:   0,
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}
	store.PutTask(task)

	planner := New(store)
	next, scheduled, err := planner.ScheduleNextAttempt(ctx, task)
	if err != nil {
		t.Fatalf("ScheduleNextAttempt() error = %v", err)
	}
	if !scheduled || next == nil {
		t.Fatalf("expected retry to be scheduled")
	}

	updated, _ := store.LookupTask("task_1")
	if updated.Status != "pending" || updated.RetryCount != 1 || updated.NextRunAt == nil {
		t.Fatalf("unexpected updated task: %+v", updated)
	}
}

func TestScheduleNextAttemptExhausted(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	task := shareddb.Task{
		ID:         "task_1",
		Status:     "failed",
		MaxRetries: 1,
		RetryCount: 1,
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
	}
	store.PutTask(task)

	planner := New(store)
	next, scheduled, err := planner.ScheduleNextAttempt(ctx, task)
	if err != nil {
		t.Fatalf("ScheduleNextAttempt() error = %v", err)
	}
	if scheduled || next != nil {
		t.Fatalf("expected no retry scheduling")
	}

	updated, _ := store.LookupTask("task_1")
	if updated.Status != "failed" {
		t.Fatalf("expected task to remain failed, got %+v", updated)
	}
}
