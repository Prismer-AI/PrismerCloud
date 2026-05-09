package dispatcher

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
)

type fakeHub struct {
	sent map[string][][]byte
}

func newFakeHub() *fakeHub {
	return &fakeHub{sent: make(map[string][][]byte)}
}

func (h *fakeHub) Send(_ context.Context, runtimeID string, message []byte) error {
	h.sent[runtimeID] = append(h.sent[runtimeID], append([]byte(nil), message...))
	return nil
}

func TestMatchRuntimePrefersSameOwnerAndLowerLoad(t *testing.T) {
	now := time.Now()
	task := shareddb.Task{
		ID:         "task_1",
		Capability: "claude-code",
		CreatorDid: "did:key:owner-a",
	}
	runtimes := []shareddb.Runtime{
		{
			ID:              "rt_other",
			OwnerDid:        "did:key:owner-b",
			Capabilities:    `[{"key":"claude-code"}]`,
			Status:          "online",
			Load:            0.1,
			LastHeartbeatAt: now,
		},
		{
			ID:              "rt_same_owner",
			OwnerDid:        "did:key:owner-a",
			Capabilities:    `[{"key":"claude-code"}]`,
			Status:          "online",
			Load:            0.5,
			LastHeartbeatAt: now,
		},
	}

	match, ok := MatchRuntime(task, runtimes, now)
	if !ok {
		t.Fatal("expected a match")
	}
	if match.Runtime.ID != "rt_same_owner" {
		t.Fatalf("expected same-owner runtime, got %s", match.Runtime.ID)
	}
}

func TestDispatchTaskSendsTaskPushAndCreatesExecution(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	hub := newFakeHub()
	dispatcher := New(store, hub)

	mustRegisterDispatcherRuntime(t, ctx, store, "rt_1", "did:key:owner-a", `[{"key":"claude-code"}]`, 0.2)
	store.PutTask(shareddb.Task{
		ID:         "task_1",
		Title:      "Refactor service layer",
		Capability: "claude-code",
		Input:      `{"prompt":"hello"}`,
		CreatorDid: "did:key:owner-a",
		Status:     "pending",
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
	})

	result, err := dispatcher.DispatchTask(ctx, "task_1")
	if err != nil {
		t.Fatalf("DispatchTask() error = %v", err)
	}
	if result.RuntimeID != "rt_1" {
		t.Fatalf("expected runtime rt_1, got %s", result.RuntimeID)
	}

	task, ok := store.LookupTask("task_1")
	if !ok {
		t.Fatal("expected task to exist")
	}
	if task.Status != "assigned" || task.RuntimeID != "rt_1" {
		t.Fatalf("unexpected claimed task state: %+v", task)
	}

	exec, ok := store.LookupTaskExecution(result.ExecutionID)
	if !ok {
		t.Fatalf("expected execution %s", result.ExecutionID)
	}
	if exec.Status != "dispatched" {
		t.Fatalf("unexpected execution status: %s", exec.Status)
	}

	messages := hub.sent["rt_1"]
	if len(messages) != 1 {
		t.Fatalf("expected 1 outbound message, got %d", len(messages))
	}

	var envelope proto.Envelope
	if err := json.Unmarshal(messages[0], &envelope); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	if err := envelope.Validate(); err != nil {
		t.Fatalf("envelope validate: %v", err)
	}
	if envelope.Type != "task.push" {
		t.Fatalf("unexpected envelope type: %s", envelope.Type)
	}
}

func TestDispatchTaskReturnsNoMatchingRuntime(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	hub := newFakeHub()
	dispatcher := New(store, hub)

	store.PutTask(shareddb.Task{
		ID:         "task_1",
		Title:      "Refactor service layer",
		Capability: "claude-code",
		Status:     "pending",
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
	})

	_, err := dispatcher.DispatchTask(ctx, "task_1")
	if !errors.Is(err, ErrNoMatchingRuntime) {
		t.Fatalf("expected ErrNoMatchingRuntime, got %v", err)
	}
}

func TestDispatchTaskReturnsApprovalRequired(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	hub := newFakeHub()
	dispatcher := New(store, hub)

	mustRegisterDispatcherRuntime(t, ctx, store, "rt_1", "did:key:owner-a", `[{"key":"claude-code"}]`, 0.2)
	store.PutTask(shareddb.Task{
		ID:                "task_approval",
		Title:             "Needs approval",
		Capability:        "claude-code",
		Status:            "pending",
		RequiresApproval:  true,
		PendingApprovalID: "appr_1",
		CreatedAt:         time.Now(),
		UpdatedAt:         time.Now(),
	})

	_, err := dispatcher.DispatchTask(ctx, "task_approval")
	if !errors.Is(err, ErrTaskApprovalRequired) {
		t.Fatalf("expected ErrTaskApprovalRequired, got %v", err)
	}
	if len(hub.sent) != 0 {
		t.Fatalf("expected no outbound message, got %+v", hub.sent)
	}
}

func TestDispatchTaskReturnsNotDispatchableForCancelledTask(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	hub := newFakeHub()
	dispatcher := New(store, hub)

	mustRegisterDispatcherRuntime(t, ctx, store, "rt_1", "did:key:owner-a", `[{"key":"claude-code"}]`, 0.2)
	store.PutTask(shareddb.Task{
		ID:         "task_cancelled",
		Title:      "Cancelled",
		Capability: "claude-code",
		Status:     "cancelled",
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
	})

	_, err := dispatcher.DispatchTask(ctx, "task_cancelled")
	if !errors.Is(err, ErrTaskNotDispatchable) {
		t.Fatalf("expected ErrTaskNotDispatchable, got %v", err)
	}
	if len(hub.sent) != 0 {
		t.Fatalf("expected no outbound message, got %+v", hub.sent)
	}
}

func TestDispatchPendingForCapabilitySkipsUnmatchedTasks(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	hub := newFakeHub()
	dispatcher := New(store, hub)

	mustRegisterDispatcherRuntime(t, ctx, store, "rt_1", "did:key:owner-a", `[{"key":"claude-code"}]`, 0.2)
	store.PutTask(shareddb.Task{
		ID:         "task_1",
		Title:      "A",
		Capability: "claude-code",
		Status:     "pending",
		CreatedAt:  time.Now().Add(-time.Minute),
		UpdatedAt:  time.Now().Add(-time.Minute),
	})
	store.PutTask(shareddb.Task{
		ID:         "task_2",
		Title:      "B",
		Capability: "other-capability",
		Status:     "pending",
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
	})

	results, err := dispatcher.DispatchPendingForCapability(ctx, "claude-code")
	if err != nil {
		t.Fatalf("DispatchPendingForCapability() error = %v", err)
	}
	if len(results) != 1 || results[0].RuntimeID != "rt_1" {
		t.Fatalf("unexpected results: %+v", results)
	}
}

func TestDispatchTaskUsesRetryAttemptAndTimeout(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	hub := newFakeHub()
	dispatcher := New(store, hub)

	mustRegisterDispatcherRuntime(t, ctx, store, "rt_1", "did:key:owner-a", `[{"key":"claude-code"}]`, 0.2)
	store.PutTask(shareddb.Task{
		ID:         "task_retry",
		Title:      "Retry task",
		Capability: "claude-code",
		Input:      `{"prompt":"retry"}`,
		Status:     "pending",
		RetryCount: 2,
		TimeoutMs:  45000,
		NextRunAt:  timePtr(time.Now().Add(-time.Second)),
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
	})

	result, err := dispatcher.DispatchTask(ctx, "task_retry")
	if err != nil {
		t.Fatalf("DispatchTask() error = %v", err)
	}

	exec, ok := store.LookupTaskExecution(result.ExecutionID)
	if !ok {
		t.Fatalf("expected execution %s", result.ExecutionID)
	}
	if exec.Attempt != 3 {
		t.Fatalf("expected attempt 3, got %d", exec.Attempt)
	}

	task, ok := store.LookupTask("task_retry")
	if !ok || task.NextRunAt != nil {
		t.Fatalf("expected claimed task to clear next run, got %+v", task)
	}

	var envelope proto.Envelope
	if err := json.Unmarshal(hub.sent["rt_1"][0], &envelope); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	var payload proto.TaskPushPayload
	if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if payload.TimeoutMs != 45000 {
		t.Fatalf("expected timeout 45000, got %d", payload.TimeoutMs)
	}
}

func TestDispatchPendingForCapabilitySkipsDelayedRetry(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	hub := newFakeHub()
	dispatcher := New(store, hub)

	mustRegisterDispatcherRuntime(t, ctx, store, "rt_1", "did:key:owner-a", `[{"key":"claude-code"}]`, 0.2)
	store.PutTask(shareddb.Task{
		ID:         "task_later",
		Title:      "Later",
		Capability: "claude-code",
		Status:     "pending",
		NextRunAt:  timePtr(time.Now().Add(time.Minute)),
		CreatedAt:  time.Now().Add(-time.Minute),
		UpdatedAt:  time.Now().Add(-time.Minute),
	})

	results, err := dispatcher.DispatchPendingForCapability(ctx, "claude-code")
	if err != nil {
		t.Fatalf("DispatchPendingForCapability() error = %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("expected delayed retry to be skipped, got %+v", results)
	}
}

func mustRegisterDispatcherRuntime(t *testing.T, ctx context.Context, store *shareddb.MemoryStore, runtimeID, ownerDid, capabilities string, load float64) {
	t.Helper()
	_, err := store.RegisterRuntime(ctx, shareddb.RegisterRuntimeParams{
		ID:           runtimeID,
		OwnerDid:     ownerDid,
		Type:         "local",
		Did:          "did:key:" + runtimeID,
		PublicKey:    "pub",
		Capabilities: capabilities,
		Status:       "online",
		Load:         load,
	})
	if err != nil {
		t.Fatalf("RegisterRuntime(%s) error = %v", runtimeID, err)
	}
}

func timePtr(value time.Time) *time.Time {
	return &value
}
