package db

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestMemoryStoreRuntimeLifecycle(t *testing.T) {
	store := NewMemoryStore()
	ctx := context.Background()

	runtime, err := store.RegisterRuntime(ctx, RegisterRuntimeParams{
		ID:           "rt_1",
		OwnerDid:     "did:key:owner",
		Type:         "local",
		Did:          "did:key:runtime1",
		PublicKey:    "pub",
		Capabilities: "[]",
		Status:       "online",
		Load:         0.2,
	})
	if err != nil {
		t.Fatalf("RegisterRuntime() error = %v", err)
	}
	if runtime.ID != "rt_1" {
		t.Fatalf("unexpected runtime id: %s", runtime.ID)
	}

	if err := store.HeartbeatRuntime(ctx, HeartbeatRuntimeParams{
		RuntimeID: "rt_1",
		Status:    "busy",
		Load:      0.9,
	}); err != nil {
		t.Fatalf("HeartbeatRuntime() error = %v", err)
	}

	runtimes, err := store.ListOnlineRuntimes(ctx)
	if err != nil {
		t.Fatalf("ListOnlineRuntimes() error = %v", err)
	}
	if len(runtimes) != 1 || runtimes[0].Status != "busy" {
		t.Fatalf("unexpected runtimes: %+v", runtimes)
	}

	session, err := store.StartDaemonSession(ctx, StartDaemonSessionParams{
		ID:        "sess_1",
		RuntimeID: "rt_1",
		Version:   "0.1.0",
	})
	if err != nil {
		t.Fatalf("StartDaemonSession() error = %v", err)
	}
	if session.RuntimeID != "rt_1" {
		t.Fatalf("unexpected session runtime id: %s", session.RuntimeID)
	}

	if err := store.TerminateDaemonSession(ctx, "sess_1", "graceful"); err != nil {
		t.Fatalf("TerminateDaemonSession() error = %v", err)
	}

	if err := store.SetRuntimeStatus(ctx, SetRuntimeStatusParams{
		RuntimeID: "rt_1",
		Status:    "offline",
	}); err != nil {
		t.Fatalf("SetRuntimeStatus() error = %v", err)
	}

	runtime, ok := store.GetRuntime("rt_1")
	if !ok || runtime.Status != "offline" {
		t.Fatalf("expected offline runtime, got %+v, ok=%v", runtime, ok)
	}
}

func TestMemoryStoreTaskExecutionAndLogs(t *testing.T) {
	store := NewMemoryStore()
	ctx := context.Background()
	store.PutTask(Task{
		ID:         "task_1",
		Title:      "test",
		Capability: "claude-code",
		Status:     "pending",
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
	})
	if _, err := store.RegisterRuntime(ctx, RegisterRuntimeParams{
		ID:           "rt_1",
		OwnerDid:     "did:key:owner",
		Type:         "local",
		Did:          "did:key:runtime1",
		PublicKey:    "pub",
		Capabilities: "[]",
		Status:       "online",
	}); err != nil {
		t.Fatalf("RegisterRuntime() error = %v", err)
	}

	task, err := store.ClaimTask(ctx, ClaimTaskParams{
		TaskID:       "task_1",
		AssigneeDid:  "did:key:agent1",
		AssigneeType: "AGENT",
		RuntimeID:    "rt_1",
		Status:       "assigned",
	})
	if err != nil {
		t.Fatalf("ClaimTask() error = %v", err)
	}
	if task.AssigneeDid != "did:key:agent1" {
		t.Fatalf("unexpected task assignee did: %s", task.AssigneeDid)
	}

	exec, err := store.InsertTaskExecution(ctx, InsertTaskExecutionParams{
		ID:             "exec_1",
		TaskID:         "task_1",
		RuntimeID:      "rt_1",
		Attempt:        1,
		Status:         "running",
		CapabilityUsed: "claude-code",
	})
	if err != nil {
		t.Fatalf("InsertTaskExecution() error = %v", err)
	}
	if exec.Status != "running" {
		t.Fatalf("unexpected execution status: %s", exec.Status)
	}

	exitCode := int64(0)
	durationMs := int64(1200)
	if err := store.CompleteTaskExecution(ctx, CompleteTaskExecutionParams{
		ExecutionID: "exec_1",
		Status:      "succeeded",
		ExitCode:    &exitCode,
		DurationMs:  &durationMs,
	}); err != nil {
		t.Fatalf("CompleteTaskExecution() error = %v", err)
	}

	log, err := store.InsertTaskLog(ctx, InsertTaskLogParams{
		ID:       "log_1",
		TaskID:   "task_1",
		Action:   "completed",
		Message:  "done",
		Metadata: "{}",
	})
	if err != nil {
		t.Fatalf("InsertTaskLog() error = %v", err)
	}
	if log.Action != "completed" {
		t.Fatalf("unexpected log action: %s", log.Action)
	}
}

func TestMemoryStoreApprovalLifecycle(t *testing.T) {
	store := NewMemoryStore()
	ctx := context.Background()
	store.PutTask(Task{
		ID:        "task_1",
		Title:     "test",
		Status:    "pending",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	})

	approval, err := store.CreateTaskApproval(ctx, CreateTaskApprovalParams{
		ID:               "appr_1",
		TaskID:           "task_1",
		Kind:             "dangerous_action",
		Action:           "git_push_force",
		Payload:          "{}",
		RequestedByDid:   "did:key:req",
		RequestSignature: "sig",
		Metadata:         "{}",
	})
	if err != nil {
		t.Fatalf("CreateTaskApproval() error = %v", err)
	}
	if approval.Status != "pending" {
		t.Fatalf("unexpected approval status: %s", approval.Status)
	}
	task, _ := store.LookupTask("task_1")
	if !task.RequiresApproval || task.PendingApprovalID != "appr_1" {
		t.Fatalf("expected task to require approval, got %+v", task)
	}

	if _, err := store.GetPendingApproval(ctx, "appr_1"); err != nil {
		t.Fatalf("GetPendingApproval() error = %v", err)
	}

	if err := store.DecideTaskApproval(ctx, DecideTaskApprovalParams{
		ApprovalID:        "appr_1",
		Status:            "approved",
		DecisionReason:    "ok",
		DecisionSignature: "sig2",
	}); err != nil {
		t.Fatalf("DecideTaskApproval() error = %v", err)
	}

	if _, err := store.GetPendingApproval(ctx, "appr_1"); err == nil {
		t.Fatalf("expected approval to no longer be pending")
	}
	task, _ = store.LookupTask("task_1")
	if task.RequiresApproval || task.PendingApprovalID != "" {
		t.Fatalf("expected task approval gate to be cleared, got %+v", task)
	}
	if log, ok := store.GetTaskLog("log_appr_1_approval_approved"); !ok || log.Action != "approval.approved" {
		t.Fatalf("expected approval approved log, got %+v ok=%v", log, ok)
	}
}

func TestMemoryStoreRejectedApprovalCancelsTask(t *testing.T) {
	store := NewMemoryStore()
	ctx := context.Background()
	store.PutTask(Task{
		ID:        "task_1",
		Title:     "test",
		Status:    "pending",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	})

	if _, err := store.CreateTaskApproval(ctx, CreateTaskApprovalParams{
		ID:               "appr_reject",
		TaskID:           "task_1",
		Kind:             "dangerous_action",
		Action:           "deploy",
		Payload:          "{}",
		RequestedByDid:   "did:key:req",
		RequestSignature: "sig",
		Metadata:         "{}",
	}); err != nil {
		t.Fatalf("CreateTaskApproval() error = %v", err)
	}

	if err := store.DecideTaskApproval(ctx, DecideTaskApprovalParams{
		ApprovalID:     "appr_reject",
		Status:         "rejected",
		DecisionReason: "denied",
	}); err != nil {
		t.Fatalf("DecideTaskApproval() error = %v", err)
	}

	task, _ := store.LookupTask("task_1")
	if task.Status != "cancelled" || task.RequiresApproval || task.PendingApprovalID != "" {
		t.Fatalf("expected rejected approval to cancel task, got %+v", task)
	}
	if log, ok := store.GetTaskLog("log_appr_reject_approval_rejected"); !ok || log.Action != "approval.rejected" {
		t.Fatalf("expected approval rejected log, got %+v ok=%v", log, ok)
	}
}

func TestMemoryStoreDuplicateApprovalDecisionIsIdempotentAndConflictingDecisionFails(t *testing.T) {
	store := NewMemoryStore()
	ctx := context.Background()
	store.PutTask(Task{
		ID:        "task_1",
		Title:     "test",
		Status:    "pending",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	})

	if _, err := store.CreateTaskApproval(ctx, CreateTaskApprovalParams{
		ID:               "appr_dup",
		TaskID:           "task_1",
		Kind:             "dangerous_action",
		Action:           "deploy",
		Payload:          "{}",
		RequestedByDid:   "did:key:req",
		RequestSignature: "sig",
		Metadata:         "{}",
	}); err != nil {
		t.Fatalf("CreateTaskApproval() error = %v", err)
	}

	if err := store.DecideTaskApproval(ctx, DecideTaskApprovalParams{
		ApprovalID:     "appr_dup",
		Status:         "approved",
		DecisionReason: "ok",
	}); err != nil {
		t.Fatalf("first DecideTaskApproval() error = %v", err)
	}
	if err := store.DecideTaskApproval(ctx, DecideTaskApprovalParams{
		ApprovalID:     "appr_dup",
		Status:         "approved",
		DecisionReason: "ok",
	}); err != nil {
		t.Fatalf("idempotent DecideTaskApproval() error = %v", err)
	}
	if err := store.DecideTaskApproval(ctx, DecideTaskApprovalParams{
		ApprovalID:     "appr_dup",
		Status:         "rejected",
		DecisionReason: "nope",
	}); !errors.Is(err, ErrApprovalAlreadyDecided) {
		t.Fatalf("expected ErrApprovalAlreadyDecided, got %v", err)
	}
}

func TestMemoryStoreSigningKeyLifecycle(t *testing.T) {
	store := NewMemoryStore()
	ctx := context.Background()

	key, err := store.CreateSigningKey(ctx, CreateSigningKeyParams{
		ID:        "key_1",
		DID:       "did:key:runtime1",
		PublicKey: "pub",
		KeyID:     "did:key:runtime1#k1",
	})
	if err != nil {
		t.Fatalf("CreateSigningKey() error = %v", err)
	}
	if key.Algorithm != "ed25519" || key.KeyVersion != 1 {
		t.Fatalf("unexpected signing key: %+v", key)
	}

	loaded, err := store.GetSigningKeyByKeyID(ctx, "did:key:runtime1#k1")
	if err != nil {
		t.Fatalf("GetSigningKeyByKeyID() error = %v", err)
	}
	if loaded.DID != "did:key:runtime1" {
		t.Fatalf("unexpected loaded signing key: %+v", loaded)
	}
}

func TestMemoryStoreStreamCursorLifecycle(t *testing.T) {
	store := NewMemoryStore()
	ctx := context.Background()

	if err := store.UpsertStreamCursor(ctx, UpsertStreamCursorParams{
		ExecutionID:      "exec_1",
		StreamID:         "stdout",
		LastCommittedSeq: 2,
	}); err != nil {
		t.Fatalf("UpsertStreamCursor() error = %v", err)
	}
	if err := store.UpsertStreamCursor(ctx, UpsertStreamCursorParams{
		ExecutionID:      "exec_1",
		StreamID:         "stdout",
		LastCommittedSeq: 1,
	}); err != nil {
		t.Fatalf("UpsertStreamCursor() second error = %v", err)
	}

	cursors, err := store.GetStreamCursors(ctx, "exec_1", []string{"stdout", "stderr"})
	if err != nil {
		t.Fatalf("GetStreamCursors() error = %v", err)
	}
	if len(cursors) != 1 || cursors[0].LastCommittedSeq != 2 {
		t.Fatalf("unexpected stream cursors: %+v", cursors)
	}
}

func TestMemoryStoreApplyStatefulMessageDedupsAndRejectsConflicts(t *testing.T) {
	store := NewMemoryStore()
	ctx := context.Background()
	calls := 0

	result, err := store.ApplyStatefulMessage(ctx, StatefulMessageParams{
		ExecutionID:  "exec_1",
		StateVersion: 1,
		MessageID:    "msg_1",
		MessageType:  "task.accepted",
		PayloadHash:  "hash_1",
	}, func(context.Context, Store) error {
		calls++
		return nil
	})
	if err != nil {
		t.Fatalf("ApplyStatefulMessage() error = %v", err)
	}
	if result.Status != StatefulMessageAccepted || calls != 1 {
		t.Fatalf("expected accepted once, result=%+v calls=%d", result, calls)
	}

	result, err = store.ApplyStatefulMessage(ctx, StatefulMessageParams{
		ExecutionID:  "exec_1",
		StateVersion: 1,
		MessageID:    "msg_1_retry",
		MessageType:  "task.accepted",
		PayloadHash:  "hash_1",
	}, func(context.Context, Store) error {
		calls++
		return nil
	})
	if err != nil {
		t.Fatalf("duplicate ApplyStatefulMessage() error = %v", err)
	}
	if result.Status != StatefulMessageDuplicate || calls != 1 {
		t.Fatalf("expected duplicate without mutation, result=%+v calls=%d", result, calls)
	}

	_, err = store.ApplyStatefulMessage(ctx, StatefulMessageParams{
		ExecutionID:  "exec_1",
		StateVersion: 1,
		MessageID:    "msg_1_conflict",
		MessageType:  "task.finished",
		PayloadHash:  "hash_2",
	}, nil)
	if !errors.Is(err, ErrStatefulMessageConflict) {
		t.Fatalf("expected ErrStatefulMessageConflict, got %v", err)
	}

	if _, err := store.ApplyStatefulMessage(ctx, StatefulMessageParams{
		ExecutionID:  "exec_1",
		StateVersion: 3,
		MessageID:    "msg_3",
		MessageType:  "task.finished",
		PayloadHash:  "hash_3",
	}, nil); err != nil {
		t.Fatalf("ApplyStatefulMessage(state=3) error = %v", err)
	}
	_, err = store.ApplyStatefulMessage(ctx, StatefulMessageParams{
		ExecutionID:  "exec_1",
		StateVersion: 2,
		MessageID:    "msg_2_stale",
		MessageType:  "task.rejected",
		PayloadHash:  "hash_2_stale",
	}, nil)
	if !errors.Is(err, ErrStatefulMessageStale) {
		t.Fatalf("expected ErrStatefulMessageStale, got %v", err)
	}

	_, err = store.ApplyStatefulMessage(ctx, StatefulMessageParams{
		ExecutionID:  "exec_1",
		StateVersion: 0,
		MessageID:    "msg_invalid",
		MessageType:  "task.accepted",
		PayloadHash:  "hash_0",
	}, nil)
	if err == nil {
		t.Fatal("expected invalid state version error")
	}
}
