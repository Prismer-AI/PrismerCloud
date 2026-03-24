package prismer

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"time"

	"nhooyr.io/websocket"
)

// ============================================================================
// Event Payload Types
// ============================================================================

// AuthenticatedPayload is sent when a real-time connection is authenticated.
type AuthenticatedPayload struct {
	UserID   string `json:"userId"`
	Username string `json:"username"`
}

// MessageNewPayload is sent when a new message arrives in a joined conversation.
type MessageNewPayload struct {
	ID             string         `json:"id"`
	ConversationID string         `json:"conversationId"`
	Content        string         `json:"content"`
	Type           string         `json:"type"`
	SenderID       string         `json:"senderId"`
	Routing        *IMRouting     `json:"routing,omitempty"`
	Metadata       map[string]any `json:"metadata,omitempty"`
	CreatedAt      string         `json:"createdAt"`
}

// TypingIndicatorPayload is sent when a user starts or stops typing.
type TypingIndicatorPayload struct {
	ConversationID string `json:"conversationId"`
	UserID         string `json:"userId"`
	IsTyping       bool   `json:"isTyping"`
}

// PresenceChangedPayload is sent when a user's presence status changes.
type PresenceChangedPayload struct {
	UserID string `json:"userId"`
	Status string `json:"status"`
}

// PongPayload is the response to a ping command.
type PongPayload struct {
	RequestID string `json:"requestId"`
}

// RealtimeErrorPayload is sent when a server-side error occurs.
type RealtimeErrorPayload struct {
	Message string `json:"message"`
}

// RealtimeEnvelope is the wire format for all real-time events.
type RealtimeEnvelope struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// RealtimeCommand is a client-to-server command (WebSocket only).
type RealtimeCommand struct {
	Type      string      `json:"type"`
	Payload   interface{} `json:"payload"`
	RequestID string      `json:"requestId,omitempty"`
}

// ============================================================================
// Configuration
// ============================================================================

// RealtimeConfig configures real-time clients.
type RealtimeConfig struct {
	Token                string
	AutoReconnect        bool
	MaxReconnectAttempts int
	ReconnectBaseDelay   time.Duration
	ReconnectMaxDelay    time.Duration
	HeartbeatInterval    time.Duration
	HTTPClient           *http.Client
}

func (c *RealtimeConfig) defaults() {
	if c.ReconnectBaseDelay == 0 {
		c.ReconnectBaseDelay = 1 * time.Second
	}
	if c.ReconnectMaxDelay == 0 {
		c.ReconnectMaxDelay = 30 * time.Second
	}
	if c.MaxReconnectAttempts == 0 {
		c.MaxReconnectAttempts = 10
	}
	if c.HeartbeatInterval == 0 {
		c.HeartbeatInterval = 25 * time.Second
	}
	if c.HTTPClient == nil {
		c.HTTPClient = http.DefaultClient
	}
}

// RealtimeState represents the connection state.
type RealtimeState string

const (
	StateDisconnected RealtimeState = "disconnected"
	StateConnecting   RealtimeState = "connecting"
	StateConnected    RealtimeState = "connected"
	StateReconnecting RealtimeState = "reconnecting"
)

// ============================================================================
// Event Dispatcher
// ============================================================================

// RealtimeEventHandler is the generic event callback type.
type RealtimeEventHandler func(eventType string, payload json.RawMessage)

type eventDispatcher struct {
	mu               sync.RWMutex
	generic          map[string][]RealtimeEventHandler
	onAuthenticated  []func(AuthenticatedPayload)
	onMessageNew     []func(MessageNewPayload)
	onTyping         []func(TypingIndicatorPayload)
	onPresence       []func(PresenceChangedPayload)
	onError          []func(RealtimeErrorPayload)
	onConnected      []func()
	onDisconnected   []func(int, string)
	onReconnecting   []func(int, time.Duration)
}

func newEventDispatcher() *eventDispatcher {
	return &eventDispatcher{
		generic: make(map[string][]RealtimeEventHandler),
	}
}

func (d *eventDispatcher) dispatch(env RealtimeEnvelope) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	// Typed handlers
	switch env.Type {
	case "authenticated":
		var p AuthenticatedPayload
		if json.Unmarshal(env.Payload, &p) == nil {
			for _, h := range d.onAuthenticated {
				go h(p)
			}
		}
	case "message.new":
		var p MessageNewPayload
		if json.Unmarshal(env.Payload, &p) == nil {
			for _, h := range d.onMessageNew {
				go h(p)
			}
		}
	case "typing.indicator":
		var p TypingIndicatorPayload
		if json.Unmarshal(env.Payload, &p) == nil {
			for _, h := range d.onTyping {
				go h(p)
			}
		}
	case "presence.changed":
		var p PresenceChangedPayload
		if json.Unmarshal(env.Payload, &p) == nil {
			for _, h := range d.onPresence {
				go h(p)
			}
		}
	case "error":
		var p RealtimeErrorPayload
		if json.Unmarshal(env.Payload, &p) == nil {
			for _, h := range d.onError {
				go h(p)
			}
		}
	}

	// Generic handlers
	for _, h := range d.generic[env.Type] {
		handler := h // capture
		go handler(env.Type, env.Payload)
	}
}

func (d *eventDispatcher) emitConnected() {
	d.mu.RLock()
	handlers := append([]func(){}, d.onConnected...)
	d.mu.RUnlock()
	for _, h := range handlers {
		go h()
	}
}

func (d *eventDispatcher) emitDisconnected(code int, reason string) {
	d.mu.RLock()
	handlers := append([]func(int, string){}, d.onDisconnected...)
	d.mu.RUnlock()
	for _, h := range handlers {
		go h(code, reason)
	}
}

func (d *eventDispatcher) emitReconnecting(attempt int, delay time.Duration) {
	d.mu.RLock()
	handlers := append([]func(int, time.Duration){}, d.onReconnecting...)
	d.mu.RUnlock()
	for _, h := range handlers {
		go h(attempt, delay)
	}
}

// ============================================================================
// Reconnector
// ============================================================================

type reconnector struct {
	baseDelay   time.Duration
	maxDelay    time.Duration
	maxAttempts int
	attempt     int
	connectedAt time.Time
}

func newReconnector(config *RealtimeConfig) *reconnector {
	return &reconnector{
		baseDelay:   config.ReconnectBaseDelay,
		maxDelay:    config.ReconnectMaxDelay,
		maxAttempts: config.MaxReconnectAttempts,
	}
}

func (r *reconnector) shouldReconnect() bool {
	return r.maxAttempts == 0 || r.attempt < r.maxAttempts
}

func (r *reconnector) markConnected() {
	r.connectedAt = time.Now()
}

func (r *reconnector) nextDelay() time.Duration {
	if !r.connectedAt.IsZero() && time.Since(r.connectedAt) > 60*time.Second {
		r.attempt = 0
	}
	jitter := time.Duration(rand.Float64() * float64(r.baseDelay) * 0.5)
	delay := time.Duration(math.Min(
		float64(r.baseDelay)*math.Pow(2, float64(r.attempt))+float64(jitter),
		float64(r.maxDelay),
	))
	r.attempt++
	return delay
}

func (r *reconnector) reset() {
	r.attempt = 0
	r.connectedAt = time.Time{}
}

// ============================================================================
// RealtimeWSClient
// ============================================================================

// RealtimeWSClient is a WebSocket real-time client with auto-reconnect and heartbeat.
type RealtimeWSClient struct {
	baseURL         string
	config          *RealtimeConfig
	conn            *websocket.Conn
	mu              sync.Mutex
	state           RealtimeState
	intentionalClose bool
	dispatcher      *eventDispatcher
	recon           *reconnector
	cancelFn        context.CancelFunc
	pingCounter     int
	pendingPings    map[string]chan PongPayload
	pendingMu       sync.Mutex
}

// OnAuthenticated registers a handler for the authenticated event.
func (ws *RealtimeWSClient) OnAuthenticated(h func(AuthenticatedPayload)) {
	ws.dispatcher.mu.Lock()
	ws.dispatcher.onAuthenticated = append(ws.dispatcher.onAuthenticated, h)
	ws.dispatcher.mu.Unlock()
}

// OnMessageNew registers a handler for new messages.
func (ws *RealtimeWSClient) OnMessageNew(h func(MessageNewPayload)) {
	ws.dispatcher.mu.Lock()
	ws.dispatcher.onMessageNew = append(ws.dispatcher.onMessageNew, h)
	ws.dispatcher.mu.Unlock()
}

// OnTypingIndicator registers a handler for typing indicators.
func (ws *RealtimeWSClient) OnTypingIndicator(h func(TypingIndicatorPayload)) {
	ws.dispatcher.mu.Lock()
	ws.dispatcher.onTyping = append(ws.dispatcher.onTyping, h)
	ws.dispatcher.mu.Unlock()
}

// OnPresenceChanged registers a handler for presence changes.
func (ws *RealtimeWSClient) OnPresenceChanged(h func(PresenceChangedPayload)) {
	ws.dispatcher.mu.Lock()
	ws.dispatcher.onPresence = append(ws.dispatcher.onPresence, h)
	ws.dispatcher.mu.Unlock()
}

// OnError registers a handler for server errors.
func (ws *RealtimeWSClient) OnError(h func(RealtimeErrorPayload)) {
	ws.dispatcher.mu.Lock()
	ws.dispatcher.onError = append(ws.dispatcher.onError, h)
	ws.dispatcher.mu.Unlock()
}

// OnConnected registers a handler for the connected meta-event.
func (ws *RealtimeWSClient) OnConnected(h func()) {
	ws.dispatcher.mu.Lock()
	ws.dispatcher.onConnected = append(ws.dispatcher.onConnected, h)
	ws.dispatcher.mu.Unlock()
}

// OnDisconnected registers a handler for the disconnected meta-event.
func (ws *RealtimeWSClient) OnDisconnected(h func(code int, reason string)) {
	ws.dispatcher.mu.Lock()
	ws.dispatcher.onDisconnected = append(ws.dispatcher.onDisconnected, h)
	ws.dispatcher.mu.Unlock()
}

// OnReconnecting registers a handler for the reconnecting meta-event.
func (ws *RealtimeWSClient) OnReconnecting(h func(attempt int, delay time.Duration)) {
	ws.dispatcher.mu.Lock()
	ws.dispatcher.onReconnecting = append(ws.dispatcher.onReconnecting, h)
	ws.dispatcher.mu.Unlock()
}

// On registers a generic event handler.
func (ws *RealtimeWSClient) On(eventType string, h RealtimeEventHandler) {
	ws.dispatcher.mu.Lock()
	ws.dispatcher.generic[eventType] = append(ws.dispatcher.generic[eventType], h)
	ws.dispatcher.mu.Unlock()
}

// State returns the current connection state.
func (ws *RealtimeWSClient) State() RealtimeState {
	ws.mu.Lock()
	defer ws.mu.Unlock()
	return ws.state
}

// Connect establishes the WebSocket connection.
func (ws *RealtimeWSClient) Connect(ctx context.Context) error {
	ws.mu.Lock()
	if ws.state == StateConnected || ws.state == StateConnecting {
		ws.mu.Unlock()
		return nil
	}
	ws.state = StateConnecting
	ws.intentionalClose = false
	ws.mu.Unlock()

	wsURL := strings.Replace(ws.baseURL, "https://", "wss://", 1)
	wsURL = strings.Replace(wsURL, "http://", "ws://", 1)
	wsURL += "/ws?token=" + ws.config.Token

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		ws.mu.Lock()
		ws.state = StateDisconnected
		ws.mu.Unlock()
		return fmt.Errorf("websocket dial: %w", err)
	}

	// Read first message (should be "authenticated")
	_, data, err := conn.Read(ctx)
	if err != nil {
		conn.Close(websocket.StatusNormalClosure, "")
		ws.mu.Lock()
		ws.state = StateDisconnected
		ws.mu.Unlock()
		return fmt.Errorf("read auth message: %w", err)
	}

	var env RealtimeEnvelope
	if err := json.Unmarshal(data, &env); err != nil || env.Type != "authenticated" {
		conn.Close(websocket.StatusNormalClosure, "")
		ws.mu.Lock()
		ws.state = StateDisconnected
		ws.mu.Unlock()
		return fmt.Errorf("expected 'authenticated', got '%s'", env.Type)
	}

	ws.mu.Lock()
	ws.conn = conn
	ws.state = StateConnected
	ws.mu.Unlock()
	ws.recon.markConnected()

	ws.dispatcher.dispatch(env)
	ws.dispatcher.emitConnected()

	connCtx, cancel := context.WithCancel(ctx)
	ws.mu.Lock()
	ws.cancelFn = cancel
	ws.mu.Unlock()

	go ws.readLoop(connCtx)
	go ws.heartbeatLoop(connCtx)

	return nil
}

// Disconnect gracefully closes the connection.
func (ws *RealtimeWSClient) Disconnect() error {
	ws.mu.Lock()
	ws.intentionalClose = true
	if ws.cancelFn != nil {
		ws.cancelFn()
		ws.cancelFn = nil
	}
	conn := ws.conn
	ws.conn = nil
	ws.state = StateDisconnected
	ws.mu.Unlock()

	ws.clearPendingPings()

	if conn != nil {
		return conn.Close(websocket.StatusNormalClosure, "client disconnect")
	}
	ws.dispatcher.emitDisconnected(1000, "client disconnect")
	return nil
}

// JoinConversation joins a conversation room.
func (ws *RealtimeWSClient) JoinConversation(ctx context.Context, conversationID string) error {
	return ws.Send(ctx, &RealtimeCommand{
		Type:    "conversation.join",
		Payload: map[string]string{"conversationId": conversationID},
	})
}

// SendMessageOptions configures optional parameters for SendMessage.
type SendMessageOptions struct {
	Metadata map[string]any
	ParentID string
}

// SendMessage sends a message via WebSocket.
func (ws *RealtimeWSClient) SendMessage(ctx context.Context, conversationID, content, msgType string, opts ...SendMessageOptions) error {
	ws.pingCounter++
	payload := map[string]any{
		"conversationId": conversationID,
		"content":        content,
		"type":           msgType,
	}
	if len(opts) > 0 {
		if opts[0].Metadata != nil {
			payload["metadata"] = opts[0].Metadata
		}
		if opts[0].ParentID != "" {
			payload["parentId"] = opts[0].ParentID
		}
	}
	return ws.Send(ctx, &RealtimeCommand{
		Type:      "message.send",
		Payload:   payload,
		RequestID: fmt.Sprintf("msg-%d", ws.pingCounter),
	})
}

// StartTyping sends a typing start indicator.
func (ws *RealtimeWSClient) StartTyping(ctx context.Context, conversationID string) error {
	return ws.Send(ctx, &RealtimeCommand{
		Type:    "typing.start",
		Payload: map[string]string{"conversationId": conversationID},
	})
}

// StopTyping sends a typing stop indicator.
func (ws *RealtimeWSClient) StopTyping(ctx context.Context, conversationID string) error {
	return ws.Send(ctx, &RealtimeCommand{
		Type:    "typing.stop",
		Payload: map[string]string{"conversationId": conversationID},
	})
}

// UpdatePresence updates the user's presence status.
func (ws *RealtimeWSClient) UpdatePresence(ctx context.Context, status string) error {
	return ws.Send(ctx, &RealtimeCommand{
		Type:    "presence.update",
		Payload: map[string]string{"status": status},
	})
}

// Send sends a raw command over the WebSocket.
func (ws *RealtimeWSClient) Send(ctx context.Context, cmd *RealtimeCommand) error {
	ws.mu.Lock()
	conn := ws.conn
	ws.mu.Unlock()

	if conn == nil {
		return fmt.Errorf("not connected")
	}

	data, err := json.Marshal(cmd)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, data)
}

// Ping sends a ping and waits for pong.
func (ws *RealtimeWSClient) Ping(ctx context.Context) (*PongPayload, error) {
	ws.pingCounter++
	requestID := fmt.Sprintf("ping-%d", ws.pingCounter)

	ch := make(chan PongPayload, 1)
	ws.pendingMu.Lock()
	ws.pendingPings[requestID] = ch
	ws.pendingMu.Unlock()

	err := ws.Send(ctx, &RealtimeCommand{
		Type:    "ping",
		Payload: map[string]string{"requestId": requestID},
	})
	if err != nil {
		ws.pendingMu.Lock()
		delete(ws.pendingPings, requestID)
		ws.pendingMu.Unlock()
		return nil, err
	}

	select {
	case pong := <-ch:
		return &pong, nil
	case <-time.After(10 * time.Second):
		ws.pendingMu.Lock()
		delete(ws.pendingPings, requestID)
		ws.pendingMu.Unlock()
		return nil, fmt.Errorf("ping timeout")
	case <-ctx.Done():
		ws.pendingMu.Lock()
		delete(ws.pendingPings, requestID)
		ws.pendingMu.Unlock()
		return nil, ctx.Err()
	}
}

func (ws *RealtimeWSClient) readLoop(ctx context.Context) {
	for {
		_, data, err := ws.conn.Read(ctx)
		if err != nil {
			ws.mu.Lock()
			intentional := ws.intentionalClose
			ws.mu.Unlock()
			if intentional {
				return
			}

			ws.mu.Lock()
			ws.state = StateDisconnected
			ws.conn = nil
			ws.mu.Unlock()

			ws.dispatcher.emitDisconnected(0, err.Error())

			if ws.config.AutoReconnect && ws.recon.shouldReconnect() {
				ws.scheduleReconnect(ctx)
			}
			return
		}

		var env RealtimeEnvelope
		if json.Unmarshal(data, &env) != nil {
			continue
		}

		// Resolve pending pings
		if env.Type == "pong" {
			var p PongPayload
			if json.Unmarshal(env.Payload, &p) == nil && p.RequestID != "" {
				ws.pendingMu.Lock()
				ch, ok := ws.pendingPings[p.RequestID]
				if ok {
					delete(ws.pendingPings, p.RequestID)
				}
				ws.pendingMu.Unlock()
				if ok {
					ch <- p
				}
			}
		}

		ws.dispatcher.dispatch(env)
	}
}

func (ws *RealtimeWSClient) heartbeatLoop(ctx context.Context) {
	ticker := time.NewTicker(ws.config.HeartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			ws.mu.Lock()
			s := ws.state
			ws.mu.Unlock()
			if s != StateConnected {
				return
			}

			_, err := ws.Ping(ctx)
			if err != nil {
				// Heartbeat failed — force close
				ws.mu.Lock()
				conn := ws.conn
				ws.mu.Unlock()
				if conn != nil {
					conn.Close(websocket.StatusGoingAway, "heartbeat timeout")
				}
				return
			}
		}
	}
}

func (ws *RealtimeWSClient) scheduleReconnect(ctx context.Context) {
	delay := ws.recon.nextDelay()
	ws.mu.Lock()
	ws.state = StateReconnecting
	ws.mu.Unlock()

	ws.dispatcher.emitReconnecting(ws.recon.attempt, delay)

	time.Sleep(delay)

	if err := ws.Connect(ctx); err != nil {
		if ws.config.AutoReconnect && ws.recon.shouldReconnect() {
			ws.scheduleReconnect(ctx)
		} else {
			ws.mu.Lock()
			ws.state = StateDisconnected
			ws.mu.Unlock()
		}
	}
}

func (ws *RealtimeWSClient) clearPendingPings() {
	ws.pendingMu.Lock()
	for k, ch := range ws.pendingPings {
		close(ch)
		delete(ws.pendingPings, k)
	}
	ws.pendingMu.Unlock()
}

// ============================================================================
// RealtimeSSEClient
// ============================================================================

// RealtimeSSEClient is an SSE real-time client (server-push only) with auto-reconnect.
type RealtimeSSEClient struct {
	baseURL          string
	config           *RealtimeConfig
	mu               sync.Mutex
	state            RealtimeState
	intentionalClose bool
	dispatcher       *eventDispatcher
	recon            *reconnector
	cancelFn         context.CancelFunc
	lastDataTime     time.Time
}

// OnAuthenticated registers a handler for the authenticated event.
func (sse *RealtimeSSEClient) OnAuthenticated(h func(AuthenticatedPayload)) {
	sse.dispatcher.mu.Lock()
	sse.dispatcher.onAuthenticated = append(sse.dispatcher.onAuthenticated, h)
	sse.dispatcher.mu.Unlock()
}

// OnMessageNew registers a handler for new messages.
func (sse *RealtimeSSEClient) OnMessageNew(h func(MessageNewPayload)) {
	sse.dispatcher.mu.Lock()
	sse.dispatcher.onMessageNew = append(sse.dispatcher.onMessageNew, h)
	sse.dispatcher.mu.Unlock()
}

// OnTypingIndicator registers a handler for typing indicators.
func (sse *RealtimeSSEClient) OnTypingIndicator(h func(TypingIndicatorPayload)) {
	sse.dispatcher.mu.Lock()
	sse.dispatcher.onTyping = append(sse.dispatcher.onTyping, h)
	sse.dispatcher.mu.Unlock()
}

// OnPresenceChanged registers a handler for presence changes.
func (sse *RealtimeSSEClient) OnPresenceChanged(h func(PresenceChangedPayload)) {
	sse.dispatcher.mu.Lock()
	sse.dispatcher.onPresence = append(sse.dispatcher.onPresence, h)
	sse.dispatcher.mu.Unlock()
}

// OnError registers a handler for server errors.
func (sse *RealtimeSSEClient) OnError(h func(RealtimeErrorPayload)) {
	sse.dispatcher.mu.Lock()
	sse.dispatcher.onError = append(sse.dispatcher.onError, h)
	sse.dispatcher.mu.Unlock()
}

// OnConnected registers a handler for the connected meta-event.
func (sse *RealtimeSSEClient) OnConnected(h func()) {
	sse.dispatcher.mu.Lock()
	sse.dispatcher.onConnected = append(sse.dispatcher.onConnected, h)
	sse.dispatcher.mu.Unlock()
}

// OnDisconnected registers a handler for the disconnected meta-event.
func (sse *RealtimeSSEClient) OnDisconnected(h func(code int, reason string)) {
	sse.dispatcher.mu.Lock()
	sse.dispatcher.onDisconnected = append(sse.dispatcher.onDisconnected, h)
	sse.dispatcher.mu.Unlock()
}

// OnReconnecting registers a handler for the reconnecting meta-event.
func (sse *RealtimeSSEClient) OnReconnecting(h func(attempt int, delay time.Duration)) {
	sse.dispatcher.mu.Lock()
	sse.dispatcher.onReconnecting = append(sse.dispatcher.onReconnecting, h)
	sse.dispatcher.mu.Unlock()
}

// On registers a generic event handler.
func (sse *RealtimeSSEClient) On(eventType string, h RealtimeEventHandler) {
	sse.dispatcher.mu.Lock()
	sse.dispatcher.generic[eventType] = append(sse.dispatcher.generic[eventType], h)
	sse.dispatcher.mu.Unlock()
}

// State returns the current connection state.
func (sse *RealtimeSSEClient) State() RealtimeState {
	sse.mu.Lock()
	defer sse.mu.Unlock()
	return sse.state
}

// Connect establishes the SSE connection.
func (sse *RealtimeSSEClient) Connect(ctx context.Context) error {
	sse.mu.Lock()
	if sse.state == StateConnected || sse.state == StateConnecting {
		sse.mu.Unlock()
		return nil
	}
	sse.state = StateConnecting
	sse.intentionalClose = false
	sse.mu.Unlock()

	sseURL := sse.baseURL + "/sse?token=" + sse.config.Token

	req, err := http.NewRequestWithContext(ctx, "GET", sseURL, nil)
	if err != nil {
		sse.mu.Lock()
		sse.state = StateDisconnected
		sse.mu.Unlock()
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Accept", "text/event-stream")

	resp, err := sse.config.HTTPClient.Do(req)
	if err != nil {
		sse.mu.Lock()
		sse.state = StateDisconnected
		sse.mu.Unlock()
		return fmt.Errorf("SSE connect: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		sse.mu.Lock()
		sse.state = StateDisconnected
		sse.mu.Unlock()
		return fmt.Errorf("SSE HTTP %d", resp.StatusCode)
	}

	sse.mu.Lock()
	sse.state = StateConnected
	sse.lastDataTime = time.Now()
	sse.mu.Unlock()
	sse.recon.markConnected()
	sse.dispatcher.emitConnected()

	connCtx, cancel := context.WithCancel(ctx)
	sse.mu.Lock()
	sse.cancelFn = cancel
	sse.mu.Unlock()

	go sse.readLoop(connCtx, resp)
	go sse.heartbeatWatchdog(connCtx)

	return nil
}

// Disconnect closes the SSE connection.
func (sse *RealtimeSSEClient) Disconnect() error {
	sse.mu.Lock()
	sse.intentionalClose = true
	if sse.cancelFn != nil {
		sse.cancelFn()
		sse.cancelFn = nil
	}
	sse.state = StateDisconnected
	sse.mu.Unlock()

	sse.dispatcher.emitDisconnected(1000, "client disconnect")
	return nil
}

func (sse *RealtimeSSEClient) readLoop(ctx context.Context, resp *http.Response) {
	defer resp.Body.Close()

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return
		default:
		}

		line := scanner.Text()

		sse.mu.Lock()
		sse.lastDataTime = time.Now()
		sse.mu.Unlock()

		if strings.HasPrefix(line, ":") {
			continue // heartbeat comment
		}

		if strings.HasPrefix(line, "data: ") {
			jsonStr := strings.TrimPrefix(line, "data: ")
			var env RealtimeEnvelope
			if json.Unmarshal([]byte(jsonStr), &env) == nil {
				sse.dispatcher.dispatch(env)
			}
		}
	}

	sse.mu.Lock()
	intentional := sse.intentionalClose
	sse.mu.Unlock()
	if intentional {
		return
	}

	sse.mu.Lock()
	sse.state = StateDisconnected
	sse.mu.Unlock()
	sse.dispatcher.emitDisconnected(0, "stream ended")

	if sse.config.AutoReconnect && sse.recon.shouldReconnect() {
		sse.scheduleReconnect(ctx)
	}
}

func (sse *RealtimeSSEClient) heartbeatWatchdog(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sse.mu.Lock()
			stale := time.Since(sse.lastDataTime) > 45*time.Second
			sse.mu.Unlock()
			if stale {
				if sse.cancelFn != nil {
					sse.cancelFn()
				}
				return
			}
		}
	}
}

func (sse *RealtimeSSEClient) scheduleReconnect(ctx context.Context) {
	delay := sse.recon.nextDelay()
	sse.mu.Lock()
	sse.state = StateReconnecting
	sse.mu.Unlock()

	sse.dispatcher.emitReconnecting(sse.recon.attempt, delay)

	time.Sleep(delay)

	// Use background context since the old context is cancelled
	if err := sse.Connect(context.Background()); err != nil {
		if sse.config.AutoReconnect && sse.recon.shouldReconnect() {
			sse.scheduleReconnect(context.Background())
		} else {
			sse.mu.Lock()
			sse.state = StateDisconnected
			sse.mu.Unlock()
		}
	}
}
