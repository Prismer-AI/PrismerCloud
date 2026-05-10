package dispatcher

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
)

var ErrNoMatchingRuntime = errors.New("no matching runtime")
var ErrTaskApprovalRequired = errors.New("task approval required before dispatch")
var ErrTaskNotDispatchable = errors.New("task not dispatchable")

type Hub interface {
	Send(ctx context.Context, runtimeID string, message []byte) error
}

type Dispatcher struct {
	store shareddb.Store
	hub   Hub
	now   func() time.Time
	seq   uint64
}

func New(store shareddb.Store, hub Hub) *Dispatcher {
	return &Dispatcher{
		store: store,
		hub:   hub,
		now:   time.Now,
	}
}

type DispatchResult struct {
	RuntimeID   string
	ExecutionID string
	MessageID   string
}

func (d *Dispatcher) DispatchTask(ctx context.Context, taskID string) (DispatchResult, error) {
	task, err := d.store.GetTask(ctx, taskID)
	if err != nil {
		return DispatchResult{}, err
	}
	if task.Status != "pending" {
		return DispatchResult{}, ErrTaskNotDispatchable
	}
	if task.RequiresApproval {
		return DispatchResult{}, ErrTaskApprovalRequired
	}

	runtimes, err := d.store.ListOnlineRuntimes(ctx)
	if err != nil {
		return DispatchResult{}, err
	}

	match, ok := MatchRuntime(task, runtimes, d.now())
	if !ok {
		return DispatchResult{}, ErrNoMatchingRuntime
	}

	attempt := task.RetryCount + 1
	executionID := d.nextID("exec")
	messageID := d.nextID("msg")
	claimedTask, err := d.store.ClaimTask(ctx, shareddb.ClaimTaskParams{
		TaskID:       task.ID,
		AssigneeID:   task.AssigneeID,
		AssigneeDid:  task.AssigneeDid,
		AssigneeType: task.AssigneeType,
		RuntimeID:    match.Runtime.ID,
		Status:       "assigned",
	})
	if err != nil {
		return DispatchResult{}, err
	}

	if _, err := d.store.InsertTaskExecution(ctx, shareddb.InsertTaskExecutionParams{
		ID:             executionID,
		TaskID:         claimedTask.ID,
		RuntimeID:      match.Runtime.ID,
		Attempt:        attempt,
		Status:         "dispatched",
		CapabilityUsed: claimedTask.Capability,
	}); err != nil {
		return DispatchResult{}, err
	}

	envelope, err := d.buildTaskPushEnvelope(claimedTask, executionID, messageID)
	if err != nil {
		return DispatchResult{}, err
	}
	wire, err := json.Marshal(envelope)
	if err != nil {
		return DispatchResult{}, err
	}
	if err := d.hub.Send(ctx, match.Runtime.ID, wire); err != nil {
		return DispatchResult{}, err
	}

	return DispatchResult{
		RuntimeID:   match.Runtime.ID,
		ExecutionID: executionID,
		MessageID:   messageID,
	}, nil
}

func (d *Dispatcher) DispatchPendingForCapability(ctx context.Context, capability string) ([]DispatchResult, error) {
	tasks, err := d.store.ListPendingTasksForCapability(ctx, capability)
	if err != nil {
		return nil, err
	}
	results := make([]DispatchResult, 0, len(tasks))
	for _, task := range tasks {
		result, err := d.DispatchTask(ctx, task.ID)
		if err != nil {
			if errors.Is(err, ErrNoMatchingRuntime) {
				continue
			}
			return results, err
		}
		results = append(results, result)
	}
	return results, nil
}

func (d *Dispatcher) buildTaskPushEnvelope(task shareddb.Task, executionID, messageID string) (proto.Envelope, error) {
	input := json.RawMessage(task.Input)
	if len(strings.TrimSpace(task.Input)) == 0 {
		input = json.RawMessage(`{}`)
	}

	payload := proto.TaskPushPayload{
		TaskID:           task.ID,
		ExecutionID:      executionID,
		Title:            task.Title,
		Capability:       task.Capability,
		Input:            input,
		ContextURI:       task.ContextURI,
		TimeoutMs:        resolveTimeoutMs(task.TimeoutMs),
		RequiresApproval: task.RequiresApproval,
		CreatorDid:       task.CreatorDid,
	}

	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return proto.Envelope{}, err
	}
	payloadHash, err := proto.ComputePayloadHash(payloadBytes)
	if err != nil {
		return proto.Envelope{}, err
	}

	return proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           messageID,
		ExecutionID:  executionID,
		Type:         "task.push",
		MessageClass: proto.MessageClassStateful,
		TimestampMs:  d.now().UnixMilli(),
		StateVersion: 1,
		PayloadHash:  payloadHash,
		AckType:      proto.AckTypeRequired,
		Payload:      payloadBytes,
	}, nil
}

func (d *Dispatcher) nextID(prefix string) string {
	n := atomic.AddUint64(&d.seq, 1)
	return fmt.Sprintf("%s_%d", prefix, n)
}

func resolveTimeoutMs(timeoutMs int64) int64 {
	if timeoutMs > 0 {
		return timeoutMs
	}
	return 300000
}
