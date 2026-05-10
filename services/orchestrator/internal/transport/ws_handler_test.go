package transport

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	execpkg "github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/exec"
	"github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/hub"
	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
)

func TestHandlerServeHTTPProcessesHelloAndHeartbeat(t *testing.T) {
	store := shareddb.NewMemoryStore()
	hubRef := hub.New(store)
	socket := newFakeSocket()
	upgrader := &fakeUpgrader{socket: socket}
	handler := NewHandler(store, hubRef, execpkg.NewTracker(store), AuthConfig{}, upgrader)

	req := httptest.NewRequest(http.MethodGet, "/ws", nil)
	req.RemoteAddr = "127.0.0.1:9000"
	req.Header.Set("User-Agent", "daemon-test")
	rec := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(rec, req)
		close(done)
	}()

	socket.pushInbound(mustStatefulEnvelopeForHandler(t, "exec_runtime", "runtime.hello", proto.RuntimeHelloPayload{
		DID:       "did:key:z6MkRuntime",
		SessionID: "sess_1",
		Version:   "0.1.0",
		Host:      proto.RuntimeHelloHost{Hostname: "host", OS: "linux", Arch: "amd64"},
	}))
	socket.pushInbound(mustStreamEnvelopeForHandler(t, "exec_runtime", "runtime.heartbeat", "heartbeat", 0, proto.RuntimeHeartbeatPayload{
		Load: 0.5,
	}))

	msg := socket.mustReadOutbound(t)
	var envelope proto.Envelope
	if err := json.Unmarshal(msg, &envelope); err != nil {
		t.Fatalf("unmarshal outbound message: %v", err)
	}
	if envelope.Type != "runtime.heartbeat_ack" {
		t.Fatalf("unexpected outbound type: %s", envelope.Type)
	}

	socket.closeRead(io.EOF)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("ServeHTTP did not exit")
	}

	runtime, ok := store.GetRuntime("did:key:z6MkRuntime")
	if !ok || runtime.Load != 0.5 {
		t.Fatalf("expected runtime heartbeat persisted, got %+v", runtime)
	}
}

func TestHandlerServeHTTPPropagatesTaskLifecycle(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	hubRef := hub.New(store)
	socket := newFakeSocket()
	upgrader := &fakeUpgrader{socket: socket}
	handler := NewHandler(store, hubRef, execpkg.NewTracker(store), AuthConfig{}, upgrader)

	store.PutTask(shareddb.Task{
		ID:        "task_1",
		Title:     "test",
		Status:    "assigned",
		RuntimeID: "did:key:z6MkRuntime",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	})
	_, _ = store.RegisterRuntime(ctx, shareddb.RegisterRuntimeParams{
		ID:           "did:key:z6MkRuntime",
		OwnerDid:     "did:key:z6MkRuntime",
		Type:         "daemon",
		Did:          "did:key:z6MkRuntime",
		PublicKey:    "",
		Capabilities: "[]",
		Status:       "online",
	})
	_, _ = store.InsertTaskExecution(ctx, shareddb.InsertTaskExecutionParams{
		ID:        "exec_1",
		TaskID:    "task_1",
		RuntimeID: "did:key:z6MkRuntime",
		Attempt:   1,
		Status:    "dispatched",
	})

	req := httptest.NewRequest(http.MethodGet, "/ws", nil)
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(rec, req)
		close(done)
	}()

	socket.pushInbound(mustStatefulEnvelopeForHandler(t, "exec_runtime", "runtime.hello", proto.RuntimeHelloPayload{
		DID:       "did:key:z6MkRuntime",
		SessionID: "sess_1",
		Version:   "0.1.0",
		Host:      proto.RuntimeHelloHost{Hostname: "host", OS: "linux", Arch: "amd64"},
	}))
	socket.pushInbound(mustStatefulEnvelopeForHandler(t, "exec_1", "task.accepted", proto.TaskAcceptedPayload{
		ExecutionID: "exec_1",
	}))
	socket.pushInbound(mustStatefulEnvelopeForHandler(t, "exec_1", "task.finished", proto.TaskFinishedPayload{
		ExecutionID: "exec_1",
		ExitCode:    0,
	}))

	socket.closeRead(io.EOF)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("ServeHTTP did not exit")
	}

	task, _ := store.LookupTask("task_1")
	if task.Status != "completed" {
		t.Fatalf("expected completed task, got %+v", task)
	}
}

type fakeUpgrader struct {
	socket SocketConn
	err    error
}

func (u *fakeUpgrader) Upgrade(_ http.ResponseWriter, _ *http.Request) (SocketConn, error) {
	if u.err != nil {
		return nil, u.err
	}
	return u.socket, nil
}

type fakeSocket struct {
	mu       sync.Mutex
	inbound  chan []byte
	outbound chan []byte
	readErr  error
	closed   chan struct{}
}

func newFakeSocket() *fakeSocket {
	return &fakeSocket{
		inbound:  make(chan []byte, 16),
		outbound: make(chan []byte, 16),
		closed:   make(chan struct{}),
	}
}

func (s *fakeSocket) ReadMessage(ctx context.Context) ([]byte, error) {
	select {
	case msg := <-s.inbound:
		return msg, nil
	default:
	}

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-s.closed:
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.readErr == nil {
			return nil, io.EOF
		}
		return nil, s.readErr
	case msg := <-s.inbound:
		return msg, nil
	}
}

func (s *fakeSocket) WriteMessage(ctx context.Context, message []byte) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case s.outbound <- append([]byte(nil), message...):
		return nil
	}
}

func (s *fakeSocket) Close() error {
	s.closeRead(io.EOF)
	return nil
}

func (s *fakeSocket) pushInbound(message []byte) {
	s.inbound <- message
}

func (s *fakeSocket) mustReadOutbound(t *testing.T) []byte {
	t.Helper()
	select {
	case msg := <-s.outbound:
		return msg
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for outbound message")
		return nil
	}
}

func (s *fakeSocket) closeRead(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.readErr = err
	select {
	case <-s.closed:
	default:
		close(s.closed)
	}
}

func mustStatefulEnvelopeForHandler(t *testing.T, executionID string, messageType string, payload any) []byte {
	t.Helper()
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	payloadHash, err := proto.ComputePayloadHash(payloadBytes)
	if err != nil {
		t.Fatalf("ComputePayloadHash() error = %v", err)
	}
	wire, err := json.Marshal(proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           "msg_" + messageType,
		ExecutionID:  executionID,
		Type:         messageType,
		MessageClass: proto.MessageClassStateful,
		TimestampMs:  time.Now().UnixMilli(),
		StateVersion: testStateVersionForHandlerMessageType(messageType),
		PayloadHash:  payloadHash,
		AckType:      proto.AckTypeRequired,
		Payload:      payloadBytes,
	})
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	return wire
}

func testStateVersionForHandlerMessageType(messageType string) int64 {
	switch messageType {
	case "task.finished", "task.rejected":
		return 2
	default:
		return 1
	}
}

func mustStreamEnvelopeForHandler(t *testing.T, executionID string, messageType string, streamID string, streamSeq int64, payload any) []byte {
	t.Helper()
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	wire, err := json.Marshal(proto.Envelope{
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
	})
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	return wire
}
