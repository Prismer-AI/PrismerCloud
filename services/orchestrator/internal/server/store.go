package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strings"

	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
)

type StoreBackend string

const (
	StoreBackendMemory StoreBackend = "memory"
	StoreBackendSQL    StoreBackend = "sql"
)

type StoreConfig struct {
	Backend     StoreBackend
	Driver      string
	DSN         string
	ApplySchema bool
}

func LoadStoreConfigFromEnv() (StoreConfig, error) {
	backend := StoreBackend(strings.TrimSpace(os.Getenv("PRISMER_STORE_BACKEND")))
	switch backend {
	case "":
		backend = StoreBackendMemory
	case StoreBackendMemory, StoreBackendSQL:
	default:
		return StoreConfig{}, fmt.Errorf("unknown PRISMER_STORE_BACKEND value: %s", backend)
	}

	applySchema := strings.EqualFold(os.Getenv("PRISMER_DB_APPLY_SCHEMA"), "true")
	return StoreConfig{
		Backend:     backend,
		Driver:      strings.TrimSpace(os.Getenv("PRISMER_DB_DRIVER")),
		DSN:         strings.TrimSpace(os.Getenv("PRISMER_DB_DSN")),
		ApplySchema: applySchema,
	}, nil
}

func OpenStoreFromEnv(ctx context.Context) (shareddb.Store, *sql.DB, error) {
	cfg, err := LoadStoreConfigFromEnv()
	if err != nil {
		return nil, nil, err
	}
	return OpenStore(ctx, cfg)
}

func OpenStore(ctx context.Context, cfg StoreConfig) (shareddb.Store, *sql.DB, error) {
	switch cfg.Backend {
	case StoreBackendMemory:
		return shareddb.NewMemoryStore(), nil, nil
	case StoreBackendSQL:
		store, rawDB, err := shareddb.OpenSQLStore(ctx, cfg.Driver, cfg.DSN)
		if err != nil {
			return nil, nil, err
		}
		if cfg.ApplySchema {
			if err := store.ApplyPhaseASchema(ctx); err != nil {
				_ = rawDB.Close()
				return nil, nil, err
			}
		}
		return store, rawDB, nil
	default:
		return nil, nil, fmt.Errorf("unsupported store backend: %s", cfg.Backend)
	}
}

func CloseStoreDB(rawDB *sql.DB) error {
	if rawDB == nil {
		return nil
	}
	return rawDB.Close()
}

func IsStoreDriverMissing(err error) bool {
	return errors.Is(err, shareddb.ErrStoreDriverNotRegistered)
}
