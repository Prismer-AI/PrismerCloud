package exec

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/retry"
	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
)

type Tracker struct {
	store shareddb.Store
	retry *retry.Planner
}

func NewTracker(store shareddb.Store) *Tracker {
	return &Tracker{
		store: store,
		retry: retry.New(store),
	}
}

func (t *Tracker) HandleAccepted(ctx context.Context, envelope proto.Envelope) error {
	var payload proto.TaskAcceptedPayload
	if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
		return fmt.Errorf("decode task.accepted payload: %w", err)
	}

	execRow, err := t.store.GetTaskExecution(ctx, payload.ExecutionID)
	if err != nil {
		return err
	}
	if isTerminalExecutionStatus(execRow.Status) {
		return nil
	}

	acceptedAt := nowFromEnvelope(envelope)
	if err := t.store.SetTaskExecutionStatus(ctx, shareddb.SetTaskExecutionStatusParams{
		ExecutionID:    payload.ExecutionID,
		Status:         "running",
		AcceptedAt:     &acceptedAt,
		CapabilityUsed: payload.CapabilityUsed,
		CLIPath:        payload.CLIPath,
		CLIVersion:     payload.CLIVersion,
	}); err != nil {
		return err
	}

	return t.store.SetTaskStatus(ctx, shareddb.SetTaskStatusParams{
		TaskID:    execRow.TaskID,
		Status:    "running",
		RuntimeID: execRow.RuntimeID,
	})
}

func (t *Tracker) HandleRejected(ctx context.Context, envelope proto.Envelope) error {
	var payload proto.TaskRejectedPayload
	if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
		return fmt.Errorf("decode task.rejected payload: %w", err)
	}

	execRow, err := t.store.GetTaskExecution(ctx, payload.ExecutionID)
	if err != nil {
		return err
	}
	if isTerminalExecutionStatus(execRow.Status) {
		return nil
	}
	task, err := t.store.GetTask(ctx, execRow.TaskID)
	if err != nil {
		return err
	}

	completedAt := nowFromEnvelope(envelope)
	if err := t.store.SetTaskExecutionStatus(ctx, shareddb.SetTaskExecutionStatusParams{
		ExecutionID: payload.ExecutionID,
		Status:      "cancelled",
		CompletedAt: &completedAt,
	}); err != nil {
		return err
	}

	reason := payload.Reason
	if strings.TrimSpace(reason) == "" {
		reason = "task rejected by daemon"
	}
	metadataBytes, err := json.Marshal(map[string]any{
		"execution_id": payload.ExecutionID,
		"retryable":    payload.Retryable,
	})
	if err != nil {
		return err
	}
	if _, err := t.store.InsertTaskLog(ctx, shareddb.InsertTaskLogParams{
		ID:       fmt.Sprintf("log_%s_rejected", payload.ExecutionID),
		TaskID:   execRow.TaskID,
		Action:   "rejected",
		Message:  reason,
		Metadata: string(metadataBytes),
	}); err != nil {
		return err
	}

	if payload.Retryable {
		scheduled, err := t.scheduleRetry(ctx, task, payload.ExecutionID, reason)
		if err != nil {
			return err
		}
		if scheduled {
			return nil
		}
	}

	status := "cancelled"
	if payload.Retryable {
		status = "failed"
	}
	return t.store.SetTaskStatus(ctx, shareddb.SetTaskStatusParams{
		TaskID:    execRow.TaskID,
		Status:    status,
		RuntimeID: execRow.RuntimeID,
	})
}

func (t *Tracker) HandleFinished(ctx context.Context, envelope proto.Envelope) error {
	var payload proto.TaskFinishedPayload
	if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
		return fmt.Errorf("decode task.finished payload: %w", err)
	}

	execRow, err := t.store.GetTaskExecution(ctx, payload.ExecutionID)
	if err != nil {
		return err
	}
	if isTerminalExecutionStatus(execRow.Status) {
		return nil
	}
	task, err := t.store.GetTask(ctx, execRow.TaskID)
	if err != nil {
		return err
	}

	completedAt := nowFromEnvelope(envelope)
	exitCode := payload.ExitCode
	durationMs := payload.DurationMs
	status := "completed"
	execStatus := "succeeded"
	if payload.ExitCode != 0 {
		status = "failed"
		execStatus = "failed"
	}

	logsRef := buildLogsRef(payload.ExecutionID)
	if err := t.store.SetTaskExecutionStatus(ctx, shareddb.SetTaskExecutionStatusParams{
		ExecutionID: payload.ExecutionID,
		Status:      execStatus,
		CompletedAt: &completedAt,
		ExitCode:    &exitCode,
		DurationMs:  &durationMs,
		LogsRef:     logsRef,
		ResultRef:   payload.ResultURI,
	}); err != nil {
		return err
	}

	if payload.ExitCode != 0 {
		scheduled, err := t.scheduleRetry(ctx, task, payload.ExecutionID, fmt.Sprintf("task failed with exit code %d", payload.ExitCode))
		if err != nil {
			return err
		}
		if scheduled {
			return nil
		}
	}

	return t.store.SetTaskStatus(ctx, shareddb.SetTaskStatusParams{
		TaskID:    execRow.TaskID,
		Status:    status,
		RuntimeID: execRow.RuntimeID,
	})
}

func (t *Tracker) HandleLogChunk(ctx context.Context, envelope proto.Envelope) error {
	var payload proto.TaskLogChunkPayload
	if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
		return fmt.Errorf("decode task.log_chunk payload: %w", err)
	}

	execRow, err := t.store.GetTaskExecution(ctx, payload.ExecutionID)
	if err != nil {
		return err
	}

	stream := payload.Stream
	for _, chunk := range payload.Chunks {
		action := "log"
		if stream != "" {
			action = "log." + stream
		}
		metadataBytes, err := json.Marshal(map[string]any{
			"execution_id": payload.ExecutionID,
			"stream":       stream,
			"seq":          chunk.Seq,
			"timestamp_ms": chunk.TimestampMs,
		})
		if err != nil {
			return err
		}
		logID := fmt.Sprintf("log_%s_%s_%d", payload.ExecutionID, normalizeLogStream(stream), chunk.Seq)
		if _, err := t.store.InsertTaskLog(ctx, shareddb.InsertTaskLogParams{
			ID:       logID,
			TaskID:   execRow.TaskID,
			Action:   action,
			Message:  chunk.Text,
			Metadata: string(metadataBytes),
		}); err != nil {
			if errors.Is(err, shareddb.ErrTaskLogExists) {
				continue
			}
			return err
		}
	}
	lastCommittedSeq := envelope.StreamSeq
	for _, chunk := range payload.Chunks {
		if chunk.Seq > lastCommittedSeq {
			lastCommittedSeq = chunk.Seq
		}
	}
	if stream != "" && lastCommittedSeq >= 0 {
		if err := t.store.UpsertStreamCursor(ctx, shareddb.UpsertStreamCursorParams{
			ExecutionID:      payload.ExecutionID,
			StreamID:         stream,
			LastCommittedSeq: lastCommittedSeq,
		}); err != nil {
			return err
		}
	}
	return nil
}

func nowFromEnvelope(envelope proto.Envelope) time.Time {
	return time.UnixMilli(envelope.TimestampMs)
}

func buildLogsRef(executionID string) string {
	return "logs://" + executionID
}

func normalizeLogStream(stream string) string {
	if strings.TrimSpace(stream) == "" {
		return "mixed"
	}
	return stream
}

func isTerminalExecutionStatus(status string) bool {
	switch status {
	case "succeeded", "failed", "cancelled":
		return true
	default:
		return false
	}
}

func (t *Tracker) scheduleRetry(ctx context.Context, task shareddb.Task, executionID string, reason string) (bool, error) {
	if !retry.ShouldRetry(task) {
		return false, nil
	}

	nextRunAt, scheduled, err := t.retry.ScheduleNextAttempt(ctx, task)
	if err != nil {
		return false, err
	}
	if !scheduled || nextRunAt == nil {
		return false, nil
	}

	metadataBytes, err := json.Marshal(map[string]any{
		"execution_id": executionID,
		"retry_count":  task.RetryCount + 1,
		"next_run_at":  nextRunAt.UnixMilli(),
	})
	if err != nil {
		return false, err
	}

	if _, err := t.store.InsertTaskLog(ctx, shareddb.InsertTaskLogParams{
		ID:       fmt.Sprintf("log_%s_retry_%d", executionID, task.RetryCount+1),
		TaskID:   task.ID,
		Action:   "retry.scheduled",
		Message:  reason,
		Metadata: string(metadataBytes),
	}); err != nil {
		return false, err
	}
	return true, nil
}
