package db

import (
	"context"
	"database/sql"
	"errors"
	"testing"
)

func TestOpenSQLStoreRequiresDSN(t *testing.T) {
	_, _, err := OpenSQLStore(context.Background(), "missing", "")
	if !errors.Is(err, ErrStoreDSNRequired) {
		t.Fatalf("expected ErrStoreDSNRequired, got %v", err)
	}
}

func TestOpenSQLStoreRequiresRegisteredDriver(t *testing.T) {
	_, _, err := OpenSQLStore(context.Background(), "missing", "file:test.db")
	if !errors.Is(err, ErrStoreDriverNotRegistered) {
		t.Fatalf("expected ErrStoreDriverNotRegistered, got %v", err)
	}
}

func TestOpenSQLStoreUsesRegisteredOpener(t *testing.T) {
	const driverName = "test-open"
	RegisterDBOpener(driverName, func(_ context.Context, dsn string) (*sql.DB, error) {
		if dsn != "dsn" {
			t.Fatalf("unexpected dsn: %s", dsn)
		}
		return &sql.DB{}, nil
	})

	store, rawDB, err := OpenSQLStore(context.Background(), driverName, "dsn")
	if err != nil {
		t.Fatalf("OpenSQLStore() error = %v", err)
	}
	if store == nil || rawDB == nil || store.db != rawDB {
		t.Fatalf("expected initialized SQL store, got store=%v db=%v", store, rawDB)
	}
}
