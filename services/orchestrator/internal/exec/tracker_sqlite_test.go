//go:build sqlite_mattn

package exec

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
)

func TestTrackerSQLiteHandleFinishedReplayIsIdempotent(t *testing.T) {
	ctx := context.Background()
	store, rawDB := mustOpenExecSQLiteStore(t, ctx)
	defer rawDB.Close()

	mustRegisterExecSQLiteRuntime(t, ctx, store, "rt_1")
	mustCreateExecSQLiteTask(t, ctx, store, execSQLiteTaskSeed{
		ID:           "task_retry",
		Title:        "retry",
		Capability:   "claude-code",
		Status:       "running",
		CreatorID:    "user_1",
		MaxRetries:   2,
		RetryDelayMs: 500,
		RuntimeID:    "rt_1",
	})
	if _, err := store.InsertTaskExecution(ctx, shareddb.InsertTaskExecutionParams{
		ID:        "exec_retry",
		TaskID:    "task_retry",
		RuntimeID: "rt_1",
		Attempt:   1,
		Status:    "running",
	}); err != nil {
		t.Fatalf("InsertTaskExecution() error = %v", err)
	}

	payload, _ := json.Marshal(proto.TaskFinishedPayload{
		ExecutionID: "exec_retry",
		ExitCode:    1,
		DurationMs:  1200,
	})
	envelope := proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           "msg_sqlite_finished_replay",
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

	task, err := store.GetTask(ctx, "task_retry")
	if err != nil {
		t.Fatalf("GetTask() error = %v", err)
	}
	if task.Status != "pending" || task.RetryCount != 1 || task.NextRunAt == nil {
		t.Fatalf("unexpected task after replay: %+v", task)
	}
}

func TestTrackerSQLiteHandleRejectedReplayIsIdempotent(t *testing.T) {
	ctx := context.Background()
	store, rawDB := mustOpenExecSQLiteStore(t, ctx)
	defer rawDB.Close()

	mustRegisterExecSQLiteRuntime(t, ctx, store, "rt_1")
	mustCreateExecSQLiteTask(t, ctx, store, execSQLiteTaskSeed{
		ID:           "task_retry",
		Title:        "retry",
		Capability:   "claude-code",
		Status:       "assigned",
		CreatorID:    "user_1",
		MaxRetries:   2,
		RetryDelayMs: 500,
		RuntimeID:    "rt_1",
	})
	if _, err := store.InsertTaskExecution(ctx, shareddb.InsertTaskExecutionParams{
		ID:        "exec_retry",
		TaskID:    "task_retry",
		RuntimeID: "rt_1",
		Attempt:   1,
		Status:    "dispatched",
	}); err != nil {
		t.Fatalf("InsertTaskExecution() error = %v", err)
	}

	payload, _ := json.Marshal(proto.TaskRejectedPayload{
		ExecutionID: "exec_retry",
		Reason:      "busy",
		Retryable:   true,
	})
	envelope := proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           "msg_sqlite_rejected_replay",
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

	task, err := store.GetTask(ctx, "task_retry")
	if err != nil {
		t.Fatalf("GetTask() error = %v", err)
	}
	if task.Status != "pending" || task.RetryCount != 1 || task.NextRunAt == nil {
		t.Fatalf("unexpected task after replay: %+v", task)
	}
}

func TestTrackerSQLiteHandleLogChunkReplayIsIdempotent(t *testing.T) {
	ctx := context.Background()
	store, rawDB := mustOpenExecSQLiteStore(t, ctx)
	defer rawDB.Close()

	mustRegisterExecSQLiteRuntime(t, ctx, store, "rt_1")
	mustCreateExecSQLiteTask(t, ctx, store, execSQLiteTaskSeed{
		ID:         "task_logs",
		Title:      "logs",
		Capability: "claude-code",
		Status:     "running",
		CreatorID:  "user_1",
		RuntimeID:  "rt_1",
	})
	if _, err := store.InsertTaskExecution(ctx, shareddb.InsertTaskExecutionParams{
		ID:        "exec_logs",
		TaskID:    "task_logs",
		RuntimeID: "rt_1",
		Attempt:   1,
		Status:    "running",
	}); err != nil {
		t.Fatalf("InsertTaskExecution() error = %v", err)
	}

	payload, _ := json.Marshal(proto.TaskLogChunkPayload{
		ExecutionID: "exec_logs",
		Stream:      "stdout",
		Chunks: []proto.TaskLogChunk{
			{Seq: 5, Text: "hello\n", TimestampMs: time.Now().UnixMilli()},
		},
	})
	envelope := proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           "msg_sqlite_log_replay",
		ExecutionID:  "exec_logs",
		Type:         "task.log_chunk",
		MessageClass: proto.MessageClassStream,
		TimestampMs:  time.Now().UnixMilli(),
		StreamID:     "stdout",
		StreamSeq:    5,
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

	cursors, err := store.GetStreamCursors(ctx, "exec_logs", []string{"stdout"})
	if err != nil {
		t.Fatalf("GetStreamCursors() error = %v", err)
	}
	if len(cursors) != 1 || cursors[0].LastCommittedSeq != 5 {
		t.Fatalf("unexpected cursors after replay: %+v", cursors)
	}
}

type execSQLiteTaskSeed struct {
	ID           string
	Title        string
	Capability   string
	Status       string
	CreatorID    string
	MaxRetries   int64
	RetryDelayMs int64
	RuntimeID    string
}

func mustOpenExecSQLiteStore(t *testing.T, ctx context.Context) (*shareddb.SQLStore, *sql.DB) {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "tracker.db") + "?_foreign_keys=on"
	store, rawDB, err := shareddb.OpenSQLStore(ctx, "sqlite3", dsn)
	if err != nil {
		t.Fatalf("OpenSQLStore() error = %v", err)
	}
	if err := store.ApplyPhaseASchema(ctx); err != nil {
		t.Fatalf("ApplyPhaseASchema() error = %v", err)
	}
	return store, rawDB
}

func mustRegisterExecSQLiteRuntime(t *testing.T, ctx context.Context, store *shareddb.SQLStore, runtimeID string) {
	t.Helper()
	if _, err := store.RegisterRuntime(ctx, shareddb.RegisterRuntimeParams{
		ID:           runtimeID,
		OwnerDid:     "did:key:owner",
		Type:         "daemon",
		Did:          "did:key:" + runtimeID,
		PublicKey:    "pub",
		Capabilities: `[]`,
		Status:       "online",
		Load:         0.1,
	}); err != nil {
		t.Fatalf("RegisterRuntime(%s) error = %v", runtimeID, err)
	}
}

func mustCreateExecSQLiteTask(t *testing.T, ctx context.Context, store *shareddb.SQLStore, seed execSQLiteTaskSeed) {
	t.Helper()
	if _, err := store.CreateTask(ctx, shareddb.CreateTaskParams{
		ID:           seed.ID,
		Title:        seed.Title,
		Capability:   seed.Capability,
		Input:        `{}`,
		CreatorID:    seed.CreatorID,
		Status:       seed.Status,
		TimeoutMs:    300000,
		MaxRetries:   seed.MaxRetries,
		RetryDelayMs: seed.RetryDelayMs,
	}); err != nil {
		t.Fatalf("CreateTask(%s) error = %v", seed.ID, err)
	}
	if seed.RuntimeID != "" {
		if err := store.SetTaskStatus(ctx, shareddb.SetTaskStatusParams{
			TaskID:    seed.ID,
			Status:    seed.Status,
			RuntimeID: seed.RuntimeID,
		}); err != nil {
			t.Fatalf("SetTaskStatus(%s) error = %v", seed.ID, err)
		}
	}
}
