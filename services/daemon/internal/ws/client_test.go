package ws

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
	"github.com/gorilla/websocket"
)

func TestClientStartSendsHelloCapabilityAndHeartbeat(t *testing.T) {
	server := newTestWSServer(t)
	defer server.Close()

	client := NewClient(Config{
		URL:               "ws://prismer.test/ws/runtime",
		RuntimeDID:        "did:key:z6MkRuntime",
		SessionID:         "sess_1",
		Version:           "0.1.0",
		UserAgent:         "daemon-test",
		Host:              proto.RuntimeHelloHost{Hostname: "host", OS: "linux", Arch: "amd64"},
		Capabilities:      []proto.RuntimeCapability{{Key: "claude-code", Version: "1.2.3"}},
		HeartbeatInterval: 10 * time.Millisecond,
		LoadProvider:      func() float64 { return 0.5 },
	})
	client.SetDialer(server)

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := client.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer client.Close()

	hello := server.mustReadEnvelope(t)
	if hello.Type != "runtime.hello" {
		t.Fatalf("expected runtime.hello, got %s", hello.Type)
	}
	report := server.mustReadEnvelope(t)
	if report.Type != "runtime.capability_report" {
		t.Fatalf("expected runtime.capability_report, got %s", report.Type)
	}
	heartbeat := server.mustReadEnvelope(t)
	if heartbeat.Type != "runtime.heartbeat" {
		t.Fatalf("expected runtime.heartbeat, got %s", heartbeat.Type)
	}
}

func TestClientReceivesTaskPushAndCancel(t *testing.T) {
	server := newTestWSServer(t)
	defer server.Close()

	client := NewClient(Config{
		URL:               "ws://prismer.test/ws/runtime",
		RuntimeDID:        "did:key:z6MkRuntime",
		SessionID:         "sess_1",
		Version:           "0.1.0",
		UserAgent:         "daemon-test",
		Host:              proto.RuntimeHelloHost{Hostname: "host", OS: "linux", Arch: "amd64"},
		HeartbeatInterval: time.Hour,
	})
	client.SetDialer(server)

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := client.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer client.Close()

	_ = server.mustReadEnvelope(t) // runtime.hello

	if err := server.writeEnvelope(mustServerStatefulEnvelope(t, "exec_1", "task.push", proto.TaskPushPayload{
		TaskID:      "task_1",
		ExecutionID: "exec_1",
		Title:       "Refactor",
		Capability:  "claude-code",
		Input:       json.RawMessage(`{"prompt":"hello"}`),
	})); err != nil {
		t.Fatalf("write task.push error = %v", err)
	}
	if err := server.writeEnvelope(mustServerStatefulEnvelope(t, "exec_1", "task.cancel", proto.TaskCancelPayload{
		ExecutionID: "exec_1",
		Reason:      "stop",
	})); err != nil {
		t.Fatalf("write task.cancel error = %v", err)
	}

	select {
	case task := <-client.TaskPushes():
		if task.TaskID != "task_1" {
			t.Fatalf("unexpected task push payload: %+v", task)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for task push")
	}

	select {
	case cancelPayload := <-client.TaskCancels():
		if cancelPayload.ExecutionID != "exec_1" {
			t.Fatalf("unexpected cancel payload: %+v", cancelPayload)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for task cancel")
	}
}

func TestClientReceivesApprovalDecision(t *testing.T) {
	server := newTestWSServer(t)
	defer server.Close()

	client := NewClient(Config{
		URL:               "ws://prismer.test/ws/runtime",
		RuntimeDID:        "did:key:z6MkRuntime",
		SessionID:         "sess_1",
		Version:           "0.1.0",
		UserAgent:         "daemon-test",
		Host:              proto.RuntimeHelloHost{Hostname: "host", OS: "linux", Arch: "amd64"},
		HeartbeatInterval: time.Hour,
	})
	client.SetDialer(server)

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := client.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer client.Close()

	_ = server.mustReadEnvelope(t) // runtime.hello

	if err := server.writeEnvelope(mustServerStatefulEnvelope(t, "task_1", "approval.decision", proto.ApprovalDecisionPayload{
		ApprovalID:     "appr_1",
		TaskID:         "task_1",
		Decision:       "approved",
		DecisionReason: "ok",
		DecidedAtMs:    time.Now().UnixMilli(),
	})); err != nil {
		t.Fatalf("write approval.decision error = %v", err)
	}

	select {
	case decision := <-client.ApprovalDecisions():
		if decision.ApprovalID != "appr_1" || decision.Decision != "approved" {
			t.Fatalf("unexpected approval decision: %+v", decision)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for approval decision")
	}
}

func TestClientSendAcceptedFinishedAndLogs(t *testing.T) {
	server := newTestWSServer(t)
	defer server.Close()

	client := NewClient(Config{
		URL:               "ws://prismer.test/ws/runtime",
		RuntimeDID:        "did:key:z6MkRuntime",
		SessionID:         "sess_1",
		Version:           "0.1.0",
		UserAgent:         "daemon-test",
		Host:              proto.RuntimeHelloHost{Hostname: "host", OS: "linux", Arch: "amd64"},
		HeartbeatInterval: time.Hour,
	})
	client.SetDialer(server)

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := client.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer client.Close()

	_ = server.mustReadEnvelope(t) // runtime.hello

	if err := client.SendAccepted(ctx, proto.TaskAcceptedPayload{
		ExecutionID:    "exec_1",
		CapabilityUsed: "claude-code",
	}); err != nil {
		t.Fatalf("SendAccepted() error = %v", err)
	}
	if err := client.SendLogChunk(ctx, proto.TaskLogChunkPayload{
		ExecutionID: "exec_1",
		Stream:      "stdout",
		Chunks: []proto.TaskLogChunk{
			{Seq: 1, Text: "hello\n", TimestampMs: time.Now().UnixMilli()},
		},
	}); err != nil {
		t.Fatalf("SendLogChunk() error = %v", err)
	}
	if err := client.SendFinished(ctx, proto.TaskFinishedPayload{
		ExecutionID: "exec_1",
		ExitCode:    0,
		ResultURI:   "prismer://result",
	}); err != nil {
		t.Fatalf("SendFinished() error = %v", err)
	}

	accepted := server.mustReadEnvelope(t)
	if accepted.Type != "task.accepted" {
		t.Fatalf("expected task.accepted, got %s", accepted.Type)
	}
	logChunk := server.mustReadEnvelope(t)
	if logChunk.Type != "task.log_chunk" {
		t.Fatalf("expected task.log_chunk, got %s", logChunk.Type)
	}
	finished := server.mustReadEnvelope(t)
	if finished.Type != "task.finished" {
		t.Fatalf("expected task.finished, got %s", finished.Type)
	}
}

func TestClientSendApprovalRequest(t *testing.T) {
	server := newTestWSServer(t)
	defer server.Close()

	client := NewClient(Config{
		URL:               "ws://prismer.test/ws/runtime",
		RuntimeDID:        "did:key:z6MkRuntime",
		SessionID:         "sess_1",
		Version:           "0.1.0",
		UserAgent:         "daemon-test",
		Host:              proto.RuntimeHelloHost{Hostname: "host", OS: "linux", Arch: "amd64"},
		HeartbeatInterval: time.Hour,
	})
	client.SetDialer(server)

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := client.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer client.Close()

	_ = server.mustReadEnvelope(t) // runtime.hello

	if err := client.SendApprovalRequest(ctx, proto.ApprovalRequestPayload{
		ApprovalID:       "appr_1",
		TaskID:           "task_1",
		Kind:             "dangerous_action",
		Action:           "git_push_force",
		Payload:          json.RawMessage(`{"branch":"main"}`),
		RequestSignature: "sig_req",
	}); err != nil {
		t.Fatalf("SendApprovalRequest() error = %v", err)
	}

	req := server.mustReadEnvelope(t)
	if req.Type != "approval.request" || req.ExecutionID != "task_1" {
		t.Fatalf("unexpected approval.request envelope: %+v", req)
	}
}

func TestClientStartSignsRuntimeHelloWhenConfigured(t *testing.T) {
	server := newTestWSServer(t)
	defer server.Close()

	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}

	client := NewClient(Config{
		URL:               "ws://prismer.test/ws/runtime",
		RuntimeDID:        "did:key:z6MkRuntime",
		SessionID:         "sess_1",
		Version:           "0.1.0",
		UserAgent:         "daemon-test",
		SigningKeyID:      "did:key:z6MkRuntime#k1",
		SigningPrivateKey: privateKey,
		Host:              proto.RuntimeHelloHost{Hostname: "host", OS: "linux", Arch: "amd64"},
		HeartbeatInterval: time.Hour,
	})
	client.SetDialer(server)

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := client.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer client.Close()

	hello := server.mustReadEnvelope(t)
	if hello.Type != "runtime.hello" || hello.KeyID != "did:key:z6MkRuntime#k1" || hello.Signature == "" {
		t.Fatalf("expected signed runtime.hello, got %+v", hello)
	}
}

func TestClientSyncExecutionStreamsAppliesResumeAck(t *testing.T) {
	server := newTestWSServer(t)
	defer server.Close()

	client := NewClient(Config{
		URL:               "ws://prismer.test/ws/runtime",
		RuntimeDID:        "did:key:z6MkRuntime",
		SessionID:         "sess_1",
		Version:           "0.1.0",
		UserAgent:         "daemon-test",
		Host:              proto.RuntimeHelloHost{Hostname: "host", OS: "linux", Arch: "amd64"},
		HeartbeatInterval: time.Hour,
	})
	client.SetDialer(server)

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := client.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer client.Close()

	_ = server.mustReadEnvelope(t) // runtime.hello

	type resumeResult struct {
		payload proto.StreamResumeAckPayload
		err     error
	}
	resultCh := make(chan resumeResult, 1)
	go func() {
		payload, err := client.SyncExecutionStreams(ctx, "exec_1", []string{"stdout", "stderr"})
		resultCh <- resumeResult{payload: payload, err: err}
	}()

	req := server.mustReadEnvelope(t)
	if req.Type != "stream.resume_request" {
		t.Fatalf("expected stream.resume_request, got %s", req.Type)
	}
	if err := server.writeEnvelope(mustServerStatefulEnvelope(t, "exec_1", "stream.resume_ack", proto.StreamResumeAckPayload{
		ExecutionID: "exec_1",
		Streams: []proto.StreamResumeAckStream{
			{StreamID: "stdout", LastCommittedSeq: 7},
			{StreamID: "stderr", LastCommittedSeq: 3},
		},
	})); err != nil {
		t.Fatalf("write stream.resume_ack error = %v", err)
	}

	select {
	case result := <-resultCh:
		if result.err != nil {
			t.Fatalf("SyncExecutionStreams() error = %v", result.err)
		}
		if len(result.payload.Streams) != 2 || result.payload.Streams[0].LastCommittedSeq != 7 {
			t.Fatalf("unexpected resume ack payload: %+v", result.payload)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for resume ack")
	}

	if err := client.SendLogChunk(ctx, proto.TaskLogChunkPayload{
		ExecutionID: "exec_1",
		Stream:      "stdout",
		Chunks: []proto.TaskLogChunk{
			{Seq: 8, Text: "hello\n", TimestampMs: time.Now().UnixMilli()},
		},
	}); err != nil {
		t.Fatalf("SendLogChunk() error = %v", err)
	}
	logChunk := server.mustReadEnvelope(t)
	if logChunk.Type != "task.log_chunk" || logChunk.StreamSeq != 8 {
		t.Fatalf("expected resumed task.log_chunk stream_seq=8, got %+v", logChunk)
	}
}

func TestClientReconnectsAndResumesTrackedExecutions(t *testing.T) {
	server1 := newTestWSServer(t)
	defer server1.Close()
	server2 := newTestWSServer(t)
	defer server2.Close()

	client := NewClient(Config{
		URL:               "ws://prismer.test/ws/runtime",
		RuntimeDID:        "did:key:z6MkRuntime",
		SessionID:         "sess_1",
		Version:           "0.1.0",
		UserAgent:         "daemon-test",
		Host:              proto.RuntimeHelloHost{Hostname: "host", OS: "linux", Arch: "amd64"},
		HeartbeatInterval: time.Hour,
	})
	client.SetDialer(&rotatingDialer{dialers: []Dialer{server1, server2}})

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := client.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer client.Close()

	hello1 := server1.mustReadEnvelope(t)
	if hello1.Type != "runtime.hello" {
		t.Fatalf("expected first runtime.hello, got %s", hello1.Type)
	}

	client.TrackExecution("exec_1", []string{"stdout"})
	server1.Close()

	hello2 := server2.mustReadEnvelope(t)
	if hello2.Type != "runtime.hello" {
		t.Fatalf("expected reconnect runtime.hello, got %s", hello2.Type)
	}
	resume := server2.mustReadEnvelope(t)
	if resume.Type != "stream.resume_request" || resume.ExecutionID != "exec_1" {
		t.Fatalf("expected stream.resume_request for exec_1, got %+v", resume)
	}
}

type testWSServer struct {
	t          *testing.T
	serverConn net.Conn
	clientConn net.Conn
	wsConn     *websocket.Conn
	envelopes  chan proto.Envelope
	once       sync.Once
}

type rotatingDialer struct {
	mu      sync.Mutex
	index   int
	dialers []Dialer
}

func (d *rotatingDialer) DialContext(ctx context.Context, urlStr string, requestHeader http.Header) (Conn, *http.Response, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.index >= len(d.dialers) {
		return nil, nil, errors.New("no more dialers")
	}
	dialer := d.dialers[d.index]
	d.index++
	return dialer.DialContext(ctx, urlStr, requestHeader)
}

func newTestWSServer(t *testing.T) *testWSServer {
	serverConn, clientConn := net.Pipe()
	s := &testWSServer{
		t:          t,
		serverConn: serverConn,
		clientConn: clientConn,
		envelopes:  make(chan proto.Envelope, 32),
	}
	go s.serve()
	return s
}

func (s *testWSServer) Close() {
	s.once.Do(func() {
		if s.wsConn != nil {
			_ = s.wsConn.Close()
		}
		_ = s.serverConn.Close()
		_ = s.clientConn.Close()
	})
}

func (s *testWSServer) DialContext(_ context.Context, urlStr string, requestHeader http.Header) (Conn, *http.Response, error) {
	u, err := url.Parse(urlStr)
	if err != nil {
		return nil, nil, err
	}
	return websocket.NewClient(s.clientConn, u, requestHeader, 1024, 1024)
}

func (s *testWSServer) serve() {
	reader := bufio.NewReader(s.serverConn)
	req, err := http.ReadRequest(reader)
	if err != nil {
		s.t.Errorf("ReadRequest() error = %v", err)
		return
	}

	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	conn, err := upgrader.Upgrade(newPipeResponseWriter(s.serverConn, reader), req, nil)
	if err != nil {
		s.t.Errorf("Upgrade() error = %v", err)
		return
	}
	s.wsConn = conn
	go s.readLoop()
}

func (s *testWSServer) readLoop() {
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
			s.t.Errorf("unmarshal envelope: %v", err)
			return
		}
		if err := envelope.Validate(); err != nil {
			s.t.Errorf("validate envelope: %v", err)
			return
		}
		s.envelopes <- envelope
	}
}

func (s *testWSServer) mustReadEnvelope(t *testing.T) proto.Envelope {
	t.Helper()
	select {
	case envelope := <-s.envelopes:
		return envelope
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for envelope")
		return proto.Envelope{}
	}
}

func (s *testWSServer) writeEnvelope(envelope proto.Envelope) error {
	waitForCondition(s.t, "server websocket conn", func() bool { return s.wsConn != nil })
	wire, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	if err := s.wsConn.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
		return err
	}
	return s.wsConn.WriteMessage(websocket.TextMessage, wire)
}

type pipeResponseWriter struct {
	conn   net.Conn
	reader *bufio.Reader
	header http.Header
}

func newPipeResponseWriter(conn net.Conn, reader *bufio.Reader) *pipeResponseWriter {
	return &pipeResponseWriter{
		conn:   conn,
		reader: reader,
		header: make(http.Header),
	}
}

func (w *pipeResponseWriter) Header() http.Header {
	return w.header
}

func (w *pipeResponseWriter) WriteHeader(statusCode int) {}

func (w *pipeResponseWriter) Write(data []byte) (int, error) {
	return w.conn.Write(data)
}

func (w *pipeResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return w.conn, bufio.NewReadWriter(w.reader, bufio.NewWriter(w.conn)), nil
}

func waitForCondition(t *testing.T, name string, fn func() bool) {
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

func mustServerStatefulEnvelope(t *testing.T, executionID string, messageType string, payload any) proto.Envelope {
	t.Helper()
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
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
