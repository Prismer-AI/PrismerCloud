package exec

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
)

func TestTrackerHandleAccepted(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	store.PutTask(shareddb.Task{
		ID:        "task_1",
		Title:     "test",
		Status:    "assigned",
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
		Status:    "dispatched",
	})

	payload, _ := json.Marshal(proto.TaskAcceptedPayload{
		ExecutionID:    "exec_1",
		CapabilityUsed: "claude-code",
		CLIPath:        "/usr/local/bin/claude",
		CLIVersion:     "1.2.3",
	})
	tracker := NewTracker(store)
	err := tracker.HandleAccepted(ctx, proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           "msg_1",
		ExecutionID:  "exec_1",
		Type:         "task.accepted",
		MessageClass: proto.MessageClassStateful,
		TimestampMs:  time.Now().UnixMilli(),
		StateVersion: 1,
		PayloadHash:  "hash",
		AckType:      proto.AckTypeRequired,
		Payload:      payload,
	})
	if err != nil {
		t.Fatalf("HandleAccepted() error = %v", err)
	}

	task, _ := store.LookupTask("task_1")
	if task.Status != "running" {
		t.Fatalf("expected task to be running, got %s", task.Status)
	}
	execRow, _ := store.LookupTaskExecution("exec_1")
	if execRow.Status != "running" || execRow.AcceptedAt == nil {
		t.Fatalf("unexpected execution state: %+v", execRow)
	}
}

func TestTrackerHandleAcceptedIgnoresReplayAfterTerminalState(t *testing.T) {
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
	acceptedAt := time.Now().Add(-2 * time.Minute)
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
		AcceptedAt:  &acceptedAt,
		CompletedAt: &completedAt,
	})

	payload, _ := json.Marshal(proto.TaskAcceptedPayload{
		ExecutionID:    "exec_1",
		CapabilityUsed: "claude-code",
		CLIPath:        "/usr/local/bin/claude",
		CLIVersion:     "1.2.3",
	})
	tracker := NewTracker(store)
	err := tracker.HandleAccepted(ctx, proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           "msg_accepted_replay",
		ExecutionID:  "exec_1",
		Type:         "task.accepted",
		MessageClass: proto.MessageClassStateful,
		TimestampMs:  time.Now().UnixMilli(),
		StateVersion: 3,
		PayloadHash:  "hash",
		AckType:      proto.AckTypeRequired,
		Payload:      payload,
	})
	if err != nil {
		t.Fatalf("HandleAccepted() replay error = %v", err)
	}

	task, _ := store.LookupTask("task_1")
	if task.Status != "completed" {
		t.Fatalf("expected task to stay completed, got %s", task.Status)
	}
	execRow, _ := store.LookupTaskExecution("exec_1")
	if execRow.Status != "succeeded" || execRow.CompletedAt == nil {
		t.Fatalf("expected execution to stay succeeded, got %+v", execRow)
	}
}

func TestTrackerHandleFinished(t *testing.T) {
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

	payload, _ := json.Marshal(proto.TaskFinishedPayload{
		ExecutionID: "exec_1",
		ExitCode:    0,
		ResultURI:   "prismer://result",
		DurationMs:  1200,
	})
	tracker := NewTracker(store)
	err := tracker.HandleFinished(ctx, proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           "msg_2",
		ExecutionID:  "exec_1",
		Type:         "task.finished",
		MessageClass: proto.MessageClassStateful,
		TimestampMs:  time.Now().UnixMilli(),
		StateVersion: 2,
		PayloadHash:  "hash",
		AckType:      proto.AckTypeRequired,
		Payload:      payload,
	})
	if err != nil {
		t.Fatalf("HandleFinished() error = %v", err)
	}

	task, _ := store.LookupTask("task_1")
	if task.Status != "completed" {
		t.Fatalf("expected task completed, got %s", task.Status)
	}
	execRow, _ := store.LookupTaskExecution("exec_1")
	if execRow.Status != "succeeded" || execRow.CompletedAt == nil || execRow.ResultRef != "prismer://result" {
		t.Fatalf("unexpected execution state: %+v", execRow)
	}
}

func TestTrackerHandleFinishedSchedulesRetryForFailure(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	store.PutTask(shareddb.Task{
		ID:           "task_retry",
		Title:        "test",
		Status:       "running",
		RuntimeID:    "rt_1",
		MaxRetries:   2,
		RetryDelayMs: 500,
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
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
		ID:        "exec_retry",
		TaskID:    "task_retry",
		RuntimeID: "rt_1",
		Attempt:   1,
		Status:    "running",
	})

	payload, _ := json.Marshal(proto.TaskFinishedPayload{
		ExecutionID: "exec_retry",
		ExitCode:    1,
		DurationMs:  1200,
	})
	tracker := NewTracker(store)
	err := tracker.HandleFinished(ctx, proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           "msg_fail",
		ExecutionID:  "exec_retry",
		Type:         "task.finished",
		MessageClass: proto.MessageClassStateful,
		TimestampMs:  time.Now().UnixMilli(),
		StateVersion: 2,
		PayloadHash:  "hash",
		AckType:      proto.AckTypeRequired,
		Payload:      payload,
	})
	if err != nil {
		t.Fatalf("HandleFinished() error = %v", err)
	}

	task, _ := store.LookupTask("task_retry")
	if task.Status != "pending" || task.RetryCount != 1 || task.NextRunAt == nil {
		t.Fatalf("expected task to be rescheduled, got %+v", task)
	}
	execRow, _ := store.LookupTaskExecution("exec_retry")
	if execRow.Status != "failed" || execRow.CompletedAt == nil {
		t.Fatalf("unexpected execution state: %+v", execRow)
	}
	if _, ok := store.GetTaskLog("log_exec_retry_retry_1"); !ok {
		t.Fatalf("expected retry scheduling log")
	}
}

func TestTrackerHandleFinishedIgnoresReplayAfterFailureRetryScheduled(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	store.PutTask(shareddb.Task{
		ID:           "task_retry",
		Title:        "test",
		Status:       "running",
		RuntimeID:    "rt_1",
		MaxRetries:   2,
		RetryDelayMs: 500,
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
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
		ID:        "exec_retry",
		TaskID:    "task_retry",
		RuntimeID: "rt_1",
		Attempt:   1,
		Status:    "running",
	})

	payload, _ := json.Marshal(proto.TaskFinishedPayload{
		ExecutionID: "exec_retry",
		ExitCode:    1,
		DurationMs:  1200,
	})
	envelope := proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           "msg_fail_replay",
		ExecutionID:  "exec_retry",
		Type:         "task.finished",
		MessageClass: proto.MessageClassStateful,
		TimestampMs:  time.Now().UnixMilli(),
		StateVersion: 2,
		PayloadHash:  "hash",
		AckType:      proto.AckTypeRequired,
		Payload:      payload,
	}
	tracker := NewTracker(store)
	if err := tracker.HandleFinished(ctx, envelope); err != nil {
		t.Fatalf("HandleFinished() first error = %v", err)
	}
	if err := tracker.HandleFinished(ctx, envelope); err != nil {
		t.Fatalf("HandleFinished() replay error = %v", err)
	}

	task, _ := store.LookupTask("task_retry")
	if task.Status != "pending" || task.RetryCount != 1 || task.NextRunAt == nil {
		t.Fatalf("expected single retry schedule, got %+v", task)
	}
	execRow, _ := store.LookupTaskExecution("exec_retry")
	if execRow.Status != "failed" {
		t.Fatalf("expected execution failed, got %+v", execRow)
	}
	if _, ok := store.GetTaskLog("log_exec_retry_retry_1"); !ok {
		t.Fatalf("expected retry scheduling log")
	}
	if _, ok := store.GetTaskLog("log_exec_retry_retry_2"); ok {
		t.Fatalf("did not expect second retry scheduling log")
	}
}

func TestTrackerHandleRejected(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	store.PutTask(shareddb.Task{
		ID:        "task_1",
		Title:     "test",
		Status:    "assigned",
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
		Status:    "dispatched",
	})

	payload, _ := json.Marshal(proto.TaskRejectedPayload{
		ExecutionID: "exec_1",
		Reason:      "busy",
		Retryable:   false,
	})
	tracker := NewTracker(store)
	err := tracker.HandleRejected(ctx, proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           "msg_rej",
		ExecutionID:  "exec_1",
		Type:         "task.rejected",
		MessageClass: proto.MessageClassStateful,
		TimestampMs:  time.Now().UnixMilli(),
		StateVersion: 2,
		PayloadHash:  "hash",
		AckType:      proto.AckTypeRequired,
		Payload:      payload,
	})
	if err != nil {
		t.Fatalf("HandleRejected() error = %v", err)
	}

	task, _ := store.LookupTask("task_1")
	if task.Status != "cancelled" {
		t.Fatalf("expected cancelled task, got %s", task.Status)
	}
	execRow, _ := store.LookupTaskExecution("exec_1")
	if execRow.Status != "cancelled" || execRow.CompletedAt == nil {
		t.Fatalf("unexpected execution state: %+v", execRow)
	}
	if _, ok := store.GetTaskLog("log_exec_1_rejected"); !ok {
		t.Fatalf("expected rejection log")
	}
}

func TestTrackerHandleRejectedSchedulesRetry(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	store.PutTask(shareddb.Task{
		ID:           "task_retry",
		Title:        "test",
		Status:       "assigned",
		RuntimeID:    "rt_1",
		MaxRetries:   2,
		RetryDelayMs: 500,
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
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
		ID:        "exec_retry",
		TaskID:    "task_retry",
		RuntimeID: "rt_1",
		Attempt:   1,
		Status:    "dispatched",
	})

	payload, _ := json.Marshal(proto.TaskRejectedPayload{
		ExecutionID: "exec_retry",
		Reason:      "busy",
		Retryable:   true,
	})
	tracker := NewTracker(store)
	err := tracker.HandleRejected(ctx, proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           "msg_rej_retry",
		ExecutionID:  "exec_retry",
		Type:         "task.rejected",
		MessageClass: proto.MessageClassStateful,
		TimestampMs:  time.Now().UnixMilli(),
		StateVersion: 2,
		PayloadHash:  "hash",
		AckType:      proto.AckTypeRequired,
		Payload:      payload,
	})
	if err != nil {
		t.Fatalf("HandleRejected() error = %v", err)
	}

	task, _ := store.LookupTask("task_retry")
	if task.Status != "pending" || task.RetryCount != 1 || task.NextRunAt == nil {
		t.Fatalf("expected retry scheduling, got %+v", task)
	}
	execRow, _ := store.LookupTaskExecution("exec_retry")
	if execRow.Status != "cancelled" || execRow.CompletedAt == nil {
		t.Fatalf("unexpected execution state: %+v", execRow)
	}
	if _, ok := store.GetTaskLog("log_exec_retry_retry_1"); !ok {
		t.Fatalf("expected retry scheduling log")
	}
}

func TestTrackerHandleRejectedIgnoresReplayAfterRetryScheduled(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	store.PutTask(shareddb.Task{
		ID:           "task_retry",
		Title:        "test",
		Status:       "assigned",
		RuntimeID:    "rt_1",
		MaxRetries:   2,
		RetryDelayMs: 500,
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
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
		ID:        "exec_retry",
		TaskID:    "task_retry",
		RuntimeID: "rt_1",
		Attempt:   1,
		Status:    "dispatched",
	})

	payload, _ := json.Marshal(proto.TaskRejectedPayload{
		ExecutionID: "exec_retry",
		Reason:      "busy",
		Retryable:   true,
	})
	envelope := proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           "msg_rej_retry_replay",
		ExecutionID:  "exec_retry",
		Type:         "task.rejected",
		MessageClass: proto.MessageClassStateful,
		TimestampMs:  time.Now().UnixMilli(),
		StateVersion: 2,
		PayloadHash:  "hash",
		AckType:      proto.AckTypeRequired,
		Payload:      payload,
	}
	tracker := NewTracker(store)
	if err := tracker.HandleRejected(ctx, envelope); err != nil {
		t.Fatalf("HandleRejected() first error = %v", err)
	}
	if err := tracker.HandleRejected(ctx, envelope); err != nil {
		t.Fatalf("HandleRejected() replay error = %v", err)
	}

	task, _ := store.LookupTask("task_retry")
	if task.Status != "pending" || task.RetryCount != 1 || task.NextRunAt == nil {
		t.Fatalf("expected single retry schedule, got %+v", task)
	}
	execRow, _ := store.LookupTaskExecution("exec_retry")
	if execRow.Status != "cancelled" {
		t.Fatalf("expected execution cancelled, got %+v", execRow)
	}
	if _, ok := store.GetTaskLog("log_exec_retry_rejected"); !ok {
		t.Fatalf("expected rejection log")
	}
	if _, ok := store.GetTaskLog("log_exec_retry_retry_1"); !ok {
		t.Fatalf("expected retry scheduling log")
	}
	if _, ok := store.GetTaskLog("log_exec_retry_retry_2"); ok {
		t.Fatalf("did not expect second retry scheduling log")
	}
}

func TestTrackerHandleLogChunk(t *testing.T) {
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

	payload, _ := json.Marshal(proto.TaskLogChunkPayload{
		ExecutionID: "exec_1",
		Stream:      "stdout",
		Chunks: []proto.TaskLogChunk{
			{Seq: 1, Text: "hello\n", TimestampMs: time.Now().UnixMilli()},
			{Seq: 2, Text: "world\n", TimestampMs: time.Now().UnixMilli()},
		},
	})
	tracker := NewTracker(store)
	err := tracker.HandleLogChunk(ctx, proto.Envelope{
		V:              proto.ProtocolVersionV2,
		ID:             "msg_3",
		ExecutionID:    "exec_1",
		Type:           "task.log_chunk",
		MessageClass:   proto.MessageClassStream,
		TimestampMs:    time.Now().UnixMilli(),
		StreamID:       "stdout",
		StreamSeq:      1,
		AckType:        proto.AckTypeBestEffort,
		IdempotencyKey: "idem_1",
		Payload:        payload,
	})
	if err != nil {
		t.Fatalf("HandleLogChunk() error = %v", err)
	}

	if _, ok := store.GetTaskLog("log_exec_1_stdout_1"); !ok {
		t.Fatalf("expected first log to exist")
	}
	if _, ok := store.GetTaskLog("log_exec_1_stdout_2"); !ok {
		t.Fatalf("expected second log to exist")
	}
	cursor, ok := store.GetStreamCursorForTest("exec_1", "stdout")
	if !ok || cursor.LastCommittedSeq != 2 {
		t.Fatalf("expected stream cursor seq=2, got %+v ok=%v", cursor, ok)
	}
}

func TestTrackerHandleLogChunkIgnoresReplay(t *testing.T) {
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

	payload, _ := json.Marshal(proto.TaskLogChunkPayload{
		ExecutionID: "exec_1",
		Stream:      "stdout",
		Chunks: []proto.TaskLogChunk{
			{Seq: 2, Text: "hello\n", TimestampMs: time.Now().UnixMilli()},
		},
	})
	envelope := proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           "msg_log_replay",
		ExecutionID:  "exec_1",
		Type:         "task.log_chunk",
		MessageClass: proto.MessageClassStream,
		TimestampMs:  time.Now().UnixMilli(),
		StreamID:     "stdout",
		StreamSeq:    2,
		AckType:      proto.AckTypeBestEffort,
		Payload:      payload,
	}

	tracker := NewTracker(store)
	if err := tracker.HandleLogChunk(ctx, envelope); err != nil {
		t.Fatalf("HandleLogChunk() first error = %v", err)
	}
	if err := tracker.HandleLogChunk(ctx, envelope); err != nil {
		t.Fatalf("HandleLogChunk() replay error = %v", err)
	}

	if logRow, ok := store.GetTaskLog("log_exec_1_stdout_2"); !ok || logRow.Message != "hello\n" {
		t.Fatalf("expected replayed log row to remain stable, got %+v ok=%v", logRow, ok)
	}
	cursor, ok := store.GetStreamCursorForTest("exec_1", "stdout")
	if !ok || cursor.LastCommittedSeq != 2 {
		t.Fatalf("expected stream cursor seq=2 after replay, got %+v ok=%v", cursor, ok)
	}
}

func TestTrackerHandleLogChunkIgnoresDuplicateLogError(t *testing.T) {
	ctx := context.Background()
	store := &duplicateLogStore{MemoryStore: shareddb.NewMemoryStore()}
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

	payload, _ := json.Marshal(proto.TaskLogChunkPayload{
		ExecutionID: "exec_1",
		Stream:      "stdout",
		Chunks: []proto.TaskLogChunk{
			{Seq: 3, Text: "dup\n", TimestampMs: time.Now().UnixMilli()},
		},
	})
	tracker := NewTracker(store)
	err := tracker.HandleLogChunk(ctx, proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           "msg_log_dup",
		ExecutionID:  "exec_1",
		Type:         "task.log_chunk",
		MessageClass: proto.MessageClassStream,
		TimestampMs:  time.Now().UnixMilli(),
		StreamID:     "stdout",
		StreamSeq:    3,
		AckType:      proto.AckTypeBestEffort,
		Payload:      payload,
	})
	if err != nil {
		t.Fatalf("HandleLogChunk() error = %v", err)
	}

	cursor, ok := store.GetStreamCursorForTest("exec_1", "stdout")
	if !ok || cursor.LastCommittedSeq != 3 {
		t.Fatalf("expected stream cursor seq=3 after duplicate log, got %+v ok=%v", cursor, ok)
	}
}

type duplicateLogStore struct {
	*shareddb.MemoryStore
}

func (s *duplicateLogStore) InsertTaskLog(ctx context.Context, params shareddb.InsertTaskLogParams) (shareddb.TaskLog, error) {
	if params.ID == "log_exec_1_stdout_3" {
		return shareddb.TaskLog{}, shareddb.ErrTaskLogExists
	}
	return s.MemoryStore.InsertTaskLog(ctx, params)
}

var _ shareddb.Store = (*duplicateLogStore)(nil)
