package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/server"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	app, err := server.OpenAppFromEnv(ctx, server.Dependencies{})
	if err != nil {
		if server.IsStoreDriverMissing(err) {
			log.Fatalf("failed to open store: %v; configure a registered driver or use PRISMER_STORE_BACKEND=memory", err)
		}
		log.Fatalf("failed to bootstrap app: %v", err)
	}
	defer app.Close()

	httpServer := app.NewHTTPServer()
	errCh := make(chan error, 1)
	go func() {
		log.Printf("orchestrator listening on %s", httpServer.Addr)
		if err := httpServer.ListenAndServe(); err != nil {
			errCh <- err
		}
	}()

	select {
	case <-ctx.Done():
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http server failed: %v", err)
		}
		return
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("http shutdown failed: %v", err)
	}
}
