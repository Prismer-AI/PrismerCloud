package server

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strings"

	"github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/transport"
)

type BootstrapConfig struct {
	Protocol   Config
	Store      StoreConfig
	ListenAddr string
}

func LoadBootstrapConfigFromEnv() (BootstrapConfig, error) {
	protocolCfg, err := LoadConfigFromEnv()
	if err != nil {
		return BootstrapConfig{}, err
	}
	storeCfg, err := LoadStoreConfigFromEnv()
	if err != nil {
		return BootstrapConfig{}, err
	}

	listenAddr := strings.TrimSpace(os.Getenv("PRISMER_HTTP_ADDR"))
	if listenAddr == "" {
		listenAddr = ":8080"
	}

	return BootstrapConfig{
		Protocol:   protocolCfg,
		Store:      storeCfg,
		ListenAddr: listenAddr,
	}, nil
}

func OpenAppFromEnv(ctx context.Context, deps Dependencies) (*App, error) {
	cfg, err := LoadBootstrapConfigFromEnv()
	if err != nil {
		return nil, err
	}

	store := deps.Store
	var rawDB *sql.DB
	if store == nil {
		openedStore, dbHandle, err := OpenStore(ctx, cfg.Store)
		if err != nil {
			return nil, fmt.Errorf("open store: %w", err)
		}
		store = openedStore
		rawDB = dbHandle
	}

	deps.Store = store
	if deps.WSUpgrader == nil {
		deps.WSUpgrader = transport.DefaultUpgraderFromEnv()
	}
	app := NewApp(cfg.Protocol, deps)
	app.ListenAddr = cfg.ListenAddr
	app.RawDB = rawDB
	return app, nil
}
