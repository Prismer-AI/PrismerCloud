// Package prismer — Offline Manager, Outbox Queue, and Sync Engine (Go).
//
// Port of core offline-first features from the TypeScript SDK.
// Provides MemoryStorage, outbox queue with idempotency, and polling sync.
//
// Usage:
//
//	storage := prismer.NewMemoryStorage()
//	offline := prismer.NewOfflineManager(storage, client, nil)
//	offline.Init()
//	defer offline.Destroy()
//
//	result, _ := offline.Dispatch(ctx, "POST", "/api/im/messages/conv-123", map[string]any{"content":"hello"}, nil)
package prismer

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// ============================================================================
// Data Types
// ============================================================================

// StoredMessage represents a locally cached message.
type StoredMessage struct {
	ID             string         `json:"id"`
	ClientID       string         `json:"clientId,omitempty"`
	ConversationID string         `json:"conversationId"`
	Content        string         `json:"content"`
	Type           string         `json:"type"`
	SenderID       string         `json:"senderId"`
	ParentID       *string        `json:"parentId,omitempty"`
	Status         string         `json:"status"`
	Metadata       map[string]any `json:"metadata,omitempty"`
	CreatedAt      string         `json:"createdAt"`
	UpdatedAt      string         `json:"updatedAt,omitempty"`
	SyncSeq        int            `json:"syncSeq,omitempty"`
}

// StoredConversation represents a locally cached conversation.
type StoredConversation struct {
	ID            string            `json:"id"`
	Type          string            `json:"type"`
	Title         string            `json:"title,omitempty"`
	LastMessage   json.RawMessage   `json:"lastMessage,omitempty"`
	LastMessageAt string            `json:"lastMessageAt,omitempty"`
	UnreadCount   int               `json:"unreadCount"`
	Members       []json.RawMessage `json:"members,omitempty"`
	Metadata      map[string]any    `json:"metadata,omitempty"`
	UpdatedAt     string            `json:"updatedAt,omitempty"`
	SyncSeq       int               `json:"syncSeq,omitempty"`
}

// OutboxOp represents a queued offline write operation.
type OutboxOp struct {
	ID             string         `json:"id"`
	OpType         string         `json:"type"`
	Method         string         `json:"method"`
	Path           string         `json:"path"`
	Body           any            `json:"body,omitempty"`
	Query          map[string]string `json:"query,omitempty"`
	Status         string         `json:"status"`
	CreatedAt      time.Time      `json:"createdAt"`
	Retries        int            `json:"retries"`
	MaxRetries     int            `json:"maxRetries"`
	IdempotencyKey string         `json:"idempotencyKey"`
	LocalData      *StoredMessage `json:"localData,omitempty"`
	Error          string         `json:"error,omitempty"`
}

// SyncEventData represents a single sync event from the server.
type SyncEventData struct {
	Seq            int            `json:"seq"`
	Type           string         `json:"type"`
	Data           map[string]any `json:"data"`
	ConversationID string         `json:"conversationId,omitempty"`
	At             string         `json:"at"`
}

// SyncResultData represents the response from the sync endpoint.
type SyncResultData struct {
	Events  []SyncEventData `json:"events"`
	Cursor  int             `json:"cursor"`
	HasMore bool            `json:"hasMore"`
}

// OfflineOptions configures the OfflineManager.
type OfflineOptions struct {
	SyncOnConnect      bool
	OutboxRetryLimit   int
	OutboxFlushInterval time.Duration
	ConflictStrategy   string // "server" or "client"
}

// ============================================================================
// MemoryStorage
// ============================================================================

// MemoryStorage is a goroutine-safe in-memory storage backend.
type MemoryStorage struct {
	mu            sync.RWMutex
	messages      map[string]*StoredMessage
	conversations map[string]*StoredConversation
	contacts      []map[string]any
	cursors       map[string]string
	outbox        map[string]*OutboxOp
}

// NewMemoryStorage creates a new in-memory storage.
func NewMemoryStorage() *MemoryStorage {
	return &MemoryStorage{
		messages:      make(map[string]*StoredMessage),
		conversations: make(map[string]*StoredConversation),
		cursors:       make(map[string]string),
		outbox:        make(map[string]*OutboxOp),
	}
}

func (s *MemoryStorage) Init() {}

// ── Messages ─────────────────────────────────────────────

func (s *MemoryStorage) GetMessage(id string) *StoredMessage {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.messages[id]
}

func (s *MemoryStorage) PutMessages(msgs []*StoredMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, m := range msgs {
		s.messages[m.ID] = m
	}
}

func (s *MemoryStorage) GetMessages(conversationID string, limit int, before string) []*StoredMessage {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var result []*StoredMessage
	for _, m := range s.messages {
		if m.ConversationID == conversationID {
			if before == "" || m.CreatedAt < before {
				result = append(result, m)
			}
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].CreatedAt < result[j].CreatedAt })
	if len(result) > limit {
		result = result[len(result)-limit:]
	}
	return result
}

func (s *MemoryStorage) DeleteMessage(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.messages, id)
}

func (s *MemoryStorage) SearchMessages(query string, conversationID string, limit int) []*StoredMessage {
	s.mu.RLock()
	defer s.mu.RUnlock()
	q := strings.ToLower(query)
	var results []*StoredMessage
	for _, m := range s.messages {
		if conversationID != "" && m.ConversationID != conversationID {
			continue
		}
		if strings.Contains(strings.ToLower(m.Content), q) {
			results = append(results, m)
			if len(results) >= limit {
				break
			}
		}
	}
	return results
}

// ── Conversations ────────────────────────────────────────

func (s *MemoryStorage) GetConversation(id string) *StoredConversation {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.conversations[id]
}

func (s *MemoryStorage) PutConversations(convs []*StoredConversation) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range convs {
		s.conversations[c.ID] = c
	}
}

func (s *MemoryStorage) GetConversations(limit int) []*StoredConversation {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var result []*StoredConversation
	for _, c := range s.conversations {
		result = append(result, c)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].UpdatedAt > result[j].UpdatedAt })
	if len(result) > limit {
		result = result[:limit]
	}
	return result
}

// ── Contacts ─────────────────────────────────────────────

func (s *MemoryStorage) GetContacts() []map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]map[string]any{}, s.contacts...)
}

func (s *MemoryStorage) PutContacts(contacts []map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.contacts = append([]map[string]any{}, contacts...)
}

// ── Cursors ──────────────────────────────────────────────

func (s *MemoryStorage) GetCursor(key string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cursors[key]
}

func (s *MemoryStorage) SetCursor(key, value string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cursors[key] = value
}

// ── Outbox ───────────────────────────────────────────────

func (s *MemoryStorage) Enqueue(op *OutboxOp) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.outbox[op.ID] = op
}

func (s *MemoryStorage) DequeueReady(limit int) []*OutboxOp {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var ready []*OutboxOp
	for _, op := range s.outbox {
		if op.Status == "pending" && op.Retries < op.MaxRetries {
			ready = append(ready, op)
		}
	}
	sort.Slice(ready, func(i, j int) bool { return ready[i].CreatedAt.Before(ready[j].CreatedAt) })
	if len(ready) > limit {
		ready = ready[:limit]
	}
	return ready
}

func (s *MemoryStorage) Ack(opID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.outbox, opID)
}

func (s *MemoryStorage) Nack(opID string, errMsg string, retries int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	op := s.outbox[opID]
	if op != nil {
		op.Retries = retries
		op.Error = errMsg
		if retries >= op.MaxRetries {
			op.Status = "failed"
		}
	}
}

func (s *MemoryStorage) PendingCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	count := 0
	for _, op := range s.outbox {
		if op.Status == "pending" {
			count++
		}
	}
	return count
}

// ============================================================================
// Write operation detection
// ============================================================================

var writePatterns = []struct {
	method  string
	pattern *regexp.Regexp
	opType  string
}{
	{"POST", regexp.MustCompile(`/api/im/(messages|direct|groups)/`), "message.send"},
	{"PATCH", regexp.MustCompile(`/api/im/messages/`), "message.edit"},
	{"DELETE", regexp.MustCompile(`/api/im/messages/`), "message.delete"},
	{"POST", regexp.MustCompile(`/api/im/conversations/[^/]+/read`), "conversation.read"},
}

var convIDPattern = regexp.MustCompile(`/(?:messages|direct|groups)/([^/]+)`)

func matchWriteOp(method, path string) string {
	for _, wp := range writePatterns {
		if method == wp.method && wp.pattern.MatchString(path) {
			return wp.opType
		}
	}
	return ""
}

// ============================================================================
// Event Emitter
// ============================================================================

// OfflineEventHandler handles offline events.
type OfflineEventHandler func(event string, payload any)

type offlineEmitter struct {
	mu        sync.RWMutex
	listeners map[string][]OfflineEventHandler
}

func (e *offlineEmitter) On(event string, handler OfflineEventHandler) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.listeners[event] = append(e.listeners[event], handler)
}

func (e *offlineEmitter) emit(event string, payload any) {
	e.mu.RLock()
	handlers := e.listeners[event]
	e.mu.RUnlock()
	for _, h := range handlers {
		func() {
			defer func() { recover() }() // swallow panics in user callbacks
			h(event, payload)
		}()
	}
}

func (e *offlineEmitter) removeAll() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.listeners = make(map[string][]OfflineEventHandler)
}

// ============================================================================
// Offline Manager
// ============================================================================

// OfflineManager manages offline-first IM operations.
type OfflineManager struct {
	offlineEmitter
	Storage *MemoryStorage
	client  *Client

	syncOnConnect      bool
	outboxRetryLimit   int
	outboxFlushInterval time.Duration
	conflictStrategy   string

	mu       sync.Mutex
	isOnline bool
	syncing  bool
	flushing bool
	stopCh   chan struct{}
	stopped  bool
}

// NewOfflineManager creates a new offline manager.
func NewOfflineManager(storage *MemoryStorage, client *Client, opts *OfflineOptions) *OfflineManager {
	o := &OfflineManager{
		offlineEmitter: offlineEmitter{listeners: make(map[string][]OfflineEventHandler)},
		Storage:        storage,
		client:         client,
		isOnline:       true,
		stopCh:         make(chan struct{}),
	}
	if opts != nil {
		o.syncOnConnect = opts.SyncOnConnect
		o.outboxRetryLimit = opts.OutboxRetryLimit
		if opts.OutboxFlushInterval > 0 {
			o.outboxFlushInterval = opts.OutboxFlushInterval
		}
		o.conflictStrategy = opts.ConflictStrategy
	}
	// Defaults
	if o.outboxRetryLimit == 0 {
		o.outboxRetryLimit = 5
	}
	if o.outboxFlushInterval == 0 {
		o.outboxFlushInterval = time.Second
	}
	if o.conflictStrategy == "" {
		o.conflictStrategy = "server"
	}
	return o
}

// Init initializes storage and starts background flush.
func (o *OfflineManager) Init() {
	o.Storage.Init()
	go o.flushLoop()
}

// Destroy stops background tasks and cleans up.
func (o *OfflineManager) Destroy() {
	o.mu.Lock()
	if !o.stopped {
		o.stopped = true
		close(o.stopCh)
	}
	o.mu.Unlock()
	o.removeAll()
}

// IsOnline returns current network state.
func (o *OfflineManager) IsOnline() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.isOnline
}

// SetOnline updates network state and triggers flush/sync.
func (o *OfflineManager) SetOnline(online bool) {
	o.mu.Lock()
	if o.isOnline == online {
		o.mu.Unlock()
		return
	}
	o.isOnline = online
	o.mu.Unlock()

	if online {
		o.emit("network.online", nil)
		go o.Flush(context.Background())
		if o.syncOnConnect {
			go o.Sync(context.Background())
		}
	} else {
		o.emit("network.offline", nil)
	}
}

// OutboxSize returns the number of pending operations.
func (o *OfflineManager) OutboxSize() int {
	return o.Storage.PendingCount()
}

// ── Request dispatch ──────────────────────────────────────

// Dispatch routes an IM request through the offline layer.
func (o *OfflineManager) Dispatch(ctx context.Context, method, path string, body any, query map[string]string) (*IMResult, error) {
	opType := matchWriteOp(method, path)
	if opType != "" {
		return o.dispatchWrite(ctx, opType, method, path, body, query)
	}

	// Reads: try local cache first
	if method == "GET" {
		if cached := o.readFromCache(path, query); cached != nil {
			return cached, nil
		}
	}

	// Network request, then cache
	result, err := o.doRequest(ctx, method, path, body, query)
	if err != nil {
		if !o.IsOnline() {
			return &IMResult{OK: true, Data: json.RawMessage(`[]`)}, nil
		}
		return nil, err
	}
	if method == "GET" {
		o.cacheReadResult(path, query, result)
	}
	return result, nil
}

func (o *OfflineManager) doRequest(ctx context.Context, method, path string, body any, query map[string]string) (*IMResult, error) {
	data, err := o.client.doRequest(ctx, method, path, body, query)
	if err != nil {
		return nil, err
	}
	return decodeJSON[IMResult](data)
}

func (o *OfflineManager) dispatchWrite(ctx context.Context, opType, method, path string, body any, query map[string]string) (*IMResult, error) {
	clientID := generateUUID()
	idempotencyKey := "sdk-" + clientID

	// Inject idempotency key
	enrichedBody := body
	if bodyMap, ok := body.(map[string]any); ok && (opType == "message.send" || opType == "message.edit") {
		eb := make(map[string]any)
		for k, v := range bodyMap {
			eb[k] = v
		}
		meta := make(map[string]any)
		if existing, ok := eb["metadata"].(map[string]any); ok {
			for k, v := range existing {
				meta[k] = v
			}
		}
		meta["_idempotencyKey"] = idempotencyKey
		eb["metadata"] = meta
		enrichedBody = eb
	}

	// Build optimistic local message
	var localMsg *StoredMessage
	if opType == "message.send" {
		if bodyMap, ok := body.(map[string]any); ok {
			convID := ""
			if m := convIDPattern.FindStringSubmatch(path); len(m) > 1 {
				convID = m[1]
			}
			content, _ := bodyMap["content"].(string)
			msgType, _ := bodyMap["type"].(string)
			if msgType == "" {
				msgType = "text"
			}
			var parentID *string
			if pid, ok := bodyMap["parentId"].(string); ok {
				parentID = &pid
			}
			var metadata map[string]any
			if md, ok := bodyMap["metadata"].(map[string]any); ok {
				metadata = md
			}
			localMsg = &StoredMessage{
				ID:             "local-" + clientID,
				ClientID:       clientID,
				ConversationID: convID,
				Content:        content,
				Type:           msgType,
				SenderID:       "__self__",
				ParentID:       parentID,
				Status:         "pending",
				Metadata:       metadata,
				CreatedAt:      time.Now().UTC().Format(time.RFC3339Nano),
			}
			o.Storage.PutMessages([]*StoredMessage{localMsg})
			o.emit("message.local", localMsg)
		}
	}

	// Enqueue to outbox
	op := &OutboxOp{
		ID:             clientID,
		OpType:         opType,
		Method:         method,
		Path:           path,
		Body:           enrichedBody,
		Query:          query,
		Status:         "pending",
		CreatedAt:      time.Now(),
		Retries:        0,
		MaxRetries:     o.outboxRetryLimit,
		IdempotencyKey: idempotencyKey,
		LocalData:      localMsg,
	}
	o.Storage.Enqueue(op)

	// Trigger immediate flush
	if o.IsOnline() {
		go o.Flush(ctx)
	}

	// Return optimistic result
	result := &IMResult{OK: true}
	if localMsg != nil {
		data, _ := json.Marshal(map[string]any{
			"conversationId": localMsg.ConversationID,
			"message":        localMsg,
		})
		result.Data = data
	}
	return result, nil
}

// ── Outbox flush ──────────────────────────────────────────

func (o *OfflineManager) flushLoop() {
	ticker := time.NewTicker(o.outboxFlushInterval)
	defer ticker.Stop()
	for {
		select {
		case <-o.stopCh:
			return
		case <-ticker.C:
			o.Flush(context.Background())
		}
	}
}

// Flush processes pending outbox operations.
func (o *OfflineManager) Flush(ctx context.Context) {
	o.mu.Lock()
	if o.flushing || !o.isOnline {
		o.mu.Unlock()
		return
	}
	o.flushing = true
	o.mu.Unlock()

	defer func() {
		o.mu.Lock()
		o.flushing = false
		o.mu.Unlock()
	}()

	ops := o.Storage.DequeueReady(10)
	for _, op := range ops {
		o.emit("outbox.sending", map[string]any{"opId": op.ID, "type": op.OpType})

		result, err := o.doRequest(ctx, op.Method, op.Path, op.Body, op.Query)
		if err != nil {
			errMsg := err.Error()
			o.Storage.Nack(op.ID, errMsg, op.Retries+1)
			if op.Retries+1 >= op.MaxRetries {
				o.emit("outbox.failed", map[string]any{"opId": op.ID, "error": errMsg, "retriesLeft": 0})
				if op.OpType == "message.send" {
					o.emit("message.failed", map[string]any{"clientId": op.ID, "error": errMsg})
				}
			}
			continue
		}

		if result.OK {
			o.Storage.Ack(op.ID)
			o.emit("outbox.confirmed", map[string]any{"opId": op.ID})

			// Update local message with server data
			if op.OpType == "message.send" && op.LocalData != nil {
				var respData map[string]any
				if result.Data != nil {
					json.Unmarshal(result.Data, &respData)
				}
				if serverMsg, ok := respData["message"].(map[string]any); ok {
					o.Storage.DeleteMessage(op.LocalData.ID)
					sid, _ := serverMsg["id"].(string)
					scontent, _ := serverMsg["content"].(string)
					stype, _ := serverMsg["type"].(string)
					ssender, _ := serverMsg["senderId"].(string)
					screated, _ := serverMsg["createdAt"].(string)
					sconvID, _ := serverMsg["conversationId"].(string)
					if sconvID == "" {
						sconvID = op.LocalData.ConversationID
					}
					if scontent == "" {
						scontent = op.LocalData.Content
					}
					if stype == "" {
						stype = op.LocalData.Type
					}
					if screated == "" {
						screated = op.LocalData.CreatedAt
					}
					o.Storage.PutMessages([]*StoredMessage{{
						ID:             sid,
						ClientID:       op.ID,
						ConversationID: sconvID,
						Content:        scontent,
						Type:           stype,
						SenderID:       ssender,
						Status:         "confirmed",
						CreatedAt:      screated,
					}})
					o.emit("message.confirmed", map[string]any{"clientId": op.ID, "serverMessage": serverMsg})
				}
			}
		} else {
			errMsg := "Request failed"
			errCode := ""
			if result.Error != nil {
				errMsg = result.Error.Message
				errCode = result.Error.Code
			}
			if !strings.Contains(errCode, "TIMEOUT") && !strings.Contains(errCode, "NETWORK") {
				// Permanent failure
				o.Storage.Nack(op.ID, errMsg, op.MaxRetries)
				o.emit("outbox.failed", map[string]any{"opId": op.ID, "error": errMsg, "retriesLeft": 0})
				if op.OpType == "message.send" {
					o.emit("message.failed", map[string]any{"clientId": op.ID, "error": errMsg})
				}
			} else {
				o.Storage.Nack(op.ID, errMsg, op.Retries+1)
				o.emit("outbox.failed", map[string]any{
					"opId": op.ID, "error": errMsg,
					"retriesLeft": op.MaxRetries - op.Retries - 1,
				})
			}
		}
	}
}

// ── Sync engine ───────────────────────────────────────────

// Sync pulls sync events from the server and applies them locally.
func (o *OfflineManager) Sync(ctx context.Context) error {
	o.mu.Lock()
	if o.syncing || !o.isOnline {
		o.mu.Unlock()
		return nil
	}
	o.syncing = true
	o.mu.Unlock()

	defer func() {
		o.mu.Lock()
		o.syncing = false
		o.mu.Unlock()
	}()

	o.emit("sync.start", nil)

	totalNew := 0
	totalUpdated := 0

	cursor := o.Storage.GetCursor("global_sync")
	if cursor == "" {
		cursor = "0"
	}
	hasMore := true

	for hasMore {
		result, err := o.doRequest(ctx, "GET", "/api/im/sync", nil, map[string]string{
			"since": cursor, "limit": "100",
		})
		if err != nil {
			o.emit("sync.error", map[string]any{"error": err.Error(), "willRetry": false})
			return err
		}
		if !result.OK || result.Data == nil {
			errMsg := "Sync failed"
			if result.Error != nil {
				errMsg = result.Error.Message
			}
			o.emit("sync.error", map[string]any{"error": errMsg, "willRetry": false})
			return fmt.Errorf("%s", errMsg)
		}

		var syncResult SyncResultData
		if err := json.Unmarshal(result.Data, &syncResult); err != nil {
			o.emit("sync.error", map[string]any{"error": err.Error(), "willRetry": false})
			return err
		}

		for _, ev := range syncResult.Events {
			o.applySyncEvent(&ev)
			if ev.Type == "message.new" {
				totalNew++
			}
			if strings.HasPrefix(ev.Type, "conversation.") {
				totalUpdated++
			}
		}

		cursor = fmt.Sprintf("%d", syncResult.Cursor)
		o.Storage.SetCursor("global_sync", cursor)
		hasMore = syncResult.HasMore

		o.emit("sync.progress", map[string]any{"synced": len(syncResult.Events), "total": len(syncResult.Events)})
	}

	o.emit("sync.complete", map[string]any{"newMessages": totalNew, "updatedConversations": totalUpdated})
	return nil
}

func (o *OfflineManager) applySyncEvent(event *SyncEventData) {
	switch event.Type {
	case "message.new":
		d := event.Data
		var parentID *string
		if pid, ok := d["parentId"].(string); ok {
			parentID = &pid
		}
		var metadata map[string]any
		if md, ok := d["metadata"].(map[string]any); ok {
			metadata = md
		}
		convID := strOr(d, "conversationId", event.ConversationID)
		o.Storage.PutMessages([]*StoredMessage{{
			ID:             strOr(d, "id", ""),
			ConversationID: convID,
			Content:        strOr(d, "content", ""),
			Type:           strOr(d, "type", "text"),
			SenderID:       strOr(d, "senderId", ""),
			ParentID:       parentID,
			Status:         "confirmed",
			Metadata:       metadata,
			CreatedAt:      strOr(d, "createdAt", event.At),
			SyncSeq:        event.Seq,
		}})

	case "message.edit":
		msgID := strOr(event.Data, "id", "")
		existing := o.Storage.GetMessage(msgID)
		if existing != nil {
			if content, ok := event.Data["content"].(string); ok {
				existing.Content = content
			}
			existing.UpdatedAt = event.At
			existing.SyncSeq = event.Seq
			o.Storage.PutMessages([]*StoredMessage{existing})
		}

	case "message.delete":
		if msgID := strOr(event.Data, "id", ""); msgID != "" {
			o.Storage.DeleteMessage(msgID)
		}

	case "conversation.create", "conversation.update":
		d := event.Data
		convID := strOr(d, "id", event.ConversationID)
		var members []json.RawMessage
		if m, ok := d["members"]; ok {
			if b, err := json.Marshal(m); err == nil {
				json.Unmarshal(b, &members)
			}
		}
		var metadata map[string]any
		if md, ok := d["metadata"].(map[string]any); ok {
			metadata = md
		}
		o.Storage.PutConversations([]*StoredConversation{{
			ID:            convID,
			Type:          strOr(d, "type", "direct"),
			Title:         strOr(d, "title", ""),
			UnreadCount:   intOr(d, "unreadCount", 0),
			Members:       members,
			Metadata:      metadata,
			SyncSeq:       event.Seq,
			UpdatedAt:     event.At,
			LastMessageAt: strOr(d, "lastMessageAt", ""),
		}})

	case "conversation.archive":
		convID := strOr(event.Data, "id", event.ConversationID)
		if convID != "" {
			existing := o.Storage.GetConversation(convID)
			if existing != nil {
				if existing.Metadata == nil {
					existing.Metadata = make(map[string]any)
				}
				existing.Metadata["_archived"] = true
				existing.SyncSeq = event.Seq
				existing.UpdatedAt = event.At
				o.Storage.PutConversations([]*StoredConversation{existing})
			}
		}

	case "participant.add":
		convID := strOr(event.Data, "conversationId", event.ConversationID)
		if convID != "" {
			existing := o.Storage.GetConversation(convID)
			if existing != nil && existing.Members != nil {
				member, _ := json.Marshal(map[string]any{
					"userId":      strOr(event.Data, "userId", ""),
					"username":    strOr(event.Data, "username", ""),
					"displayName": strOr(event.Data, "displayName", ""),
					"role":        strOr(event.Data, "role", "member"),
				})
				existing.Members = append(existing.Members, member)
				existing.SyncSeq = event.Seq
				existing.UpdatedAt = event.At
				o.Storage.PutConversations([]*StoredConversation{existing})
			}
		}

	case "participant.remove":
		convID := strOr(event.Data, "conversationId", event.ConversationID)
		userID := strOr(event.Data, "userId", "")
		if convID != "" && userID != "" {
			existing := o.Storage.GetConversation(convID)
			if existing != nil && existing.Members != nil {
				var filtered []json.RawMessage
				for _, m := range existing.Members {
					var member map[string]any
					json.Unmarshal(m, &member)
					if strOr(member, "userId", "") != userID {
						filtered = append(filtered, m)
					}
				}
				existing.Members = filtered
				existing.SyncSeq = event.Seq
				existing.UpdatedAt = event.At
				o.Storage.PutConversations([]*StoredConversation{existing})
			}
		}
	}
}

// HandleRealtimeEvent stores a real-time event locally.
func (o *OfflineManager) HandleRealtimeEvent(eventType string, payload map[string]any) {
	if eventType == "message.new" && payload != nil {
		var parentID *string
		if pid, ok := payload["parentId"].(string); ok {
			parentID = &pid
		}
		var metadata map[string]any
		if md, ok := payload["metadata"].(map[string]any); ok {
			metadata = md
		}
		o.Storage.PutMessages([]*StoredMessage{{
			ID:             strOr(payload, "id", ""),
			ConversationID: strOr(payload, "conversationId", ""),
			Content:        strOr(payload, "content", ""),
			Type:           strOr(payload, "type", "text"),
			SenderID:       strOr(payload, "senderId", ""),
			ParentID:       parentID,
			Status:         "confirmed",
			Metadata:       metadata,
			CreatedAt:      strOr(payload, "createdAt", time.Now().UTC().Format(time.RFC3339Nano)),
		}})
	}
}

// SearchMessages searches local messages.
func (o *OfflineManager) SearchMessages(query, conversationID string, limit int) []*StoredMessage {
	if limit <= 0 {
		limit = 50
	}
	return o.Storage.SearchMessages(query, conversationID, limit)
}

// ── Read cache ────────────────────────────────────────────

var (
	conversationsPattern = regexp.MustCompile(`/api/im/conversations$`)
	messagesPattern      = regexp.MustCompile(`/api/im/messages/([^/]+)$`)
	contactsPattern      = regexp.MustCompile(`/api/im/contacts$`)
)

func (o *OfflineManager) readFromCache(path string, query map[string]string) *IMResult {
	if conversationsPattern.MatchString(path) {
		convos := o.Storage.GetConversations(50)
		if len(convos) > 0 {
			data, _ := json.Marshal(convos)
			return &IMResult{OK: true, Data: data}
		}
	}

	if m := messagesPattern.FindStringSubmatch(path); len(m) > 1 {
		convID := m[1]
		limit := 50
		if l, ok := query["limit"]; ok {
			fmt.Sscanf(l, "%d", &limit)
		}
		before := query["before"]
		msgs := o.Storage.GetMessages(convID, limit, before)
		if len(msgs) > 0 {
			data, _ := json.Marshal(msgs)
			return &IMResult{OK: true, Data: data}
		}
	}

	if contactsPattern.MatchString(path) {
		contacts := o.Storage.GetContacts()
		if len(contacts) > 0 {
			data, _ := json.Marshal(contacts)
			return &IMResult{OK: true, Data: data}
		}
	}

	return nil
}

func (o *OfflineManager) cacheReadResult(path string, query map[string]string, result *IMResult) {
	if result == nil || !result.OK || result.Data == nil {
		return
	}

	if conversationsPattern.MatchString(path) {
		var convos []map[string]any
		if json.Unmarshal(result.Data, &convos) == nil {
			var stored []*StoredConversation
			for _, c := range convos {
				var members []json.RawMessage
				if m, ok := c["members"]; ok {
					b, _ := json.Marshal(m)
					json.Unmarshal(b, &members)
				}
				var metadata map[string]any
				if md, ok := c["metadata"].(map[string]any); ok {
					metadata = md
				}
				stored = append(stored, &StoredConversation{
					ID:            strOr(c, "id", ""),
					Type:          strOr(c, "type", "direct"),
					Title:         strOr(c, "title", ""),
					UnreadCount:   intOr(c, "unreadCount", 0),
					Members:       members,
					Metadata:      metadata,
					UpdatedAt:     strOr(c, "updatedAt", time.Now().UTC().Format(time.RFC3339Nano)),
					LastMessageAt: strOr(c, "lastMessageAt", ""),
				})
			}
			o.Storage.PutConversations(stored)
		}
	}

	if m := messagesPattern.FindStringSubmatch(path); len(m) > 1 {
		convID := m[1]
		var msgs []map[string]any
		if json.Unmarshal(result.Data, &msgs) == nil {
			var stored []*StoredMessage
			for _, msg := range msgs {
				var parentID *string
				if pid, ok := msg["parentId"].(string); ok {
					parentID = &pid
				}
				var metadata map[string]any
				if md, ok := msg["metadata"].(map[string]any); ok {
					metadata = md
				}
				stored = append(stored, &StoredMessage{
					ID:             strOr(msg, "id", ""),
					ConversationID: strOr(msg, "conversationId", convID),
					Content:        strOr(msg, "content", ""),
					Type:           strOr(msg, "type", "text"),
					SenderID:       strOr(msg, "senderId", ""),
					ParentID:       parentID,
					Status:         "confirmed",
					Metadata:       metadata,
					CreatedAt:      strOr(msg, "createdAt", ""),
				})
			}
			o.Storage.PutMessages(stored)
		}
	}

	if contactsPattern.MatchString(path) {
		var contacts []map[string]any
		if json.Unmarshal(result.Data, &contacts) == nil {
			o.Storage.PutContacts(contacts)
		}
	}
}

// ============================================================================
// Helpers
// ============================================================================

func generateUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// Fallback to timestamp-based ID
		return fmt.Sprintf("%d-%d", time.Now().UnixNano(), time.Now().UnixMilli())
	}
	b[6] = (b[6] & 0x0f) | 0x40 // Version 4
	b[8] = (b[8] & 0x3f) | 0x80 // Variant 10
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func strOr(m map[string]any, key, fallback string) string {
	if v, ok := m[key].(string); ok && v != "" {
		return v
	}
	return fallback
}

func intOr(m map[string]any, key string, fallback int) int {
	if v, ok := m[key].(float64); ok {
		return int(v)
	}
	return fallback
}
