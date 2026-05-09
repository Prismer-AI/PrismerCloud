//go:build gorilla_websocket

package transport

import (
	"context"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

type GorillaUpgrader struct {
	Upgrader websocket.Upgrader
}

func NewGorillaUpgrader(upgrader websocket.Upgrader) *GorillaUpgrader {
	return &GorillaUpgrader{Upgrader: upgrader}
}

func (u *GorillaUpgrader) Upgrade(w http.ResponseWriter, r *http.Request) (SocketConn, error) {
	conn, err := u.Upgrader.Upgrade(w, r, nil)
	if err != nil {
		return nil, err
	}
	return &gorillaSocketConn{conn: conn}, nil
}

type gorillaSocketConn struct {
	conn *websocket.Conn
}

func (s *gorillaSocketConn) ReadMessage(ctx context.Context) ([]byte, error) {
	if deadline, ok := ctx.Deadline(); ok {
		_ = s.conn.SetReadDeadline(deadline)
	} else {
		_ = s.conn.SetReadDeadline(time.Time{})
	}
	_, message, err := s.conn.ReadMessage()
	return message, err
}

func (s *gorillaSocketConn) WriteMessage(ctx context.Context, message []byte) error {
	if deadline, ok := ctx.Deadline(); ok {
		_ = s.conn.SetWriteDeadline(deadline)
	} else {
		_ = s.conn.SetWriteDeadline(time.Time{})
	}
	return s.conn.WriteMessage(websocket.TextMessage, message)
}

func (s *gorillaSocketConn) Close() error {
	return s.conn.Close()
}
