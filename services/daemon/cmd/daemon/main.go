package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/Prismer-AI/PrismerCloud/services/daemon/internal/app"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := app.LoadConfigFromEnv()
	if err != nil {
		log.Fatalf("failed to load daemon config: %v", err)
	}

	daemon := app.New(cfg)
	if err := daemon.Start(ctx); err != nil {
		log.Fatalf("failed to start daemon: %v", err)
	}
	defer daemon.Close()

	select {
	case <-ctx.Done():
	case err := <-daemon.Client.Errors():
		if err != nil {
			log.Fatalf("daemon websocket client failed: %v", err)
		}
	}
}
