package transport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	execpkg "github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/exec"
	"github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/hub"
	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
	"github.com/Prismer-AI/PrismerCloud/services/shared/identity"
	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
)

var ErrRuntimeNotInitialized = errors.New("runtime session not initialized")
var ErrConnectionNotReady = errors.New("runtime connection not ready")
var ErrRuntimeNotAllowed = errors.New("runtime did not pass admission policy")
var ErrJoinTokenRequired = errors.New("runtime.hello requires agent_join_token")
var ErrInvalidJoinToken = errors.New("runtime.hello agent_join_token rejected")
var ErrRuntimeSignatureRequired = errors.New("runtime.hello signature required")
var ErrRuntimeSigningKeyRejected = errors.New("runtime.hello signing key rejected")

type Session struct {
	store shareddb.Store
	hub   *hub.Hub
	exec  *execpkg.Tracker
	auth  AuthConfig

	remoteAddr string
	userAgent  string
	now        func() time.Time

	mu        sync.RWMutex
	runtimeID string
	conn      *hub.Connection

	stateSeq  int64
	streamSeq uint64
}

func NewSession(store shareddb.Store, hubRef *hub.Hub, execTracker *execpkg.Tracker, auth AuthConfig, remoteAddr string, userAgent string) *Session {
	return &Session{
		store:      store,
		hub:        hubRef,
		exec:       execTracker,
		auth:       auth,
		remoteAddr: remoteAddr,
		userAgent:  userAgent,
		now:        time.Now,
	}
}

func (s *Session) HandleInbound(ctx context.Context, wire []byte) error {
	var envelope proto.Envelope
	if err := json.Unmarshal(wire, &envelope); err != nil {
		return fmt.Errorf("decode envelope: %w", err)
	}
	if err := envelope.Validate(); err != nil {
		return err
	}

	switch envelope.Type {
	case "runtime.hello":
		return s.handleRuntimeHello(ctx, envelope)
	case "runtime.capability_report":
		return s.applyStatefulEnvelope(ctx, envelope, func(ctx context.Context, store shareddb.Store) error {
			return s.handleCapabilityReportWithStore(ctx, store, envelope)
		})
	case "runtime.heartbeat":
		return s.handleHeartbeat(ctx, envelope)
	case "stream.resume_request":
		return s.handleResumeRequest(ctx, envelope)
	case "approval.request":
		return s.applyStatefulEnvelope(ctx, envelope, func(ctx context.Context, store shareddb.Store) error {
			return s.handleApprovalRequestWithStore(ctx, store, envelope)
		})
	case "task.accepted":
		return s.applyStatefulEnvelope(ctx, envelope, func(ctx context.Context, store shareddb.Store) error {
			return execpkg.NewTracker(store).HandleAccepted(ctx, envelope)
		})
	case "task.rejected":
		return s.applyStatefulEnvelope(ctx, envelope, func(ctx context.Context, store shareddb.Store) error {
			return execpkg.NewTracker(store).HandleRejected(ctx, envelope)
		})
	case "task.log_chunk":
		return s.exec.HandleLogChunk(ctx, envelope)
	case "task.finished":
		return s.applyStatefulEnvelope(ctx, envelope, func(ctx context.Context, store shareddb.Store) error {
			return execpkg.NewTracker(store).HandleFinished(ctx, envelope)
		})
	default:
		return fmt.Errorf("unsupported inbound message type: %s", envelope.Type)
	}
}

func (s *Session) Outbound() <-chan []byte {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.conn == nil {
		return nil
	}
	return s.conn.Outbound()
}

func (s *Session) RuntimeID() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.runtimeID
}

func (s *Session) HasConnection() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.conn != nil
}

func (s *Session) handleRuntimeHello(ctx context.Context, envelope proto.Envelope) error {
	var payload proto.RuntimeHelloPayload
	if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
		return fmt.Errorf("decode runtime.hello payload: %w", err)
	}
	if payload.DID == "" {
		return errors.New("runtime.hello requires did")
	}
	if payload.SessionID == "" {
		return errors.New("runtime.hello requires session_id")
	}
	if !s.auth.AllowsDID(payload.DID) {
		return ErrRuntimeNotAllowed
	}
	if s.auth.RequiresJoinToken() {
		if payload.AgentJoinToken == "" {
			return ErrJoinTokenRequired
		}
		if payload.AgentJoinToken != s.auth.RuntimeJoinToken {
			return ErrInvalidJoinToken
		}
	}
	if err := s.verifyRuntimeHelloEnvelope(ctx, envelope); err != nil {
		return err
	}

	runtimeID := payload.DID
	if _, err := s.store.RegisterRuntime(ctx, shareddb.RegisterRuntimeParams{
		ID:            runtimeID,
		OwnerDid:      payload.DID,
		OwnerIMUserID: "",
		Type:          "daemon",
		Did:           payload.DID,
		PublicKey:     "",
		Hostname:      payload.Host.Hostname,
		OS:            payload.Host.OS,
		Arch:          payload.Host.Arch,
		Version:       payload.Version,
		Endpoint:      s.remoteAddr,
		Capabilities:  "[]",
		Status:        "online",
		Load:          0,
	}); err != nil {
		return err
	}

	conn, err := s.hub.Connect(ctx, hub.ConnectParams{
		RuntimeID:  runtimeID,
		SessionID:  payload.SessionID,
		Version:    payload.Version,
		RemoteAddr: s.remoteAddr,
		UserAgent:  s.userAgent,
	})
	if err != nil {
		return err
	}

	s.mu.Lock()
	s.runtimeID = runtimeID
	s.conn = conn
	s.mu.Unlock()
	return nil
}

func (s *Session) verifyRuntimeHelloEnvelope(ctx context.Context, envelope proto.Envelope) error {
	if envelope.Signature == "" {
		if s.auth.RequiresRuntimeSignature() {
			return ErrRuntimeSignatureRequired
		}
		return nil
	}
	if envelope.KeyID == "" {
		return ErrRuntimeSignatureRequired
	}

	publicKey, err := (identity.StoreKeyResolver{Store: s.store}).ActiveEd25519PublicKey(ctx, envelope.KeyID, s.now())
	if err != nil {
		if errors.Is(err, identity.ErrSigningKeyUnknown) ||
			errors.Is(err, identity.ErrSigningKeyUnsupportedAlgorithm) ||
			errors.Is(err, identity.ErrSigningKeyRevoked) ||
			errors.Is(err, identity.ErrSigningKeyExpired) ||
			errors.Is(err, identity.ErrSigningKeyInvalidPublicKey) {
			return fmt.Errorf("%w: %v", ErrRuntimeSigningKeyRejected, err)
		}
		return err
	}

	return identity.VerifyEnvelopeSignature(
		envelope,
		publicKey,
		s.now(),
		s.auth.RuntimeMaxTimeSkew,
	)
}

func (s *Session) Disconnect(ctx context.Context, reason string) error {
	runtimeID, err := s.requireRuntimeID()
	if err != nil {
		if errors.Is(err, ErrRuntimeNotInitialized) {
			return nil
		}
		return err
	}
	if err := s.hub.Disconnect(ctx, runtimeID, reason); err != nil && !errors.Is(err, hub.ErrRuntimeNotConnected) {
		return err
	}

	s.mu.Lock()
	s.conn = nil
	s.runtimeID = ""
	s.mu.Unlock()
	return nil
}

func (s *Session) handleCapabilityReport(ctx context.Context, envelope proto.Envelope) error {
	return s.handleCapabilityReportWithStore(ctx, s.store, envelope)
}

func (s *Session) handleCapabilityReportWithStore(ctx context.Context, store shareddb.Store, envelope proto.Envelope) error {
	runtimeID, err := s.requireRuntimeID()
	if err != nil {
		return err
	}

	var payload proto.RuntimeCapabilityReportPayload
	if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
		return fmt.Errorf("decode runtime.capability_report payload: %w", err)
	}
	capabilitiesBytes, err := json.Marshal(payload.Capabilities)
	if err != nil {
		return err
	}
	return store.SetRuntimeCapabilities(ctx, runtimeID, string(capabilitiesBytes))
}

func (s *Session) handleHeartbeat(ctx context.Context, envelope proto.Envelope) error {
	runtimeID, err := s.requireRuntimeID()
	if err != nil {
		return err
	}

	var payload proto.RuntimeHeartbeatPayload
	if len(envelope.Payload) != 0 {
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			return fmt.Errorf("decode runtime.heartbeat payload: %w", err)
		}
	}
	if err := s.hub.HandleHeartbeat(ctx, runtimeID, payload.Load); err != nil {
		return err
	}

	ack, err := s.buildStreamEnvelope(envelope.ExecutionID, "runtime.heartbeat_ack", "heartbeat", map[string]any{})
	if err != nil {
		return err
	}
	wire, err := json.Marshal(ack)
	if err != nil {
		return err
	}
	return s.hub.Send(ctx, runtimeID, wire)
}

func (s *Session) handleResumeRequest(ctx context.Context, envelope proto.Envelope) error {
	runtimeID, err := s.requireRuntimeID()
	if err != nil {
		return err
	}

	var payload proto.StreamResumeRequestPayload
	if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
		return fmt.Errorf("decode stream.resume_request payload: %w", err)
	}
	cursors, err := s.store.GetStreamCursors(ctx, payload.ExecutionID, payload.Streams)
	if err != nil {
		return err
	}
	cursorByStream := make(map[string]int64, len(cursors))
	for _, cursor := range cursors {
		cursorByStream[cursor.StreamID] = cursor.LastCommittedSeq
	}

	streams := make([]proto.StreamResumeAckStream, 0, len(payload.Streams))
	for _, streamID := range payload.Streams {
		streams = append(streams, proto.StreamResumeAckStream{
			StreamID:         streamID,
			LastCommittedSeq: cursorByStream[streamID],
		})
	}

	ack, err := s.buildStatefulEnvelope(payload.ExecutionID, "stream.resume_ack", proto.StreamResumeAckPayload{
		ExecutionID: payload.ExecutionID,
		Streams:     streams,
	})
	if err != nil {
		return err
	}
	wire, err := json.Marshal(ack)
	if err != nil {
		return err
	}
	return s.hub.Send(ctx, runtimeID, wire)
}

func (s *Session) handleApprovalRequest(ctx context.Context, envelope proto.Envelope) error {
	return s.handleApprovalRequestWithStore(ctx, s.store, envelope)
}

func (s *Session) handleApprovalRequestWithStore(ctx context.Context, store shareddb.Store, envelope proto.Envelope) error {
	runtimeID, err := s.requireRuntimeID()
	if err != nil {
		return err
	}

	var payload proto.ApprovalRequestPayload
	if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
		return fmt.Errorf("decode approval.request payload: %w", err)
	}
	if payload.ApprovalID == "" {
		return errors.New("approval.request requires approval_id")
	}
	if payload.TaskID == "" {
		return errors.New("approval.request requires task_id")
	}
	if payload.Kind == "" {
		return errors.New("approval.request requires kind")
	}
	if payload.Action == "" {
		return errors.New("approval.request requires action")
	}
	if payload.RequestSignature == "" {
		return errors.New("approval.request requires request_signature")
	}

	_, err = store.CreateTaskApproval(ctx, shareddb.CreateTaskApprovalParams{
		ID:               payload.ApprovalID,
		TaskID:           payload.TaskID,
		Kind:             payload.Kind,
		Action:           payload.Action,
		Payload:          defaultApprovalJSON(payload.Payload),
		RequestedByDid:   runtimeID,
		ApproverDid:      payload.ApproverDID,
		ApproverIMUserID: payload.ApproverIMUserID,
		RequestSignature: payload.RequestSignature,
		Metadata:         defaultApprovalJSON(payload.Metadata),
	})
	return err
}

func (s *Session) applyStatefulEnvelope(ctx context.Context, envelope proto.Envelope, mutate shareddb.StatefulMessageMutator) error {
	if err := proto.VerifyPayloadHash(envelope); err != nil {
		return err
	}
	_, err := s.store.ApplyStatefulMessage(ctx, shareddb.StatefulMessageParams{
		ExecutionID:  envelope.ExecutionID,
		StateVersion: envelope.StateVersion,
		MessageID:    envelope.ID,
		MessageType:  envelope.Type,
		PayloadHash:  envelope.PayloadHash,
	}, mutate)
	return err
}

func defaultApprovalJSON(raw json.RawMessage) string {
	if len(raw) == 0 {
		return `{}`
	}
	return string(raw)
}

func (s *Session) requireRuntimeID() (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.runtimeID == "" {
		return "", ErrRuntimeNotInitialized
	}
	return s.runtimeID, nil
}

func (s *Session) buildStatefulEnvelope(executionID string, messageType string, payload any) (proto.Envelope, error) {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return proto.Envelope{}, err
	}
	payloadHash, err := proto.ComputePayloadHash(payloadBytes)
	if err != nil {
		return proto.Envelope{}, err
	}
	stateVersion := atomic.AddInt64(&s.stateSeq, 1)
	return proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           fmt.Sprintf("msg_%d", s.now().UnixNano()),
		ExecutionID:  executionID,
		Type:         messageType,
		MessageClass: proto.MessageClassStateful,
		TimestampMs:  s.now().UnixMilli(),
		StateVersion: stateVersion,
		PayloadHash:  payloadHash,
		AckType:      proto.AckTypeRequired,
		Payload:      payloadBytes,
	}, nil
}

func (s *Session) buildStreamEnvelope(executionID string, messageType string, streamID string, payload any) (proto.Envelope, error) {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return proto.Envelope{}, err
	}
	return proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           fmt.Sprintf("msg_%d", s.now().UnixNano()),
		ExecutionID:  executionID,
		Type:         messageType,
		MessageClass: proto.MessageClassStream,
		TimestampMs:  s.now().UnixMilli(),
		StreamID:     streamID,
		StreamSeq:    int64(atomic.AddUint64(&s.streamSeq, 1) - 1),
		AckType:      proto.AckTypeNone,
		Payload:      payloadBytes,
	}, nil
}
