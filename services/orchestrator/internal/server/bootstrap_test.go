package server

import (
	"context"
	"database/sql"
	"testing"

	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
)

func TestLoadBootstrapConfigDefaults(t *testing.T) {
	t.Setenv("PRISMER_PROTOCOL_ENFORCE", "")
	t.Setenv("SIGNATURE_ENFORCE", "")
	t.Setenv("SIGNATURE_FALLBACK", "")
	t.Setenv("APP_ENV", "")
	t.Setenv("PRISMER_STORE_BACKEND", "")
	t.Setenv("PRISMER_DB_DRIVER", "")
	t.Setenv("PRISMER_DB_DSN", "")
	t.Setenv("PRISMER_DB_APPLY_SCHEMA", "")
	t.Setenv("PRISMER_HTTP_ADDR", "")

	cfg, err := LoadBootstrapConfigFromEnv()
	if err != nil {
		t.Fatalf("LoadBootstrapConfigFromEnv() error = %v", err)
	}
	if cfg.ListenAddr != ":8080" || cfg.Store.Backend != StoreBackendMemory || cfg.Protocol.ProtocolEnforce != ProtocolEnforceStrict {
		t.Fatalf("unexpected bootstrap config: %+v", cfg)
	}
}

func TestOpenAppFromEnvUsesMemoryByDefault(t *testing.T) {
	t.Setenv("PRISMER_PROTOCOL_ENFORCE", "")
	t.Setenv("SIGNATURE_ENFORCE", "")
	t.Setenv("SIGNATURE_FALLBACK", "")
	t.Setenv("APP_ENV", "")
	t.Setenv("PRISMER_STORE_BACKEND", "")
	t.Setenv("PRISMER_HTTP_ADDR", ":9090")

	app, err := OpenAppFromEnv(context.Background(), Dependencies{})
	if err != nil {
		t.Fatalf("OpenAppFromEnv() error = %v", err)
	}
	defer app.Close()

	if app.ListenAddr != ":9090" || app.RawDB != nil {
		t.Fatalf("unexpected app bootstrap state: %+v", app)
	}
	if _, ok := app.Store.(*shareddb.MemoryStore); !ok {
		t.Fatalf("expected memory store, got %T", app.Store)
	}
}

func TestOpenAppFromEnvUsesInjectedStore(t *testing.T) {
	store := shareddb.NewMemoryStore()

	app, err := OpenAppFromEnv(context.Background(), Dependencies{Store: store})
	if err != nil {
		t.Fatalf("OpenAppFromEnv() error = %v", err)
	}
	defer app.Close()

	if app.Store != store {
		t.Fatalf("expected injected store, got %T", app.Store)
	}
}

func TestOpenAppFromEnvOpensConfiguredSQLStore(t *testing.T) {
	const driverName = "bootstrap-test-sql"
	shareddb.RegisterDBOpener(driverName, func(_ context.Context, dsn string) (*sql.DB, error) {
		if dsn != "file:test.db" {
			t.Fatalf("unexpected dsn: %s", dsn)
		}
		return &sql.DB{}, nil
	})

	t.Setenv("PRISMER_PROTOCOL_ENFORCE", "")
	t.Setenv("SIGNATURE_ENFORCE", "")
	t.Setenv("SIGNATURE_FALLBACK", "")
	t.Setenv("APP_ENV", "")
	t.Setenv("PRISMER_STORE_BACKEND", "sql")
	t.Setenv("PRISMER_DB_DRIVER", driverName)
	t.Setenv("PRISMER_DB_DSN", "file:test.db")
	t.Setenv("PRISMER_DB_APPLY_SCHEMA", "false")

	app, err := OpenAppFromEnv(context.Background(), Dependencies{})
	if err != nil {
		t.Fatalf("OpenAppFromEnv() error = %v", err)
	}

	if app.RawDB == nil {
		t.Fatal("expected raw db handle")
	}
	if _, ok := app.Store.(*shareddb.SQLStore); !ok {
		t.Fatalf("expected SQLStore, got %T", app.Store)
	}
}
