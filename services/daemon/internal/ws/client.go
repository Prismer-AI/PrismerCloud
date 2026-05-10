package ws

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
	"github.com/gorilla/websocket"
)

var (
	ErrClientNotConnected = errors.New("daemon websocket client not connected")
	ErrMissingRuntimeDID  = errors.New("runtime did required")
	ErrMissingSessionID   = errors.New("session id required")
)

type Dialer interface {
	DialContext(ctx context.Context, url string, requestHeader http.Header) (Conn, *http.Response, error)
}

type Conn interface {
	ReadMessage() (messageType int, p []byte, err error)
	WriteMessage(messageType int, data []byte) error
	Close() error
	SetReadDeadline(t time.Time) error
	SetWriteDeadline(t time.Time) error
}

type Config struct {
	URL               string
	RuntimeDID        string
	SessionID         string
	Version           string
	AgentJoinToken    string
	SigningKeyID      string
	SigningPrivateKey ed25519.PrivateKey
	Host              proto.RuntimeHelloHost
	Capabilities      []proto.RuntimeCapability
	HeartbeatInterval time.Duration
	UserAgent         string
	LoadProvider      func() float64
}

type gorillaDialer struct {
	inner *websocket.Dialer
}

func (d *gorillaDialer) DialContext(ctx context.Context, url string, requestHeader http.Header) (Conn, *http.Response, error) {
	return d.inner.DialContext(ctx, url, requestHeader)
}

type Client struct {
	cfg    Config
	dialer Dialer
	now    func() time.Time

	mu           sync.RWMutex
	conn         Conn
	cancel       context.CancelFunc
	runCtx       context.Context
	ready        chan struct{}
	reconnecting bool

	stateSeq  int64
	streamSeq map[string]map[string]int64
	waiters   map[string][]chan proto.StreamResumeAckPayload
	tracked   map[string][]string

	tasks       chan proto.TaskPushPayload
	cancels     chan proto.TaskCancelPayload
	approvals   chan proto.ApprovalDecisionPayload
	errors      chan error
	reconnected chan struct{}
}

func NewClient(cfg Config) *Client {
	if cfg.HeartbeatInterval <= 0 {
		cfg.HeartbeatInterval = 20 * time.Second
	}
	return &Client{
		cfg:         cfg,
		dialer:      &gorillaDialer{inner: websocket.DefaultDialer},
		now:         time.Now,
		ready:       make(chan struct{}),
		streamSeq:   make(map[string]map[string]int64),
		waiters:     make(map[string][]chan proto.StreamResumeAckPayload),
		tracked:     make(map[string][]string),
		tasks:       make(chan proto.TaskPushPayload, 16),
		cancels:     make(chan proto.TaskCancelPayload, 16),
		approvals:   make(chan proto.ApprovalDecisionPayload, 16),
		errors:      make(chan error, 16),
		reconnected: make(chan struct{}, 8),
	}
}

func (c *Client) SetDialer(dialer Dialer) {
	c.dialer = dialer
}

func (c *Client) Start(ctx context.Context) error {
	if c.cfg.RuntimeDID == "" {
		return ErrMissingRuntimeDID
	}
	if c.cfg.SessionID == "" {
		return ErrMissingSessionID
	}
	if c.cfg.URL == "" {
		return fmt.Errorf("daemon websocket url required")
	}

	runCtx, cancel := context.WithCancel(ctx)
	c.mu.Lock()
	c.cancel = cancel
	c.runCtx = runCtx
	c.mu.Unlock()

	conn, err := c.connectAndBootstrap(runCtx)
	if err != nil {
		cancel()
		c.clearConnection()
		return err
	}
	go c.readLoop(runCtx, conn)
	go c.heartbeatLoop(runCtx)
	return nil
}

func (c *Client) Close() error {
	c.mu.Lock()
	cancel := c.cancel
	conn := c.conn
	c.conn = nil
	c.cancel = nil
	c.runCtx = nil
	c.ready = make(chan struct{})
	c.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if conn != nil {
		return conn.Close()
	}
	return nil
}

func (c *Client) TaskPushes() <-chan proto.TaskPushPayload {
	return c.tasks
}

func (c *Client) TaskCancels() <-chan proto.TaskCancelPayload {
	return c.cancels
}

func (c *Client) ApprovalDecisions() <-chan proto.ApprovalDecisionPayload {
	return c.approvals
}

func (c *Client) Errors() <-chan error {
	return c.errors
}

func (c *Client) Reconnects() <-chan struct{} {
	return c.reconnected
}

func (c *Client) TrackExecution(executionID string, streams []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.tracked[executionID] = append([]string(nil), streams...)
}

func (c *Client) UntrackExecution(executionID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.tracked, executionID)
	delete(c.streamSeq, executionID)
	delete(c.waiters, executionID)
}

func (c *Client) SyncExecutionStreams(ctx context.Context, executionID string, streams []string) (proto.StreamResumeAckPayload, error) {
	waiter := make(chan proto.StreamResumeAckPayload, 1)
	c.mu.Lock()
	c.waiters[executionID] = append(c.waiters[executionID], waiter)
	c.mu.Unlock()

	if err := c.sendStateful(ctx, executionID, "stream.resume_request", proto.StreamResumeRequestPayload{
		ExecutionID: executionID,
		Streams:     streams,
	}); err != nil {
		c.removeWaiter(executionID, waiter)
		return proto.StreamResumeAckPayload{}, err
	}

	select {
	case <-ctx.Done():
		c.removeWaiter(executionID, waiter)
		return proto.StreamResumeAckPayload{}, ctx.Err()
	case ack := <-waiter:
		return ack, nil
	}
}

func (c *Client) SendCapabilityReport(ctx context.Context, capabilities []proto.RuntimeCapability) error {
	return c.sendStateful(ctx, c.cfg.SessionID, "runtime.capability_report", proto.RuntimeCapabilityReportPayload{
		Capabilities: capabilities,
		ScannedAtMs:  c.now().UnixMilli(),
	})
}

func (c *Client) SendAccepted(ctx context.Context, payload proto.TaskAcceptedPayload) error {
	return c.sendStateful(ctx, payload.ExecutionID, "task.accepted", payload)
}

func (c *Client) SendRejected(ctx context.Context, payload proto.TaskRejectedPayload) error {
	return c.sendStateful(ctx, payload.ExecutionID, "task.rejected", payload)
}

func (c *Client) SendFinished(ctx context.Context, payload proto.TaskFinishedPayload) error {
	return c.sendStateful(ctx, payload.ExecutionID, "task.finished", payload)
}

func (c *Client) SendApprovalRequest(ctx context.Context, payload proto.ApprovalRequestPayload) error {
	executionID := payload.TaskID
	if executionID == "" {
		executionID = payload.ApprovalID
	}
	return c.sendStateful(ctx, executionID, "approval.request", payload)
}

func (c *Client) SendLogChunk(ctx context.Context, payload proto.TaskLogChunkPayload) error {
	streamID := payload.Stream
	if streamID == "" {
		streamID = "stdout"
	}
	streamSeq := int64(0)
	if len(payload.Chunks) > 0 {
		streamSeq = payload.Chunks[len(payload.Chunks)-1].Seq
		c.ensureNextStreamSeq(payload.ExecutionID, streamID, streamSeq+1)
	}
	return c.sendStreamWithSeq(ctx, payload.ExecutionID, "task.log_chunk", streamID, streamSeq, payload)
}

func (c *Client) sendRuntimeHello(ctx context.Context) error {
	return c.sendStateful(ctx, c.cfg.SessionID, "runtime.hello", proto.RuntimeHelloPayload{
		DID:            c.cfg.RuntimeDID,
		SessionID:      c.cfg.SessionID,
		Version:        c.cfg.Version,
		AgentJoinToken: c.cfg.AgentJoinToken,
		Host:           c.cfg.Host,
	})
}

func (c *Client) heartbeatLoop(ctx context.Context) {
	ticker := time.NewTicker(c.cfg.HeartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			load := 0.0
			if c.cfg.LoadProvider != nil {
				load = c.cfg.LoadProvider()
			}
			if err := c.sendStream(ctx, c.cfg.SessionID, "runtime.heartbeat", "heartbeat", proto.RuntimeHeartbeatPayload{
				Load: load,
			}); err != nil {
				c.reportError(err)
				return
			}
		}
	}
}

func (c *Client) readLoop(ctx context.Context, conn Conn) {
	for {
		if deadline, ok := ctx.Deadline(); ok {
			_ = conn.SetReadDeadline(deadline)
		}
		_, wire, err := conn.ReadMessage()
		if err != nil {
			if ctx.Err() == nil {
				c.handleDisconnect(err, conn)
			}
			return
		}
		if err := c.handleInbound(wire); err != nil {
			c.reportError(err)
			return
		}
	}
}

func (c *Client) handleInbound(wire []byte) error {
	var envelope proto.Envelope
	if err := json.Unmarshal(wire, &envelope); err != nil {
		return fmt.Errorf("decode inbound envelope: %w", err)
	}
	if err := envelope.Validate(); err != nil {
		return err
	}

	switch envelope.Type {
	case "runtime.heartbeat_ack":
		return nil
	case "stream.resume_ack":
		var payload proto.StreamResumeAckPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			return err
		}
		c.applyResumeAck(payload)
		return nil
	case "task.push":
		var payload proto.TaskPushPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			return err
		}
		c.tasks <- payload
		return nil
	case "task.cancel":
		var payload proto.TaskCancelPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			return err
		}
		c.cancels <- payload
		return nil
	case "approval.decision":
		var payload proto.ApprovalDecisionPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			return err
		}
		c.approvals <- payload
		return nil
	default:
		return fmt.Errorf("unsupported inbound message type: %s", envelope.Type)
	}
}

func (c *Client) sendStateful(ctx context.Context, executionID string, messageType string, payload any) error {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	payloadHash, err := proto.ComputePayloadHash(payloadBytes)
	if err != nil {
		return err
	}
	envelope := proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           c.nextMessageID("msg"),
		ExecutionID:  executionID,
		Type:         messageType,
		MessageClass: proto.MessageClassStateful,
		TimestampMs:  c.now().UnixMilli(),
		StateVersion: atomic.AddInt64(&c.stateSeq, 1),
		PayloadHash:  payloadHash,
		AckType:      proto.AckTypeRequired,
		KeyID:        c.cfg.SigningKeyID,
		Payload:      payloadBytes,
	}
	if err := c.signEnvelope(&envelope); err != nil {
		return err
	}
	return c.writeEnvelope(ctx, envelope)
}

func (c *Client) sendStream(ctx context.Context, executionID string, messageType string, streamID string, payload any) error {
	return c.sendStreamWithSeq(ctx, executionID, messageType, streamID, c.nextStreamSeq(executionID, streamID), payload)
}

func (c *Client) sendStreamWithSeq(ctx context.Context, executionID string, messageType string, streamID string, streamSeq int64, payload any) error {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	envelope := proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           c.nextMessageID("msg"),
		ExecutionID:  executionID,
		Type:         messageType,
		MessageClass: proto.MessageClassStream,
		TimestampMs:  c.now().UnixMilli(),
		StreamID:     streamID,
		StreamSeq:    streamSeq,
		AckType:      proto.AckTypeBestEffort,
		KeyID:        c.cfg.SigningKeyID,
		Payload:      payloadBytes,
	}
	if err := c.signEnvelope(&envelope); err != nil {
		return err
	}
	return c.writeEnvelope(ctx, envelope)
}

func (c *Client) writeEnvelope(ctx context.Context, envelope proto.Envelope) error {
	wire, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		conn, err := c.requireConn(ctx)
		if err != nil {
			return err
		}
		if deadline, ok := ctx.Deadline(); ok {
			_ = conn.SetWriteDeadline(deadline)
		}
		if err := conn.WriteMessage(websocket.TextMessage, wire); err == nil {
			return nil
		} else {
			lastErr = err
			c.handleDisconnect(err, conn)
		}
	}
	return lastErr
}

func (c *Client) requireConn(ctx context.Context) (Conn, error) {
	for {
		c.mu.RLock()
		conn := c.conn
		ready := c.ready
		c.mu.RUnlock()
		if conn != nil {
			return conn, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ready:
		}
	}
}

func (c *Client) clearConnection() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.conn = nil
	c.cancel = nil
	c.runCtx = nil
	c.ready = make(chan struct{})
	c.waiters = make(map[string][]chan proto.StreamResumeAckPayload)
}

func (c *Client) reportError(err error) {
	select {
	case c.errors <- err:
	default:
	}
}

func (c *Client) nextMessageID(prefix string) string {
	return fmt.Sprintf("%s_%d", prefix, c.now().UnixNano())
}

func (c *Client) signEnvelope(envelope *proto.Envelope) error {
	if len(c.cfg.SigningPrivateKey) == 0 {
		return nil
	}
	if c.cfg.SigningKeyID == "" {
		return fmt.Errorf("daemon signing key_id required when private key configured")
	}
	return proto.SignEnvelope(envelope, c.cfg.SigningPrivateKey)
}

func (c *Client) nextStreamSeq(executionID string, streamID string) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	streams := c.streamSeq[executionID]
	if streams == nil {
		streams = make(map[string]int64)
		c.streamSeq[executionID] = streams
	}
	seq := streams[streamID]
	streams[streamID] = seq + 1
	return seq
}

func (c *Client) ensureNextStreamSeq(executionID string, streamID string, next int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	streams := c.streamSeq[executionID]
	if streams == nil {
		streams = make(map[string]int64)
		c.streamSeq[executionID] = streams
	}
	if streams[streamID] < next {
		streams[streamID] = next
	}
}

func (c *Client) applyResumeAck(payload proto.StreamResumeAckPayload) {
	c.mu.Lock()
	streams := c.streamSeq[payload.ExecutionID]
	if streams == nil {
		streams = make(map[string]int64)
		c.streamSeq[payload.ExecutionID] = streams
	}
	for _, stream := range payload.Streams {
		next := stream.LastCommittedSeq + 1
		if next < 0 {
			next = 0
		}
		streams[stream.StreamID] = next
	}
	waiters := c.waiters[payload.ExecutionID]
	delete(c.waiters, payload.ExecutionID)
	c.mu.Unlock()

	for _, waiter := range waiters {
		select {
		case waiter <- payload:
		default:
		}
		close(waiter)
	}
}

func (c *Client) removeWaiter(executionID string, target chan proto.StreamResumeAckPayload) {
	c.mu.Lock()
	defer c.mu.Unlock()
	waiters := c.waiters[executionID]
	if len(waiters) == 0 {
		return
	}
	filtered := waiters[:0]
	for _, waiter := range waiters {
		if waiter == target {
			continue
		}
		filtered = append(filtered, waiter)
	}
	if len(filtered) == 0 {
		delete(c.waiters, executionID)
		return
	}
	c.waiters[executionID] = filtered
}

func (c *Client) connectAndBootstrap(ctx context.Context) (Conn, error) {
	conn, _, err := c.dialer.DialContext(ctx, c.cfg.URL, http.Header{
		"User-Agent": []string{c.cfg.UserAgent},
	})
	if err != nil {
		return nil, err
	}
	c.setConnection(conn)
	if err := c.sendRuntimeHello(ctx); err != nil {
		_ = conn.Close()
		c.handleDisconnect(err, conn)
		return nil, err
	}
	if len(c.cfg.Capabilities) > 0 {
		if err := c.SendCapabilityReport(ctx, c.cfg.Capabilities); err != nil {
			_ = conn.Close()
			c.handleDisconnect(err, conn)
			return nil, err
		}
	}
	return conn, nil
}

func (c *Client) setConnection(conn Conn) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.conn = conn
	if c.ready != nil {
		close(c.ready)
	}
}

func (c *Client) handleDisconnect(err error, failedConn Conn) {
	c.mu.Lock()
	if failedConn != nil && c.conn != failedConn {
		c.mu.Unlock()
		return
	}
	if c.conn != nil {
		_ = c.conn.Close()
		c.conn = nil
	}
	c.ready = make(chan struct{})
	if c.reconnecting || c.runCtx == nil || c.runCtx.Err() != nil {
		c.mu.Unlock()
		return
	}
	c.reconnecting = true
	runCtx := c.runCtx
	c.mu.Unlock()

	go c.reconnectLoop(runCtx)
}

func (c *Client) reconnectLoop(ctx context.Context) {
	backoff := 100 * time.Millisecond
	for {
		if ctx.Err() != nil {
			c.mu.Lock()
			c.reconnecting = false
			c.mu.Unlock()
			return
		}
		conn, err := c.connectAndBootstrap(ctx)
		if err == nil {
			c.mu.Lock()
			c.reconnecting = false
			c.mu.Unlock()
			go c.readLoop(ctx, conn)
			c.resumeTrackedExecutions(ctx)
			c.notifyReconnected()
			return
		}
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			c.mu.Lock()
			c.reconnecting = false
			c.mu.Unlock()
			return
		case <-timer.C:
		}
		if backoff < time.Second {
			backoff *= 2
			if backoff > time.Second {
				backoff = time.Second
			}
		}
	}
}

func (c *Client) resumeTrackedExecutions(ctx context.Context) {
	c.mu.RLock()
	tracked := make(map[string][]string, len(c.tracked))
	for executionID, streams := range c.tracked {
		tracked[executionID] = append([]string(nil), streams...)
	}
	c.mu.RUnlock()

	for executionID, streams := range tracked {
		resumeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		_, err := c.SyncExecutionStreams(resumeCtx, executionID, streams)
		cancel()
		if err != nil {
			c.reportError(fmt.Errorf("resume tracked execution %s: %w", executionID, err))
			return
		}
	}
}

func (c *Client) notifyReconnected() {
	select {
	case c.reconnected <- struct{}{}:
	default:
	}
}
