package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
)

type Client interface {
	TaskPushes() <-chan proto.TaskPushPayload
	TaskCancels() <-chan proto.TaskCancelPayload
	ApprovalDecisions() <-chan proto.ApprovalDecisionPayload
	Reconnects() <-chan struct{}
	TrackExecution(executionID string, streams []string)
	UntrackExecution(executionID string)
	SyncExecutionStreams(ctx context.Context, executionID string, streams []string) (proto.StreamResumeAckPayload, error)
	SendAccepted(ctx context.Context, payload proto.TaskAcceptedPayload) error
	SendApprovalRequest(ctx context.Context, payload proto.ApprovalRequestPayload) error
	SendRejected(ctx context.Context, payload proto.TaskRejectedPayload) error
	SendFinished(ctx context.Context, payload proto.TaskFinishedPayload) error
	SendLogChunk(ctx context.Context, payload proto.TaskLogChunkPayload) error
}

type Reporter interface {
	Log(ctx context.Context, stream string, text string) error
	RequestApproval(ctx context.Context, request ApprovalRequest) (proto.ApprovalDecisionPayload, error)
}

type Executor interface {
	Execute(ctx context.Context, task proto.TaskPushPayload, reporter Reporter) (ExecutionResult, error)
}

type ExecutionResult struct {
	ExitCode   int64
	ResultURI  string
	Summary    string
	Stats      proto.TaskFinishedStats
	DurationMs int64
}

type RejectError struct {
	Reason    string
	Retryable bool
}

func (e *RejectError) Error() string {
	if e == nil || e.Reason == "" {
		return "task rejected"
	}
	return e.Reason
}

type Config struct {
	CapabilityUsed string
	CLIPath        string
	CLIVersion     string
	ResumeStreams  []string
}

type ApprovalRequest struct {
	Kind             string
	Action           string
	Payload          json.RawMessage
	ApproverDID      string
	ApproverIMUserID string
	RequestSignature string
	Metadata         json.RawMessage
}

type Runner struct {
	client   Client
	executor Executor
	cfg      Config

	approvalSeq uint64

	mu        sync.Mutex
	cancels   map[string]context.CancelFunc
	streamSeq map[string]map[string]int64
	active    map[string]proto.TaskAcceptedPayload
	pending   map[string]terminalReplay
	waiters   map[string]chan proto.ApprovalDecisionPayload
}

type terminalReplay struct {
	rejected *proto.TaskRejectedPayload
	finished *proto.TaskFinishedPayload
}

func New(client Client, executor Executor, cfg Config) *Runner {
	return &Runner{
		client:    client,
		executor:  executor,
		cfg:       cfg,
		cancels:   make(map[string]context.CancelFunc),
		streamSeq: make(map[string]map[string]int64),
		active:    make(map[string]proto.TaskAcceptedPayload),
		pending:   make(map[string]terminalReplay),
		waiters:   make(map[string]chan proto.ApprovalDecisionPayload),
	}
}

func (r *Runner) Start(ctx context.Context) {
	go r.loop(ctx)
}

func (r *Runner) loop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			r.cancelAll()
			return
		case task, ok := <-r.client.TaskPushes():
			if !ok {
				r.cancelAll()
				return
			}
			r.startTask(ctx, task)
		case cancel, ok := <-r.client.TaskCancels():
			if !ok {
				continue
			}
			r.cancelExecution(cancel.ExecutionID)
		case decision, ok := <-r.client.ApprovalDecisions():
			if !ok {
				continue
			}
			r.handleApprovalDecision(decision)
		case _, ok := <-r.client.Reconnects():
			if !ok {
				continue
			}
			r.replayAccepted(ctx)
			r.replayPending(ctx)
		}
	}
}

func (r *Runner) startTask(parent context.Context, task proto.TaskPushPayload) {
	taskCtx, cancel := context.WithCancel(parent)
	r.mu.Lock()
	r.cancels[task.ExecutionID] = cancel
	r.mu.Unlock()
	resumeStreams := r.resumeStreams()
	r.client.TrackExecution(task.ExecutionID, resumeStreams)

	go func() {
		defer r.finishExecution(task.ExecutionID)
		defer r.client.UntrackExecution(task.ExecutionID)
		if ack, err := r.client.SyncExecutionStreams(taskCtx, task.ExecutionID, resumeStreams); err != nil {
			return
		} else {
			r.applyResumeAck(ack)
		}

		accepted := proto.TaskAcceptedPayload{
			ExecutionID:    task.ExecutionID,
			CapabilityUsed: r.cfg.CapabilityUsed,
			CLIPath:        r.cfg.CLIPath,
			CLIVersion:     r.cfg.CLIVersion,
		}
		r.setActiveAccepted(accepted)
		if err := r.client.SendAccepted(taskCtx, accepted); err != nil {
			return
		}

		startedAt := time.Now()
		reporter := &taskReporter{runner: r, taskID: task.TaskID, executionID: task.ExecutionID}
		result, err := r.executor.Execute(taskCtx, task, reporter)
		if err != nil {
			var rejectErr *RejectError
			if errors.As(err, &rejectErr) {
				r.sendRejected(taskCtx, proto.TaskRejectedPayload{
					ExecutionID: task.ExecutionID,
					Reason:      rejectErr.Reason,
					Retryable:   rejectErr.Retryable,
				})
				return
			}

			exitCode := int64(1)
			summary := err.Error()
			if errors.Is(err, context.Canceled) {
				exitCode = 130
				summary = "cancelled"
			}
			r.sendFinished(taskCtx, proto.TaskFinishedPayload{
				ExecutionID: task.ExecutionID,
				ExitCode:    exitCode,
				DurationMs:  time.Since(startedAt).Milliseconds(),
				Summary:     summary,
			})
			return
		}

		durationMs := result.DurationMs
		if durationMs == 0 {
			durationMs = time.Since(startedAt).Milliseconds()
		}
		r.sendFinished(taskCtx, proto.TaskFinishedPayload{
			ExecutionID: task.ExecutionID,
			ExitCode:    result.ExitCode,
			ResultURI:   result.ResultURI,
			DurationMs:  durationMs,
			Stats:       result.Stats,
			Summary:     result.Summary,
		})
	}()
}

func (r *Runner) sendLog(ctx context.Context, executionID string, stream string, text string) error {
	seq := r.nextStreamSeq(executionID, stream)
	return r.client.SendLogChunk(ctx, proto.TaskLogChunkPayload{
		ExecutionID: executionID,
		Stream:      stream,
		Chunks: []proto.TaskLogChunk{
			{
				Seq:         seq,
				Text:        text,
				TimestampMs: time.Now().UnixMilli(),
			},
		},
	})
}

func (r *Runner) nextStreamSeq(executionID string, stream string) int64 {
	r.mu.Lock()
	defer r.mu.Unlock()

	streams, ok := r.streamSeq[executionID]
	if !ok {
		streams = make(map[string]int64)
		r.streamSeq[executionID] = streams
	}
	seq := streams[stream]
	if seq == 0 {
		seq = 1
	}
	streams[stream] = seq + 1
	return seq
}

func (r *Runner) cancelExecution(executionID string) {
	r.mu.Lock()
	cancel := r.cancels[executionID]
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (r *Runner) cancelAll() {
	r.mu.Lock()
	cancels := make([]context.CancelFunc, 0, len(r.cancels))
	for _, cancel := range r.cancels {
		cancels = append(cancels, cancel)
	}
	r.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

func (r *Runner) finishExecution(executionID string) {
	r.mu.Lock()
	delete(r.cancels, executionID)
	delete(r.streamSeq, executionID)
	delete(r.active, executionID)
	r.mu.Unlock()
}

func (r *Runner) applyResumeAck(payload proto.StreamResumeAckPayload) {
	r.mu.Lock()
	defer r.mu.Unlock()

	streams := r.streamSeq[payload.ExecutionID]
	if streams == nil {
		streams = make(map[string]int64)
		r.streamSeq[payload.ExecutionID] = streams
	}
	for _, stream := range payload.Streams {
		next := stream.LastCommittedSeq + 1
		if next <= 0 {
			next = 1
		}
		streams[stream.StreamID] = next
	}
}

func (r *Runner) resumeStreams() []string {
	if len(r.cfg.ResumeStreams) != 0 {
		return append([]string(nil), r.cfg.ResumeStreams...)
	}
	return []string{"stdout", "stderr", "progress"}
}

func (r *Runner) setActiveAccepted(payload proto.TaskAcceptedPayload) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.active[payload.ExecutionID] = payload
}

func (r *Runner) replayAccepted(ctx context.Context) {
	r.mu.Lock()
	payloads := make([]proto.TaskAcceptedPayload, 0, len(r.active))
	for _, payload := range r.active {
		payloads = append(payloads, payload)
	}
	r.mu.Unlock()

	for _, payload := range payloads {
		replayCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		_ = r.client.SendAccepted(replayCtx, payload)
		cancel()
	}
}

func (r *Runner) replayPending(ctx context.Context) {
	r.mu.Lock()
	payloads := make([]terminalReplay, 0, len(r.pending))
	for _, payload := range r.pending {
		payloads = append(payloads, payload)
	}
	r.mu.Unlock()

	for _, payload := range payloads {
		replayCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		switch {
		case payload.finished != nil:
			if err := r.client.SendFinished(replayCtx, *payload.finished); err == nil {
				r.clearPendingTerminal(payload.finished.ExecutionID)
			}
		case payload.rejected != nil:
			if err := r.client.SendRejected(replayCtx, *payload.rejected); err == nil {
				r.clearPendingTerminal(payload.rejected.ExecutionID)
			}
		}
		cancel()
	}
}

func (r *Runner) sendRejected(ctx context.Context, payload proto.TaskRejectedPayload) {
	if err := r.client.SendRejected(ctx, payload); err != nil {
		r.setPendingRejected(payload)
		return
	}
	r.clearPendingTerminal(payload.ExecutionID)
}

func (r *Runner) sendFinished(ctx context.Context, payload proto.TaskFinishedPayload) {
	if err := r.client.SendFinished(ctx, payload); err != nil {
		r.setPendingFinished(payload)
		return
	}
	r.clearPendingTerminal(payload.ExecutionID)
}

func (r *Runner) setPendingRejected(payload proto.TaskRejectedPayload) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pending[payload.ExecutionID] = terminalReplay{rejected: &payload}
}

func (r *Runner) setPendingFinished(payload proto.TaskFinishedPayload) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pending[payload.ExecutionID] = terminalReplay{finished: &payload}
}

func (r *Runner) clearPendingTerminal(executionID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.pending, executionID)
}

func (r *Runner) requestApproval(ctx context.Context, taskID string, executionID string, request ApprovalRequest) (proto.ApprovalDecisionPayload, error) {
	if request.Kind == "" {
		return proto.ApprovalDecisionPayload{}, fmt.Errorf("approval kind required")
	}
	if request.Action == "" {
		return proto.ApprovalDecisionPayload{}, fmt.Errorf("approval action required")
	}

	approvalID := fmt.Sprintf("appr_%s_%d", executionID, atomic.AddUint64(&r.approvalSeq, 1))
	waiter := make(chan proto.ApprovalDecisionPayload, 1)
	r.mu.Lock()
	r.waiters[approvalID] = waiter
	r.mu.Unlock()

	err := r.client.SendApprovalRequest(ctx, proto.ApprovalRequestPayload{
		ApprovalID:       approvalID,
		TaskID:           taskID,
		Kind:             request.Kind,
		Action:           request.Action,
		Payload:          defaultApprovalRaw(request.Payload),
		ApproverDID:      request.ApproverDID,
		ApproverIMUserID: request.ApproverIMUserID,
		RequestSignature: defaultApprovalSignature(request.RequestSignature),
		Metadata:         defaultApprovalRaw(request.Metadata),
	})
	if err != nil {
		r.removeApprovalWaiter(approvalID)
		return proto.ApprovalDecisionPayload{}, err
	}

	select {
	case <-ctx.Done():
		r.removeApprovalWaiter(approvalID)
		return proto.ApprovalDecisionPayload{}, ctx.Err()
	case decision := <-waiter:
		return decision, nil
	}
}

func (r *Runner) handleApprovalDecision(decision proto.ApprovalDecisionPayload) {
	r.mu.Lock()
	waiter := r.waiters[decision.ApprovalID]
	if waiter != nil {
		delete(r.waiters, decision.ApprovalID)
	}
	r.mu.Unlock()
	if waiter == nil {
		return
	}
	select {
	case waiter <- decision:
	default:
	}
	close(waiter)
}

func (r *Runner) removeApprovalWaiter(approvalID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	waiter := r.waiters[approvalID]
	if waiter == nil {
		return
	}
	delete(r.waiters, approvalID)
	close(waiter)
}

func defaultApprovalRaw(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`{}`)
	}
	return raw
}

func defaultApprovalSignature(signature string) string {
	if signature == "" {
		return "daemon-local"
	}
	return signature
}

type taskReporter struct {
	runner      *Runner
	taskID      string
	executionID string
}

func (r *taskReporter) Log(ctx context.Context, stream string, text string) error {
	return r.runner.sendLog(ctx, r.executionID, stream, text)
}

func (r *taskReporter) RequestApproval(ctx context.Context, request ApprovalRequest) (proto.ApprovalDecisionPayload, error) {
	return r.runner.requestApproval(ctx, r.taskID, r.executionID, request)
}
