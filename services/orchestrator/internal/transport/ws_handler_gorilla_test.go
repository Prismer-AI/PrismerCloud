//go:build gorilla_websocket

package transport

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

	execpkg "github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/exec"
	"github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/hub"
	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
	"github.com/gorilla/websocket"
)

func TestGorillaHandlerProcessesHelloAndHeartbeat(t *testing.T) {
	store := shareddb.NewMemoryStore()
	hubRef := hub.New(store)
	handler := NewHandler(
		store,
		hubRef,
		execpkg.NewTracker(store),
		AuthConfig{},
		NewGorillaUpgrader(websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}),
	)

	conn, closeClient := mustNewInMemoryWebSocketClient(t, handler)
	defer closeClient()

	mustWriteWSMessage(t, conn, mustGorillaStatefulEnvelope(t, "exec_runtime", "runtime.hello", proto.RuntimeHelloPayload{
		DID:       "did:key:z6MkRuntime",
		SessionID: "sess_1",
		Version:   "0.1.0",
		Host: proto.RuntimeHelloHost{
			Hostname: "host",
			OS:       "linux",
			Arch:     "amd64",
		},
	}))
	mustWriteWSMessage(t, conn, mustGorillaStreamEnvelope(t, "exec_runtime", "runtime.heartbeat", "heartbeat", 0, proto.RuntimeHeartbeatPayload{
		Load: 0.5,
	}))

	_, wire, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("ReadMessage() error = %v", err)
	}

	var envelope proto.Envelope
	if err := json.Unmarshal(wire, &envelope); err != nil {
		t.Fatalf("unmarshal heartbeat ack: %v", err)
	}
	if envelope.Type != "runtime.heartbeat_ack" {
		t.Fatalf("unexpected outbound type: %s", envelope.Type)
	}
	if err := envelope.Validate(); err != nil {
		t.Fatalf("heartbeat ack validate: %v", err)
	}

	runtime, ok := store.GetRuntime("did:key:z6MkRuntime")
	if !ok {
		t.Fatal("expected runtime registration")
	}
	if runtime.Load != 0.5 || runtime.Status != "online" {
		t.Fatalf("unexpected runtime state: %+v", runtime)
	}
}

func TestGorillaHandlerPropagatesTaskLifecycle(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	hubRef := hub.New(store)
	handler := NewHandler(
		store,
		hubRef,
		execpkg.NewTracker(store),
		AuthConfig{},
		NewGorillaUpgrader(websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}),
	)

	conn, closeClient := mustNewInMemoryWebSocketClient(t, handler)
	defer closeClient()

	mustWriteWSMessage(t, conn, mustGorillaStatefulEnvelope(t, "exec_runtime", "runtime.hello", proto.RuntimeHelloPayload{
		DID:       "did:key:z6MkRuntime",
		SessionID: "sess_1",
		Version:   "0.1.0",
		Host:      proto.RuntimeHelloHost{Hostname: "host", OS: "linux", Arch: "amd64"},
	}))

	waitForTestCondition(t, "runtime registration", func() bool {
		_, ok := store.GetRuntime("did:key:z6MkRuntime")
		return ok
	})

	store.PutTask(shareddb.Task{
		ID:        "task_1",
		Title:     "test",
		Status:    "assigned",
		RuntimeID: "did:key:z6MkRuntime",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	})
	if _, err := store.InsertTaskExecution(ctx, shareddb.InsertTaskExecutionParams{
		ID:        "exec_1",
		TaskID:    "task_1",
		RuntimeID: "did:key:z6MkRuntime",
		Attempt:   1,
		Status:    "dispatched",
	}); err != nil {
		t.Fatalf("InsertTaskExecution() error = %v", err)
	}

	mustWriteWSMessage(t, conn, mustGorillaStatefulEnvelope(t, "exec_1", "task.accepted", proto.TaskAcceptedPayload{
		ExecutionID:    "exec_1",
		CapabilityUsed: "claude-code",
	}))
	mustWriteWSMessage(t, conn, mustGorillaStatefulEnvelope(t, "exec_1", "task.finished", proto.TaskFinishedPayload{
		ExecutionID: "exec_1",
		ExitCode:    0,
		DurationMs:  1200,
		ResultURI:   "prismer://result",
	}))

	waitForTestCondition(t, "task completion", func() bool {
		task, ok := store.LookupTask("task_1")
		return ok && task.Status == "completed"
	})

	task, _ := store.LookupTask("task_1")
	if task.Status != "completed" {
		t.Fatalf("unexpected task state: %+v", task)
	}
	execRow, _ := store.LookupTaskExecution("exec_1")
	if execRow.Status != "succeeded" || execRow.ResultRef != "prismer://result" {
		t.Fatalf("unexpected execution state: %+v", execRow)
	}
}

func mustNewInMemoryWebSocketClient(t *testing.T, handler http.Handler) (*websocket.Conn, func()) {
	t.Helper()

	serverConn, clientConn := net.Pipe()
	serverDone := make(chan struct{})

	go func() {
		defer close(serverDone)
		defer serverConn.Close()

		reader := bufio.NewReader(serverConn)
		req, err := http.ReadRequest(reader)
		if err != nil {
			return
		}
		req.RemoteAddr = "pipe"
		req.RequestURI = req.URL.RequestURI()

		handler.ServeHTTP(newPipeResponseWriter(serverConn, reader), req)
	}()

	u, err := url.Parse("ws://prismer.test/ws/runtime")
	if err != nil {
		t.Fatalf("url.Parse() error = %v", err)
	}
	conn, _, err := websocket.NewClient(clientConn, u, http.Header{
		"Origin": []string{"http://prismer.test"},
	}, 1024, 1024)
	if err != nil {
		t.Fatalf("websocket.NewClient() error = %v", err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("SetReadDeadline() error = %v", err)
	}
	return conn, func() {
		_ = conn.Close()
		<-serverDone
	}
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

func mustWriteWSMessage(t *testing.T, conn *websocket.Conn, wire []byte) {
	t.Helper()
	if err := conn.WriteMessage(websocket.TextMessage, wire); err != nil {
		t.Fatalf("WriteMessage() error = %v", err)
	}
}

func waitForTestCondition(t *testing.T, name string, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", name)
}

func mustGorillaStatefulEnvelope(t *testing.T, executionID string, messageType string, payload any) []byte {
	t.Helper()
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	sum := sha256.Sum256(payloadBytes)
	wire, err := json.Marshal(proto.Envelope{
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
	})
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	return wire
}

func mustGorillaStreamEnvelope(t *testing.T, executionID string, messageType string, streamID string, streamSeq int64, payload any) []byte {
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
