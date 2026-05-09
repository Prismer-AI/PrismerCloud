package db

import (
	"context"
	"testing"
)

func TestSQLStoreImplementsStore(t *testing.T) {
	var _ Store = (*SQLStore)(nil)
}

func TestSQLStoreApplyPhaseASchemaRequiresDB(t *testing.T) {
	store := NewSQLStore(nil)
	if err := store.ApplyPhaseASchema(context.Background()); err != ErrSQLDBNotConfigured {
		t.Fatalf("expected ErrSQLDBNotConfigured, got %v", err)
	}
}

func TestPhaseASchemaEmbedded(t *testing.T) {
	data, err := schemaFS.ReadFile("schema/phase_a.sql")
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if len(data) == 0 {
		t.Fatal("expected embedded schema to be non-empty")
	}
}
