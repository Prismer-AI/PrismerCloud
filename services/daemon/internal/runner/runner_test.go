package runner

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
)

func TestRunnerSuccessfulTaskLifecycle(t *testing.T) {
	client := newFakeClient()
	executor := &fakeExecutor{
		execute: func(ctx context.Context, task proto.TaskPushPayload, reporter Reporter) (ExecutionResult, error) {
			if err := reporter.Log(ctx, "stdout", "hello\n"); err != nil {
				return ExecutionResult{}, err
			}
			return ExecutionResult{
				ExitCode:  0,
				ResultURI: "prismer://result",
				Summary:   "done",
			}, nil
		},
	}
	runner := New(client, executor, Config{
		CapabilityUsed: "claude-code",
		CLIPath:        "/usr/local/bin/claude",
		CLIVersion:     "1.2.3",
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runner.Start(ctx)

	client.pushTask(proto.TaskPushPayload{
		TaskID:      "task_1",
		ExecutionID: "exec_1",
		Title:       "Run",
		Capability:  "claude-code",
	})

	client.waitAccepted(t, "exec_1")
	client.waitLog(t, "exec_1", 1, "hello\n")
	client.waitFinished(t, "exec_1", 0)
}

func TestRunnerRejectsTask(t *testing.T) {
	client := newFakeClient()
	executor := &fakeExecutor{
		execute: func(ctx context.Context, task proto.TaskPushPayload, reporter Reporter) (ExecutionResult, error) {
			return ExecutionResult{}, &RejectError{Reason: "busy", Retryable: true}
		},
	}
	runner := New(client, executor, Config{CapabilityUsed: "claude-code"})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runner.Start(ctx)

	client.pushTask(proto.TaskPushPayload{
		TaskID:      "task_1",
		ExecutionID: "exec_1",
	})

	client.waitAccepted(t, "exec_1")
	client.waitRejected(t, "exec_1", true)
}

func TestRunnerCancelsRunningTask(t *testing.T) {
	client := newFakeClient()
	blocked := make(chan struct{})
	executor := &fakeExecutor{
		execute: func(ctx context.Context, task proto.TaskPushPayload, reporter Reporter) (ExecutionResult, error) {
			close(blocked)
			<-ctx.Done()
			return ExecutionResult{}, ctx.Err()
		},
	}
	runner := New(client, executor, Config{CapabilityUsed: "claude-code"})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runner.Start(ctx)

	client.pushTask(proto.TaskPushPayload{
		TaskID:      "task_1",
		ExecutionID: "exec_1",
	})
	client.waitAccepted(t, "exec_1")

	select {
	case <-blocked:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for executor start")
	}

	client.pushCancel(proto.TaskCancelPayload{
		ExecutionID: "exec_1",
		Reason:      "stop",
	})
	client.waitFinished(t, "exec_1", 130)
}

func TestRunnerResumesStreamSequencesFromAck(t *testing.T) {
	client := newFakeClient()
	client.setResumeAck(proto.StreamResumeAckPayload{
		ExecutionID: "exec_1",
		Streams: []proto.StreamResumeAckStream{
			{StreamID: "stdout", LastCommittedSeq: 7},
		},
	})
	executor := &fakeExecutor{
		execute: func(ctx context.Context, task proto.TaskPushPayload, reporter Reporter) (ExecutionResult, error) {
			if err := reporter.Log(ctx, "stdout", "resumed\n"); err != nil {
				return ExecutionResult{}, err
			}
			return ExecutionResult{ExitCode: 0}, nil
		},
	}
	runner := New(client, executor, Config{CapabilityUsed: "claude-code"})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runner.Start(ctx)

	client.pushTask(proto.TaskPushPayload{
		TaskID:      "task_1",
		ExecutionID: "exec_1",
	})

	client.waitAccepted(t, "exec_1")
	client.waitLog(t, "exec_1", 8, "resumed\n")
}

func TestRunnerWaitsForApprovalAndContinuesOnApproved(t *testing.T) {
	client := newFakeClient()
	executor := &fakeExecutor{
		execute: func(ctx context.Context, task proto.TaskPushPayload, reporter Reporter) (ExecutionResult, error) {
			decision, err := reporter.RequestApproval(ctx, ApprovalRequest{
				Kind:             "dangerous_action",
				Action:           "git_push_force",
				Payload:          []byte(`{"branch":"main"}`),
				RequestSignature: "sig_req",
			})
			if err != nil {
				return ExecutionResult{}, err
			}
			if decision.Decision != "approved" {
				return ExecutionResult{}, errors.New("unexpected approval decision")
			}
			if err := reporter.Log(ctx, "stdout", "approved\n"); err != nil {
				return ExecutionResult{}, err
			}
			return ExecutionResult{ExitCode: 0}, nil
		},
	}
	runner := New(client, executor, Config{CapabilityUsed: "claude-code"})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runner.Start(ctx)

	client.pushTask(proto.TaskPushPayload{
		TaskID:      "task_1",
		ExecutionID: "exec_1",
	})
	client.waitAccepted(t, "exec_1")
	request := client.waitApprovalRequest(t, "task_1")
	if request.Kind != "dangerous_action" || request.Action != "git_push_force" {
		t.Fatalf("unexpected approval request: %+v", request)
	}
	client.pushApprovalDecision(proto.ApprovalDecisionPayload{
		ApprovalID:  request.ApprovalID,
		TaskID:      "task_1",
		Decision:    "approved",
		DecidedAtMs: time.Now().UnixMilli(),
	})

	client.waitLog(t, "exec_1", 1, "approved\n")
	client.waitFinished(t, "exec_1", 0)
}

func TestRunnerRejectsTaskWhenApprovalDenied(t *testing.T) {
	client := newFakeClient()
	executor := &fakeExecutor{
		execute: func(ctx context.Context, task proto.TaskPushPayload, reporter Reporter) (ExecutionResult, error) {
			decision, err := reporter.RequestApproval(ctx, ApprovalRequest{
				Kind:             "dangerous_action",
				Action:           "git_push_force",
				RequestSignature: "sig_req",
			})
			if err != nil {
				return ExecutionResult{}, err
			}
			if decision.Decision != "approved" {
				return ExecutionResult{}, &RejectError{Reason: "approval rejected", Retryable: false}
			}
			return ExecutionResult{ExitCode: 0}, nil
		},
	}
	runner := New(client, executor, Config{CapabilityUsed: "claude-code"})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runner.Start(ctx)

	client.pushTask(proto.TaskPushPayload{
		TaskID:      "task_1",
		ExecutionID: "exec_1",
	})
	client.waitAccepted(t, "exec_1")
	request := client.waitApprovalRequest(t, "task_1")
	client.pushApprovalDecision(proto.ApprovalDecisionPayload{
		ApprovalID:  request.ApprovalID,
		TaskID:      "task_1",
		Decision:    "rejected",
		DecidedAtMs: time.Now().UnixMilli(),
	})

	client.waitRejected(t, "exec_1", false)
}

func TestRunnerReplaysAcceptedAfterReconnect(t *testing.T) {
	client := newFakeClient()
	executorStarted := make(chan struct{})
	executorRelease := make(chan struct{})
	executor := &fakeExecutor{
		execute: func(ctx context.Context, task proto.TaskPushPayload, reporter Reporter) (ExecutionResult, error) {
			close(executorStarted)
			<-executorRelease
			return ExecutionResult{ExitCode: 0}, nil
		},
	}
	runner := New(client, executor, Config{CapabilityUsed: "claude-code"})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runner.Start(ctx)

	client.pushTask(proto.TaskPushPayload{
		TaskID:      "task_1",
		ExecutionID: "exec_1",
	})
	client.waitAccepted(t, "exec_1")

	select {
	case <-executorStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for executor start")
	}

	client.triggerReconnect()
	waitForRunnerCondition(t, "accepted replay", func() bool {
		client.mu.Lock()
		defer client.mu.Unlock()
		count := 0
		for _, item := range client.accepted {
			if item.ExecutionID == "exec_1" {
				count++
			}
		}
		return count >= 2
	})

	close(executorRelease)
	client.waitFinished(t, "exec_1", 0)
}

func TestRunnerReplaysFinishedAfterReconnect(t *testing.T) {
	client := newFakeClient()
	client.setFinishedFailures("exec_1", 1)
	executor := &fakeExecutor{
		execute: func(ctx context.Context, task proto.TaskPushPayload, reporter Reporter) (ExecutionResult, error) {
			return ExecutionResult{ExitCode: 0, Summary: "done"}, nil
		},
	}
	runner := New(client, executor, Config{CapabilityUsed: "claude-code"})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runner.Start(ctx)

	client.pushTask(proto.TaskPushPayload{
		TaskID:      "task_1",
		ExecutionID: "exec_1",
	})
	client.waitAccepted(t, "exec_1")
	client.waitFinishedAttempts(t, "exec_1", 1)

	client.triggerReconnect()
	client.waitFinished(t, "exec_1", 0)
	client.waitFinishedAttempts(t, "exec_1", 2)
}

func TestRunnerReplaysRejectedAfterReconnect(t *testing.T) {
	client := newFakeClient()
	client.setRejectedFailures("exec_1", 1)
	executor := &fakeExecutor{
		execute: func(ctx context.Context, task proto.TaskPushPayload, reporter Reporter) (ExecutionResult, error) {
			return ExecutionResult{}, &RejectError{Reason: "busy", Retryable: true}
		},
	}
	runner := New(client, executor, Config{CapabilityUsed: "claude-code"})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runner.Start(ctx)

	client.pushTask(proto.TaskPushPayload{
		TaskID:      "task_1",
		ExecutionID: "exec_1",
	})
	client.waitAccepted(t, "exec_1")
	client.waitRejectedAttempts(t, "exec_1", 1)

	client.triggerReconnect()
	client.waitRejected(t, "exec_1", true)
	client.waitRejectedAttempts(t, "exec_1", 2)
}

type fakeExecutor struct {
	execute func(ctx context.Context, task proto.TaskPushPayload, reporter Reporter) (ExecutionResult, error)
}

func (e *fakeExecutor) Execute(ctx context.Context, task proto.TaskPushPayload, reporter Reporter) (ExecutionResult, error) {
	if e.execute == nil {
		return ExecutionResult{}, errors.New("execute not configured")
	}
	return e.execute(ctx, task, reporter)
}

type fakeClient struct {
	taskPushes chan proto.TaskPushPayload
	cancels    chan proto.TaskCancelPayload
	approvals  chan proto.ApprovalDecisionPayload

	mu               sync.Mutex
	resumeAcks       map[string]proto.StreamResumeAckPayload
	tracked          map[string][]string
	approvalRequests []proto.ApprovalRequestPayload
	accepted         []proto.TaskAcceptedPayload
	rejected         []proto.TaskRejectedPayload
	finished         []proto.TaskFinishedPayload
	logChunks        []proto.TaskLogChunkPayload
	rejectedAttempts map[string]int
	finishedAttempts map[string]int
	rejectedFailures map[string]int
	finishedFailures map[string]int
	reconnects       chan struct{}
}

func newFakeClient() *fakeClient {
	return &fakeClient{
		taskPushes:       make(chan proto.TaskPushPayload, 8),
		cancels:          make(chan proto.TaskCancelPayload, 8),
		approvals:        make(chan proto.ApprovalDecisionPayload, 8),
		resumeAcks:       make(map[string]proto.StreamResumeAckPayload),
		tracked:          make(map[string][]string),
		rejectedAttempts: make(map[string]int),
		finishedAttempts: make(map[string]int),
		rejectedFailures: make(map[string]int),
		finishedFailures: make(map[string]int),
		reconnects:       make(chan struct{}, 8),
	}
}

func (c *fakeClient) TaskPushes() <-chan proto.TaskPushPayload {
	return c.taskPushes
}

func (c *fakeClient) TaskCancels() <-chan proto.TaskCancelPayload {
	return c.cancels
}

func (c *fakeClient) Reconnects() <-chan struct{} {
	return c.reconnects
}

func (c *fakeClient) ApprovalDecisions() <-chan proto.ApprovalDecisionPayload {
	return c.approvals
}

func (c *fakeClient) TrackExecution(executionID string, streams []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.tracked[executionID] = append([]string(nil), streams...)
}

func (c *fakeClient) UntrackExecution(executionID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.tracked, executionID)
}

func (c *fakeClient) SyncExecutionStreams(ctx context.Context, executionID string, streams []string) (proto.StreamResumeAckPayload, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if ack, ok := c.resumeAcks[executionID]; ok {
		return ack, nil
	}
	ackStreams := make([]proto.StreamResumeAckStream, 0, len(streams))
	for _, stream := range streams {
		ackStreams = append(ackStreams, proto.StreamResumeAckStream{
			StreamID:         stream,
			LastCommittedSeq: 0,
		})
	}
	return proto.StreamResumeAckPayload{
		ExecutionID: executionID,
		Streams:     ackStreams,
	}, nil
}

func (c *fakeClient) SendAccepted(ctx context.Context, payload proto.TaskAcceptedPayload) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.accepted = append(c.accepted, payload)
	return nil
}

func (c *fakeClient) SendApprovalRequest(ctx context.Context, payload proto.ApprovalRequestPayload) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.approvalRequests = append(c.approvalRequests, payload)
	return nil
}

func (c *fakeClient) SendRejected(ctx context.Context, payload proto.TaskRejectedPayload) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.rejectedAttempts[payload.ExecutionID]++
	if c.rejectedFailures[payload.ExecutionID] > 0 {
		c.rejectedFailures[payload.ExecutionID]--
		return fmt.Errorf("forced rejected send failure for %s", payload.ExecutionID)
	}
	c.rejected = append(c.rejected, payload)
	return nil
}

func (c *fakeClient) SendFinished(ctx context.Context, payload proto.TaskFinishedPayload) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.finishedAttempts[payload.ExecutionID]++
	if c.finishedFailures[payload.ExecutionID] > 0 {
		c.finishedFailures[payload.ExecutionID]--
		return fmt.Errorf("forced finished send failure for %s", payload.ExecutionID)
	}
	c.finished = append(c.finished, payload)
	return nil
}

func (c *fakeClient) SendLogChunk(ctx context.Context, payload proto.TaskLogChunkPayload) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.logChunks = append(c.logChunks, payload)
	return nil
}

func (c *fakeClient) pushTask(task proto.TaskPushPayload) {
	c.taskPushes <- task
}

func (c *fakeClient) pushCancel(payload proto.TaskCancelPayload) {
	c.cancels <- payload
}

func (c *fakeClient) pushApprovalDecision(payload proto.ApprovalDecisionPayload) {
	c.approvals <- payload
}

func (c *fakeClient) setResumeAck(payload proto.StreamResumeAckPayload) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.resumeAcks[payload.ExecutionID] = payload
}

func (c *fakeClient) setRejectedFailures(executionID string, count int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.rejectedFailures[executionID] = count
}

func (c *fakeClient) setFinishedFailures(executionID string, count int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.finishedFailures[executionID] = count
}

func (c *fakeClient) triggerReconnect() {
	c.reconnects <- struct{}{}
}

func (c *fakeClient) waitAccepted(t *testing.T, executionID string) {
	t.Helper()
	waitForRunnerCondition(t, "accepted", func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		for _, item := range c.accepted {
			if item.ExecutionID == executionID {
				return true
			}
		}
		return false
	})
}

func (c *fakeClient) waitApprovalRequest(t *testing.T, taskID string) proto.ApprovalRequestPayload {
	t.Helper()
	var matched proto.ApprovalRequestPayload
	waitForRunnerCondition(t, "approval request", func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		for _, item := range c.approvalRequests {
			if item.TaskID == taskID {
				matched = item
				return true
			}
		}
		return false
	})
	return matched
}

func (c *fakeClient) waitRejected(t *testing.T, executionID string, retryable bool) {
	t.Helper()
	waitForRunnerCondition(t, "rejected", func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		for _, item := range c.rejected {
			if item.ExecutionID == executionID && item.Retryable == retryable {
				return true
			}
		}
		return false
	})
}

func (c *fakeClient) waitRejectedAttempts(t *testing.T, executionID string, min int) {
	t.Helper()
	waitForRunnerCondition(t, "rejected attempts", func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.rejectedAttempts[executionID] >= min
	})
}

func (c *fakeClient) waitFinished(t *testing.T, executionID string, exitCode int64) {
	t.Helper()
	waitForRunnerCondition(t, "finished", func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		for _, item := range c.finished {
			if item.ExecutionID == executionID && item.ExitCode == exitCode {
				return true
			}
		}
		return false
	})
}

func (c *fakeClient) waitFinishedAttempts(t *testing.T, executionID string, min int) {
	t.Helper()
	waitForRunnerCondition(t, "finished attempts", func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.finishedAttempts[executionID] >= min
	})
}

func (c *fakeClient) waitLog(t *testing.T, executionID string, seq int64, text string) {
	t.Helper()
	waitForRunnerCondition(t, "log chunk", func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		for _, item := range c.logChunks {
			if item.ExecutionID == executionID && len(item.Chunks) == 1 && item.Chunks[0].Seq == seq && item.Chunks[0].Text == text {
				return true
			}
		}
		return false
	})
}

func waitForRunnerCondition(t *testing.T, name string, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", name)
}
