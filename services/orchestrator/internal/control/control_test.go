package control

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
)

type fakeHub struct {
	runtimeID string
	message   []byte
}

func (h *fakeHub) Send(_ context.Context, runtimeID string, message []byte) error {
	h.runtimeID = runtimeID
	h.message = append([]byte(nil), message...)
	return nil
}

func TestCancelExecution(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	store.PutTask(shareddb.Task{
		ID:        "task_1",
		Title:     "test",
		Status:    "running",
		RuntimeID: "rt_1",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	})
	_, _ = store.RegisterRuntime(ctx, shareddb.RegisterRuntimeParams{
		ID:           "rt_1",
		OwnerDid:     "did:key:owner",
		Type:         "local",
		Did:          "did:key:rt_1",
		PublicKey:    "pub",
		Capabilities: "[]",
		Status:       "online",
	})
	_, _ = store.InsertTaskExecution(ctx, shareddb.InsertTaskExecutionParams{
		ID:        "exec_1",
		TaskID:    "task_1",
		RuntimeID: "rt_1",
		Attempt:   1,
		Status:    "running",
	})

	hub := &fakeHub{}
	controller := New(store, hub)
	if err := controller.CancelExecution(ctx, "exec_1", "user requested"); err != nil {
		t.Fatalf("CancelExecution() error = %v", err)
	}

	if hub.runtimeID != "rt_1" {
		t.Fatalf("expected cancel sent to rt_1, got %s", hub.runtimeID)
	}

	var envelope proto.Envelope
	if err := json.Unmarshal(hub.message, &envelope); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	if envelope.Type != "task.cancel" {
		t.Fatalf("unexpected envelope type: %s", envelope.Type)
	}

	task, _ := store.LookupTask("task_1")
	if task.Status != "cancelled" {
		t.Fatalf("expected cancelled task, got %+v", task)
	}
	execRow, _ := store.LookupTaskExecution("exec_1")
	if execRow.Status != "cancelled" {
		t.Fatalf("expected cancelled execution, got %+v", execRow)
	}
	if _, ok := store.GetTaskLog("log_exec_1_cancel"); !ok {
		t.Fatalf("expected cancel log")
	}
}

func TestCancelExecutionIgnoresSucceededExecution(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	store.PutTask(shareddb.Task{
		ID:        "task_1",
		Title:     "test",
		Status:    "completed",
		RuntimeID: "rt_1",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	})
	_, _ = store.RegisterRuntime(ctx, shareddb.RegisterRuntimeParams{
		ID:           "rt_1",
		OwnerDid:     "did:key:owner",
		Type:         "local",
		Did:          "did:key:rt_1",
		PublicKey:    "pub",
		Capabilities: "[]",
		Status:       "online",
	})
	completedAt := time.Now().Add(-time.Minute)
	_, _ = store.InsertTaskExecution(ctx, shareddb.InsertTaskExecutionParams{
		ID:        "exec_1",
		TaskID:    "task_1",
		RuntimeID: "rt_1",
		Attempt:   1,
		Status:    "running",
	})
	_ = store.SetTaskExecutionStatus(ctx, shareddb.SetTaskExecutionStatusParams{
		ExecutionID: "exec_1",
		Status:      "succeeded",
		CompletedAt: &completedAt,
	})

	hub := &fakeHub{}
	controller := New(store, hub)
	if err := controller.CancelExecution(ctx, "exec_1", "too late"); err != nil {
		t.Fatalf("CancelExecution() error = %v", err)
	}

	if hub.message != nil {
		t.Fatalf("did not expect cancel to be sent for succeeded execution")
	}

	task, _ := store.LookupTask("task_1")
	if task.Status != "completed" {
		t.Fatalf("expected completed task to stay completed, got %+v", task)
	}
	execRow, _ := store.LookupTaskExecution("exec_1")
	if execRow.Status != "succeeded" || execRow.CompletedAt == nil {
		t.Fatalf("expected succeeded execution to stay succeeded, got %+v", execRow)
	}
	if _, ok := store.GetTaskLog("log_exec_1_cancel"); ok {
		t.Fatalf("did not expect cancel log for succeeded execution")
	}
}

func TestCancelExecutionIgnoresAlreadyCancelledExecution(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	store.PutTask(shareddb.Task{
		ID:        "task_1",
		Title:     "test",
		Status:    "cancelled",
		RuntimeID: "rt_1",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	})
	_, _ = store.RegisterRuntime(ctx, shareddb.RegisterRuntimeParams{
		ID:           "rt_1",
		OwnerDid:     "did:key:owner",
		Type:         "local",
		Did:          "did:key:rt_1",
		PublicKey:    "pub",
		Capabilities: "[]",
		Status:       "online",
	})
	completedAt := time.Now().Add(-time.Minute)
	_, _ = store.InsertTaskExecution(ctx, shareddb.InsertTaskExecutionParams{
		ID:        "exec_1",
		TaskID:    "task_1",
		RuntimeID: "rt_1",
		Attempt:   1,
		Status:    "running",
	})
	_ = store.SetTaskExecutionStatus(ctx, shareddb.SetTaskExecutionStatusParams{
		ExecutionID: "exec_1",
		Status:      "cancelled",
		CompletedAt: &completedAt,
	})

	hub := &fakeHub{}
	controller := New(store, hub)
	if err := controller.CancelExecution(ctx, "exec_1", "duplicate cancel"); err != nil {
		t.Fatalf("CancelExecution() error = %v", err)
	}

	if hub.message != nil {
		t.Fatalf("did not expect cancel to be resent for cancelled execution")
	}

	task, _ := store.LookupTask("task_1")
	if task.Status != "cancelled" {
		t.Fatalf("expected cancelled task to stay cancelled, got %+v", task)
	}
	execRow, _ := store.LookupTaskExecution("exec_1")
	if execRow.Status != "cancelled" || execRow.CompletedAt == nil {
		t.Fatalf("expected cancelled execution to stay cancelled, got %+v", execRow)
	}
	if _, ok := store.GetTaskLog("log_exec_1_cancel"); ok {
		t.Fatalf("did not expect duplicate cancel log")
	}
}
