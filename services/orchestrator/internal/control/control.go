package control

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
)

type Hub interface {
	Send(ctx context.Context, runtimeID string, message []byte) error
}

type Controller struct {
	store shareddb.Store
	hub   Hub
	now   func() time.Time
}

func New(store shareddb.Store, hub Hub) *Controller {
	return &Controller{
		store: store,
		hub:   hub,
		now:   time.Now,
	}
}

func (c *Controller) CancelExecution(ctx context.Context, executionID string, reason string) error {
	execRow, err := c.store.GetTaskExecution(ctx, executionID)
	if err != nil {
		return err
	}
	if isTerminalExecutionStatus(execRow.Status) {
		return nil
	}

	payloadBytes, err := json.Marshal(proto.TaskCancelPayload{
		ExecutionID: executionID,
		Reason:      reason,
	})
	if err != nil {
		return err
	}
	envelope := proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           fmt.Sprintf("msg_cancel_%d", c.now().UnixNano()),
		ExecutionID:  executionID,
		Type:         "task.cancel",
		MessageClass: proto.MessageClassStateful,
		TimestampMs:  c.now().UnixMilli(),
		StateVersion: 1,
		PayloadHash:  "cancel",
		AckType:      proto.AckTypeRequired,
		Payload:      payloadBytes,
	}
	wire, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	if err := c.hub.Send(ctx, execRow.RuntimeID, wire); err != nil {
		return err
	}

	completedAt := c.now()
	if err := c.store.SetTaskExecutionStatus(ctx, shareddb.SetTaskExecutionStatusParams{
		ExecutionID: executionID,
		Status:      "cancelled",
		CompletedAt: &completedAt,
	}); err != nil {
		return err
	}
	if err := c.store.SetTaskStatus(ctx, shareddb.SetTaskStatusParams{
		TaskID:    execRow.TaskID,
		Status:    "cancelled",
		RuntimeID: execRow.RuntimeID,
	}); err != nil {
		return err
	}
	_, err = c.store.InsertTaskLog(ctx, shareddb.InsertTaskLogParams{
		ID:       fmt.Sprintf("log_%s_cancel", executionID),
		TaskID:   execRow.TaskID,
		Action:   "cancelled",
		Message:  reason,
		Metadata: `{"source":"control"}`,
	})
	return err
}

func isTerminalExecutionStatus(status string) bool {
	switch status {
	case "succeeded", "failed", "cancelled":
		return true
	default:
		return false
	}
}
