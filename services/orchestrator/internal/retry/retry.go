package retry

import (
	"context"
	"time"

	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
)

type Planner struct {
	store shareddb.Store
	now   func() time.Time
}

func New(store shareddb.Store) *Planner {
	return &Planner{
		store: store,
		now:   time.Now,
	}
}

func ShouldRetry(task shareddb.Task) bool {
	return task.MaxRetries > 0 && task.RetryCount < task.MaxRetries
}

func NextDelay(task shareddb.Task) time.Duration {
	baseMs := task.RetryDelayMs
	if baseMs <= 0 {
		baseMs = 60000
	}
	multiplier := int64(1) << task.RetryCount
	return time.Duration(baseMs*multiplier) * time.Millisecond
}

func (p *Planner) ScheduleNextAttempt(ctx context.Context, task shareddb.Task) (*time.Time, bool, error) {
	if !ShouldRetry(task) {
		if err := p.store.SetTaskRetryState(ctx, shareddb.SetTaskRetryStateParams{
			TaskID:     task.ID,
			Status:     "failed",
			RetryCount: task.RetryCount,
			RuntimeID:  "",
		}); err != nil {
			return nil, false, err
		}
		return nil, false, nil
	}

	next := p.now().Add(NextDelay(task))
	if err := p.store.SetTaskRetryState(ctx, shareddb.SetTaskRetryStateParams{
		TaskID:     task.ID,
		Status:     "pending",
		RetryCount: task.RetryCount + 1,
		NextRunAt:  &next,
		RuntimeID:  "",
	}); err != nil {
		return nil, false, err
	}
	return &next, true, nil
}
