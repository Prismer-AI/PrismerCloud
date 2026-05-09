package hub

import (
	"context"
	"time"
)

func (h *Hub) HeartbeatLoop(ctx context.Context, runtimeID string, interval time.Duration, loadFn func() float64) error {
	if interval <= 0 {
		interval = 20 * time.Second
	}
	if err := h.HandleHeartbeat(ctx, runtimeID, loadFn()); err != nil {
		return err
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := h.HandleHeartbeat(ctx, runtimeID, loadFn()); err != nil {
				return err
			}
		}
	}
}
