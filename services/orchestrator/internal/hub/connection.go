package hub

import (
	"errors"
	"sync"
)

var ErrConnectionClosed = errors.New("connection closed")

type Connection struct {
	runtimeID string
	sessionID string
	outbound  chan []byte
	closed    chan struct{}
	closeOnce sync.Once
}

func newConnection(runtimeID, sessionID string, bufferSize int) *Connection {
	if bufferSize <= 0 {
		bufferSize = 16
	}
	return &Connection{
		runtimeID: runtimeID,
		sessionID: sessionID,
		outbound:  make(chan []byte, bufferSize),
		closed:    make(chan struct{}),
	}
}

func (c *Connection) RuntimeID() string {
	return c.runtimeID
}

func (c *Connection) SessionID() string {
	return c.sessionID
}

func (c *Connection) Outbound() <-chan []byte {
	return c.outbound
}

func (c *Connection) Closed() <-chan struct{} {
	return c.closed
}

func (c *Connection) Close() {
	c.closeOnce.Do(func() {
		close(c.closed)
		close(c.outbound)
	})
}
