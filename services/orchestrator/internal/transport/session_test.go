package transport

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"
	"time"

	execpkg "github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/exec"
	"github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/hub"
	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
)

func TestSessionHandleRuntimeHelloAndHeartbeat(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	h := hub.New(store)
	session := NewSession(store, h, execpkg.NewTracker(store), AuthConfig{}, "127.0.0.1:9000", "daemon-test")

	hello := mustStatefulEnvelope(t, "exec_runtime", "runtime.hello", proto.RuntimeHelloPayload{
		DID:       "did:key:z6MkRuntime",
		SessionID: "sess_1",
		Version:   "0.1.0",
		Host: proto.RuntimeHelloHost{
			Hostname: "macbook-pro",
			OS:       "darwin",
			Arch:     "arm64",
		},
	})
	if err := session.HandleInbound(ctx, hello); err != nil {
		t.Fatalf("HandleInbound(runtime.hello) error = %v", err)
	}
	if got := session.RuntimeID(); got != "did:key:z6MkRuntime" {
		t.Fatalf("unexpected runtime id: %s", got)
	}

	runtime, ok := store.GetRuntime("did:key:z6MkRuntime")
	if !ok {
		t.Fatal("expected runtime to be registered")
	}
	if runtime.Hostname != "macbook-pro" || runtime.Status != "online" {
		t.Fatalf("unexpected runtime: %+v", runtime)
	}

	heartbeat := mustStreamEnvelope(t, "exec_runtime", "runtime.heartbeat", "heartbeat", 0, proto.RuntimeHeartbeatPayload{
		Load: 0.42,
	})
	if err := session.HandleInbound(ctx, heartbeat); err != nil {
		t.Fatalf("HandleInbound(runtime.heartbeat) error = %v", err)
	}

	runtime, ok = store.GetRuntime("did:key:z6MkRuntime")
	if !ok || runtime.Load != 0.42 {
		t.Fatalf("expected runtime load update, got %+v", runtime)
	}

	outbound := session.Outbound()
	if outbound == nil {
		t.Fatal("expected outbound connection")
	}
	select {
	case msg := <-outbound:
		var envelope proto.Envelope
		if err := json.Unmarshal(msg, &envelope); err != nil {
			t.Fatalf("unmarshal outbound heartbeat ack: %v", err)
		}
		if envelope.Type != "runtime.heartbeat_ack" {
			t.Fatalf("unexpected outbound type: %s", envelope.Type)
		}
		if err := envelope.Validate(); err != nil {
			t.Fatalf("heartbeat ack validate: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for heartbeat ack")
	}
}

func TestSessionHandleCapabilityReport(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	h := hub.New(store)
	session := NewSession(store, h, execpkg.NewTracker(store), AuthConfig{}, "127.0.0.1:9000", "daemon-test")

	if err := session.HandleInbound(ctx, mustStatefulEnvelope(t, "exec_runtime", "runtime.hello", proto.RuntimeHelloPayload{
		DID:       "did:key:z6MkRuntime",
		SessionID: "sess_1",
		Version:   "0.1.0",
		Host:      proto.RuntimeHelloHost{Hostname: "box", OS: "linux", Arch: "amd64"},
	})); err != nil {
		t.Fatalf("hello error = %v", err)
	}

	report := mustStatefulEnvelope(t, "exec_runtime", "runtime.capability_report", proto.RuntimeCapabilityReportPayload{
		Capabilities: []proto.RuntimeCapability{
			{Key: "claude-code", Version: "1.2.3", Path: "/usr/local/bin/claude"},
			{Key: "codex", Version: "0.5.0", Path: "/usr/local/bin/codex"},
		},
		ScannedAtMs: time.Now().UnixMilli(),
	})
	if err := session.HandleInbound(ctx, report); err != nil {
		t.Fatalf("HandleInbound(runtime.capability_report) error = %v", err)
	}

	runtime, ok := store.GetRuntime("did:key:z6MkRuntime")
	if !ok {
		t.Fatal("expected runtime in store")
	}
	if runtime.Capabilities == "" || runtime.Capabilities == "[]" {
		t.Fatalf("expected capabilities to update, got %+v", runtime)
	}
}

func TestSessionHandleApprovalRequestCreatesApproval(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	h := hub.New(store)
	session := NewSession(store, h, execpkg.NewTracker(store), AuthConfig{}, "127.0.0.1:9000", "daemon-test")

	store.PutTask(shareddb.Task{
		ID:        "task_approval",
		Title:     "approval",
		Status:    "assigned",
		RuntimeID: "did:key:z6MkRuntime",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	})
	if err := session.HandleInbound(ctx, mustStatefulEnvelope(t, "exec_runtime", "runtime.hello", proto.RuntimeHelloPayload{
		DID:       "did:key:z6MkRuntime",
		SessionID: "sess_1",
		Version:   "0.1.0",
		Host:      proto.RuntimeHelloHost{Hostname: "box", OS: "linux", Arch: "amd64"},
	})); err != nil {
		t.Fatalf("hello error = %v", err)
	}

	req := mustStatefulEnvelope(t, "task_approval", "approval.request", proto.ApprovalRequestPayload{
		ApprovalID:       "appr_ws_1",
		TaskID:           "task_approval",
		Kind:             "dangerous_action",
		Action:           "git_push_force",
		Payload:          json.RawMessage(`{"branch":"main"}`),
		RequestSignature: "sig_req",
		Metadata:         json.RawMessage(`{"source":"daemon"}`),
	})
	if err := session.HandleInbound(ctx, req); err != nil {
		t.Fatalf("HandleInbound(approval.request) error = %v", err)
	}

	approval, err := store.GetPendingApproval(ctx, "appr_ws_1")
	if err != nil {
		t.Fatalf("GetPendingApproval() error = %v", err)
	}
	if approval.TaskID != "task_approval" || approval.RequestedByDid != "did:key:z6MkRuntime" || approval.Action != "git_push_force" {
		t.Fatalf("unexpected approval: %+v", approval)
	}
}

func TestSessionHandleResumeRequest(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	h := hub.New(store)
	session := NewSession(store, h, execpkg.NewTracker(store), AuthConfig{}, "127.0.0.1:9000", "daemon-test")

	if err := session.HandleInbound(ctx, mustStatefulEnvelope(t, "exec_runtime", "runtime.hello", proto.RuntimeHelloPayload{
		DID:       "did:key:z6MkRuntime",
		SessionID: "sess_1",
		Version:   "0.1.0",
		Host:      proto.RuntimeHelloHost{Hostname: "box", OS: "linux", Arch: "amd64"},
	})); err != nil {
		t.Fatalf("hello error = %v", err)
	}

	req := mustStatefulEnvelope(t, "exec_1", "stream.resume_request", proto.StreamResumeRequestPayload{
		ExecutionID: "exec_1",
		Streams:     []string{"stdout", "stderr"},
	})
	if err := session.HandleInbound(ctx, req); err != nil {
		t.Fatalf("HandleInbound(stream.resume_request) error = %v", err)
	}

	select {
	case msg := <-session.Outbound():
		var envelope proto.Envelope
		if err := json.Unmarshal(msg, &envelope); err != nil {
			t.Fatalf("unmarshal outbound resume ack: %v", err)
		}
		if envelope.Type != "stream.resume_ack" {
			t.Fatalf("unexpected outbound type: %s", envelope.Type)
		}
		var payload proto.StreamResumeAckPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			t.Fatalf("unmarshal resume ack payload: %v", err)
		}
		if len(payload.Streams) != 2 || payload.Streams[0].LastCommittedSeq != 0 {
			t.Fatalf("unexpected resume ack payload: %+v", payload)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for resume ack")
	}
}

func TestSessionHandleResumeRequestReturnsStoredCursor(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	h := hub.New(store)
	session := NewSession(store, h, execpkg.NewTracker(store), AuthConfig{}, "127.0.0.1:9000", "daemon-test")

	if err := session.HandleInbound(ctx, mustStatefulEnvelope(t, "exec_runtime", "runtime.hello", proto.RuntimeHelloPayload{
		DID:       "did:key:z6MkRuntime",
		SessionID: "sess_1",
		Version:   "0.1.0",
		Host:      proto.RuntimeHelloHost{Hostname: "box", OS: "linux", Arch: "amd64"},
	})); err != nil {
		t.Fatalf("hello error = %v", err)
	}
	if err := store.UpsertStreamCursor(ctx, shareddb.UpsertStreamCursorParams{
		ExecutionID:      "exec_1",
		StreamID:         "stdout",
		LastCommittedSeq: 7,
	}); err != nil {
		t.Fatalf("UpsertStreamCursor() error = %v", err)
	}

	req := mustStatefulEnvelope(t, "exec_1", "stream.resume_request", proto.StreamResumeRequestPayload{
		ExecutionID: "exec_1",
		Streams:     []string{"stdout", "stderr"},
	})
	if err := session.HandleInbound(ctx, req); err != nil {
		t.Fatalf("HandleInbound(stream.resume_request) error = %v", err)
	}

	select {
	case msg := <-session.Outbound():
		var envelope proto.Envelope
		if err := json.Unmarshal(msg, &envelope); err != nil {
			t.Fatalf("unmarshal outbound resume ack: %v", err)
		}
		var payload proto.StreamResumeAckPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			t.Fatalf("unmarshal resume ack payload: %v", err)
		}
		if len(payload.Streams) != 2 || payload.Streams[0].LastCommittedSeq != 7 || payload.Streams[1].LastCommittedSeq != 0 {
			t.Fatalf("unexpected resume ack payload: %+v", payload)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for resume ack")
	}
}

func TestSessionDelegatesExecutionMessages(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	h := hub.New(store)
	session := NewSession(store, h, execpkg.NewTracker(store), AuthConfig{}, "127.0.0.1:9000", "daemon-test")

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

	accepted := mustStatefulEnvelope(t, "exec_1", "task.accepted", proto.TaskAcceptedPayload{
		ExecutionID:    "exec_1",
		CapabilityUsed: "claude-code",
	})
	if err := session.HandleInbound(ctx, accepted); err != nil {
		t.Fatalf("accepted error = %v", err)
	}

	finished := mustStatefulEnvelope(t, "exec_1", "task.finished", proto.TaskFinishedPayload{
		ExecutionID: "exec_1",
		ExitCode:    0,
		DurationMs:  1200,
		ResultURI:   "prismer://result",
	})
	if err := session.HandleInbound(ctx, finished); err != nil {
		t.Fatalf("finished error = %v", err)
	}

	task, _ := store.LookupTask("task_1")
	if task.Status != "completed" {
		t.Fatalf("expected completed task, got %+v", task)
	}
}

func TestSessionDedupsStatefulMessagesAndRejectsPayloadCollision(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	h := hub.New(store)
	session := NewSession(store, h, execpkg.NewTracker(store), AuthConfig{}, "127.0.0.1:9000", "daemon-test")

	if err := session.HandleInbound(ctx, mustStatefulEnvelope(t, "exec_runtime", "runtime.hello", proto.RuntimeHelloPayload{
		DID:       "did:key:z6MkRuntime",
		SessionID: "sess_1",
		Version:   "0.1.0",
		Host:      proto.RuntimeHelloHost{Hostname: "box", OS: "linux", Arch: "amd64"},
	})); err != nil {
		t.Fatalf("hello error = %v", err)
	}

	report := mustStatefulEnvelope(t, "exec_runtime", "runtime.capability_report", proto.RuntimeCapabilityReportPayload{
		Capabilities: []proto.RuntimeCapability{{Key: "codex"}},
		ScannedAtMs:  time.Now().UnixMilli(),
	})
	if err := session.HandleInbound(ctx, report); err != nil {
		t.Fatalf("first capability report error = %v", err)
	}

	if err := store.SetRuntimeCapabilities(ctx, "did:key:z6MkRuntime", `["manual"]`); err != nil {
		t.Fatalf("SetRuntimeCapabilities() error = %v", err)
	}
	if err := session.HandleInbound(ctx, report); err != nil {
		t.Fatalf("duplicate capability report error = %v", err)
	}
	runtime, ok := store.GetRuntime("did:key:z6MkRuntime")
	if !ok || runtime.Capabilities != `["manual"]` {
		t.Fatalf("expected duplicate to skip mutation, got %+v", runtime)
	}

	conflict := mustStatefulEnvelope(t, "exec_runtime", "runtime.capability_report", proto.RuntimeCapabilityReportPayload{
		Capabilities: []proto.RuntimeCapability{{Key: "claude-code"}},
		ScannedAtMs:  time.Now().UnixMilli(),
	})
	err := session.HandleInbound(ctx, conflict)
	if !errors.Is(err, shareddb.ErrStatefulMessageConflict) {
		t.Fatalf("expected ErrStatefulMessageConflict, got %v", err)
	}
}

func TestSessionRequiresHelloBeforeHeartbeat(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	h := hub.New(store)
	session := NewSession(store, h, execpkg.NewTracker(store), AuthConfig{}, "127.0.0.1:9000", "daemon-test")

	err := session.HandleInbound(ctx, mustStreamEnvelope(t, "exec_runtime", "runtime.heartbeat", "heartbeat", 0, proto.RuntimeHeartbeatPayload{}))
	if err == nil || !errors.Is(err, ErrRuntimeNotInitialized) {
		t.Fatalf("expected ErrRuntimeNotInitialized, got %v", err)
	}
}

func TestSessionRejectsRuntimeHelloWithoutRequiredJoinToken(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	h := hub.New(store)
	session := NewSession(store, h, execpkg.NewTracker(store), NewAuthConfig("join-secret", nil, false, 5*time.Minute), "127.0.0.1:9000", "daemon-test")

	err := session.HandleInbound(ctx, mustStatefulEnvelope(t, "exec_runtime", "runtime.hello", proto.RuntimeHelloPayload{
		DID:       "did:key:z6MkRuntime",
		SessionID: "sess_1",
		Version:   "0.1.0",
		Host:      proto.RuntimeHelloHost{Hostname: "box", OS: "linux", Arch: "amd64"},
	}))
	if err == nil || !errors.Is(err, ErrJoinTokenRequired) {
		t.Fatalf("expected ErrJoinTokenRequired, got %v", err)
	}
}

func TestSessionRejectsRuntimeHelloOutsideAllowedDIDs(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	h := hub.New(store)
	session := NewSession(
		store,
		h,
		execpkg.NewTracker(store),
		NewAuthConfig("", []string{"did:key:allowed"}, false, 5*time.Minute),
		"127.0.0.1:9000",
		"daemon-test",
	)

	err := session.HandleInbound(ctx, mustStatefulEnvelope(t, "exec_runtime", "runtime.hello", proto.RuntimeHelloPayload{
		DID:            "did:key:blocked",
		SessionID:      "sess_1",
		Version:        "0.1.0",
		AgentJoinToken: "anything",
		Host:           proto.RuntimeHelloHost{Hostname: "box", OS: "linux", Arch: "amd64"},
	}))
	if err == nil || !errors.Is(err, ErrRuntimeNotAllowed) {
		t.Fatalf("expected ErrRuntimeNotAllowed, got %v", err)
	}
}

func TestSessionAcceptsSignedRuntimeHelloWhenRequired(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	h := hub.New(store)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	_, err = store.CreateSigningKey(ctx, shareddb.CreateSigningKeyParams{
		ID:        "key_1",
		DID:       "did:key:z6MkRuntime",
		PublicKey: base64.RawURLEncoding.EncodeToString(publicKey),
		KeyID:     "did:key:z6MkRuntime#k1",
	})
	if err != nil {
		t.Fatalf("CreateSigningKey() error = %v", err)
	}
	session := NewSession(
		store,
		h,
		execpkg.NewTracker(store),
		NewAuthConfig("", nil, true, 5*time.Minute),
		"127.0.0.1:9000",
		"daemon-test",
	)

	hello := mustSignedStatefulEnvelope(t, privateKey, "exec_runtime", "runtime.hello", proto.RuntimeHelloPayload{
		DID:       "did:key:z6MkRuntime",
		SessionID: "sess_1",
		Version:   "0.1.0",
		Host:      proto.RuntimeHelloHost{Hostname: "box", OS: "linux", Arch: "amd64"},
	}, "did:key:z6MkRuntime#k1")
	if err := session.HandleInbound(ctx, hello); err != nil {
		t.Fatalf("HandleInbound(runtime.hello) error = %v", err)
	}
}

func TestSessionRejectsUnsignedRuntimeHelloWhenSignatureRequired(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	h := hub.New(store)
	session := NewSession(
		store,
		h,
		execpkg.NewTracker(store),
		NewAuthConfig("", nil, true, 5*time.Minute),
		"127.0.0.1:9000",
		"daemon-test",
	)

	err := session.HandleInbound(ctx, mustStatefulEnvelope(t, "exec_runtime", "runtime.hello", proto.RuntimeHelloPayload{
		DID:       "did:key:z6MkRuntime",
		SessionID: "sess_1",
		Version:   "0.1.0",
		Host:      proto.RuntimeHelloHost{Hostname: "box", OS: "linux", Arch: "amd64"},
	}))
	if err == nil || !errors.Is(err, ErrRuntimeSignatureRequired) {
		t.Fatalf("expected ErrRuntimeSignatureRequired, got %v", err)
	}
}

func TestSessionRejectsSignedRuntimeHelloWithUnknownKey(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	h := hub.New(store)
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	session := NewSession(
		store,
		h,
		execpkg.NewTracker(store),
		NewAuthConfig("", nil, true, 5*time.Minute),
		"127.0.0.1:9000",
		"daemon-test",
	)

	err = session.HandleInbound(ctx, mustSignedStatefulEnvelope(t, privateKey, "exec_runtime", "runtime.hello", proto.RuntimeHelloPayload{
		DID:       "did:key:z6MkRuntime",
		SessionID: "sess_1",
		Version:   "0.1.0",
		Host:      proto.RuntimeHelloHost{Hostname: "box", OS: "linux", Arch: "amd64"},
	}, "did:key:z6MkRuntime#missing"))
	if err == nil || !errors.Is(err, ErrRuntimeSigningKeyRejected) {
		t.Fatalf("expected ErrRuntimeSigningKeyRejected, got %v", err)
	}
}

func mustStatefulEnvelope(t *testing.T, executionID string, messageType string, payload any) []byte {
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
		StateVersion: testStateVersionForMessageType(messageType),
		PayloadHash:  payloadHash,
		AckType:      proto.AckTypeRequired,
		Payload:      payloadBytes,
	})
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	return wire
}

func testStateVersionForMessageType(messageType string) int64 {
	switch messageType {
	case "task.finished", "task.rejected":
		return 2
	default:
		return 1
	}
}

func mustStreamEnvelope(t *testing.T, executionID string, messageType string, streamID string, streamSeq int64, payload any) []byte {
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

func mustSignedStatefulEnvelope(t *testing.T, privateKey ed25519.PrivateKey, executionID string, messageType string, payload any, keyID string) []byte {
	t.Helper()
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	payloadHash, err := proto.ComputePayloadHash(payloadBytes)
	if err != nil {
		t.Fatalf("ComputePayloadHash() error = %v", err)
	}
	envelope := proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           "msg_" + messageType + "_signed",
		ExecutionID:  executionID,
		Type:         messageType,
		MessageClass: proto.MessageClassStateful,
		TimestampMs:  time.Now().UnixMilli(),
		StateVersion: 1,
		PayloadHash:  payloadHash,
		AckType:      proto.AckTypeRequired,
		KeyID:        keyID,
		Payload:      payloadBytes,
	}
	input, err := proto.SigningInput(envelope)
	if err != nil {
		t.Fatalf("SigningInput() error = %v", err)
	}
	digest := sha256.Sum256(input)
	envelope.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, digest[:]))
	wire, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal signed envelope: %v", err)
	}
	return wire
}
