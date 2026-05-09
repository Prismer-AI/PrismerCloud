package hub

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
)

func TestHubSendAndDisconnect(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	mustRegisterRuntime(t, ctx, store, "rt_1")

	h := New(store)
	conn, err := h.Connect(ctx, ConnectParams{
		RuntimeID: "rt_1",
		SessionID: "sess_1",
		Version:   "0.1.0",
	})
	if err != nil {
		t.Fatalf("Connect() error = %v", err)
	}

	if err := h.Send(ctx, "rt_1", []byte("hello")); err != nil {
		t.Fatalf("Send() error = %v", err)
	}

	select {
	case msg := <-conn.Outbound():
		if string(msg) != "hello" {
			t.Fatalf("unexpected message: %s", string(msg))
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for outbound message")
	}

	if err := h.Disconnect(ctx, "rt_1", "graceful"); err != nil {
		t.Fatalf("Disconnect() error = %v", err)
	}

	session, ok := store.GetSession("sess_1")
	if !ok || session.TerminatedAt == nil {
		t.Fatalf("expected terminated session, got %+v, ok=%v", session, ok)
	}
}

func TestHubBroadcastToManyConnections(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	h := New(store)

	const n = 100
	conns := make([]*Connection, 0, n)
	for i := 0; i < n; i++ {
		runtimeID := fmt.Sprintf("rt_%03d", i)
		sessionID := fmt.Sprintf("sess_%03d", i)
		mustRegisterRuntime(t, ctx, store, runtimeID)
		conn, err := h.Connect(ctx, ConnectParams{
			RuntimeID:  runtimeID,
			SessionID:  sessionID,
			Version:    "0.1.0",
			BufferSize: 1,
		})
		if err != nil {
			t.Fatalf("Connect(%s) error = %v", runtimeID, err)
		}
		conns = append(conns, conn)
	}

	if err := h.Broadcast(ctx, []byte("fanout")); err != nil {
		t.Fatalf("Broadcast() error = %v", err)
	}

	var wg sync.WaitGroup
	for _, conn := range conns {
		wg.Add(1)
		go func(conn *Connection) {
			defer wg.Done()
			select {
			case msg := <-conn.Outbound():
				if string(msg) != "fanout" {
					t.Errorf("unexpected message: %s", string(msg))
				}
			case <-time.After(time.Second):
				t.Errorf("timed out waiting for message for runtime %s", conn.RuntimeID())
			}
		}(conn)
	}
	wg.Wait()
}

func TestHubHandleHeartbeatUpdatesStore(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	mustRegisterRuntime(t, ctx, store, "rt_1")

	h := New(store)
	if _, err := h.Connect(ctx, ConnectParams{
		RuntimeID: "rt_1",
		SessionID: "sess_1",
		Version:   "0.1.0",
	}); err != nil {
		t.Fatalf("Connect() error = %v", err)
	}

	if err := h.HandleHeartbeat(ctx, "rt_1", 0.75); err != nil {
		t.Fatalf("HandleHeartbeat() error = %v", err)
	}

	runtime, ok := store.GetRuntime("rt_1")
	if !ok {
		t.Fatal("expected runtime in store")
	}
	if runtime.Status != "online" {
		t.Fatalf("expected online runtime, got %s", runtime.Status)
	}
	if runtime.Load != 0.75 {
		t.Fatalf("expected load 0.75, got %f", runtime.Load)
	}
}

func TestHubReconnectReplacesOldConnection(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	mustRegisterRuntime(t, ctx, store, "rt_1")

	h := New(store)
	oldConn, err := h.Connect(ctx, ConnectParams{
		RuntimeID: "rt_1",
		SessionID: "sess_1",
		Version:   "0.1.0",
	})
	if err != nil {
		t.Fatalf("Connect(old) error = %v", err)
	}

	newConn, err := h.Connect(ctx, ConnectParams{
		RuntimeID: "rt_1",
		SessionID: "sess_2",
		Version:   "0.1.1",
	})
	if err != nil {
		t.Fatalf("Connect(new) error = %v", err)
	}

	select {
	case <-oldConn.Closed():
	case <-time.After(time.Second):
		t.Fatal("expected old connection to be closed")
	}

	if err := h.Send(ctx, "rt_1", []byte("new")); err != nil {
		t.Fatalf("Send() error = %v", err)
	}

	select {
	case msg := <-newConn.Outbound():
		if string(msg) != "new" {
			t.Fatalf("unexpected message: %s", string(msg))
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for new connection message")
	}

	oldSession, ok := store.GetSession("sess_1")
	if !ok || oldSession.TerminatedAt == nil || oldSession.TerminationReason != "server_replaced" {
		t.Fatalf("expected old session to be terminated by replacement, got %+v", oldSession)
	}
}

func mustRegisterRuntime(t *testing.T, ctx context.Context, store *shareddb.MemoryStore, runtimeID string) {
	t.Helper()
	if _, err := store.RegisterRuntime(ctx, shareddb.RegisterRuntimeParams{
		ID:           runtimeID,
		OwnerDid:     "did:key:owner",
		Type:         "local",
		Did:          "did:key:" + runtimeID,
		PublicKey:    "pub",
		Capabilities: "[]",
		Status:       "online",
	}); err != nil {
		t.Fatalf("RegisterRuntime(%s) error = %v", runtimeID, err)
	}
}
