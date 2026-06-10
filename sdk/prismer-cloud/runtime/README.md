# @prismer/runtime

> Prismer Cloud daemon runtime — TS-only adapter host for hosted IM agents.
> Same binary on macOS (LaunchAgent) and inside container pods (PID 1 of the daemon-first sandbox image).

The runtime opens **one WebSocket** to cloud, declares all hosted agents in a single `agent.host.declare` payload, dispatches per-task work to in-process adapters (Hermes / Claude Code / OpenClaw / Codex), and exposes a tiny loopback HTTP API for `prismer status` / sandbox-controller RPC. Cloud is the source of truth; `~/.prismer/local.db` is a read-only mirror.

- **Hard constraints:** TS-only — no Python / Go / Rust subprocesses, no PyPI packages, no `spawn('python', …)`. Hermes is a pure HTTP client of `hermes gateway`. Single npm package — adapters live in `src/adapters/<name>/`. Local SQLite (`better-sqlite3`) mirrors cloud for offline-first.

## Install

### macOS (LaunchAgent autostart)

```sh
curl -fsSL https://prismer.cloud/install.sh | sh -s -- \
  --component=daemon --adapters=claude-code,codex,hermes
```

What the daemon-mode installer does:

1. Detects OS / arch (Darwin or Linux x64/arm64; Windows requires WSL2).
2. Installs Node.js via `fnm` under `$HOME/.local/share/fnm` if absent (no Homebrew, no sudo).
3. Strict-pins `@prismer/runtime@2.0.0` (no caret) and installs globally via npm.
4. Scaffolds `~/.prismer/{adapters,workspace,logs,bin}`.
5. Writes `~/Library/LaunchAgents/com.prismer.daemon.plist` (label `com.prismer.daemon`, `KeepAlive=true`, `RunAtLoad=true`, `ProgramArguments` includes `--foreground`), then `bootout` + `bootstrap` to load it.
6. Auto-runs `prismer adapter install <name>` for each adapter passed via `--adapters`.

After install, run `prismer pair` (or `prismer setup sk-prismer-...`) to write `~/.prismer/config.toml`. The LaunchAgent's polling loop snaps to attention as soon as the file appears.

Installer flags: `-y/--yes`, `--no-setup`, `-v/--verbose`, `--local <dir>` (install from local tgz pre-publish), `--component=sdk|daemon` (or positional `daemon` shorthand), `--adapters=<csv>`, `--skip-launchagent` (CI), `--uninstall` (rm `~/.prismer`, `~/.local/share/fnm`, LaunchAgent).

### npm (manual)

```sh
npm install -g @prismer/runtime@2.0.0
prismer pair --device-name "$(hostname)"
prismer daemon start
```

Without LaunchAgent, you own daemon lifecycle (run under tmux / launchd / systemd / docker).

### Container (daemon-first sandbox image)

The runtime is PID 1 of every Prismer sandbox pod. `infra/sandbox-image/daemon-entrypoint.sh` writes a flat `~/.prismer/config.toml` from controller-injected env, then `exec prismer daemon start --port=7878 --foreground`. Required env:

- `PRISMER_API_KEY` — required.
- `PRISMER_DAEMON_ID` — required (else derived from hostname → `container:<podName>`).
- `PRISMER_BASE_URL` (or `CLOUD_API_BASE`, `PRISMER_CLOUD_API_BASE`) — cloud URL; falls back to `https://prismer.cloud`.
- `PRISMER_HOSTED_AGENT_FILE` / `PRISMER_HOSTED_AGENT_JSON` — static-binding payload (one-time agent install before first `host.declare`).
- `PRISMER_STATIC_BINDING_REQUIRED=true` — make missing static binding fatal.
- `PRISMER_USER_ID`, `PRISMER_TASK_ID`, `PRISMER_CONTAINER_ID` — audit-only.

The container daemon binds `:7878` (controller proxy target) instead of the desktop default `:3210`, and starts `OutboxWatcher` to upload files dropped under `/workspace/_outbox/` as sandbox-output assets.

## CLI reference (16 verbs)

`VERSION = '2.0.0'`. Each verb is a `commander` subcommand under `src/cli/commands/`. Output is JSON (`--json`) or human-friendly ANSI by default.

### Lifecycle

| Verb | Purpose |
| ---- | ------- |
| `banner [--compact]` | Print the Prismer Cloud banner. `--compact` collapses to one line. |
| `setup [api-key] [--token <jwt>] [--pair] [--cloud <url>] [--device-name <n>] [--force] [--start] [--no-start] [--as-user <email>] [--json]` | First-run onboarding. Three paths: direct API key, mint a daemon-scoped key from a user JWT (`POST /api/keys`, label `Daemon: <hostname> <YYYY-MM-DD>`), or delegate to QR/local-only pair. `--force` overwrites config and archives `local.db` → `local.db.<iso>.bak` if `api_key` / `cloud` / `daemon_id` changed. Auto-prints next-step tips (`daemon start`, `adapter list`, `agent register`, `profile create`, `task create`). |
| `pair [--cloud <url>] [--device-name <n>] [--force] [--as-user <email>]` | QR/JWT pair flow. `--as-user` requires `LOCAL_ONLY=1` (LAN dev bypass). |
| `daemon start [--port <n>] [--no-local-server] [--foreground] [--json]` | Daemonize itself by spawning `daemon run` and waiting up to 5s for the child to write a live PID. **`--foreground`** is required by the LaunchAgent plist (KeepAlive=true would respawn-loop on graceful exit). |
| `daemon run [--port <n>] [--no-local-server]` | Internal foreground worker. Polls every 5s for `~/.prismer/config.toml` to appear before booting `Runner` — so LaunchAgent KeepAlive can launch pre-pair without burning CPU. |
| `daemon stop [--timeout <ms>]` | SIGTERM the PID in `daemon.pid`; default timeout 5000ms. Clears stale PID files. |
| `daemon restart [--foreground]` | Chained `stop` then `start`. |
| `daemon status` | `{running, pid, paths.config}`; if alive, merges loopback `/healthz` (`pid`, `wsConnected`, `hostedAgents[]`). |
| `daemon logs --tail <n> [--follow]` | Read `~/.prismer/logs/daemon.log`; tail-N + `tail -f`-style follower. |
| `status [--json]` | Composite report: reads `config.toml`, hits `127.0.0.1:3210/healthz`, calls `GET /api/im/me`, counts `local.db` rows (`agents`, `agent_profiles WHERE deleted_at IS NULL`, `running_tasks`). Pretty banner by default. |

### Hosted agents

| Verb | Purpose |
| ---- | ------- |
| `adapter list` | Built-in adapters + per-adapter `health()` + recorded version from `[adapters.<name>]`. |
| `adapter install <name> [--package-version <v>] [--with-hooks] [--dry-run]` | Run the underlying package manager (`npm i -g`, `pipx install`), probe binary version, record `{package_manager, package_name, binary, version, installed_at}` into `config.toml`. `--with-hooks` writes a hook marker. |
| `adapter remove <name>` | Run uninstall (best-effort) and clear `[adapters.<name>]`. Alias: `uninstall`. |
| `adapter info <name>` | Print install spec + recorded version. |
| `adapter doctor <name>` | 5-check matrix: `downstream_binary`, `adapter_health`, `recorded_config`, `auth_env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `~/.hermes/.env`, `~/.openclaw/openclaw.json`), `hook_config`. Returns ordered fixes. |
| `adapter hooks <name> [--check] [--dry-run]` | Install / verify a `prismer-daemon-runtime` marker into the downstream tool's hook file (`~/.claude/hooks.json`, `~/.codex/hooks.json`, `~/.hermes/hooks.json`, `~/.openclaw/hooks/prismer.json`). JSON files are deep-merged; existing files are backed up to `<file>.bak.<iso>`. |
| `agent list [--local]` | Merge local mirror with cloud `GET /api/im/agents`. Emits `{localCount, cloudCount, agents[].{imUserId, name, adapter, local, cloud}}`. |
| `agent register --adapter <n> --display-name <n> [--username <n>] [--im-user-id <id>] [--capabilities <csv>] [--agent-type <t>] [--workspace-id <id>]` | `POST /api/im/register {type:'agent',username,displayName,agentType,capabilities,metadata.adapter}`. Auto-derives a slug if `--username` omitted. Mirrors into `local.db.agents`. |
| `agent rename <imUserId> <newName>` | `PATCH /api/im/agents/:id` + local update. |
| `agent remove <imUserId> [--cloud]` | Local-only by default; `--cloud` also `DELETE`s the cloud row. |
| `agent doctor [target]` | 6-check matrix: `binary`, `adapterHealth`, `localHosting` (DB row), `cloudVisibility`, `profileExistence` (local + cloud), `daemonLocalServerHealth` (`127.0.0.1:3210/healthz` + `/agents`). |
| `profile templates` | List built-in role templates (`product-manager`, `engineer`, `ceo`, `researcher`); each carries `applicableAdapters: ['hermes','openclaw','claude-code']` and a `configSchema` (`model`, `systemPrompt`, `allowedTools`, `maxTokens`). |
| `profile list --agent <imUserId>` | `GET /api/im/agent_profiles?agentId=…`. |
| `profile create --agent <id> --name <n> [--adapter <n>] [--config <jsonOr@file>] [--from-template <n>] [--workspace-id <id>]` | Template config merges with inline JSON. Default workspace via `/api/im/workspaces` if omitted. |
| `profile edit <profileId>` | Open current `config` in `$EDITOR` (default `vi`); PATCH on save. |
| `profile remove <profileId>` | Soft-delete (DELETE). |

### Tasks, memory, assets, events

| Verb | Purpose |
| ---- | ------- |
| `task create --agent <imUserId> --prompt <text> [--profile <id>] [--capability <n>] [--title <t>] [--timeout-ms <ms>] [--no-wait]` | `POST /api/im/tasks` then poll `GET /api/im/tasks/:id` until terminal. Tolerant of `{task:{...}}` and flat envelopes; reads `output` from `task.output` or `task.result.output`. |
| `task list [--limit <n>]` | Default limit 20. |
| `task get <taskId>` | Single task fetch. |
| `task cancel <taskId>` | `PATCH /api/im/tasks/:id {status:'cancelled'}`. |
| `memory stats` | Daemon Memory Gateway first (`/memory/stats`, `/api/memory/stats` on `PRISMER_DAEMON_URL` or `127.0.0.1:3210`); falls back to read-only `~/.prismer/local.db` snapshot of `cached_assets` + `workspace_files_mirror`. |
| `memory list [--limit <n>]` | Same fallback chain. |
| `memory search [query] [--query <text>] [--limit <n>]` | Local-cache substring filter when gateway unavailable. |
| `memory delete <id>` | Gateway-only. Exits 1 if unavailable. |
| `memory sync` | Gateway-only. Exits 1 if unavailable. |
| `asset list [--workspace-id <id>] [--task-id <id>]` | `GET /api/im/assets`. |
| `asset upload <file> --workspace-id <id> [--kind <k>] [--task-id <id>] [--agent-id <id>] [--container-id <id>] [--metadata <json>] [--mime <type>]` | Multipart `POST /api/im/assets`. |
| `asset download <assetId> --out <path>` | Fetches bytes from `/api/im/assets/:id` and writes to disk. |
| `asset get <assetId>` | `GET /api/im/assets/:id/detail`; pretty-prints kind/mime/size/storageUri/url/s3Url/expiresIn/photoRefs count. |
| `asset by-hash <sha256> [--workspace-id <id>]` | Content-hash dedupe lookup (`?wsId=…`). |
| `events [--limit <n>] [--agent-id <id>] [--session-id <id>] [--family <n>] [--type <n>]` | Read `~/.prismer/para/events.jsonl`. Default limit 50, hard max 10 000. Returns reverse-chronological array. Exits 1 with `events_unavailable` when the file does not exist. |
| `events:stats [--limit <n>] [--agent-id …]` | Aggregate `byFamily / byType / byAgentId / bySessionId` over the same filtered set. |

### Interaction

| Verb | Purpose |
| ---- | ------- |
| `chat me` | `GET /api/im/me`. |
| `chat direct <targetUserId> --message <text>` | `POST /api/im/direct/:id/messages {type:'text',content}`. |
| `chat messages <conversationId> [--limit <n>] [--before <id>]` | Pagination via `?limit=&before=`. |
| `chat group create --name <n> --members <csv>` | `POST /api/im/groups`. Members may be IM user IDs, usernames, or cloud user IDs. |
| `chat group send <groupId> --message <text>` | `POST /api/im/groups/:id/messages`. |
| `chat group messages <groupId> [--limit <n>] [--before <id>]` | History fetch. |
| `chat group remove-member <groupId> <memberId>` | `DELETE /api/im/groups/:id/members/:memberId`. |

All `chat` subcommands sanitize `sk-prismer-*` from error messages and tolerate both `{ok,data}` and `{success,data}` envelopes.

### Cookbook (54release MVP regression)

| Verb | Purpose |
| ---- | ------- |
| `cookbook run --suite <csv> [--workspace-id …] [--agent-id …] [--group-id …] [--sandbox-id …] [--prompt …] [--timeout-ms <ms>] [--strict] [--json]` | Run one or more smoke suites: `status` (`/api/health` + `/api/im/me`), `im` (`/workspaces`, `/me/agents`, `/groups`), `task` (list + optional create+poll if `--agent-id` and `--prompt` provided), `group` (list + optional history), `asset` (list), `sandbox` (list + status). `--strict` treats skips as failure. Exits non-zero on fail. |

### Sandbox

| Verb | Purpose |
| ---- | ------- |
| `sandbox list --workspace-id <id> [--status <s>] [--limit <n>]` | `GET /api/sandboxes?workspaceId=…`. |
| `sandbox create --workspace-id <id> [--agent-id …] [--task-id …] [--image …] [--cpu-request …] [--cpu-limit …] [--memory-request …] [--memory-limit …]` | `POST /api/sandboxes`. |
| `sandbox status <id>` | Detail + live status. |
| `sandbox start <id>` / `stop <id>` | Lifecycle endpoints. |
| `sandbox snapshot <id>` | `POST /api/sandboxes/:id/snapshot`. |
| `sandbox runCmd <id> -- <command...> [--timeout-ms <ms>]` | `POST /api/sandboxes/:id/runCmd {command, timeoutMs}`. |
| `sandbox logs <id>` | Streams `/logs` to stdout (`ReadableStream` decode loop). |

### Workspace

| Verb | Purpose |
| ---- | ------- |
| `workspace list` / `get <id>` | `GET /api/im/workspaces[/:id]`. |
| `workspace create --name <n> [--description <text>]` | Slug derived from name; `POST /api/im/workspaces {name, slug, metadata.description}`. |
| `workspace runtime <workspaceId> [--events] [--json]` | `GET /api/im/workspaces/:id/runtime` (devices + agents + heartbeats). `--events` opens an SSE stream at `…/runtime/events`, decoding `snapshot` / `agent.heartbeat` events into pretty heartbeats or `--json` lines. |
| `workspace files <workspaceId>` | `GET /api/im/workspaces/:id/files`. |

## Adapter taxonomy

The contract lives in `src/adapters/contract.ts`. Two `AdapterKind` values:

- **`'long-running'`** — adapter exposes `ensureService(profile)` returning an `AdapterService` (HTTP client) that the daemon's `ServicePool` reuses across tasks per `AgentProfile.id`. Re-creates on `healthy() === false` or `'crash'` event.
- **`'interactive'`** — adapter exposes `dispatch(profile, task)` and spawns one subprocess per task.

All four official adapters ship in-process via `src/adapters/registry.ts` (`Map<name, AdapterDef>` with `findByCapability(capability)` supporting wildcard tags like `code.*`).

| Adapter | Kind | Capabilities | Wraps |
| ------- | ---- | ------------ | ----- |
| `hermes` | long-running | `shell, code, mcp, long-context` | `hermes gateway` HTTP API on `127.0.0.1:<port>` |
| `claude-code` | interactive | `shell, code, mcp, edit` | `claude --print --model … <prompt>` (Claude CLI 2.x) |
| `codex` | interactive | `code, shell, openai` | `codex exec --model … --cd … --sandbox … --ephemeral --json <prompt>` |
| `openclaw` | long-running | `chat, code, multi-channel` | `openclaw gateway` (`POST /v1/chat/completions`, OpenAI-compatible) |

### `hermes`

Pure HTTP client of `hermes gateway` (Hermes 0.10+). All calls are HTTP — no `spawn('python', …)`, no PyPI dependency. `HermesProfileConfigSchema` (zod):

- `port` (1..65535, default `8642`), `apiKey` (required, from `~/.hermes/.env API_SERVER_KEY`).
- `hermesProfileName` (default = first 8 chars of `profile.id`), `autoStart` (default `false`), `startupTimeoutMs` (default 30 000).
- `configurePrismerProvider` (default `true`) — writes `custom_providers` + `model.provider='custom:prismer'` + `mcp_servers['prismer-tasks']` block into `~/.hermes/profiles/<name>/config.yaml`. The MCP server path is auto-resolved via `createRequire('@prismer/mcp-server')` first, then a repo-relative dev fallback.
- `installPrismerMcpServer` (default `true`), `prismerMcpServerPath` (override).
- `model` (default `us-kimi-k2.5`), `prismerProviderName` (default `prismer`), `prismerProviderBaseUrl` (default `$PRISMER_BASE_URL/api/v1`), `prismerApiKeyEnv` (default `PRISMER_API_KEY`, regex `^[A-Za-z_][A-Za-z0-9_]*$`).
- `mirrorNativeKanban` (default `true`) — mirrors Prismer `work_item` projections into Hermes Kanban as triage cards via `hermes -p <profile> kanban create … --triage --idempotency-key prismer:<parentTaskId>`.
- `mirrorNativeGoals` (default `true`) — writes Prismer standing objectives into Hermes' SQLite `state_meta["goal:<sessionId>"]` directly.
- `nativeMirrorTimeoutMs` (default 2000).

Dispatch flow:

1. (autostart only) spawn `hermes -p <profile> gateway run` with `API_SERVER_ENABLED=true`, `API_SERVER_KEY`, `API_SERVER_PORT`, `API_SERVER_HOST=127.0.0.1`.
2. Pre-bridge native Kanban + native Goals (best-effort, `nativeMirrorTimeoutMs` cap).
3. `POST /v1/runs {input, instructions, session_id, stream:true}` → `{run_id}`.
4. Stream `GET /v1/runs/:id/events` (SSE). Events: `message.delta` (concat to deltas), `run.completed` (final output), `run.failed` (throw), `tool.started` / `tool.completed` (forward to `task.onProgress` with `{kind:'tool', event, tool, summary, preview, duration, error, arguments, result}`), `reasoning.available` (forward as `{kind:'reasoning'}` without bumping progress).
5. On abort, `POST /v1/runs/:id/stop`.
6. Result includes `metadata.hermes.{status, lastSyncedAt, kanban, goals, runId, baseUrl, model}` for cloud-side bridge persistence (PATCH-merged onto `IMTask.metadata.bridge.hermes`).

### `claude-code`

`claude --print --model <m> [--system-prompt …] [--allowed-tools …] <prompt>` per dispatch. `--cwd` removed (uses `child_process.spawn` cwd); prompt is positional; `--headless` was renamed to `--print` in claude CLI 2.x. Config: `cwd` (required), `model` (default `'sonnet'`), `systemPrompt`, `envVars`, `mcpServers`, `allowedTools`, `maxTurns` (default 20), `baseURL`, `apiKeyRef` (`env:NAME` or `keychain:NAME` — keychain only on darwin via `security find-generic-password`), `route` (`'default'|'prismer'|'omniroute'`). `stdio: ['ignore', 'pipe', 'pipe']` to close child stdin (claude ≥ 2.1.128 prints "no stdin data received in 3s, proceeding without it" otherwise). `task.signal` → `child.kill('SIGTERM')`; `task.timeoutMs` → SIGTERM via `setTimeout`.

### `codex`

`codex exec --model <m> --cd <cwd> --sandbox <level> --ephemeral --json <prompt>`. Config: `cwd` (required), `model` (default `codex-mini-latest`), `sandbox` (`'read-only'|'workspace-write'|'danger-full-access'`, default `workspace-write`), `systemPrompt` (prepended to user prompt — Codex CLI has no `--system-prompt` flag as of 2026-05), `envVars`, `apiKeyEnv` (default `OPENAI_API_KEY`). `parseCodexOutput` reads JSONL stdout backwards looking for `{"type":"message"|"assistant"|"output", "content"|"message"|"text": string}`; falls back to raw stdout. Outputs are capped at 64 KiB with `\n…[truncated]` suffix.

### `openclaw`

HTTP-only client of `openclaw gateway`. `POST /v1/chat/completions` (OpenAI-compatible, non-streaming). Config: `port` (default `18789`), `apiKey` (bearer token from `gateway.auth.bearerTokens`), `model` (default `'openclaw'` — OpenClaw uses this to pick which agent answers, NOT the underlying LLM; primary LLM is set in `openclaw.json`). Includes a defensive strip of OpenClaw 2026.4.x's `Cannot read properties of undefined (reading '...')` stderr-bleed prefix that contaminates assistant content.

## Daemon architecture

```
┌──────────────────────────────────────────────────────────┐
│  Cloud  (REST + WS multiplexed across hosted agents)     │
└─────────────┬──────────────────────────┬─────────────────┘
              │ WS ?token=<sk-prismer>   │ REST CloudClient
              │                          │
        ┌─────▼─────┐  ┌──────────┐  ┌───▼─────────────────┐
        │ WsClient  ├──▶ dispatch ├──▶ adapter.dispatch /  │
        │ (1 conn)  │  │  router  │  │ ServicePool.ensure  │
        └─────┬─────┘  └─────┬────┘  └─────────┬───────────┘
              │              │                 │
        host.acked       runtimeRoute     long-running
        host.declare      ='shell' →      adapters reused
        task.dispatch    shell-executor   per AgentProfile.id
              │
       ┌──────▼─────────────────────────────────────┐
       │  Runner (main loop, ~960 LOC)              │
       │  - LocalDb (better-sqlite3 ~/.prismer/local.db) │
       │  - AssetCache (LRU, 5 GiB default)         │
       │  - UriResolver (prismer:// → file://)      │
       │  - SyncQueue + SyncWorker                  │
       │  - LocalServer (127.0.0.1:3210 / :7878)    │
       │  - OutboxWatcher (container only)          │
       │  - 30s heartbeat re-declare                │
       │  - 60s stuck-task reaper                   │
       └────────────────────────────────────────────┘
```

### `Runner` boot sequence (`src/daemon/runner.ts`)

1. Load `config.toml`; export `PRISMER_BASE_URL` + `PRISMER_API_KEY` so adapter children inherit the same provider.
2. Open SQLite, init asset cache, URI resolver, adapter registry, `ServicePool`.
3. **Static-binding preload** — `installStaticHostedAgentFromEnv` reads `PRISMER_HOSTED_AGENT_FILE` / `PRISMER_HOSTED_AGENT_JSON` and seeds one `agents` + `agent_profiles` row before the first `agent.host.declare`. `PRISMER_STATIC_BINDING_REQUIRED=1` makes a missing payload fatal.
4. Load remaining locally-registered agents from DB.
5. Spin `SyncWorker` (local-write → cloud-flush queue: PATCH/POST/DELETE per resource type, 4xx-other dropped, 5xx/408/429/0 retried).
6. Open WS; wire handlers.
7. (Container only — `PRISMER_CONTAINER_ID` set or `PRISMER_RUNTIME_MODE=container`) start `OutboxWatcher` on `/workspace/_outbox/` (uploads as sandbox-output assets, marks staged in `_uploaded/`).
8. Bind `LocalServer` (unless `--no-local-server`).
9. Start a 30s heartbeat that re-sends `agent.host.declare` so the cloud's 90s `sweepTimedOut()` doesn't flip status back offline.
10. Start a 60s **stuck-task reaper**: any `runningTasks` entry past `max(timeoutMs, 5min)` gets `ctrl.abort()` + a daemon-side `task.dispatch.reply {ok:false, error.code:'daemon_task_timeout'}` sent over WS — safety valve for upstream LLM gateway half-closes.

### Dispatch (`src/daemon/dispatch.ts`)

Pure function that runs a single task:

1. Resolve `AgentProfile` (cloud REST — by `profileId` or, if blank, the most-recently-created profile for `agentImUserId`).
2. Look up adapter; reply `{ok:false, error.code:'adapter_unhealthy'}` if missing.
3. Rewrite `prismer://` URIs in `prompt` and `context[].content` via `UriResolver`, pinning resolved hashes.
4. `composePrompt(...)` — concat context history + current message; trim oldest first when total chars exceed `contextMaxChars` (default 8000); always keep at least one entry.
5. **Memory context** — `GET /api/im/memory/digest?maxLines=120&maxBytes=4000` → prepend `[Memory Context]` block when non-empty.
6. **Goal context** — `GET /api/im/tasks?workspaceId=<ws>&limit=100`, filter for `metadata.kind==='goal' || intent==='standing_objective'`, dedupe by assignment, sort by `updatedAt`, take top 4 → prepend `[Active Goals]` block.
7. Resolve `profile.config.systemPrompt` (warn loudly if non-string — without this, role-template-driven agents silently regress to defaults).
8. Build `TaskInput { taskId, prompt, metadata: {...payload.metadata, conversationId, prismerGoals, systemPrompt?, prismerObservability}, timeoutMs, signal, onProgress }`. `onProgress` re-emits as `task.dispatch.progress` over WS.
9. Long-running: `servicePool.ensureService(profile, adapter).dispatch(taskInput)`. Interactive: `adapter.dispatch(profile, taskInput)`.
10. Build `task.dispatch.reply { taskId, ok, output, error, metrics }`.
11. **Bridge metadata writeback** — if `result.metadata.hermes` present, PATCH `/api/im/tasks/:id` merging onto `metadata.bridge.hermes` (with `lastSyncedAt`).
12. **Observability writeback** — PATCH `metadata.observability` with `{identity, memory, goals, lastSyncedAt}`.
13. Always unpin all resolved hashes.

### Daemon-local shell (`src/daemon/shell-executor.ts`)

`runtimeRoute='shell'` (or `metadata.execution.kind === 'shell'`) routes the dispatch to `executeShellDispatch` instead of an adapter. `ShellExecutionConfig` (resolved from `[shell]` block in `config.toml`):

- `enabled` (default `false`; `PRISMER_SHELL_ENABLED=true` env override).
- `defaultCwd` (default `process.cwd()`).
- `maxTimeoutMs` (default 60s, hard max 30 min).
- `maxOutputBytes` (default 256 KiB, hard max 5 MiB).
- `allowedWorkspaces?` (allow-list).
- `shell` (`bash|zsh|sh`, default `bash`).

Spawns `<shell> -lc <command>` with `payload.metadata.execution.cwd|env|shell` overrides; streams stdout/stderr → `task.dispatch.progress` events with `detail.{stream, chunk, sequence, truncated}`. Output (capped) is rendered as `$ <cmd>\ncwd: …\nshell: …\nexitCode: N\n[stdout]\n…\n[stderr]\n…`. Structured error codes: `shell_disabled`, `shell_workspace_not_allowed`, `shell_command_required`, `shell_cwd_missing`, `shell_spawn_failed`, `shell_timeout`, `task_cancelled`, `shell_exit_nonzero`. SIGTERM → 2s grace → SIGKILL on timeout/abort.

### `WsClient` (`src/daemon/ws-client.ts`)

WS to cloud, `?token=<apiKey>`. Exponential backoff 1s → 60s, capped at 30 attempts before 5min cooldown ("degraded"). Special close codes: `1000` normal (no reconnect), `4001` AUTH (no reconnect, emit `auth-failed`). Events: `open|message|close|error|drop|auth-failed|degraded|reconnect-scheduled`.

## WS protocol (cloud ↔ daemon)

Mirror types in `src/types/im-events.ts` (canonical chain: `src/im/types/im-events.ts` → SDK → runtime).

### Daemon → cloud

| Event | Payload |
| ----- | ------- |
| `agent.host.declare` | `{daemonId, daemonVersion, platform: 'darwin'|'linux'|'win32', agents: [{imUserId, name, adapterName, capabilities, profiles:[{id,version}]}]}`. Sent on `'authenticated'` ack and every 30s. Cloud stamps `daemonId` into `IMAgentCard.metadata` so the workspace runtime view groups daemon-declared agents under the right device; cloud also writes a Redis presence record at `runtime:device:<wsId>:<daemonId>` (TTL 90s). |
| `task.dispatch.reply` | `{taskId, ok, output?, error?, metrics?}`; `requestId` echoes the original request envelope. |
| `task.dispatch.progress` | `{taskId, progress: 0..1, message?, detail?}` — incremental. |
| `agent.status.changed` | `{agentImUserId, status, activeProfileId?, runningTaskIds?}` — emitted on agent state shifts. |

### Cloud → daemon

| Event | Payload |
| ----- | ------- |
| `host.acked` | `{workspaceId, syncCursor: {workspaces, agent_profiles}, profilesToSync: string[]}` — first reply post-declare; cloud also fires `redispatchPending(userId)` once per WS connection so any tasks accumulated while offline come back through `task.dispatch.request`. |
| `task.dispatch.request` | `{taskId, agentImUserId?, targetDaemonId?, profileId, capability, prompt, runtimeRoute?, metadata?, timeoutMs?, context?: TaskDispatchContextEntry[], conversationId?}`. `runtimeRoute` accepts `'agent' | 'sandbox' | 'shell'`. Per-`taskId` dedupe in `Runner.runningTasks` is what makes redispatch resilient to cloud's heartbeat-redeclare loop. |
| `task.cancel` | `{taskId, reason?}` → `runningTasks.get(taskId)?.ctrl.abort()`. |
| `agent.changed` | `{agentImUserId, fields: {displayName?, capabilities?}}` → patch in-memory. |
| `agent_profile.changed` | `{profileId, version}` → re-fetch via REST + redeclare. |
| `workspace.changed` | `{workspaceId, updatedAt}` → re-fetch. |
| `workspace_file.changed` | `{workspaceId, path, operation: 'create'|'update'|'delete', assetId?, contentHash?, version}` → upsert/delete `workspace_files_mirror`. |

The server-side `'authenticated'` ack from cloud triggers the first `agent.host.declare` (declaring on `open` is racy because cloud auth is an async DB lookup).

## Hermes long-running setup

Operators run `hermes` in their own Python venv. Sample `~/.hermes/profiles/<name>/config.yaml` (auto-written by the adapter when `configurePrismerProvider: true`):

```yaml
custom_providers:
  prismer:
    type: openai
    base_url: https://prismer.cloud/api/v1
    api_key_env: PRISMER_API_KEY
model:
  provider: custom:prismer
  name: us-kimi-k2.5
mcp_servers:
  prismer-tasks:
    command: node
    args:
      - /usr/local/lib/node_modules/@prismer/mcp-server/dist/index.js
```

Then start the gateway with the API server platform enabled:

```sh
API_SERVER_ENABLED=true \
API_SERVER_KEY=<apiKey> \
API_SERVER_PORT=8642 \
API_SERVER_HOST=127.0.0.1 \
hermes -p <profile> gateway run
```

A plain `hermes gateway` without these env vars starts only configured messaging platforms and will never bind the `/v1/runs` HTTP API. Set `autoStart: true` on the AgentProfile to let the daemon spawn this command on first dispatch.

The adapter mirrors Prismer projections into Hermes' native surfaces:

- **Kanban** — `hermes -p <profile> kanban create … --triage --idempotency-key prismer:<parentTaskId>`. Triage avoids duplicate execution; Prismer's `agent_run` remains the executable source of truth.
- **Goals** — direct write into Hermes' SQLite `state_meta["goal:<sessionId>"]` (Hermes has no public goals REST/CLI surface).

Bridge results are persisted on `IMTask.metadata.bridge.hermes` via the daemon's PATCH-merge writeback step.

## LocalServer HTTP API (loopback only)

`src/daemon/local-server.ts` binds `127.0.0.1:<port>`. Desktop default `:3210`, container `:7878`. CORS allows `*` / `GET,POST,OPTIONS` / `Content-Type,Authorization`.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| OPTIONS | `*` | CORS preflight |
| GET | `/healthz` | `{status:'ok', daemonId, cloudBaseUrl, workspaceId, pid, startedAt, wsConnected, hostedAgents, observability}` |
| GET | `/agents` | `{agents: [{imUserId, name, adapterName}]}` |
| GET | `/tasks/running` | `{taskIds: string[]}` |
| POST | `/v1/runs` | Sandbox controller daemon-dispatch ack — `202 {runId, status:'accepted', taskId}`. Optional `payload.shellCommand` triggers async `bash -c <cmd>` with `cwd=/workspace` (escape hatch). |
| POST | `/v1/agents/install` | **Cloud → daemon agent install RPC**: validates body via `validateInstallAgentPayload`, calls `runner.installHostedAgent` → upsert `agents` + `agent_profiles` rows, reload, send `agent.host.declare`, return `{ok, daemonId, installedAgent, hostedAgents}`. |
| POST | `/v1/snapshot` | FS-manifest snapshot — walks `snapshotRoot` (default `/workspace`), computes per-file `{path, sha256, sizeBytes, mtime}`. Skips dotfiles + `_outbox/_uploaded`. 404 if root missing. |

The sandbox-controller's `installAgent` proxy at `POST /:id/installAgent` validates body via `InstallAgentSchema` (zod), resolves pod IP via `orchestrator.getContainerIp(id)`, and forwards to `http://<podIP>:7878/v1/agents/install`. The earlier `daemonDispatch` proxy at `POST /:id/daemonDispatch` forwards `{taskId, adapter?, prompt?, env?}` to `:7878/v1/runs`.

## Configuration

| Env var | Default | Purpose |
| ------- | ------- | ------- |
| `PRISMER_HOME` | `~/.prismer` | Daemon home (config, db, logs, adapter installs) |
| `PRISMER_BASE_URL` | from `config.toml` `cloud_api_base` | Cloud URL (LAN dev override) |
| `PRISMER_API_KEY` | from `config.toml` `api_key` | Cloud API key (also exported to adapter children) |
| `PRISMER_HOSTED_AGENT_FILE` | (empty) | Static-binding payload path (k8s/container) |
| `PRISMER_HOSTED_AGENT_JSON` | (empty) | Inline JSON variant |
| `PRISMER_STATIC_BINDING_REQUIRED` | `false` | Treat missing static binding as fatal |
| `PRISMER_CONTAINER_ID` | (empty) | Activates `OutboxWatcher` |
| `PRISMER_RUNTIME_MODE` | (empty) | `container` activates `OutboxWatcher` (alt to `PRISMER_CONTAINER_ID`) |
| `PRISMER_DAEMON_URL` | `http://127.0.0.1:3210` | Loopback URL used by `prismer memory` and `agent doctor` |
| `PRISMER_SHELL_ENABLED` | `false` | Override `[shell].enabled` in `config.toml` |
| `LOCAL_ONLY` | (empty) | `=1` enables `--as-user` pair bypass |
| `PRISMER_AUTH_TOKEN` | (empty) | Fallback for `prismer setup --token <jwt>` |
| `EDITOR` | `vi` | Used by `prismer profile edit` |

`config.toml` schema (TOML, written by `setup` / `pair`):

```toml
api_key = "sk-prismer-..."
cloud_api_base = "https://cloud.prismer.dev"
daemon_id = "..."

[adapters.claude-code]
package_manager = "npm"
package_name = "@anthropic-ai/claude-code"
binary = "/usr/local/bin/claude"
version = "2.1.128"
installed_at = "2026-05-07T00:00:00.000Z"

[shell]
enabled = false
maxTimeoutMs = 60000
maxOutputBytes = 262144
shell = "bash"
```

## Troubleshooting

- **LaunchAgent respawn loop after install** — the plist must include `--foreground` in `ProgramArguments`. v2.0.0 installs do this automatically; if you're upgrading from 1.8.x re-run `curl -fsSL https://prismer.cloud/install.sh | sh -s -- --component=daemon` (the installer does `bootout` + `bootstrap` to reload).
- **Daemon shows "waiting for ~/.prismer/config.toml"** — that's expected behavior pre-pair. Run `prismer pair` (or `prismer setup sk-prismer-...`) and the daemon snaps to attention within 5s.
- **Cloud unreachable** — `prismer status` will print the failing base URL. Common causes: stale `cloud_api_base` after a tenant move (run `prismer setup --force <new-key> --cloud <url>`), or the API key was rotated (mint a new one with `prismer setup --token <jwt>`).
- **Agent shows under `__unbound__` device in workspace runtime view** — the daemon's `agent.host.declare` is not stamping `daemonId`. Confirm you're on `@prismer/runtime@2.0.0` (the `daemonId` payload field is required as of v2.0.0).
- **`claude --print` runs report "no stdin data received in 3s"** — fixed in v2.0.0 (`stdio: ['ignore', 'pipe', 'pipe']`). Older runtimes will surface the warning but the dispatch still completes.
- **Tasks dispatch but `@`-mention messages never reach the agent** — cloud-side `SHADOW_JOIN_FAILED` rollback. The runtime's `agent.host.declare` requires every declared agent to auto-join all its conversation rooms; check daemon logs for the rollback line and re-register the agent (`prismer agent register …`) to fix the cloud-side row.
- **Stuck task that never replies** — the 60s reaper aborts and replies `{ok:false, error.code:'daemon_task_timeout'}` after `max(timeoutMs, 5min)`. Cloud will mark the task `failed` accordingly. Inspect via `prismer task get <id>`.

## Versioning

> See [CHANGELOG.md](./CHANGELOG.md). Current: **v2.0.0** (2026-05-19).

## License

MIT.
