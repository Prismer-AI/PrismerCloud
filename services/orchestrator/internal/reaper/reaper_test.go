package reaper

import (
	"context"
	"testing"
	"time"

	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
)

func TestReaperSweepOnceMarksStaleRuntimeOffline(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	_, err := store.RegisterRuntime(ctx, shareddb.RegisterRuntimeParams{
		ID:           "rt_stale",
		OwnerDid:     "did:key:owner",
		Type:         "local",
		Did:          "did:key:rt_stale",
		PublicKey:    "pub",
		Capabilities: "[]",
		Status:       "online",
	})
	if err != nil {
		t.Fatalf("RegisterRuntime() error = %v", err)
	}
	_, err = store.RegisterRuntime(ctx, shareddb.RegisterRuntimeParams{
		ID:           "rt_fresh",
		OwnerDid:     "did:key:owner",
		Type:         "local",
		Did:          "did:key:rt_fresh",
		PublicKey:    "pub",
		Capabilities: "[]",
		Status:       "online",
	})
	if err != nil {
		t.Fatalf("RegisterRuntime() error = %v", err)
	}

	stale, _ := store.GetRuntime("rt_stale")
	stale.LastHeartbeatAt = time.Now().Add(-2 * time.Minute)
	stale.RegisteredAt = time.Now().Add(-2 * time.Minute)
	stale.UpdatedAt = stale.LastHeartbeatAt
	store.PutRuntimeForTest(stale)

	fresh, _ := store.GetRuntime("rt_fresh")
	fresh.LastHeartbeatAt = time.Now()
	fresh.UpdatedAt = fresh.LastHeartbeatAt
	store.PutRuntimeForTest(fresh)

	reaper := New(store, 90*time.Second)
	reaped, err := reaper.SweepOnce(ctx)
	if err != nil {
		t.Fatalf("SweepOnce() error = %v", err)
	}
	if reaped != 1 {
		t.Fatalf("expected 1 reaped runtime, got %d", reaped)
	}

	stale, _ = store.GetRuntime("rt_stale")
	if stale.Status != "offline" {
		t.Fatalf("expected stale runtime to be offline, got %s", stale.Status)
	}

	fresh, _ = store.GetRuntime("rt_fresh")
	if fresh.Status != "online" {
		t.Fatalf("expected fresh runtime to stay online, got %s", fresh.Status)
	}
}
