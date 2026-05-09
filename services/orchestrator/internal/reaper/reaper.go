package reaper

import (
	"context"
	"time"

	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
)

type Reaper struct {
	store   shareddb.Store
	now     func() time.Time
	timeout time.Duration
}

func New(store shareddb.Store, timeout time.Duration) *Reaper {
	if timeout <= 0 {
		timeout = 90 * time.Second
	}
	return &Reaper{
		store:   store,
		now:     time.Now,
		timeout: timeout,
	}
}

func (r *Reaper) SweepOnce(ctx context.Context) (int, error) {
	runtimes, err := r.store.ListOnlineRuntimes(ctx)
	if err != nil {
		return 0, err
	}

	cutoff := r.now().Add(-r.timeout)
	var reaped int
	for _, runtime := range runtimes {
		if runtime.LastHeartbeatAt.IsZero() {
			continue
		}
		if runtime.LastHeartbeatAt.Before(cutoff) {
			if err := r.store.SetRuntimeStatus(ctx, shareddb.SetRuntimeStatusParams{
				RuntimeID: runtime.ID,
				Status:    "offline",
			}); err != nil {
				return reaped, err
			}
			reaped++
		}
	}
	return reaped, nil
}

func (r *Reaper) Run(ctx context.Context, interval time.Duration) error {
	if interval <= 0 {
		interval = 30 * time.Second
	}

	if _, err := r.SweepOnce(ctx); err != nil {
		return err
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if _, err := r.SweepOnce(ctx); err != nil {
				return err
			}
		}
	}
}
