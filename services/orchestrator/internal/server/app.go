package server

import (
	"context"
	"database/sql"
	"net/http"

	dispatcherpkg "github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/dispatcher"
	execpkg "github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/exec"
	"github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/hub"
	"github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/transport"
	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
)

type TaskDispatcher interface {
	DispatchTask(ctx context.Context, taskID string) (dispatcherpkg.DispatchResult, error)
}

type Dependencies struct {
	Store      shareddb.Store
	Hub        *hub.Hub
	Tracker    *execpkg.Tracker
	Dispatcher TaskDispatcher
	WSUpgrader transport.Upgrader
}

type App struct {
	Config           Config
	ListenAddr       string
	Store            shareddb.Store
	RawDB            *sql.DB
	Hub              *hub.Hub
	Tracker          *execpkg.Tracker
	Dispatcher       TaskDispatcher
	RuntimeWSHandler http.Handler
	HTTPHandler      http.Handler
}

func NewApp(cfg Config, deps Dependencies) *App {
	store := deps.Store
	if store == nil {
		store = shareddb.NewMemoryStore()
	}

	hubRef := deps.Hub
	if hubRef == nil {
		hubRef = hub.New(store)
	}

	tracker := deps.Tracker
	if tracker == nil {
		tracker = execpkg.NewTracker(store)
	}

	taskDispatcher := deps.Dispatcher
	if taskDispatcher == nil {
		taskDispatcher = dispatcherpkg.New(store, hubRef)
	}

	var runtimeWSHandler http.Handler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "runtime websocket upgrader not configured", http.StatusNotImplemented)
	})
	if deps.WSUpgrader != nil {
		runtimeWSHandler = transport.NewHandler(
			store,
			hubRef,
			tracker,
			transport.NewAuthConfig(
				cfg.RuntimeJoinToken,
				cfg.AllowedRuntimeDIDs,
				cfg.RuntimeSignatureRequired,
				cfg.RuntimeMaxTimeSkew,
			),
			deps.WSUpgrader,
		)
	}

	mux := http.NewServeMux()
	mux.Handle("/ws/runtime", runtimeWSHandler)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	registerDebugHandlers(mux, store, taskDispatcher, hubRef)

	return &App{
		Config:           cfg,
		ListenAddr:       ":8080",
		Store:            store,
		Hub:              hubRef,
		Tracker:          tracker,
		Dispatcher:       taskDispatcher,
		RuntimeWSHandler: runtimeWSHandler,
		HTTPHandler:      mux,
	}
}

func (a *App) Close() error {
	return CloseStoreDB(a.RawDB)
}

func (a *App) NewHTTPServer() *http.Server {
	addr := a.ListenAddr
	if addr == "" {
		addr = ":8080"
	}
	return &http.Server{
		Addr:    addr,
		Handler: a.HTTPHandler,
	}
}
