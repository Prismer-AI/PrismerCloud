//go:build gorilla_websocket

package transport

import (
	"net/http"
	"os"
	"strings"

	"github.com/gorilla/websocket"
)

func DefaultUpgraderFromEnv() Upgrader {
	allowAllOrigins := strings.EqualFold(strings.TrimSpace(os.Getenv("PRISMER_WS_ALLOW_ALL_ORIGINS")), "true")
	return NewGorillaUpgrader(websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			if allowAllOrigins {
				return true
			}
			origin := strings.TrimSpace(r.Header.Get("Origin"))
			if origin == "" {
				return true
			}
			host := strings.TrimSpace(r.Host)
			return host != "" && strings.Contains(origin, host)
		},
	})
}
