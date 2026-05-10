//go:build gorilla_websocket

package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	controlpkg "github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/control"
	dispatcherpkg "github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/dispatcher"
	"github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/transport"
	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
	"github.com/gorilla/websocket"
)

func TestEndToEndCompletedTaskIgnoresLateCancel(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	store := shareddb.NewMemoryStore()
	app := NewApp(Config{}, Dependencies{
		Store:      store,
		WSUpgrader: transport.NewGorillaUpgrader(websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}),
	})
	endpoint := newInMemoryWSEndpoint(app.HTTPHandler)
	defer endpoint.Close()

	conn := endpoint.mustConnect(t, "ws://prismer.test/ws/runtime")
	defer conn.Close()

	mustWriteEnvelope(t, conn, mustStatefulEnvelope(t, "exec_runtime", "runtime.hello", proto.RuntimeHelloPayload{
		DID:       "did:key:e2e-runtime",
		SessionID: "sess_e2e_1",
		Version:   "0.1.0",
		Host:      proto.RuntimeHelloHost{Hostname: "host", OS: "linux", Arch: "amd64"},
	}))

	waitForServerCondition(t, "runtime connection", func() bool {
		return app.Hub.ConnectionCount() == 1
	})

	mustSeedDispatchedTask(t, ctx, store, "did:key:e2e-runtime", "task_1", "exec_1")
	if err := app.Hub.Send(ctx, "did:key:e2e-runtime", mustTaskPushEnvelopeBytes(t, proto.TaskPushPayload{
		TaskID:      "task_1",
		ExecutionID: "exec_1",
		Title:       "End to End",
		Capability:  "noop",
		Input:       json.RawMessage(`{"prompt":"hello"}`),
	})); err != nil {
		t.Fatalf("Hub.Send(task.push) error = %v", err)
	}

	pushEnvelope := mustReadEnvelope(t, conn)
	if pushEnvelope.Type != "task.push" {
		t.Fatalf("expected task.push, got %+v", pushEnvelope)
	}

	mustWriteEnvelope(t, conn, mustStatefulEnvelope(t, "exec_1", "task.accepted", proto.TaskAcceptedPayload{
		ExecutionID:    "exec_1",
		CapabilityUsed: "noop",
		CLIPath:        "/usr/bin/noop",
		CLIVersion:     "0.1.0",
	}))
	mustWriteEnvelope(t, conn, mustStreamEnvelope(t, "exec_1", "task.log_chunk", "stdout", 1, proto.TaskLogChunkPayload{
		ExecutionID: "exec_1",
		Stream:      "stdout",
		Chunks: []proto.TaskLogChunk{
			{Seq: 1, Text: "hello\n", TimestampMs: time.Now().UnixMilli()},
		},
	}))
	mustWriteEnvelope(t, conn, mustStatefulEnvelope(t, "exec_1", "task.finished", proto.TaskFinishedPayload{
		ExecutionID: "exec_1",
		ExitCode:    0,
		DurationMs:  1200,
		ResultURI:   "prismer://result/e2e",
		Summary:     "done",
	}))

	waitForServerCondition(t, "task completion", func() bool {
		task, ok := store.LookupTask("task_1")
		return ok && task.Status == "completed"
	})

	controller := controlpkg.New(store, app.Hub)
	if err := controller.CancelExecution(ctx, "exec_1", "late cancel"); err != nil {
		t.Fatalf("CancelExecution() error = %v", err)
	}

	task, _ := store.LookupTask("task_1")
	if task.Status != "completed" {
		t.Fatalf("expected completed task after late cancel, got %+v", task)
	}
	execRow, _ := store.LookupTaskExecution("exec_1")
	if execRow.Status != "succeeded" || execRow.ResultRef != "prismer://result/e2e" {
		t.Fatalf("expected succeeded execution after late cancel, got %+v", execRow)
	}
	if _, ok := store.GetTaskLog("log_exec_1_cancel"); ok {
		t.Fatalf("did not expect cancel log after late cancel")
	}
	assertNoEnvelope(t, conn, 200*time.Millisecond)
}

func TestEndToEndReconnectResumeAndReplayCompleteTask(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	store := shareddb.NewMemoryStore()
	app := NewApp(Config{}, Dependencies{
		Store:      store,
		WSUpgrader: transport.NewGorillaUpgrader(websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}),
	})
	endpoint := newInMemoryWSEndpoint(app.HTTPHandler)
	defer endpoint.Close()

	conn1 := endpoint.mustConnect(t, "ws://prismer.test/ws/runtime")
	defer conn1.Close()
	mustWriteEnvelope(t, conn1, mustStatefulEnvelope(t, "exec_runtime", "runtime.hello", proto.RuntimeHelloPayload{
		DID:       "did:key:e2e-runtime",
		SessionID: "sess_e2e_2",
		Version:   "0.1.0",
		Host:      proto.RuntimeHelloHost{Hostname: "host", OS: "linux", Arch: "amd64"},
	}))

	waitForServerCondition(t, "runtime connection", func() bool {
		return app.Hub.ConnectionCount() == 1
	})

	mustSeedDispatchedTask(t, ctx, store, "did:key:e2e-runtime", "task_2", "exec_2")
	if err := app.Hub.Send(ctx, "did:key:e2e-runtime", mustTaskPushEnvelopeBytes(t, proto.TaskPushPayload{
		TaskID:      "task_2",
		ExecutionID: "exec_2",
		Title:       "Reconnect",
		Capability:  "noop",
		Input:       json.RawMessage(`{"prompt":"reconnect"}`),
	})); err != nil {
		t.Fatalf("Hub.Send(task.push) error = %v", err)
	}

	pushEnvelope := mustReadEnvelope(t, conn1)
	if pushEnvelope.Type != "task.push" {
		t.Fatalf("expected task.push, got %+v", pushEnvelope)
	}

	mustWriteEnvelope(t, conn1, mustStatefulEnvelope(t, "exec_2", "task.accepted", proto.TaskAcceptedPayload{
		ExecutionID:    "exec_2",
		CapabilityUsed: "noop",
		CLIPath:        "/usr/bin/noop",
		CLIVersion:     "0.1.0",
	}))
	mustWriteEnvelope(t, conn1, mustStreamEnvelope(t, "exec_2", "task.log_chunk", "stdout", 1, proto.TaskLogChunkPayload{
		ExecutionID: "exec_2",
		Stream:      "stdout",
		Chunks: []proto.TaskLogChunk{
			{Seq: 1, Text: "before-reconnect\n", TimestampMs: time.Now().UnixMilli()},
		},
	}))

	waitForServerCondition(t, "first cursor", func() bool {
		cursor, ok := store.GetStreamCursorForTest("exec_2", "stdout")
		return ok && cursor.LastCommittedSeq == 1
	})

	endpoint.DisconnectCurrent()
	_ = conn1.Close()

	conn2 := endpoint.mustConnect(t, "ws://prismer.test/ws/runtime")
	defer conn2.Close()
	mustWriteEnvelope(t, conn2, mustStatefulEnvelope(t, "exec_runtime_reconnect", "runtime.hello", proto.RuntimeHelloPayload{
		DID:       "did:key:e2e-runtime",
		SessionID: "sess_e2e_2",
		Version:   "0.1.0",
		Host:      proto.RuntimeHelloHost{Hostname: "host", OS: "linux", Arch: "amd64"},
	}))

	waitForServerCondition(t, "reconnected runtime", func() bool {
		return app.Hub.ConnectionCount() == 1
	})

	mustWriteEnvelope(t, conn2, mustStatefulEnvelope(t, "exec_2", "stream.resume_request", proto.StreamResumeRequestPayload{
		ExecutionID: "exec_2",
		Streams:     []string{"stdout"},
	}))

	resumeAckEnvelope := mustReadEnvelope(t, conn2)
	if resumeAckEnvelope.Type != "stream.resume_ack" {
		t.Fatalf("expected stream.resume_ack, got %+v", resumeAckEnvelope)
	}
	var resumeAck proto.StreamResumeAckPayload
	if err := json.Unmarshal(resumeAckEnvelope.Payload, &resumeAck); err != nil {
		t.Fatalf("json.Unmarshal(resume ack) error = %v", err)
	}
	if len(resumeAck.Streams) != 1 || resumeAck.Streams[0].LastCommittedSeq != 1 {
		t.Fatalf("expected resume ack seq=1, got %+v", resumeAck)
	}

	mustWriteEnvelope(t, conn2, mustStatefulEnvelope(t, "exec_2", "task.accepted", proto.TaskAcceptedPayload{
		ExecutionID:    "exec_2",
		CapabilityUsed: "noop",
		CLIPath:        "/usr/bin/noop",
		CLIVersion:     "0.1.0",
	}))
	mustWriteEnvelope(t, conn2, mustStreamEnvelope(t, "exec_2", "task.log_chunk", "stdout", 2, proto.TaskLogChunkPayload{
		ExecutionID: "exec_2",
		Stream:      "stdout",
		Chunks: []proto.TaskLogChunk{
			{Seq: 2, Text: "after-reconnect\n", TimestampMs: time.Now().UnixMilli()},
		},
	}))
	mustWriteEnvelope(t, conn2, mustStatefulEnvelope(t, "exec_2", "task.finished", proto.TaskFinishedPayload{
		ExecutionID: "exec_2",
		ExitCode:    0,
		DurationMs:  2400,
		Summary:     "done",
	}))

	waitForServerCondition(t, "task completion after reconnect", func() bool {
		task, ok := store.LookupTask("task_2")
		return ok && task.Status == "completed"
	})

	task, _ := store.LookupTask("task_2")
	if task.Status != "completed" {
		t.Fatalf("expected completed task after reconnect, got %+v", task)
	}
	execRow, _ := store.LookupTaskExecution("exec_2")
	if execRow.Status != "succeeded" {
		t.Fatalf("expected succeeded execution after reconnect, got %+v", execRow)
	}
	cursor, ok := store.GetStreamCursorForTest("exec_2", "stdout")
	if !ok || cursor.LastCommittedSeq != 2 {
		t.Fatalf("expected resumed cursor seq=2, got %+v ok=%v", cursor, ok)
	}
}

func TestEndToEndFailedThenRetriedDispatchSucceeds(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	store := shareddb.NewMemoryStore()
	app := NewApp(Config{}, Dependencies{
		Store:      store,
		WSUpgrader: transport.NewGorillaUpgrader(websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}),
	})
	endpoint := newInMemoryWSEndpoint(app.HTTPHandler)
	defer endpoint.Close()

	conn := endpoint.mustConnect(t, "ws://prismer.test/ws/runtime")
	defer conn.Close()

	mustWriteEnvelope(t, conn, mustStatefulEnvelope(t, "exec_runtime", "runtime.hello", proto.RuntimeHelloPayload{
		DID:       "did:key:e2e-runtime",
		SessionID: "sess_e2e_retry",
		Version:   "0.1.0",
		Host:      proto.RuntimeHelloHost{Hostname: "host", OS: "linux", Arch: "amd64"},
	}))
	mustWriteEnvelope(t, conn, mustStatefulEnvelope(t, "exec_runtime", "runtime.capability_report", proto.RuntimeCapabilityReportPayload{
		Capabilities: []proto.RuntimeCapability{{Key: "noop", Version: "0.1.0"}},
		ScannedAtMs:  time.Now().UnixMilli(),
	}))

	waitForServerCondition(t, "runtime ready for dispatch", func() bool {
		runtime, ok := store.GetRuntime("did:key:e2e-runtime")
		return ok && runtime.Capabilities != "[]"
	})

	store.PutTask(shareddb.Task{
		ID:           "task_retry_e2e",
		Title:        "Retry E2E",
		Capability:   "noop",
		Input:        `{"prompt":"retry"}`,
		Status:       "pending",
		MaxRetries:   2,
		RetryDelayMs: 1,
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	})

	firstDispatch, err := app.Dispatcher.DispatchTask(ctx, "task_retry_e2e")
	if err != nil {
		t.Fatalf("DispatchTask(first) error = %v", err)
	}
	firstPush := mustReadEnvelope(t, conn)
	if firstPush.Type != "task.push" || firstPush.ExecutionID != firstDispatch.ExecutionID {
		t.Fatalf("unexpected first task.push: %+v result=%+v", firstPush, firstDispatch)
	}

	mustWriteEnvelope(t, conn, mustStatefulEnvelope(t, firstDispatch.ExecutionID, "task.accepted", proto.TaskAcceptedPayload{
		ExecutionID:    firstDispatch.ExecutionID,
		CapabilityUsed: "noop",
		CLIPath:        "/usr/bin/noop",
		CLIVersion:     "0.1.0",
	}))
	mustWriteEnvelope(t, conn, mustStatefulEnvelope(t, firstDispatch.ExecutionID, "task.finished", proto.TaskFinishedPayload{
		ExecutionID: firstDispatch.ExecutionID,
		ExitCode:    1,
		DurationMs:  200,
		Summary:     "boom",
	}))

	waitForServerCondition(t, "task scheduled for retry", func() bool {
		task, ok := store.LookupTask("task_retry_e2e")
		return ok && task.Status == "pending" && task.RetryCount == 1 && task.NextRunAt != nil
	})
	waitForServerCondition(t, "retry due", func() bool {
		task, ok := store.LookupTask("task_retry_e2e")
		return ok && task.NextRunAt != nil && !task.NextRunAt.After(time.Now())
	})

	secondDispatch, err := app.Dispatcher.DispatchTask(ctx, "task_retry_e2e")
	if err != nil {
		t.Fatalf("DispatchTask(second) error = %v", err)
	}
	if secondDispatch.ExecutionID == firstDispatch.ExecutionID {
		t.Fatalf("expected new execution id on retry, got %+v", secondDispatch)
	}

	secondPush := mustReadEnvelope(t, conn)
	if secondPush.Type != "task.push" || secondPush.ExecutionID != secondDispatch.ExecutionID {
		t.Fatalf("unexpected second task.push: %+v result=%+v", secondPush, secondDispatch)
	}

	mustWriteEnvelope(t, conn, mustStatefulEnvelope(t, secondDispatch.ExecutionID, "task.accepted", proto.TaskAcceptedPayload{
		ExecutionID:    secondDispatch.ExecutionID,
		CapabilityUsed: "noop",
		CLIPath:        "/usr/bin/noop",
		CLIVersion:     "0.1.0",
	}))
	mustWriteEnvelope(t, conn, mustStatefulEnvelope(t, secondDispatch.ExecutionID, "task.finished", proto.TaskFinishedPayload{
		ExecutionID: secondDispatch.ExecutionID,
		ExitCode:    0,
		DurationMs:  180,
		Summary:     "recovered",
	}))

	waitForServerCondition(t, "task completed after retry", func() bool {
		task, ok := store.LookupTask("task_retry_e2e")
		return ok && task.Status == "completed"
	})

	task, _ := store.LookupTask("task_retry_e2e")
	if task.Status != "completed" || task.RetryCount != 1 {
		t.Fatalf("unexpected final task state: %+v", task)
	}
	firstExec, _ := store.LookupTaskExecution(firstDispatch.ExecutionID)
	if firstExec.Status != "failed" || firstExec.Attempt != 1 {
		t.Fatalf("unexpected first execution state: %+v", firstExec)
	}
	secondExec, _ := store.LookupTaskExecution(secondDispatch.ExecutionID)
	if secondExec.Status != "succeeded" || secondExec.Attempt != 2 {
		t.Fatalf("unexpected second execution state: %+v", secondExec)
	}
}

func TestEndToEndApprovalGateBlocksThenAllowsDispatch(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	store := shareddb.NewMemoryStore()
	app := NewApp(Config{}, Dependencies{
		Store:      store,
		WSUpgrader: transport.NewGorillaUpgrader(websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}),
	})
	endpoint := newInMemoryWSEndpoint(app.HTTPHandler)
	defer endpoint.Close()

	conn := endpoint.mustConnect(t, "ws://prismer.test/ws/runtime")
	defer conn.Close()

	mustWriteEnvelope(t, conn, mustStatefulEnvelope(t, "exec_runtime", "runtime.hello", proto.RuntimeHelloPayload{
		DID:       "did:key:e2e-runtime",
		SessionID: "sess_e2e_approval",
		Version:   "0.1.0",
		Host:      proto.RuntimeHelloHost{Hostname: "host", OS: "linux", Arch: "amd64"},
	}))
	mustWriteEnvelope(t, conn, mustStatefulEnvelope(t, "exec_runtime", "runtime.capability_report", proto.RuntimeCapabilityReportPayload{
		Capabilities: []proto.RuntimeCapability{{Key: "noop", Version: "0.1.0"}},
		ScannedAtMs:  time.Now().UnixMilli(),
	}))

	waitForServerCondition(t, "runtime ready for approval dispatch", func() bool {
		runtime, ok := store.GetRuntime("did:key:e2e-runtime")
		return ok && runtime.Capabilities != "[]"
	})

	store.PutTask(shareddb.Task{
		ID:                "task_approval_e2e",
		Title:             "Approval E2E",
		Capability:        "noop",
		Input:             `{"prompt":"approval"}`,
		Status:            "pending",
		RequiresApproval:  true,
		PendingApprovalID: "appr_e2e",
		CreatedAt:         time.Now(),
		UpdatedAt:         time.Now(),
	})
	if _, err := store.CreateTaskApproval(ctx, shareddb.CreateTaskApprovalParams{
		ID:               "appr_e2e",
		TaskID:           "task_approval_e2e",
		Kind:             "dangerous_action",
		Action:           "deploy",
		Payload:          `{}`,
		RequestedByDid:   "did:key:req",
		RequestSignature: "sig",
		Metadata:         `{}`,
	}); err != nil {
		t.Fatalf("CreateTaskApproval() error = %v", err)
	}

	if _, err := app.Dispatcher.DispatchTask(ctx, "task_approval_e2e"); !errors.Is(err, dispatcherpkg.ErrTaskApprovalRequired) {
		t.Fatalf("expected ErrTaskApprovalRequired, got %v", err)
	}

	if err := store.DecideTaskApproval(ctx, shareddb.DecideTaskApprovalParams{
		ApprovalID:        "appr_e2e",
		Status:            "approved",
		DecisionReason:    "ok",
		DecisionSignature: "sig2",
	}); err != nil {
		t.Fatalf("DecideTaskApproval() error = %v", err)
	}

	dispatchResult, err := app.Dispatcher.DispatchTask(ctx, "task_approval_e2e")
	if err != nil {
		t.Fatalf("DispatchTask() after approval error = %v", err)
	}

	pushEnvelope := mustReadEnvelope(t, conn)
	if pushEnvelope.Type != "task.push" || pushEnvelope.ExecutionID != dispatchResult.ExecutionID {
		t.Fatalf("unexpected task.push after approval: %+v result=%+v", pushEnvelope, dispatchResult)
	}
}

func TestEndToEndRejectedApprovalCancelsTaskAndBlocksDispatch(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	store := shareddb.NewMemoryStore()
	app := NewApp(Config{}, Dependencies{
		Store:      store,
		WSUpgrader: transport.NewGorillaUpgrader(websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}),
	})
	endpoint := newInMemoryWSEndpoint(app.HTTPHandler)
	defer endpoint.Close()

	conn := endpoint.mustConnect(t, "ws://prismer.test/ws/runtime")
	defer conn.Close()

	mustWriteEnvelope(t, conn, mustStatefulEnvelope(t, "exec_runtime", "runtime.hello", proto.RuntimeHelloPayload{
		DID:       "did:key:e2e-runtime",
		SessionID: "sess_e2e_approval_reject",
		Version:   "0.1.0",
		Host:      proto.RuntimeHelloHost{Hostname: "host", OS: "linux", Arch: "amd64"},
	}))
	mustWriteEnvelope(t, conn, mustStatefulEnvelope(t, "exec_runtime", "runtime.capability_report", proto.RuntimeCapabilityReportPayload{
		Capabilities: []proto.RuntimeCapability{{Key: "noop", Version: "0.1.0"}},
		ScannedAtMs:  time.Now().UnixMilli(),
	}))

	waitForServerCondition(t, "runtime ready for rejected approval dispatch", func() bool {
		runtime, ok := store.GetRuntime("did:key:e2e-runtime")
		return ok && runtime.Capabilities != "[]"
	})

	if _, err := store.CreateTask(ctx, shareddb.CreateTaskParams{
		ID:         "task_approval_reject_e2e",
		Title:      "Approval Reject E2E",
		Capability: "noop",
		Input:      `{"prompt":"approval"}`,
		CreatorID:  "debug",
		Status:     "pending",
		Metadata:   `{}`,
	}); err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}
	if _, err := store.CreateTaskApproval(ctx, shareddb.CreateTaskApprovalParams{
		ID:               "appr_reject_e2e",
		TaskID:           "task_approval_reject_e2e",
		Kind:             "dangerous_action",
		Action:           "deploy",
		Payload:          `{}`,
		RequestedByDid:   "did:key:req",
		RequestSignature: "sig",
		Metadata:         `{}`,
	}); err != nil {
		t.Fatalf("CreateTaskApproval() error = %v", err)
	}

	if err := store.DecideTaskApproval(ctx, shareddb.DecideTaskApprovalParams{
		ApprovalID:     "appr_reject_e2e",
		Status:         "rejected",
		DecisionReason: "denied",
	}); err != nil {
		t.Fatalf("DecideTaskApproval() error = %v", err)
	}

	task, _ := store.LookupTask("task_approval_reject_e2e")
	if task.Status != "cancelled" || task.RequiresApproval || task.PendingApprovalID != "" {
		t.Fatalf("expected rejected approval to cancel task, got %+v", task)
	}
	if _, err := app.Dispatcher.DispatchTask(ctx, "task_approval_reject_e2e"); !errors.Is(err, dispatcherpkg.ErrTaskNotDispatchable) {
		t.Fatalf("expected ErrTaskNotDispatchable, got %v", err)
	}
	if log, ok := store.GetTaskLog("log_appr_reject_e2e_approval_rejected"); !ok || log.Action != "approval.rejected" {
		t.Fatalf("expected approval rejected log, got %+v ok=%v", log, ok)
	}
}

func TestEndToEndApprovalRequestThenDecisionOverWebSocket(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	store := shareddb.NewMemoryStore()
	app := NewApp(Config{}, Dependencies{
		Store:      store,
		WSUpgrader: transport.NewGorillaUpgrader(websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}),
	})
	endpoint := newInMemoryWSEndpoint(app.HTTPHandler)
	defer endpoint.Close()

	conn := endpoint.mustConnect(t, "ws://prismer.test/ws/runtime")
	defer conn.Close()

	mustWriteEnvelope(t, conn, mustStatefulEnvelope(t, "exec_runtime", "runtime.hello", proto.RuntimeHelloPayload{
		DID:       "did:key:e2e-runtime",
		SessionID: "sess_e2e_approval_ws",
		Version:   "0.1.0",
		Host:      proto.RuntimeHelloHost{Hostname: "host", OS: "linux", Arch: "amd64"},
	}))

	waitForServerCondition(t, "runtime ready for websocket approval", func() bool {
		return app.Hub.ConnectionCount() == 1
	})

	store.PutTask(shareddb.Task{
		ID:        "task_approval_ws_e2e",
		Title:     "Approval WS E2E",
		Status:    "assigned",
		RuntimeID: "did:key:e2e-runtime",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	})

	mustWriteEnvelope(t, conn, mustStatefulEnvelope(t, "task_approval_ws_e2e", "approval.request", proto.ApprovalRequestPayload{
		ApprovalID:       "appr_ws_e2e",
		TaskID:           "task_approval_ws_e2e",
		Kind:             "dangerous_action",
		Action:           "git_push_force",
		Payload:          json.RawMessage(`{"branch":"main"}`),
		RequestSignature: "sig_req",
	}))

	waitForServerCondition(t, "approval request stored", func() bool {
		approval, err := store.GetPendingApproval(ctx, "appr_ws_e2e")
		return err == nil && approval.TaskID == "task_approval_ws_e2e"
	})

	req := httptest.NewRequest(http.MethodPost, "/debug/approvals/decide", strings.NewReader(`{"approval_id":"appr_ws_e2e","status":"approved","decision_reason":"ok"}`))
	rec := httptest.NewRecorder()
	app.HTTPHandler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 from approval decide endpoint, got %d body=%q", rec.Code, rec.Body.String())
	}

	decisionEnvelope := mustReadEnvelope(t, conn)
	if decisionEnvelope.Type != "approval.decision" {
		t.Fatalf("expected approval.decision, got %+v", decisionEnvelope)
	}
	var decision proto.ApprovalDecisionPayload
	if err := json.Unmarshal(decisionEnvelope.Payload, &decision); err != nil {
		t.Fatalf("json.Unmarshal(approval decision) error = %v", err)
	}
	if decision.ApprovalID != "appr_ws_e2e" || decision.Decision != "approved" || decision.TaskID != "task_approval_ws_e2e" {
		t.Fatalf("unexpected approval decision payload: %+v", decision)
	}
}

type inMemoryWSEndpoint struct {
	handler http.Handler

	mu      sync.Mutex
	current *endpointConn
	conns   []*endpointConn
}

type endpointConn struct {
	serverConn net.Conn
	clientConn net.Conn
}

func newInMemoryWSEndpoint(handler http.Handler) *inMemoryWSEndpoint {
	return &inMemoryWSEndpoint{handler: handler}
}

func (e *inMemoryWSEndpoint) mustConnect(t *testing.T, urlStr string) *websocket.Conn {
	t.Helper()
	serverConn, clientConn := net.Pipe()
	conn := &endpointConn{
		serverConn: serverConn,
		clientConn: clientConn,
	}

	e.mu.Lock()
	e.current = conn
	e.conns = append(e.conns, conn)
	e.mu.Unlock()

	go func() {
		reader := bufio.NewReader(serverConn)
		req, err := http.ReadRequest(reader)
		if err != nil {
			return
		}
		req.RemoteAddr = "pipe"
		req.RequestURI = req.URL.RequestURI()
		e.handler.ServeHTTP(newE2EPipeResponseWriter(serverConn, reader), req)
	}()

	u, err := url.Parse(urlStr)
	if err != nil {
		t.Fatalf("url.Parse() error = %v", err)
	}
	wsConn, _, err := websocket.NewClient(clientConn, u, http.Header{
		"Origin": []string{"http://prismer.test"},
	}, 1024, 1024)
	if err != nil {
		t.Fatalf("websocket.NewClient() error = %v", err)
	}
	return wsConn
}

func (e *inMemoryWSEndpoint) DisconnectCurrent() {
	e.mu.Lock()
	current := e.current
	e.mu.Unlock()
	if current != nil {
		_ = current.serverConn.Close()
	}
}

func (e *inMemoryWSEndpoint) Close() {
	e.mu.Lock()
	conns := append([]*endpointConn(nil), e.conns...)
	e.current = nil
	e.conns = nil
	e.mu.Unlock()

	for _, conn := range conns {
		_ = conn.serverConn.Close()
		_ = conn.clientConn.Close()
	}
}

type e2ePipeResponseWriter struct {
	conn   net.Conn
	reader *bufio.Reader
	header http.Header
}

func newE2EPipeResponseWriter(conn net.Conn, reader *bufio.Reader) *e2ePipeResponseWriter {
	return &e2ePipeResponseWriter{
		conn:   conn,
		reader: reader,
		header: make(http.Header),
	}
}

func (w *e2ePipeResponseWriter) Header() http.Header {
	return w.header
}

func (w *e2ePipeResponseWriter) WriteHeader(statusCode int) {}

func (w *e2ePipeResponseWriter) Write(data []byte) (int, error) {
	return w.conn.Write(data)
}

func (w *e2ePipeResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return w.conn, bufio.NewReadWriter(w.reader, bufio.NewWriter(w.conn)), nil
}

func mustSeedDispatchedTask(t *testing.T, ctx context.Context, store *shareddb.MemoryStore, runtimeID string, taskID string, executionID string) {
	t.Helper()
	store.PutTask(shareddb.Task{
		ID:         taskID,
		Title:      "e2e",
		Capability: "noop",
		Status:     "assigned",
		RuntimeID:  runtimeID,
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
	})
	if _, err := store.InsertTaskExecution(ctx, shareddb.InsertTaskExecutionParams{
		ID:        executionID,
		TaskID:    taskID,
		RuntimeID: runtimeID,
		Attempt:   1,
		Status:    "dispatched",
	}); err != nil {
		t.Fatalf("InsertTaskExecution(%s) error = %v", executionID, err)
	}
}

func mustStatefulEnvelope(t *testing.T, executionID string, messageType string, payload any) proto.Envelope {
	t.Helper()
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("json.Marshal(payload) error = %v", err)
	}
	payloadHash, err := proto.ComputePayloadHash(payloadBytes)
	if err != nil {
		t.Fatalf("ComputePayloadHash() error = %v", err)
	}
	return proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           "msg_" + messageType,
		ExecutionID:  executionID,
		Type:         messageType,
		MessageClass: proto.MessageClassStateful,
		TimestampMs:  time.Now().UnixMilli(),
		StateVersion: testStateVersionForMessageType(messageType),
		PayloadHash:  payloadHash,
		AckType:      proto.AckTypeRequired,
		Payload:      payloadBytes,
	}
}

func testStateVersionForMessageType(messageType string) int64 {
	switch messageType {
	case "task.finished", "task.rejected":
		return 2
	default:
		return 1
	}
}

func mustStreamEnvelope(t *testing.T, executionID string, messageType string, streamID string, streamSeq int64, payload any) proto.Envelope {
	t.Helper()
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("json.Marshal(payload) error = %v", err)
	}
	return proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           "msg_" + messageType,
		ExecutionID:  executionID,
		Type:         messageType,
		MessageClass: proto.MessageClassStream,
		TimestampMs:  time.Now().UnixMilli(),
		StreamID:     streamID,
		StreamSeq:    streamSeq,
		AckType:      proto.AckTypeBestEffort,
		Payload:      payloadBytes,
	}
}

func mustTaskPushEnvelopeBytes(t *testing.T, payload proto.TaskPushPayload) []byte {
	t.Helper()
	envelope := mustStatefulEnvelope(t, payload.ExecutionID, "task.push", payload)
	wire, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("json.Marshal(task push envelope) error = %v", err)
	}
	return wire
}

func mustWriteEnvelope(t *testing.T, conn *websocket.Conn, envelope proto.Envelope) {
	t.Helper()
	wire, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("json.Marshal(envelope) error = %v", err)
	}
	if err := conn.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("SetWriteDeadline() error = %v", err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, wire); err != nil {
		t.Fatalf("WriteMessage() error = %v", err)
	}
}

func mustReadEnvelope(t *testing.T, conn *websocket.Conn) proto.Envelope {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("SetReadDeadline() error = %v", err)
	}
	_, wire, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("ReadMessage() error = %v", err)
	}
	var envelope proto.Envelope
	if err := json.Unmarshal(wire, &envelope); err != nil {
		t.Fatalf("json.Unmarshal(envelope) error = %v", err)
	}
	if err := envelope.Validate(); err != nil {
		t.Fatalf("envelope.Validate() error = %v", err)
	}
	return envelope
}

func assertNoEnvelope(t *testing.T, conn *websocket.Conn, duration time.Duration) {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(duration)); err != nil {
		t.Fatalf("SetReadDeadline() error = %v", err)
	}
	_, _, err := conn.ReadMessage()
	if err == nil {
		t.Fatal("expected no outbound websocket message")
	}
	var netErr net.Error
	if !errors.As(err, &netErr) || !netErr.Timeout() {
		t.Fatalf("expected timeout while waiting for no message, got %v", err)
	}
}

func waitForServerCondition(t *testing.T, name string, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", name)
}
