package server

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
)

func TestLoadStoreConfigDefaultsToMemory(t *testing.T) {
	t.Setenv("PRISMER_STORE_BACKEND", "")
	t.Setenv("PRISMER_DB_DRIVER", "")
	t.Setenv("PRISMER_DB_DSN", "")
	t.Setenv("PRISMER_DB_APPLY_SCHEMA", "")

	cfg, err := LoadStoreConfigFromEnv()
	if err != nil {
		t.Fatalf("LoadStoreConfigFromEnv() error = %v", err)
	}
	if cfg.Backend != StoreBackendMemory || cfg.ApplySchema {
		t.Fatalf("unexpected store config: %+v", cfg)
	}
}

func TestLoadStoreConfigRejectsUnknownBackend(t *testing.T) {
	t.Setenv("PRISMER_STORE_BACKEND", "weird")
	_, err := LoadStoreConfigFromEnv()
	if err == nil {
		t.Fatal("expected backend parse error")
	}
}

func TestOpenStoreMemory(t *testing.T) {
	store, rawDB, err := OpenStore(context.Background(), StoreConfig{Backend: StoreBackendMemory})
	if err != nil {
		t.Fatalf("OpenStore(memory) error = %v", err)
	}
	if rawDB != nil {
		t.Fatalf("expected nil raw db for memory backend, got %v", rawDB)
	}
	if _, ok := store.(*shareddb.MemoryStore); !ok {
		t.Fatalf("expected memory store, got %T", store)
	}
}

func TestOpenStoreSQLRequiresDriver(t *testing.T) {
	_, _, err := OpenStore(context.Background(), StoreConfig{
		Backend: StoreBackendSQL,
		Driver:  "missing",
		DSN:     "file:test.db",
	})
	if !errors.Is(err, shareddb.ErrStoreDriverNotRegistered) {
		t.Fatalf("expected ErrStoreDriverNotRegistered, got %v", err)
	}
}

func TestOpenStoreSQLUsesRegisteredDriver(t *testing.T) {
	const driverName = "server-store-test"
	shareddb.RegisterDBOpener(driverName, func(_ context.Context, dsn string) (*sql.DB, error) {
		if dsn != "file:test.db" {
			t.Fatalf("unexpected dsn: %s", dsn)
		}
		return &sql.DB{}, nil
	})

	store, rawDB, err := OpenStore(context.Background(), StoreConfig{
		Backend: StoreBackendSQL,
		Driver:  driverName,
		DSN:     "file:test.db",
	})
	if err != nil {
		t.Fatalf("OpenStore(sql) error = %v", err)
	}
	if rawDB == nil {
		t.Fatal("expected raw db")
	}
	if _, ok := store.(*shareddb.SQLStore); !ok {
		t.Fatalf("expected SQLStore, got %T", store)
	}
}
