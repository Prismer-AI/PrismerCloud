package db

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrSQLDBNotConfigured = errors.New("sql db not configured")

//go:embed schema/phase_a.sql
var schemaFS embed.FS

type SQLStore struct {
	db     *sql.DB
	runner sqlRunner
}

func NewSQLStore(db *sql.DB) *SQLStore {
	return &SQLStore{db: db, runner: db}
}

type sqlRunner interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

func (s *SQLStore) ApplyPhaseASchema(ctx context.Context) error {
	if s.db == nil {
		return ErrSQLDBNotConfigured
	}
	schemaSQL, err := schemaFS.ReadFile("schema/phase_a.sql")
	if err != nil {
		return fmt.Errorf("read phase_a.sql: %w", err)
	}
	_, err = s.db.ExecContext(ctx, string(schemaSQL))
	return err
}

func (s *SQLStore) RegisterRuntime(ctx context.Context, params RegisterRuntimeParams) (Runtime, error) {
	row := s.queryRow(ctx, `
		INSERT INTO im_runtimes (
			id, owner_did, owner_im_user_id, type, did, public_key, hostname, os, arch, version,
			endpoint, capabilities, status, load, last_heartbeat_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(did) DO UPDATE SET
			id = excluded.id,
			owner_did = excluded.owner_did,
			owner_im_user_id = excluded.owner_im_user_id,
			type = excluded.type,
			public_key = excluded.public_key,
			hostname = excluded.hostname,
			os = excluded.os,
			arch = excluded.arch,
			version = excluded.version,
			endpoint = excluded.endpoint,
			capabilities = excluded.capabilities,
			status = excluded.status,
			load = excluded.load,
			last_heartbeat_at = CURRENT_TIMESTAMP,
			updated_at = CURRENT_TIMESTAMP
		RETURNING
			id, owner_did, owner_im_user_id, type, did, public_key, hostname, os, arch, version,
			endpoint, capabilities, status, load, last_heartbeat_at, registered_at, updated_at
	`, params.ID, params.OwnerDid, nullableString(params.OwnerIMUserID), params.Type, params.Did, params.PublicKey,
		nullableString(params.Hostname), nullableString(params.OS), nullableString(params.Arch), nullableString(params.Version),
		nullableString(params.Endpoint), params.Capabilities, params.Status, params.Load)
	return scanRuntime(row)
}

func (s *SQLStore) HeartbeatRuntime(ctx context.Context, params HeartbeatRuntimeParams) error {
	result, err := s.exec(ctx, `
		UPDATE im_runtimes
		SET status = ?, load = ?, last_heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, params.Status, params.Load, params.RuntimeID)
	if err != nil {
		return err
	}
	return mapRowsAffected(result, ErrRuntimeNotFound)
}

func (s *SQLStore) SetRuntimeStatus(ctx context.Context, params SetRuntimeStatusParams) error {
	result, err := s.exec(ctx, `
		UPDATE im_runtimes
		SET status = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, params.Status, params.RuntimeID)
	if err != nil {
		return err
	}
	return mapRowsAffected(result, ErrRuntimeNotFound)
}

func (s *SQLStore) SetRuntimeCapabilities(ctx context.Context, runtimeID string, capabilities string) error {
	result, err := s.exec(ctx, `
		UPDATE im_runtimes
		SET capabilities = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, capabilities, runtimeID)
	if err != nil {
		return err
	}
	return mapRowsAffected(result, ErrRuntimeNotFound)
}

func (s *SQLStore) ListOnlineRuntimes(ctx context.Context) ([]Runtime, error) {
	rows, err := s.query(ctx, `
		SELECT
			id, owner_did, owner_im_user_id, type, did, public_key, hostname, os, arch, version,
			endpoint, capabilities, status, load, last_heartbeat_at, registered_at, updated_at
		FROM im_runtimes
		WHERE status IN ('online', 'idle', 'busy')
		ORDER BY load ASC, last_heartbeat_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var runtimes []Runtime
	for rows.Next() {
		runtime, err := scanRuntime(rows)
		if err != nil {
			return nil, err
		}
		runtimes = append(runtimes, runtime)
	}
	return runtimes, rows.Err()
}

func (s *SQLStore) StartDaemonSession(ctx context.Context, params StartDaemonSessionParams) (DaemonSession, error) {
	row := s.queryRow(ctx, `
		INSERT INTO im_daemon_sessions (id, runtime_id, version, pid, remote_addr, user_agent)
		VALUES (?, ?, ?, ?, ?, ?)
		RETURNING
			id, runtime_id, started_at, terminated_at, termination_reason, version, pid, remote_addr, user_agent,
			task_count, log_bytes
	`, params.ID, params.RuntimeID, params.Version, nullableInt64Ptr(params.PID), nullableString(params.RemoteAddr), nullableString(params.UserAgent))
	return scanDaemonSession(row)
}

func (s *SQLStore) TerminateDaemonSession(ctx context.Context, sessionID string, terminationReason string) error {
	result, err := s.exec(ctx, `
		UPDATE im_daemon_sessions
		SET terminated_at = CURRENT_TIMESTAMP, termination_reason = ?
		WHERE id = ?
	`, terminationReason, sessionID)
	if err != nil {
		return err
	}
	return mapRowsAffected(result, ErrSessionNotFound)
}

func (s *SQLStore) CreateTask(ctx context.Context, params CreateTaskParams) (Task, error) {
	row := s.queryRow(ctx, `
		INSERT INTO im_tasks (
			id, title, description, capability, input, context_uri, creator_id, creator_did, assignee_id, assignee_did,
			assignee_type, scope, conversation_id, status, runtime_id, requires_approval, pending_approval_id, timeout_ms,
			deadline, max_retries, retry_delay_ms, retry_count, next_run_at, metadata
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING
			id, title, description, capability, input, context_uri, creator_id, creator_did, assignee_id, assignee_did,
			assignee_type, scope, conversation_id, status, runtime_id, requires_approval, pending_approval_id, timeout_ms,
			deadline, max_retries, retry_delay_ms, retry_count, next_run_at, metadata, created_at, updated_at
	`, params.ID, params.Title, nullableString(params.Description), nullableString(params.Capability),
		defaultSQLString(params.Input, `{}`), nullableString(params.ContextURI), params.CreatorID, nullableString(params.CreatorDid),
		nullableString(params.AssigneeID), nullableString(params.AssigneeDid), nullableString(params.AssigneeType),
		defaultSQLString(params.Scope, "global"), nullableString(params.ConversationID), defaultSQLString(params.Status, "pending"),
		params.RequiresApproval, nullableString(params.PendingApprovalID), defaultSQLInt64(params.TimeoutMs, 300000),
		nullableTimePtr(params.Deadline), params.MaxRetries, defaultSQLInt64(params.RetryDelayMs, 60000),
		params.RetryCount, nullableTimePtr(params.NextRunAt), defaultSQLString(params.Metadata, `{}`))
	return scanTask(row)
}

func (s *SQLStore) GetTask(ctx context.Context, taskID string) (Task, error) {
	row := s.queryRow(ctx, selectTaskSQL(`WHERE id = ?`), taskID)
	task, err := scanTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, ErrTaskNotFound
	}
	return task, err
}

func (s *SQLStore) SetTaskStatus(ctx context.Context, params SetTaskStatusParams) error {
	result, err := s.exec(ctx, `
		UPDATE im_tasks
		SET
			status = ?,
			runtime_id = CASE WHEN ? <> '' THEN ? ELSE runtime_id END,
			pending_approval_id = ?,
			next_run_at = CASE WHEN ? = 'pending' THEN next_run_at ELSE NULL END,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, params.Status, params.RuntimeID, params.RuntimeID, nullableString(params.PendingApprovalID), params.Status, params.TaskID)
	if err != nil {
		return err
	}
	return mapRowsAffected(result, ErrTaskNotFound)
}

func (s *SQLStore) SetTaskRetryState(ctx context.Context, params SetTaskRetryStateParams) error {
	result, err := s.exec(ctx, `
		UPDATE im_tasks
		SET
			status = ?,
			retry_count = ?,
			next_run_at = ?,
			runtime_id = CASE WHEN ? <> '' THEN ? ELSE runtime_id END,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, params.Status, params.RetryCount, nullableTimePtr(params.NextRunAt), params.RuntimeID, params.RuntimeID, params.TaskID)
	if err != nil {
		return err
	}
	return mapRowsAffected(result, ErrTaskNotFound)
}

func (s *SQLStore) ListPendingTasksForCapability(ctx context.Context, capability string) ([]Task, error) {
	rows, err := s.query(ctx, selectTaskSQL(`
		WHERE capability = ?
		  AND status = 'pending'
		  AND (next_run_at IS NULL OR next_run_at <= CURRENT_TIMESTAMP)
		ORDER BY created_at ASC
	`), capability)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tasks []Task
	for rows.Next() {
		task, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	return tasks, rows.Err()
}

func (s *SQLStore) ClaimTask(ctx context.Context, params ClaimTaskParams) (Task, error) {
	row := s.queryRow(ctx, `
		UPDATE im_tasks
		SET
			assignee_id = ?,
			assignee_did = ?,
			assignee_type = ?,
			runtime_id = ?,
			status = ?,
			next_run_at = NULL,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
		RETURNING
			id, title, description, capability, input, context_uri, creator_id, creator_did, assignee_id, assignee_did,
			assignee_type, scope, conversation_id, status, runtime_id, requires_approval, pending_approval_id, timeout_ms,
			deadline, max_retries, retry_delay_ms, retry_count, next_run_at, metadata, created_at, updated_at
	`, nullableString(params.AssigneeID), nullableString(params.AssigneeDid), nullableString(params.AssigneeType), nullableString(params.RuntimeID), params.Status, params.TaskID)
	task, err := scanTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, ErrTaskNotFound
	}
	return task, err
}

func (s *SQLStore) GetTaskExecution(ctx context.Context, executionID string) (TaskExecution, error) {
	row := s.queryRow(ctx, selectTaskExecutionSQL(`WHERE id = ?`), executionID)
	execRow, err := scanTaskExecution(row)
	if errors.Is(err, sql.ErrNoRows) {
		return TaskExecution{}, ErrTaskNotFound
	}
	return execRow, err
}

func (s *SQLStore) InsertTaskExecution(ctx context.Context, params InsertTaskExecutionParams) (TaskExecution, error) {
	row := s.queryRow(ctx, `
		INSERT INTO im_task_executions (
			id, task_id, runtime_id, attempt, status, capability_used, cli_path, cli_version
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING
			id, task_id, runtime_id, attempt, status, started_at, accepted_at, completed_at, exit_code, duration_ms,
			capability_used, cli_path, cli_version, logs_ref, result_ref, cpu_seconds, memory_bytes
	`, params.ID, params.TaskID, params.RuntimeID, params.Attempt, params.Status, nullableString(params.CapabilityUsed), nullableString(params.CLIPath), nullableString(params.CLIVersion))
	execRow, err := scanTaskExecution(row)
	if errors.Is(err, sql.ErrNoRows) {
		return TaskExecution{}, ErrTaskNotFound
	}
	return execRow, err
}

func (s *SQLStore) SetTaskExecutionStatus(ctx context.Context, params SetTaskExecutionStatusParams) error {
	result, err := s.exec(ctx, `
		UPDATE im_task_executions
		SET
			status = ?,
			accepted_at = COALESCE(?, accepted_at),
			completed_at = COALESCE(?, completed_at),
			exit_code = COALESCE(?, exit_code),
			duration_ms = COALESCE(?, duration_ms),
			capability_used = COALESCE(?, capability_used),
			cli_path = COALESCE(?, cli_path),
			cli_version = COALESCE(?, cli_version),
			logs_ref = COALESCE(?, logs_ref),
			result_ref = COALESCE(?, result_ref),
			cpu_seconds = COALESCE(?, cpu_seconds),
			memory_bytes = COALESCE(?, memory_bytes)
		WHERE id = ?
	`, params.Status, nullableTimePtr(params.AcceptedAt), nullableTimePtr(params.CompletedAt), nullableInt64Ptr(params.ExitCode),
		nullableInt64Ptr(params.DurationMs), nullableString(params.CapabilityUsed), nullableString(params.CLIPath),
		nullableString(params.CLIVersion), nullableString(params.LogsRef), nullableString(params.ResultRef),
		nullableFloat64Ptr(params.CPUSeconds), nullableInt64Ptr(params.MemoryBytes), params.ExecutionID)
	if err != nil {
		return err
	}
	return mapRowsAffected(result, ErrTaskNotFound)
}

func (s *SQLStore) CompleteTaskExecution(ctx context.Context, params CompleteTaskExecutionParams) error {
	result, err := s.exec(ctx, `
		UPDATE im_task_executions
		SET
			status = ?,
			accepted_at = COALESCE(?, accepted_at),
			completed_at = COALESCE(?, CURRENT_TIMESTAMP),
			exit_code = ?,
			duration_ms = ?,
			logs_ref = ?,
			result_ref = ?,
			cpu_seconds = ?,
			memory_bytes = ?
		WHERE id = ?
	`, params.Status, nullableTimePtr(params.AcceptedAt), nullableTimePtr(params.CompletedAt), nullableInt64Ptr(params.ExitCode),
		nullableInt64Ptr(params.DurationMs), nullableString(params.LogsRef), nullableString(params.ResultRef),
		nullableFloat64Ptr(params.CPUSeconds), nullableInt64Ptr(params.MemoryBytes), params.ExecutionID)
	if err != nil {
		return err
	}
	return mapRowsAffected(result, ErrTaskNotFound)
}

func (s *SQLStore) InsertTaskLog(ctx context.Context, params InsertTaskLogParams) (TaskLog, error) {
	row := s.queryRow(ctx, `
		INSERT INTO im_task_logs (id, task_id, actor_id, action, message, metadata)
		VALUES (?, ?, ?, ?, ?, ?)
		RETURNING id, task_id, actor_id, action, message, metadata, created_at
	`, params.ID, params.TaskID, nullableString(params.ActorID), params.Action, nullableString(params.Message), params.Metadata)
	logRow, err := scanTaskLog(row)
	if isTaskLogDuplicateError(err) {
		return TaskLog{}, ErrTaskLogExists
	}
	if errors.Is(err, sql.ErrNoRows) {
		return TaskLog{}, ErrTaskNotFound
	}
	return logRow, err
}

func (s *SQLStore) CreateTaskApproval(ctx context.Context, params CreateTaskApprovalParams) (TaskApproval, error) {
	row := s.queryRow(ctx, `
		INSERT INTO im_task_approvals (
			id, task_id, kind, action, payload, requested_by_did, approver_did, approver_im_user_id,
			request_signature, expires_at, metadata
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING
			id, task_id, kind, action, payload, requested_by_did, requested_at, approver_did, approver_im_user_id,
			status, decided_at, decision_reason, request_signature, decision_signature, delegation_proof, expires_at, metadata
	`, params.ID, nullableString(params.TaskID), params.Kind, params.Action, params.Payload, params.RequestedByDid,
		nullableString(params.ApproverDid), nullableString(params.ApproverIMUserID), params.RequestSignature,
		nullableTimePtr(params.ExpiresAt), params.Metadata)
	approval, err := scanTaskApproval(row)
	if errors.Is(err, sql.ErrNoRows) {
		return TaskApproval{}, ErrTaskNotFound
	}
	if err != nil {
		return TaskApproval{}, err
	}
	if params.TaskID != "" {
		result, err := s.exec(ctx, `
			UPDATE im_tasks
			SET requires_approval = TRUE, pending_approval_id = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`, params.ID, params.TaskID)
		if err != nil {
			return TaskApproval{}, err
		}
		if err := mapRowsAffected(result, ErrTaskNotFound); err != nil {
			return TaskApproval{}, err
		}
	}
	return approval, err
}

func (s *SQLStore) GetPendingApproval(ctx context.Context, approvalID string) (TaskApproval, error) {
	row := s.queryRow(ctx, `
		SELECT
			id, task_id, kind, action, payload, requested_by_did, requested_at, approver_did, approver_im_user_id,
			status, decided_at, decision_reason, request_signature, decision_signature, delegation_proof, expires_at, metadata
		FROM im_task_approvals
		WHERE id = ? AND status = 'pending'
		LIMIT 1
	`, approvalID)
	approval, err := scanTaskApproval(row)
	if errors.Is(err, sql.ErrNoRows) {
		return TaskApproval{}, ErrApprovalNotFound
	}
	return approval, err
}

func (s *SQLStore) DecideTaskApproval(ctx context.Context, params DecideTaskApprovalParams) error {
	approval, err := s.getApprovalByID(ctx, params.ApprovalID)
	if err != nil {
		return err
	}
	if approval.Status != "pending" {
		if approval.Status == params.Status {
			return nil
		}
		return ErrApprovalAlreadyDecided
	}
	result, err := s.exec(ctx, `
		UPDATE im_task_approvals
		SET
			status = ?,
			decided_at = CURRENT_TIMESTAMP,
			decision_reason = ?,
			decision_signature = ?,
			delegation_proof = ?
		WHERE id = ? AND status = 'pending'
	`, params.Status, nullableString(params.DecisionReason), nullableString(params.DecisionSignature), nullableString(params.DelegationProof), params.ApprovalID)
	if err != nil {
		return err
	}
	if err := mapRowsAffected(result, ErrApprovalNotFound); err != nil {
		return err
	}
	if approval.TaskID == "" {
		return nil
	}
	result, err = s.exec(ctx, `
		UPDATE im_tasks
		SET
			pending_approval_id = NULL,
			requires_approval = CASE WHEN ? IN ('approved', 'rejected') THEN FALSE ELSE requires_approval END,
			status = CASE WHEN ? = 'rejected' THEN 'cancelled' ELSE status END,
			next_run_at = CASE WHEN ? = 'rejected' THEN NULL ELSE next_run_at END,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, params.Status, params.Status, params.Status, approval.TaskID)
	if err != nil {
		return err
	}
	if err := mapRowsAffected(result, ErrTaskNotFound); err != nil {
		return err
	}
	_, err = s.exec(ctx, `
		INSERT INTO im_task_logs (id, task_id, action, message, metadata)
		VALUES (?, ?, ?, ?, ?)
	`, "log_"+approval.ID+"_approval_"+params.Status, approval.TaskID, "approval."+params.Status, nullableString(params.DecisionReason), fmt.Sprintf(`{"approval_id":"%s"}`, approval.ID))
	return err
}

func (s *SQLStore) getApprovalByID(ctx context.Context, approvalID string) (TaskApproval, error) {
	row := s.queryRow(ctx, `
		SELECT
			id, task_id, kind, action, payload, requested_by_did, requested_at, approver_did, approver_im_user_id,
			status, decided_at, decision_reason, request_signature, decision_signature, delegation_proof, expires_at, metadata
		FROM im_task_approvals
		WHERE id = ?
		LIMIT 1
	`, approvalID)
	approval, err := scanTaskApproval(row)
	if errors.Is(err, sql.ErrNoRows) {
		return TaskApproval{}, ErrApprovalNotFound
	}
	return approval, err
}

func (s *SQLStore) CreateSigningKey(ctx context.Context, params CreateSigningKeyParams) (SigningKey, error) {
	row := s.queryRow(ctx, `
		INSERT INTO im_signing_keys (
			id, did, key_version, public_key, algorithm, key_id, revoked_at, expires_at, metadata
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING
			id, did, key_version, public_key, algorithm, key_id, revoked_at, expires_at, created_at, metadata
	`, params.ID, params.DID, defaultSQLInt64(params.KeyVersion, 1), params.PublicKey,
		defaultSQLString(params.Algorithm, "ed25519"), params.KeyID, nullableTimePtr(params.RevokedAt),
		nullableTimePtr(params.ExpiresAt), defaultSQLString(params.Metadata, `{}`))
	return scanSigningKey(row)
}

func (s *SQLStore) GetSigningKeyByKeyID(ctx context.Context, keyID string) (SigningKey, error) {
	row := s.queryRow(ctx, `
		SELECT
			id, did, key_version, public_key, algorithm, key_id, revoked_at, expires_at, created_at, metadata
		FROM im_signing_keys
		WHERE key_id = ?
	`, keyID)
	key, err := scanSigningKey(row)
	if errors.Is(err, sql.ErrNoRows) {
		return SigningKey{}, ErrSigningKeyNotFound
	}
	return key, err
}

func (s *SQLStore) ApplyStatefulMessage(ctx context.Context, params StatefulMessageParams, mutate StatefulMessageMutator) (StatefulMessageResult, error) {
	if s.db == nil {
		return StatefulMessageResult{}, ErrSQLDBNotConfigured
	}
	if err := validateStatefulMessageParams(params); err != nil {
		return StatefulMessageResult{}, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return StatefulMessageResult{}, err
	}
	txStore := &SQLStore{db: s.db, runner: tx}

	result, err := txStore.applyStatefulMessageInTx(ctx, params, mutate)
	if err != nil {
		_ = tx.Rollback()
		return StatefulMessageResult{}, err
	}
	if result.Status != StatefulMessageAccepted {
		_ = tx.Rollback()
		return result, nil
	}
	if err := tx.Commit(); err != nil {
		return StatefulMessageResult{}, err
	}
	return result, nil
}

func (s *SQLStore) applyStatefulMessageInTx(ctx context.Context, params StatefulMessageParams, mutate StatefulMessageMutator) (StatefulMessageResult, error) {
	var existing StatefulMessageRecord
	err := s.queryRow(ctx, `
		SELECT execution_id, state_version, msg_id, msg_type, payload_hash, received_at
		FROM phase_a_msg_dedup_stateful
		WHERE execution_id = ? AND state_version = ?
	`, params.ExecutionID, params.StateVersion).Scan(
		&existing.ExecutionID,
		&existing.StateVersion,
		&existing.MessageID,
		&existing.MessageType,
		&existing.PayloadHash,
		&existing.ReceivedAt,
	)
	if err == nil {
		if existing.MessageType == params.MessageType && existing.PayloadHash == params.PayloadHash {
			return StatefulMessageResult{
				Status:            StatefulMessageDuplicate,
				ExistingMessageID: existing.MessageID,
			}, nil
		}
		return StatefulMessageResult{}, ErrStatefulMessageConflict
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return StatefulMessageResult{}, err
	}

	var maxStateVersion sql.NullInt64
	if err := s.queryRow(ctx, `
		SELECT MAX(state_version)
		FROM phase_a_msg_dedup_stateful
		WHERE execution_id = ?
	`, params.ExecutionID).Scan(&maxStateVersion); err != nil {
		return StatefulMessageResult{}, err
	}
	if maxStateVersion.Valid && params.StateVersion <= maxStateVersion.Int64 {
		return StatefulMessageResult{}, ErrStatefulMessageStale
	}

	if _, err := s.exec(ctx, `
		INSERT INTO phase_a_msg_dedup_stateful (
			execution_id, state_version, msg_id, msg_type, payload_hash
		) VALUES (?, ?, ?, ?, ?)
	`, params.ExecutionID, params.StateVersion, params.MessageID, params.MessageType, params.PayloadHash); err != nil {
		return StatefulMessageResult{}, err
	}

	if mutate != nil {
		if err := mutate(ctx, s); err != nil {
			return StatefulMessageResult{}, err
		}
	}
	return StatefulMessageResult{Status: StatefulMessageAccepted}, nil
}

func (s *SQLStore) UpsertStreamCursor(ctx context.Context, params UpsertStreamCursorParams) error {
	result, err := s.exec(ctx, `
		INSERT INTO im_execution_stream_cursors (execution_id, stream_id, last_committed_seq)
		VALUES (?, ?, ?)
		ON CONFLICT(execution_id, stream_id) DO UPDATE SET
			last_committed_seq = CASE
				WHEN excluded.last_committed_seq > im_execution_stream_cursors.last_committed_seq
				THEN excluded.last_committed_seq
				ELSE im_execution_stream_cursors.last_committed_seq
			END,
			updated_at = CURRENT_TIMESTAMP
	`, params.ExecutionID, params.StreamID, params.LastCommittedSeq)
	if err != nil {
		return err
	}
	_, err = result.RowsAffected()
	return err
}

func (s *SQLStore) GetStreamCursors(ctx context.Context, executionID string, streamIDs []string) ([]StreamCursor, error) {
	if len(streamIDs) == 0 {
		return nil, nil
	}
	args := make([]any, 0, len(streamIDs)+1)
	args = append(args, executionID)
	placeholders := make([]string, 0, len(streamIDs))
	for _, streamID := range streamIDs {
		placeholders = append(placeholders, "?")
		args = append(args, streamID)
	}
	rows, err := s.query(ctx, fmt.Sprintf(`
		SELECT execution_id, stream_id, last_committed_seq, updated_at
		FROM im_execution_stream_cursors
		WHERE execution_id = ?
		  AND stream_id IN (%s)
	`, strings.Join(placeholders, ", ")), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var cursors []StreamCursor
	for rows.Next() {
		cursor, err := scanStreamCursor(rows)
		if err != nil {
			return nil, err
		}
		cursors = append(cursors, cursor)
	}
	return cursors, rows.Err()
}

func (s *SQLStore) exec(ctx context.Context, query string, args ...any) (sql.Result, error) {
	if s.runner == nil {
		return nil, ErrSQLDBNotConfigured
	}
	return s.runner.ExecContext(ctx, query, args...)
}

func (s *SQLStore) query(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	if s.runner == nil {
		return nil, ErrSQLDBNotConfigured
	}
	return s.runner.QueryContext(ctx, query, args...)
}

func (s *SQLStore) queryRow(ctx context.Context, query string, args ...any) *sql.Row {
	if s.runner == nil {
		return nil
	}
	return s.runner.QueryRowContext(ctx, query, args...)
}

type scanner interface {
	Scan(dest ...any) error
}

func scanRuntime(s scanner) (Runtime, error) {
	if s == nil {
		return Runtime{}, ErrSQLDBNotConfigured
	}
	var runtime Runtime
	var ownerIMUserID, hostname, osValue, arch, version, endpoint sql.NullString
	if err := s.Scan(
		&runtime.ID, &runtime.OwnerDid, &ownerIMUserID, &runtime.Type, &runtime.Did, &runtime.PublicKey,
		&hostname, &osValue, &arch, &version, &endpoint, &runtime.Capabilities, &runtime.Status, &runtime.Load,
		&runtime.LastHeartbeatAt, &runtime.RegisteredAt, &runtime.UpdatedAt,
	); err != nil {
		return Runtime{}, err
	}
	runtime.OwnerIMUserID = ownerIMUserID.String
	runtime.Hostname = hostname.String
	runtime.OS = osValue.String
	runtime.Arch = arch.String
	runtime.Version = version.String
	runtime.Endpoint = endpoint.String
	return runtime, nil
}

func scanDaemonSession(s scanner) (DaemonSession, error) {
	if s == nil {
		return DaemonSession{}, ErrSQLDBNotConfigured
	}
	var session DaemonSession
	var terminatedAt sql.NullTime
	var reason, remoteAddr, userAgent sql.NullString
	var pid sql.NullInt64
	if err := s.Scan(
		&session.ID, &session.RuntimeID, &session.StartedAt, &terminatedAt, &reason, &session.Version, &pid,
		&remoteAddr, &userAgent, &session.TaskCount, &session.LogBytes,
	); err != nil {
		return DaemonSession{}, err
	}
	session.TerminatedAt = nullableTimeValue(terminatedAt)
	session.TerminationReason = reason.String
	session.PID = nullableInt64Value(pid)
	session.RemoteAddr = remoteAddr.String
	session.UserAgent = userAgent.String
	return session, nil
}

func scanTask(s scanner) (Task, error) {
	if s == nil {
		return Task{}, ErrSQLDBNotConfigured
	}
	var task Task
	var description, capability, contextURI, creatorDID, assigneeID, assigneeDID, assigneeType sql.NullString
	var conversationID, runtimeID, pendingApprovalID, metadata sql.NullString
	var deadline, nextRunAt sql.NullTime
	var requiresApproval bool
	if err := s.Scan(
		&task.ID, &task.Title, &description, &capability, &task.Input, &contextURI, &task.CreatorID, &creatorDID,
		&assigneeID, &assigneeDID, &assigneeType, &task.Scope, &conversationID, &task.Status, &runtimeID,
		&requiresApproval, &pendingApprovalID, &task.TimeoutMs, &deadline, &task.MaxRetries, &task.RetryDelayMs,
		&task.RetryCount, &nextRunAt, &metadata, &task.CreatedAt, &task.UpdatedAt,
	); err != nil {
		return Task{}, err
	}
	task.Description = description.String
	task.Capability = capability.String
	task.ContextURI = contextURI.String
	task.CreatorDid = creatorDID.String
	task.AssigneeID = assigneeID.String
	task.AssigneeDid = assigneeDID.String
	task.AssigneeType = assigneeType.String
	task.ConversationID = conversationID.String
	task.RuntimeID = runtimeID.String
	task.RequiresApproval = requiresApproval
	task.PendingApprovalID = pendingApprovalID.String
	task.Deadline = nullableTimeValue(deadline)
	task.NextRunAt = nullableTimeValue(nextRunAt)
	task.Metadata = metadata.String
	return task, nil
}

func scanTaskExecution(s scanner) (TaskExecution, error) {
	if s == nil {
		return TaskExecution{}, ErrSQLDBNotConfigured
	}
	var execRow TaskExecution
	var acceptedAt, completedAt sql.NullTime
	var exitCode, durationMs, memoryBytes sql.NullInt64
	var capabilityUsed, cliPath, cliVersion, logsRef, resultRef sql.NullString
	var cpuSeconds sql.NullFloat64
	if err := s.Scan(
		&execRow.ID, &execRow.TaskID, &execRow.RuntimeID, &execRow.Attempt, &execRow.Status, &execRow.StartedAt,
		&acceptedAt, &completedAt, &exitCode, &durationMs, &capabilityUsed, &cliPath, &cliVersion, &logsRef,
		&resultRef, &cpuSeconds, &memoryBytes,
	); err != nil {
		return TaskExecution{}, err
	}
	execRow.AcceptedAt = nullableTimeValue(acceptedAt)
	execRow.CompletedAt = nullableTimeValue(completedAt)
	execRow.ExitCode = nullableInt64Value(exitCode)
	execRow.DurationMs = nullableInt64Value(durationMs)
	execRow.CapabilityUsed = capabilityUsed.String
	execRow.CLIPath = cliPath.String
	execRow.CLIVersion = cliVersion.String
	execRow.LogsRef = logsRef.String
	execRow.ResultRef = resultRef.String
	execRow.CPUSeconds = nullableFloat64Value(cpuSeconds)
	execRow.MemoryBytes = nullableInt64Value(memoryBytes)
	return execRow, nil
}

func scanTaskLog(s scanner) (TaskLog, error) {
	if s == nil {
		return TaskLog{}, ErrSQLDBNotConfigured
	}
	var logRow TaskLog
	var actorID, message sql.NullString
	if err := s.Scan(&logRow.ID, &logRow.TaskID, &actorID, &logRow.Action, &message, &logRow.Metadata, &logRow.CreatedAt); err != nil {
		return TaskLog{}, err
	}
	logRow.ActorID = actorID.String
	logRow.Message = message.String
	return logRow, nil
}

func scanTaskApproval(s scanner) (TaskApproval, error) {
	if s == nil {
		return TaskApproval{}, ErrSQLDBNotConfigured
	}
	var approval TaskApproval
	var taskID, approverDID, approverIMUserID sql.NullString
	var decidedAt, expiresAt sql.NullTime
	var decisionReason, decisionSignature, delegationProof sql.NullString
	if err := s.Scan(
		&approval.ID, &taskID, &approval.Kind, &approval.Action, &approval.Payload, &approval.RequestedByDid,
		&approval.RequestedAt, &approverDID, &approverIMUserID, &approval.Status, &decidedAt, &decisionReason,
		&approval.RequestSignature, &decisionSignature, &delegationProof, &expiresAt, &approval.Metadata,
	); err != nil {
		return TaskApproval{}, err
	}
	approval.TaskID = taskID.String
	approval.ApproverDid = approverDID.String
	approval.ApproverIMUserID = approverIMUserID.String
	approval.DecidedAt = nullableTimeValue(decidedAt)
	approval.DecisionReason = decisionReason.String
	approval.DecisionSignature = decisionSignature.String
	approval.DelegationProof = delegationProof.String
	approval.ExpiresAt = nullableTimeValue(expiresAt)
	return approval, nil
}

func scanSigningKey(s scanner) (SigningKey, error) {
	if s == nil {
		return SigningKey{}, ErrSQLDBNotConfigured
	}
	var key SigningKey
	var revokedAt, expiresAt sql.NullTime
	if err := s.Scan(
		&key.ID, &key.DID, &key.KeyVersion, &key.PublicKey, &key.Algorithm,
		&key.KeyID, &revokedAt, &expiresAt, &key.CreatedAt, &key.Metadata,
	); err != nil {
		return SigningKey{}, err
	}
	key.RevokedAt = nullableTimeValue(revokedAt)
	key.ExpiresAt = nullableTimeValue(expiresAt)
	return key, nil
}

func scanStreamCursor(s scanner) (StreamCursor, error) {
	if s == nil {
		return StreamCursor{}, ErrSQLDBNotConfigured
	}
	var cursor StreamCursor
	if err := s.Scan(&cursor.ExecutionID, &cursor.StreamID, &cursor.LastCommittedSeq, &cursor.UpdatedAt); err != nil {
		return StreamCursor{}, err
	}
	return cursor, nil
}

func mapRowsAffected(result sql.Result, notFound error) error {
	if result == nil {
		return ErrSQLDBNotConfigured
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows == 0 {
		return notFound
	}
	return nil
}

func isTaskLogDuplicateError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "UNIQUE constraint failed: im_task_logs.id")
}

func selectTaskSQL(suffix string) string {
	return `
		SELECT
			id, title, description, capability, input, context_uri, creator_id, creator_did, assignee_id, assignee_did,
			assignee_type, scope, conversation_id, status, runtime_id, requires_approval, pending_approval_id, timeout_ms,
			deadline, max_retries, retry_delay_ms, retry_count, next_run_at, metadata, created_at, updated_at
		FROM im_tasks
	` + suffix
}

func selectTaskExecutionSQL(suffix string) string {
	return `
		SELECT
			id, task_id, runtime_id, attempt, status, started_at, accepted_at, completed_at, exit_code, duration_ms,
			capability_used, cli_path, cli_version, logs_ref, result_ref, cpu_seconds, memory_bytes
		FROM im_task_executions
	` + suffix
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func defaultSQLString(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func defaultSQLInt64(value int64, fallback int64) int64 {
	if value == 0 {
		return fallback
	}
	return value
}

func nullableTimePtr(value *time.Time) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableInt64Ptr(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableFloat64Ptr(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableTimeValue(value sql.NullTime) *time.Time {
	if !value.Valid {
		return nil
	}
	v := value.Time
	return &v
}

func nullableInt64Value(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	v := value.Int64
	return &v
}

func nullableFloat64Value(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	v := value.Float64
	return &v
}
