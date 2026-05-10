//go:build sqlite_mattn

package db

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestSQLStoreSQLiteRuntimeLifecycle(t *testing.T) {
	ctx := context.Background()
	store, rawDB := mustOpenSQLiteStore(t, ctx)
	defer rawDB.Close()

	runtime, err := store.RegisterRuntime(ctx, RegisterRuntimeParams{
		ID:           "rt_1",
		OwnerDid:     "did:key:owner",
		Type:         "daemon",
		Did:          "did:key:rt_1",
		PublicKey:    "pub",
		Hostname:     "host",
		OS:           "linux",
		Arch:         "amd64",
		Version:      "0.1.0",
		Endpoint:     "127.0.0.1:9000",
		Capabilities: `[]`,
		Status:       "online",
		Load:         0.2,
	})
	if err != nil {
		t.Fatalf("RegisterRuntime() error = %v", err)
	}
	if runtime.ID != "rt_1" || runtime.Status != "online" {
		t.Fatalf("unexpected runtime: %+v", runtime)
	}

	if err := store.SetRuntimeCapabilities(ctx, "rt_1", `[{"key":"claude-code"}]`); err != nil {
		t.Fatalf("SetRuntimeCapabilities() error = %v", err)
	}
	if err := store.HeartbeatRuntime(ctx, HeartbeatRuntimeParams{
		RuntimeID: "rt_1",
		Status:    "busy",
		Load:      0.7,
	}); err != nil {
		t.Fatalf("HeartbeatRuntime() error = %v", err)
	}

	runtimes, err := store.ListOnlineRuntimes(ctx)
	if err != nil {
		t.Fatalf("ListOnlineRuntimes() error = %v", err)
	}
	if len(runtimes) != 1 || runtimes[0].Capabilities == `[]` || runtimes[0].Load != 0.7 {
		t.Fatalf("unexpected runtimes: %+v", runtimes)
	}

	session, err := store.StartDaemonSession(ctx, StartDaemonSessionParams{
		ID:         "sess_1",
		RuntimeID:  "rt_1",
		Version:    "0.1.0",
		RemoteAddr: "127.0.0.1:9000",
		UserAgent:  "daemon-test",
	})
	if err != nil {
		t.Fatalf("StartDaemonSession() error = %v", err)
	}
	if session.RuntimeID != "rt_1" {
		t.Fatalf("unexpected session: %+v", session)
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

	online, err := store.ListOnlineRuntimes(ctx)
	if err != nil {
		t.Fatalf("ListOnlineRuntimes() second call error = %v", err)
	}
	if len(online) != 0 {
		t.Fatalf("expected no online runtimes, got %+v", online)
	}
}

func TestSQLStoreSQLiteTaskExecutionAndRetryLifecycle(t *testing.T) {
	ctx := context.Background()
	store, rawDB := mustOpenSQLiteStore(t, ctx)
	defer rawDB.Close()

	mustRegisterSQLiteRuntime(t, ctx, store, "rt_1")
	mustInsertSQLiteTask(t, ctx, store, sqliteTaskSeed{
		ID:           "task_due",
		Title:        "due",
		Capability:   "claude-code",
		Status:       "pending",
		CreatorID:    "user_1",
		TimeoutMs:    45000,
		MaxRetries:   2,
		RetryDelayMs: 500,
	})
	mustInsertSQLiteTask(t, ctx, store, sqliteTaskSeed{
		ID:           "task_later",
		Title:        "later",
		Capability:   "claude-code",
		Status:       "pending",
		CreatorID:    "user_1",
		MaxRetries:   2,
		RetryDelayMs: 500,
		NextRunAt:    timePtr(time.Now().Add(time.Hour)),
	})

	pending, err := store.ListPendingTasksForCapability(ctx, "claude-code")
	if err != nil {
		t.Fatalf("ListPendingTasksForCapability() error = %v", err)
	}
	if len(pending) != 1 || pending[0].ID != "task_due" {
		t.Fatalf("unexpected pending tasks: %+v", pending)
	}

	nextRunAt := time.Now().Add(2 * time.Minute)
	if err := store.SetTaskRetryState(ctx, SetTaskRetryStateParams{
		TaskID:     "task_due",
		Status:     "pending",
		RetryCount: 1,
		NextRunAt:  &nextRunAt,
	}); err != nil {
		t.Fatalf("SetTaskRetryState() error = %v", err)
	}

	pending, err = store.ListPendingTasksForCapability(ctx, "claude-code")
	if err != nil {
		t.Fatalf("ListPendingTasksForCapability() after retry error = %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("expected no due pending tasks, got %+v", pending)
	}

	past := time.Now().Add(-time.Second)
	if err := store.SetTaskRetryState(ctx, SetTaskRetryStateParams{
		TaskID:     "task_due",
		Status:     "pending",
		RetryCount: 1,
		NextRunAt:  &past,
	}); err != nil {
		t.Fatalf("SetTaskRetryState() second error = %v", err)
	}

	task, err := store.ClaimTask(ctx, ClaimTaskParams{
		TaskID:       "task_due",
		AssigneeDid:  "did:key:agent",
		AssigneeType: "AGENT",
		RuntimeID:    "rt_1",
		Status:       "assigned",
	})
	if err != nil {
		t.Fatalf("ClaimTask() error = %v", err)
	}
	if task.RuntimeID != "rt_1" || task.NextRunAt != nil {
		t.Fatalf("unexpected claimed task: %+v", task)
	}

	execRow, err := store.InsertTaskExecution(ctx, InsertTaskExecutionParams{
		ID:             "exec_1",
		TaskID:         "task_due",
		RuntimeID:      "rt_1",
		Attempt:        2,
		Status:         "dispatched",
		CapabilityUsed: "claude-code",
	})
	if err != nil {
		t.Fatalf("InsertTaskExecution() error = %v", err)
	}
	if execRow.Attempt != 2 {
		t.Fatalf("unexpected execution: %+v", execRow)
	}

	acceptedAt := time.Now()
	if err := store.SetTaskExecutionStatus(ctx, SetTaskExecutionStatusParams{
		ExecutionID:    "exec_1",
		Status:         "running",
		AcceptedAt:     &acceptedAt,
		CapabilityUsed: "claude-code",
		CLIPath:        "/usr/local/bin/claude",
		CLIVersion:     "1.2.3",
	}); err != nil {
		t.Fatalf("SetTaskExecutionStatus() error = %v", err)
	}

	logRow, err := store.InsertTaskLog(ctx, InsertTaskLogParams{
		ID:       "log_1",
		TaskID:   "task_due",
		Action:   "log.stdout",
		Message:  "hello",
		Metadata: `{"stream":"stdout"}`,
	})
	if err != nil {
		t.Fatalf("InsertTaskLog() error = %v", err)
	}
	if logRow.ID != "log_1" {
		t.Fatalf("unexpected log row: %+v", logRow)
	}

	exitCode := int64(0)
	durationMs := int64(1200)
	if err := store.CompleteTaskExecution(ctx, CompleteTaskExecutionParams{
		ExecutionID: "exec_1",
		Status:      "succeeded",
		ExitCode:    &exitCode,
		DurationMs:  &durationMs,
		ResultRef:   "prismer://result",
	}); err != nil {
		t.Fatalf("CompleteTaskExecution() error = %v", err)
	}

	execRow, err = store.GetTaskExecution(ctx, "exec_1")
	if err != nil {
		t.Fatalf("GetTaskExecution() error = %v", err)
	}
	if execRow.Status != "succeeded" || execRow.ResultRef != "prismer://result" {
		t.Fatalf("unexpected completed execution: %+v", execRow)
	}
}

func TestSQLStoreSQLiteApprovalLifecycle(t *testing.T) {
	ctx := context.Background()
	store, rawDB := mustOpenSQLiteStore(t, ctx)
	defer rawDB.Close()

	mustInsertSQLiteTask(t, ctx, store, sqliteTaskSeed{
		ID:         "task_approval",
		Title:      "approval",
		Capability: "claude-code",
		Status:     "pending",
		CreatorID:  "user_1",
	})

	approval, err := store.CreateTaskApproval(ctx, CreateTaskApprovalParams{
		ID:               "appr_1",
		TaskID:           "task_approval",
		Kind:             "dangerous_action",
		Action:           "git_push_force",
		Payload:          `{"ref":"main"}`,
		RequestedByDid:   "did:key:req",
		ApproverDid:      "did:key:approver",
		ApproverIMUserID: "im_1",
		RequestSignature: "sig",
		Metadata:         `{"source":"test"}`,
	})
	if err != nil {
		t.Fatalf("CreateTaskApproval() error = %v", err)
	}
	if approval.Status != "pending" {
		t.Fatalf("unexpected approval: %+v", approval)
	}
	task, err := store.GetTask(ctx, "task_approval")
	if err != nil {
		t.Fatalf("GetTask() after CreateTaskApproval error = %v", err)
	}
	if !task.RequiresApproval || task.PendingApprovalID != "appr_1" {
		t.Fatalf("expected task approval gate to be set, got %+v", task)
	}

	pending, err := store.GetPendingApproval(ctx, "appr_1")
	if err != nil {
		t.Fatalf("GetPendingApproval() error = %v", err)
	}
	if pending.Action != "git_push_force" {
		t.Fatalf("unexpected pending approval: %+v", pending)
	}

	if err := store.DecideTaskApproval(ctx, DecideTaskApprovalParams{
		ApprovalID:        "appr_1",
		Status:            "approved",
		DecisionReason:    "ok",
		DecisionSignature: "sig2",
		DelegationProof:   "proof",
	}); err != nil {
		t.Fatalf("DecideTaskApproval() error = %v", err)
	}

	if _, err := store.GetPendingApproval(ctx, "appr_1"); !errors.Is(err, ErrApprovalNotFound) {
		t.Fatalf("expected ErrApprovalNotFound after approval, got %v", err)
	}
	task, err = store.GetTask(ctx, "task_approval")
	if err != nil {
		t.Fatalf("GetTask() after DecideTaskApproval error = %v", err)
	}
	if task.RequiresApproval || task.PendingApprovalID != "" {
		t.Fatalf("expected task approval gate to be cleared, got %+v", task)
	}
	logRow, ok := fetchSQLiteTaskLogByID(t, ctx, rawDB, "log_appr_1_approval_approved")
	if !ok || logRow.Action != "approval.approved" {
		t.Fatalf("expected approval approved log, got %+v ok=%v", logRow, ok)
	}
}

func TestSQLStoreSQLiteRejectedApprovalCancelsTask(t *testing.T) {
	ctx := context.Background()
	store, rawDB := mustOpenSQLiteStore(t, ctx)
	defer rawDB.Close()

	mustInsertSQLiteTask(t, ctx, store, sqliteTaskSeed{
		ID:         "task_reject",
		Title:      "reject",
		Capability: "claude-code",
		Status:     "pending",
		CreatorID:  "user_1",
	})

	if _, err := store.CreateTaskApproval(ctx, CreateTaskApprovalParams{
		ID:               "appr_reject",
		TaskID:           "task_reject",
		Kind:             "dangerous_action",
		Action:           "deploy",
		Payload:          `{}`,
		RequestedByDid:   "did:key:req",
		RequestSignature: "sig",
		Metadata:         `{}`,
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

	task, err := store.GetTask(ctx, "task_reject")
	if err != nil {
		t.Fatalf("GetTask() error = %v", err)
	}
	if task.Status != "cancelled" || task.RequiresApproval || task.PendingApprovalID != "" {
		t.Fatalf("expected rejected approval to cancel task, got %+v", task)
	}
	logRow, ok := fetchSQLiteTaskLogByID(t, ctx, rawDB, "log_appr_reject_approval_rejected")
	if !ok || logRow.Action != "approval.rejected" {
		t.Fatalf("expected approval rejected log, got %+v ok=%v", logRow, ok)
	}
}

func TestSQLStoreSQLiteDuplicateApprovalDecisionIsIdempotentAndConflictingDecisionFails(t *testing.T) {
	ctx := context.Background()
	store, rawDB := mustOpenSQLiteStore(t, ctx)
	defer rawDB.Close()

	mustInsertSQLiteTask(t, ctx, store, sqliteTaskSeed{
		ID:         "task_dup",
		Title:      "dup",
		Capability: "claude-code",
		Status:     "pending",
		CreatorID:  "user_1",
	})

	if _, err := store.CreateTaskApproval(ctx, CreateTaskApprovalParams{
		ID:               "appr_dup",
		TaskID:           "task_dup",
		Kind:             "dangerous_action",
		Action:           "deploy",
		Payload:          `{}`,
		RequestedByDid:   "did:key:req",
		RequestSignature: "sig",
		Metadata:         `{}`,
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

func TestSQLStoreSQLiteSigningKeyLifecycle(t *testing.T) {
	ctx := context.Background()
	store, rawDB := mustOpenSQLiteStore(t, ctx)
	defer rawDB.Close()

	expiresAt := time.Now().Add(time.Hour)
	key, err := store.CreateSigningKey(ctx, CreateSigningKeyParams{
		ID:         "key_1",
		DID:        "did:key:runtime1",
		KeyVersion: 3,
		PublicKey:  "pub",
		Algorithm:  "ed25519",
		KeyID:      "did:key:runtime1#k3",
		ExpiresAt:  &expiresAt,
		Metadata:   `{"source":"test"}`,
	})
	if err != nil {
		t.Fatalf("CreateSigningKey() error = %v", err)
	}
	if key.KeyVersion != 3 || key.ExpiresAt == nil {
		t.Fatalf("unexpected signing key: %+v", key)
	}

	loaded, err := store.GetSigningKeyByKeyID(ctx, "did:key:runtime1#k3")
	if err != nil {
		t.Fatalf("GetSigningKeyByKeyID() error = %v", err)
	}
	if loaded.DID != "did:key:runtime1" || loaded.Metadata != `{"source":"test"}` {
		t.Fatalf("unexpected loaded signing key: %+v", loaded)
	}
}

func TestSQLStoreSQLiteStreamCursorLifecycle(t *testing.T) {
	ctx := context.Background()
	store, rawDB := mustOpenSQLiteStore(t, ctx)
	defer rawDB.Close()

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
	if err := store.UpsertStreamCursor(ctx, UpsertStreamCursorParams{
		ExecutionID:      "exec_1",
		StreamID:         "stderr",
		LastCommittedSeq: 5,
	}); err != nil {
		t.Fatalf("UpsertStreamCursor() stderr error = %v", err)
	}

	cursors, err := store.GetStreamCursors(ctx, "exec_1", []string{"stdout", "stderr", "progress"})
	if err != nil {
		t.Fatalf("GetStreamCursors() error = %v", err)
	}
	if len(cursors) != 2 {
		t.Fatalf("unexpected stream cursors: %+v", cursors)
	}
}

func TestSQLStoreSQLiteApplyStatefulMessageIsTransactional(t *testing.T) {
	ctx := context.Background()
	store, rawDB := mustOpenSQLiteStore(t, ctx)
	defer rawDB.Close()

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
		MessageID:    "msg_conflict",
		MessageType:  "task.finished",
		PayloadHash:  "hash_2",
	}, nil)
	if !errors.Is(err, ErrStatefulMessageConflict) {
		t.Fatalf("expected ErrStatefulMessageConflict, got %v", err)
	}

	_, err = store.ApplyStatefulMessage(ctx, StatefulMessageParams{
		ExecutionID:  "exec_1",
		StateVersion: 3,
		MessageID:    "msg_3",
		MessageType:  "task.finished",
		PayloadHash:  "hash_3",
	}, func(context.Context, Store) error {
		return errors.New("boom")
	})
	if err == nil || err.Error() != "boom" {
		t.Fatalf("expected mutation error, got %v", err)
	}
	result, err = store.ApplyStatefulMessage(ctx, StatefulMessageParams{
		ExecutionID:  "exec_1",
		StateVersion: 3,
		MessageID:    "msg_3_retry",
		MessageType:  "task.finished",
		PayloadHash:  "hash_3",
	}, nil)
	if err != nil {
		t.Fatalf("expected failed mutation to roll back dedup row, got %v", err)
	}
	if result.Status != StatefulMessageAccepted {
		t.Fatalf("expected state=3 retry to be accepted, got %+v", result)
	}
}

type sqliteTaskSeed struct {
	ID           string
	Title        string
	Capability   string
	Status       string
	CreatorID    string
	TimeoutMs    int64
	MaxRetries   int64
	RetryDelayMs int64
	NextRunAt    *time.Time
}

func mustOpenSQLiteStore(t *testing.T, ctx context.Context) (*SQLStore, *sql.DB) {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "phase_a.db") + "?_foreign_keys=on"
	store, rawDB, err := OpenSQLStore(ctx, "sqlite3", dsn)
	if err != nil {
		t.Fatalf("OpenSQLStore() error = %v", err)
	}
	if err := store.ApplyPhaseASchema(ctx); err != nil {
		t.Fatalf("ApplyPhaseASchema() error = %v", err)
	}
	return store, rawDB
}

func mustRegisterSQLiteRuntime(t *testing.T, ctx context.Context, store *SQLStore, runtimeID string) {
	t.Helper()
	if _, err := store.RegisterRuntime(ctx, RegisterRuntimeParams{
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

func mustInsertSQLiteTask(t *testing.T, ctx context.Context, store *SQLStore, seed sqliteTaskSeed) {
	t.Helper()
	timeoutMs := seed.TimeoutMs
	if timeoutMs == 0 {
		timeoutMs = 300000
	}
	retryDelayMs := seed.RetryDelayMs
	if retryDelayMs == 0 {
		retryDelayMs = 60000
	}
	_, err := store.CreateTask(ctx, CreateTaskParams{
		ID:           seed.ID,
		Title:        seed.Title,
		Capability:   seed.Capability,
		Input:        `{}`,
		CreatorID:    seed.CreatorID,
		Status:       seed.Status,
		TimeoutMs:    timeoutMs,
		MaxRetries:   seed.MaxRetries,
		RetryDelayMs: retryDelayMs,
		NextRunAt:    seed.NextRunAt,
	})
	if err != nil {
		t.Fatalf("CreateTask(%s) error = %v", seed.ID, err)
	}
}

func timePtr(value time.Time) *time.Time {
	return &value
}

func fetchSQLiteTaskLogByID(t *testing.T, ctx context.Context, rawDB *sql.DB, logID string) (TaskLog, bool) {
	t.Helper()
	row := rawDB.QueryRowContext(ctx, `
		SELECT id, task_id, actor_id, action, message, metadata, created_at
		FROM im_task_logs
		WHERE id = ?
	`, logID)
	logRow, err := scanTaskLog(row)
	if errors.Is(err, sql.ErrNoRows) {
		return TaskLog{}, false
	}
	if err != nil {
		t.Fatalf("scanTaskLog(%s) error = %v", logID, err)
	}
	return logRow, true
}
