//go:build !gorilla_websocket

package transport

// DefaultUpgraderFromEnv returns nil in the default build so the server keeps
// exposing a clear 501 until a concrete websocket implementation is compiled
// in. See upgrader_gorilla.go for the gorilla-backed runtime path.
func DefaultUpgraderFromEnv() Upgrader {
	return nil
}
