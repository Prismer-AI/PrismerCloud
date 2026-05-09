package hub

import (
	"context"
	"errors"
	"fmt"
	"sync"

	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
)

var ErrRuntimeNotConnected = errors.New("runtime not connected")

type ConnectParams struct {
	RuntimeID  string
	SessionID  string
	Version    string
	PID        *int64
	RemoteAddr string
	UserAgent  string
	BufferSize int
}

type Hub struct {
	store shareddb.Store

	mu          sync.RWMutex
	connections map[string]*Connection
}

func New(store shareddb.Store) *Hub {
	return &Hub{
		store:       store,
		connections: make(map[string]*Connection),
	}
}

func (h *Hub) Connect(ctx context.Context, params ConnectParams) (*Connection, error) {
	if params.RuntimeID == "" {
		return nil, fmt.Errorf("runtime id required")
	}
	if params.SessionID == "" {
		return nil, fmt.Errorf("session id required")
	}

	if _, err := h.store.StartDaemonSession(ctx, shareddb.StartDaemonSessionParams{
		ID:         params.SessionID,
		RuntimeID:  params.RuntimeID,
		Version:    params.Version,
		PID:        params.PID,
		RemoteAddr: params.RemoteAddr,
		UserAgent:  params.UserAgent,
	}); err != nil {
		return nil, err
	}

	conn := newConnection(params.RuntimeID, params.SessionID, params.BufferSize)

	h.mu.Lock()
	if existing, ok := h.connections[params.RuntimeID]; ok {
		_ = h.store.TerminateDaemonSession(ctx, existing.SessionID(), "server_replaced")
		existing.Close()
	}
	h.connections[params.RuntimeID] = conn
	h.mu.Unlock()

	return conn, nil
}

func (h *Hub) Disconnect(ctx context.Context, runtimeID string, reason string) error {
	h.mu.Lock()
	conn, ok := h.connections[runtimeID]
	if ok {
		delete(h.connections, runtimeID)
	}
	h.mu.Unlock()

	if !ok {
		return ErrRuntimeNotConnected
	}
	if err := h.store.TerminateDaemonSession(ctx, conn.SessionID(), reason); err != nil {
		return err
	}
	conn.Close()
	return nil
}

func (h *Hub) Send(ctx context.Context, runtimeID string, message []byte) error {
	conn, ok := h.getConnection(runtimeID)
	if !ok {
		return ErrRuntimeNotConnected
	}
	return deliver(ctx, conn, message)
}

func (h *Hub) Broadcast(ctx context.Context, message []byte) error {
	h.mu.RLock()
	connections := make([]*Connection, 0, len(h.connections))
	for _, conn := range h.connections {
		connections = append(connections, conn)
	}
	h.mu.RUnlock()

	for _, conn := range connections {
		if err := deliver(ctx, conn, message); err != nil {
			return err
		}
	}
	return nil
}

func (h *Hub) HandleHeartbeat(ctx context.Context, runtimeID string, load float64) error {
	if _, ok := h.getConnection(runtimeID); !ok {
		return ErrRuntimeNotConnected
	}
	return h.store.HeartbeatRuntime(ctx, shareddb.HeartbeatRuntimeParams{
		RuntimeID: runtimeID,
		Status:    "online",
		Load:      load,
	})
}

func (h *Hub) ConnectionCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.connections)
}

func (h *Hub) getConnection(runtimeID string) (*Connection, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	conn, ok := h.connections[runtimeID]
	return conn, ok
}

func deliver(ctx context.Context, conn *Connection, message []byte) error {
	msgCopy := append([]byte(nil), message...)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-conn.Closed():
		return ErrConnectionClosed
	case conn.outbound <- msgCopy:
		return nil
	}
}
