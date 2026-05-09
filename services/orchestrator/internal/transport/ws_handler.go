package transport

import (
	"context"
	"errors"
	"io"
	"net/http"
	"sync"

	execpkg "github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/exec"
	"github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/hub"
	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
)

type SocketConn interface {
	ReadMessage(ctx context.Context) ([]byte, error)
	WriteMessage(ctx context.Context, message []byte) error
	Close() error
}

type Upgrader interface {
	Upgrade(w http.ResponseWriter, r *http.Request) (SocketConn, error)
}

type Handler struct {
	store    shareddb.Store
	hub      *hub.Hub
	exec     *execpkg.Tracker
	auth     AuthConfig
	upgrader Upgrader
}

func NewHandler(store shareddb.Store, hubRef *hub.Hub, execTracker *execpkg.Tracker, auth AuthConfig, upgrader Upgrader) *Handler {
	return &Handler{
		store:    store,
		hub:      hubRef,
		exec:     execTracker,
		auth:     auth,
		upgrader: upgrader,
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	socket, err := h.upgrader.Upgrade(w, r)
	if err != nil {
		http.Error(w, "websocket upgrade failed", http.StatusBadRequest)
		return
	}
	defer socket.Close()

	session := NewSession(h.store, h.hub, h.exec, h.auth, r.RemoteAddr, r.UserAgent())
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	defer session.Disconnect(context.Background(), "connection_closed")

	errCh := make(chan error, 2)
	var startWriter sync.Once

	startWriterIfReady := func() {
		if !session.HasConnection() {
			return
		}
		startWriter.Do(func() {
			go h.writeLoop(ctx, socket, session, errCh)
		})
	}

	go h.readLoop(ctx, socket, session, startWriterIfReady, errCh)

	if err := <-errCh; err != nil && !isSocketClosure(err) && !errors.Is(err, context.Canceled) {
		cancel()
		return
	}
	cancel()
}

func (h *Handler) readLoop(ctx context.Context, socket SocketConn, session *Session, startWriter func(), errCh chan<- error) {
	for {
		wire, err := socket.ReadMessage(ctx)
		if err != nil {
			errCh <- err
			return
		}
		if err := session.HandleInbound(ctx, wire); err != nil {
			errCh <- err
			return
		}
		startWriter()
	}
}

func (h *Handler) writeLoop(ctx context.Context, socket SocketConn, session *Session, errCh chan<- error) {
	outbound := session.Outbound()
	if outbound == nil {
		errCh <- ErrConnectionNotReady
		return
	}
	for {
		select {
		case <-ctx.Done():
			errCh <- ctx.Err()
			return
		case message, ok := <-outbound:
			if !ok {
				errCh <- io.EOF
				return
			}
			if err := socket.WriteMessage(ctx, message); err != nil {
				errCh <- err
				return
			}
		}
	}
}

func isSocketClosure(err error) bool {
	return errors.Is(err, io.EOF)
}
