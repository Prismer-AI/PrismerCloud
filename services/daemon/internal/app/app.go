package app

import (
	"context"

	"github.com/Prismer-AI/PrismerCloud/services/daemon/internal/approval"
	"github.com/Prismer-AI/PrismerCloud/services/daemon/internal/executor"
	"github.com/Prismer-AI/PrismerCloud/services/daemon/internal/runner"
	"github.com/Prismer-AI/PrismerCloud/services/daemon/internal/ws"
	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
)

type Config struct {
	WS             ws.Config
	ApprovalPolicy approval.Policy
}

type App struct {
	Config   Config
	Client   *ws.Client
	Runner   *runner.Runner
	Executor runner.Executor
}

func New(cfg Config) *App {
	client := ws.NewClient(cfg.WS)
	exec := executor.NewNoop(cfg.WS.Capabilities, cfg.ApprovalPolicy)
	r := runner.New(client, exec, runner.Config{
		CapabilityUsed: firstCapabilityKey(cfg.WS.Capabilities),
		CLIPath:        firstCapabilityPath(cfg.WS.Capabilities),
		CLIVersion:     firstCapabilityVersion(cfg.WS.Capabilities),
	})
	return &App{
		Config:   cfg,
		Client:   client,
		Runner:   r,
		Executor: exec,
	}
}

func (a *App) Start(ctx context.Context) error {
	if err := a.Client.Start(ctx); err != nil {
		return err
	}
	a.Runner.Start(ctx)
	return nil
}

func (a *App) Close() error {
	return a.Client.Close()
}

func firstCapabilityKey(capabilities []proto.RuntimeCapability) string {
	if len(capabilities) == 0 {
		return ""
	}
	return capabilities[0].Key
}

func firstCapabilityPath(capabilities []proto.RuntimeCapability) string {
	if len(capabilities) == 0 {
		return ""
	}
	return capabilities[0].Path
}

func firstCapabilityVersion(capabilities []proto.RuntimeCapability) string {
	if len(capabilities) == 0 {
		return ""
	}
	return capabilities[0].Version
}
