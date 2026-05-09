package app

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/Prismer-AI/PrismerCloud/services/daemon/internal/approval"
	"github.com/Prismer-AI/PrismerCloud/services/daemon/internal/ws"
	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
	"github.com/gorilla/websocket"
)

func TestAppApprovalFlowCompletesAfterDecision(t *testing.T) {
	server := newAppTestWSServer(t)
	defer server.Close()

	app := New(Config{
		WS: wsConfigForTest(),
	})
	app.Client.SetDialer(server)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := app.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer app.Close()

	hello := server.mustReadEnvelope(t)
	if hello.Type != "runtime.hello" {
		t.Fatalf("expected runtime.hello, got %+v", hello)
	}
	report := server.mustReadEnvelope(t)
	if report.Type != "runtime.capability_report" {
		t.Fatalf("expected runtime.capability_report, got %+v", report)
	}

	if err := server.writeEnvelope(mustAppServerStatefulEnvelope(t, "exec_1", "task.push", proto.TaskPushPayload{
		TaskID:           "task_1",
		ExecutionID:      "exec_1",
		Title:            "Approval Demo",
		Capability:       "noop",
		RequiresApproval: false,
		Input:            json.RawMessage(`{"approval":{"kind":"dangerous_action","action":"git_push_force","payload":{"branch":"main"}}}`),
	})); err != nil {
		t.Fatalf("write task.push error = %v", err)
	}

	resumeReq := server.mustReadEnvelope(t)
	if resumeReq.Type != "stream.resume_request" || resumeReq.ExecutionID != "exec_1" {
		t.Fatalf("expected stream.resume_request for exec_1, got %+v", resumeReq)
	}
	if err := server.writeEnvelope(mustAppServerStatefulEnvelope(t, "exec_1", "stream.resume_ack", proto.StreamResumeAckPayload{
		ExecutionID: "exec_1",
		Streams: []proto.StreamResumeAckStream{
			{StreamID: "stdout", LastCommittedSeq: 0},
			{StreamID: "stderr", LastCommittedSeq: 0},
			{StreamID: "progress", LastCommittedSeq: 0},
		},
	})); err != nil {
		t.Fatalf("write stream.resume_ack error = %v", err)
	}

	accepted := server.mustReadEnvelope(t)
	if accepted.Type != "task.accepted" {
		t.Fatalf("expected task.accepted, got %+v", accepted)
	}

	approvalReq := server.mustReadEnvelope(t)
	if approvalReq.Type != "approval.request" || approvalReq.ExecutionID != "task_1" {
		t.Fatalf("expected approval.request for task_1, got %+v", approvalReq)
	}
	var approvalPayload proto.ApprovalRequestPayload
	if err := json.Unmarshal(approvalReq.Payload, &approvalPayload); err != nil {
		t.Fatalf("json.Unmarshal(approval request) error = %v", err)
	}
	if approvalPayload.Action != "git_push_force" || approvalPayload.Kind != "dangerous_action" {
		t.Fatalf("unexpected approval request payload: %+v", approvalPayload)
	}

	if err := server.writeEnvelope(mustAppServerStatefulEnvelope(t, "task_1", "approval.decision", proto.ApprovalDecisionPayload{
		ApprovalID:  approvalPayload.ApprovalID,
		TaskID:      "task_1",
		Decision:    "approved",
		DecidedAtMs: time.Now().UnixMilli(),
	})); err != nil {
		t.Fatalf("write approval.decision error = %v", err)
	}

	log1 := server.mustReadEnvelope(t)
	if log1.Type != "task.log_chunk" {
		t.Fatalf("expected first task.log_chunk, got %+v", log1)
	}
	var log1Payload proto.TaskLogChunkPayload
	if err := json.Unmarshal(log1.Payload, &log1Payload); err != nil {
		t.Fatalf("json.Unmarshal(log1) error = %v", err)
	}
	if len(log1Payload.Chunks) != 1 || log1Payload.Chunks[0].Text != "approval granted\n" {
		t.Fatalf("unexpected first log chunk: %+v", log1Payload)
	}

	finished := server.waitForEnvelopeType(t, "task.finished")
	var finishedPayload proto.TaskFinishedPayload
	if err := json.Unmarshal(finished.Payload, &finishedPayload); err != nil {
		t.Fatalf("json.Unmarshal(finished) error = %v", err)
	}
	if finishedPayload.ExitCode != 0 {
		t.Fatalf("unexpected finished payload: %+v", finishedPayload)
	}
}

func TestAppApprovalFlowRejectsAfterDecision(t *testing.T) {
	server := newAppTestWSServer(t)
	defer server.Close()

	app := New(Config{
		WS: wsConfigForTest(),
	})
	app.Client.SetDialer(server)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := app.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer app.Close()

	_ = server.mustReadEnvelope(t) // runtime.hello
	_ = server.mustReadEnvelope(t) // runtime.capability_report

	if err := server.writeEnvelope(mustAppServerStatefulEnvelope(t, "exec_2", "task.push", proto.TaskPushPayload{
		TaskID:      "task_2",
		ExecutionID: "exec_2",
		Title:       "Approval Reject Demo",
		Capability:  "noop",
		Input:       json.RawMessage(`{"approval":{"kind":"dangerous_action","action":"git_push_force","payload":{"branch":"main"}}}`),
	})); err != nil {
		t.Fatalf("write task.push error = %v", err)
	}

	resumeReq := server.mustReadEnvelope(t)
	if resumeReq.Type != "stream.resume_request" || resumeReq.ExecutionID != "exec_2" {
		t.Fatalf("expected stream.resume_request for exec_2, got %+v", resumeReq)
	}
	if err := server.writeEnvelope(mustAppServerStatefulEnvelope(t, "exec_2", "stream.resume_ack", proto.StreamResumeAckPayload{
		ExecutionID: "exec_2",
		Streams: []proto.StreamResumeAckStream{
			{StreamID: "stdout", LastCommittedSeq: 0},
			{StreamID: "stderr", LastCommittedSeq: 0},
			{StreamID: "progress", LastCommittedSeq: 0},
		},
	})); err != nil {
		t.Fatalf("write stream.resume_ack error = %v", err)
	}

	accepted := server.mustReadEnvelope(t)
	if accepted.Type != "task.accepted" {
		t.Fatalf("expected task.accepted, got %+v", accepted)
	}

	approvalReq := server.mustReadEnvelope(t)
	if approvalReq.Type != "approval.request" {
		t.Fatalf("expected approval.request, got %+v", approvalReq)
	}
	var approvalPayload proto.ApprovalRequestPayload
	if err := json.Unmarshal(approvalReq.Payload, &approvalPayload); err != nil {
		t.Fatalf("json.Unmarshal(approval request) error = %v", err)
	}

	if err := server.writeEnvelope(mustAppServerStatefulEnvelope(t, "task_2", "approval.decision", proto.ApprovalDecisionPayload{
		ApprovalID:  approvalPayload.ApprovalID,
		TaskID:      "task_2",
		Decision:    "rejected",
		DecidedAtMs: time.Now().UnixMilli(),
	})); err != nil {
		t.Fatalf("write approval.decision error = %v", err)
	}

	rejected := server.waitForEnvelopeType(t, "task.rejected")
	var rejectedPayload proto.TaskRejectedPayload
	if err := json.Unmarshal(rejected.Payload, &rejectedPayload); err != nil {
		t.Fatalf("json.Unmarshal(rejected) error = %v", err)
	}
	if rejectedPayload.ExecutionID != "exec_2" || rejectedPayload.Reason != "approval rejected" || rejectedPayload.Retryable {
		t.Fatalf("unexpected rejected payload: %+v", rejectedPayload)
	}
}

func TestAppApprovalPolicyTriggersApprovalRequest(t *testing.T) {
	server := newAppTestWSServer(t)
	defer server.Close()

	app := New(Config{
		WS: wsConfigForTest(),
		ApprovalPolicy: approval.Policy{
			Enforce: true,
			DangerousActions: map[string]struct{}{
				"git_push_force": {},
			},
			TaskCreateBudgetOver: 1000,
		},
	})
	app.Client.SetDialer(server)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := app.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer app.Close()

	_ = server.mustReadEnvelope(t) // runtime.hello
	_ = server.mustReadEnvelope(t) // runtime.capability_report

	if err := server.writeEnvelope(mustAppServerStatefulEnvelope(t, "exec_3", "task.push", proto.TaskPushPayload{
		TaskID:      "task_3",
		ExecutionID: "exec_3",
		Title:       "Policy Demo",
		Capability:  "noop",
		Input:       json.RawMessage(`{"action":"git_push_force","branch":"main"}`),
	})); err != nil {
		t.Fatalf("write task.push error = %v", err)
	}

	_ = server.mustReadEnvelope(t) // stream.resume_request
	if err := server.writeEnvelope(mustAppServerStatefulEnvelope(t, "exec_3", "stream.resume_ack", proto.StreamResumeAckPayload{
		ExecutionID: "exec_3",
		Streams: []proto.StreamResumeAckStream{
			{StreamID: "stdout", LastCommittedSeq: 0},
			{StreamID: "stderr", LastCommittedSeq: 0},
			{StreamID: "progress", LastCommittedSeq: 0},
		},
	})); err != nil {
		t.Fatalf("write stream.resume_ack error = %v", err)
	}

	_ = server.mustReadEnvelope(t) // task.accepted
	approvalReq := server.mustReadEnvelope(t)
	if approvalReq.Type != "approval.request" {
		t.Fatalf("expected approval.request, got %+v", approvalReq)
	}
	var approvalPayload proto.ApprovalRequestPayload
	if err := json.Unmarshal(approvalReq.Payload, &approvalPayload); err != nil {
		t.Fatalf("json.Unmarshal(approval request) error = %v", err)
	}
	if approvalPayload.Kind != "dangerous_action" || approvalPayload.Action != "git_push_force" {
		t.Fatalf("unexpected approval request payload: %+v", approvalPayload)
	}
}

func wsConfigForTest() ws.Config {
	return ws.Config{
		URL:               "ws://prismer.test/ws/runtime",
		RuntimeDID:        "did:key:test-daemon",
		SessionID:         "sess_test_1",
		Version:           "0.1.0",
		UserAgent:         "daemon-app-test",
		HeartbeatInterval: time.Hour,
		Host: proto.RuntimeHelloHost{
			Hostname: "host",
			OS:       "linux",
			Arch:     "amd64",
		},
		Capabilities: []proto.RuntimeCapability{
			{Key: "noop", Version: "0.1.0", Path: "/usr/local/bin/noop"},
		},
	}
}

type appTestWSServer struct {
	t          *testing.T
	serverConn net.Conn
	clientConn net.Conn
	wsConn     *websocket.Conn
	envelopes  chan proto.Envelope
}

func newAppTestWSServer(t *testing.T) *appTestWSServer {
	serverConn, clientConn := net.Pipe()
	s := &appTestWSServer{
		t:          t,
		serverConn: serverConn,
		clientConn: clientConn,
		envelopes:  make(chan proto.Envelope, 32),
	}
	go s.serve()
	return s
}

func (s *appTestWSServer) Close() {
	if s.wsConn != nil {
		_ = s.wsConn.Close()
	}
	_ = s.serverConn.Close()
	_ = s.clientConn.Close()
}

func (s *appTestWSServer) DialContext(_ context.Context, urlStr string, requestHeader http.Header) (ws.Conn, *http.Response, error) {
	u, err := url.Parse(urlStr)
	if err != nil {
		return nil, nil, err
	}
	return websocket.NewClient(s.clientConn, u, requestHeader, 1024, 1024)
}

func (s *appTestWSServer) serve() {
	reader := bufio.NewReader(s.serverConn)
	req, err := http.ReadRequest(reader)
	if err != nil {
		s.t.Errorf("ReadRequest() error = %v", err)
		return
	}
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	conn, err := upgrader.Upgrade(newAppPipeResponseWriter(s.serverConn, reader), req, nil)
	if err != nil {
		s.t.Errorf("Upgrade() error = %v", err)
		return
	}
	s.wsConn = conn
	go s.readLoop()
}

func (s *appTestWSServer) readLoop() {
	for {
		if err := s.wsConn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
			return
		}
		_, wire, err := s.wsConn.ReadMessage()
		if err != nil {
			return
		}
		var envelope proto.Envelope
		if err := json.Unmarshal(wire, &envelope); err != nil {
			s.t.Errorf("json.Unmarshal(envelope) error = %v", err)
			return
		}
		if err := envelope.Validate(); err != nil {
			s.t.Errorf("envelope.Validate() error = %v", err)
			return
		}
		s.envelopes <- envelope
	}
}

func (s *appTestWSServer) mustReadEnvelope(t *testing.T) proto.Envelope {
	t.Helper()
	select {
	case envelope := <-s.envelopes:
		return envelope
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for envelope")
		return proto.Envelope{}
	}
}

func (s *appTestWSServer) waitForEnvelopeType(t *testing.T, messageType string) proto.Envelope {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		envelope := s.mustReadEnvelope(t)
		if envelope.Type == messageType {
			return envelope
		}
	}
	t.Fatalf("timed out waiting for envelope type %s", messageType)
	return proto.Envelope{}
}

func (s *appTestWSServer) writeEnvelope(envelope proto.Envelope) error {
	for i := 0; i < 100; i++ {
		if s.wsConn != nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	wire, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	if err := s.wsConn.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
		return err
	}
	return s.wsConn.WriteMessage(websocket.TextMessage, wire)
}

type appPipeResponseWriter struct {
	conn   net.Conn
	reader *bufio.Reader
	header http.Header
}

func newAppPipeResponseWriter(conn net.Conn, reader *bufio.Reader) *appPipeResponseWriter {
	return &appPipeResponseWriter{
		conn:   conn,
		reader: reader,
		header: make(http.Header),
	}
}

func (w *appPipeResponseWriter) Header() http.Header            { return w.header }
func (w *appPipeResponseWriter) WriteHeader(statusCode int)     {}
func (w *appPipeResponseWriter) Write(data []byte) (int, error) { return w.conn.Write(data) }
func (w *appPipeResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return w.conn, bufio.NewReadWriter(w.reader, bufio.NewWriter(w.conn)), nil
}

func mustAppServerStatefulEnvelope(t *testing.T, executionID string, messageType string, payload any) proto.Envelope {
	t.Helper()
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("json.Marshal(payload) error = %v", err)
	}
	sum := sha256.Sum256(payloadBytes)
	return proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           "msg_" + messageType,
		ExecutionID:  executionID,
		Type:         messageType,
		MessageClass: proto.MessageClassStateful,
		TimestampMs:  time.Now().UnixMilli(),
		StateVersion: 1,
		PayloadHash:  base64.RawURLEncoding.EncodeToString(sum[:]),
		AckType:      proto.AckTypeRequired,
		Payload:      payloadBytes,
	}
}
