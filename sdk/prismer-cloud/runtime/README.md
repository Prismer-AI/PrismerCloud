# @prismer/runtime

Prismer Cloud v1.9.0 daemon runtime and `prismer` CLI.

This package hosts the local Prismer daemon, the HTTP control plane on port 3210, the multi-path transport to Cloud Relay (WebSocket), the agent supervisor and PARA adapter registry, and the `prismer` command-line interface. It is one of the three core v1.9.0 tracks — see [`docs/version190/02-architecture.md`](https://github.com/Prismer-AI/PrismerCloud/blob/main/docs/version190/02-architecture.md) for the full design.

## Install

### Bootstrap installer (recommended)

```
curl -fsSL https://prismer.cloud/install.sh | sh
```

Auto-detects Node via `fnm`, installs `@prismer/sdk` and `@prismer/runtime` globally, launches the daemon, and runs first-time setup. macOS and Linux, no sudo, no Homebrew required.

### Manual (npm)

```
npm install -g @prismer/runtime @prismer/sdk
prismer setup
```

Requires Node.js 20+. `@prismer/sdk` is required — the runtime mounts the SDK's `register / config / token / send / load / search / parse / recall / discover` commands via `@prismer/sdk/cli`.

## Quick start

```
# 1. Provide an API key (persists to ~/.prismer/config.toml)
prismer setup sk-prismer-live-...

# 2. Start the daemon (HTTP on 127.0.0.1:3210 + Cloud Relay WS)
prismer daemon start

# 3. Check health
prismer status

# 4. Wire an agent
prismer agent install claude-code --install-agent   # also installs the upstream CLI if missing
prismer agent list

# 5. Pair a mobile device
prismer pair show
```

`PRISMER_API_KEY=sk-prismer-... prismer setup` works equivalently for Docker and CI — no browser OAuth round-trip is required when the key is supplied out-of-band.

## CLI surface

### Lifecycle

| Command | Purpose |
|---|---|
| `prismer setup [api-key]` | First-run setup: write API key, start daemon, scan for agents, print next steps. `--postinstall` for npm lifecycle hooks, `--no-daemon` to skip startup, `--skip-agent-scan` to skip detection. |
| `prismer status` | Daemon + agent + system health overview. `--json` for machine-readable. |
| `prismer daemon start` | Start detached background daemon on port 3210. `--foreground` for Docker/systemd. `--port <n>` to override. |
| `prismer daemon stop` | Graceful SIGTERM with 10s timeout, then SIGKILL. |
| `prismer daemon restart` | Stop then start. Preserves port. |
| `prismer daemon status` | PID file + port binding state. |
| `prismer daemon logs [--tail N] [--follow]` | Tail `~/.prismer/logs/daemon.log`. |
| `prismer daemon reprobe` | Force a transport reprobe pass without restarting. |

The daemon writes its PID to `~/.prismer/daemon.pid` atomically with `O_CREAT | O_EXCL`. A crash-loop guard in `daemon.starts.json` blocks rapid restart storms (3 failures in 10 minutes → 5-minute cooldown).

### Agent control

| Command | Purpose |
|---|---|
| `prismer agent list` | All installed agents with tier + hook status. |
| `prismer agent install <name>` | Install an adapter pack. Two-tier fetch: signed release manifest (GitHub Release) → npm registry. Ed25519 signature verified before hook wiring unless `--skip-verify`. `--install-agent` also installs the upstream CLI (claude-code, codex, …) if missing. `--source cdn\|mirror\|npm`, `--force`, `--non-interactive`, `--accept-defaults`. |
| `prismer agent doctor <name>` | Diagnose binary path, hook config, daemon registration, PARA event emission for a given agent. |
| `prismer agent remove <name>` | Rollback hook config to the pre-install backup and remove the sandbox profile. Keychain entries are preserved. `--yes` to skip the confirmation prompt. |
| `prismer agent update <name>` | Shorthand for `install --force`. |
| `prismer agent publish <name>` | Publish the locally-installed agent so it appears from mobile. Writes to `~/.prismer/published-agents.toml` and calls cloud. |
| `prismer agent unpublish <name>` | Reverse of publish. Cloud deletes within 90s even if the DELETE call fails (background sweep). |

Shipped adapters: `claude-code`, `codex`, `openclaw`, `hermes`. Each ships via npm with an Ed25519-signed manifest attached to the matching GitHub Release. See [`docs/version190/15-cli-design.md`](https://github.com/Prismer-AI/PrismerCloud/blob/main/docs/version190/15-cli-design.md) §15.6 for pack schema and signing flow.

### Pack registry

```
prismer pack list
prismer pack search <query>
prismer pack verify <name> <signature>
```

Reads the signed pack index from the current GitHub Release — useful to inspect available adapters without installing.

### Device pairing

```
prismer pair show [--ttl 300]    # generate QR code (5 min TTL, single-use)
prismer pair list                # list paired devices
prismer pair revoke <deviceId>   # remove from local registry
```

Pairing offers use 5-minute TTL tokens exchanged via Cloud Relay. The CLI polls the daemon for pair completion and writes the resulting device record to `~/.prismer/data/paired-devices.json`.

### Domain commands (via SDK)

Mounted at runtime via `@prismer/sdk/cli`:

```
prismer register <username>         # create a Prismer identity
prismer config show|set
prismer token refresh

prismer send / load / search        # IM + context shortcuts
prismer parse / parse-status / parse-result
prismer recall / discover           # memory + agent discovery
```

### Domain commands (native)

```
prismer task ...         # Task Router (v1.9.0 cross-agent task routing)
prismer memory ...       # Memory Gateway (hexagonal cloud/local ports)
prismer memory key-backup / key-recover / key-fingerprint   # Shamir recovery
prismer evolution ...    # Evolution Gateway
prismer tier:set <agent-id> <tier>     # 1..7
prismer tier:get <agent-id>
prismer session export <sessionId>     # copy ~/.prismer/trace/<id>.jsonl.zst
prismer events [--agent-id --session-id --family --type]
prismer events:stats
prismer permissions:test --tier N      # inspect permission evaluation
```

### Migration

```
prismer migrate                          # v1.8 → v1.9 upgrade (api key → keychain, hooks → daemon)
prismer migrate luminclaw-memory         # import luminclaw local memory to Memory Gateway
prismer migrate-secrets                  # sweep config.toml plaintext → keychain
```

`migrate-secrets --dry-run` previews without touching files or the keychain.

## Global flags

Applied before Commander parses the command tree — all subcommands honour them:

| Flag | Effect |
|---|---|
| `--json` | Machine-readable single-line JSON output. Mutually exclusive with `--follow` on log streaming. |
| `--quiet` | Suppress non-error output. |
| `--color` / `--no-color` | Force colour on / off. `NO_COLOR` env is also honoured. |

All error-path JSON conforms to the Prismer API envelope: `{ success: false, error: { code, message }, ... }`.

## Configuration

Config lives at `~/.prismer/config.toml`:

```toml
[default]
api_key      = "sk-prismer-live-..."
environment  = "production"
base_url     = "https://prismer.cloud"

[daemon]
id = "daemon:abc123..."

[user]
id = "user:abc123..."
```

Resolution order for any value: **explicit flag > environment variable > config.toml > keychain placeholder > default**. `sk-prismer-...` API keys may also live in the keychain under service `prismer-config/default.api_key` and be referenced from the TOML via `$KEYRING:prismer-config/default.api_key`.

Relevant environment variables:

| Var | Default | Purpose |
|---|---|---|
| `PRISMER_API_KEY` | — | Seeds `prismer setup` and daemon identity. |
| `PRISMER_BASE_URL` | `https://prismer.cloud` | Cloud API base for all daemon + CLI calls. |
| `PRISMER_API_BASE` | `https://prismer.cloud/api/im` | IM / PARA endpoints. |
| `PRISMER_MASTER_PASSPHRASE` | — | Enables the encrypted-file keychain backend when no system keychain is available. |
| `PRISMER_SKIP_POSTINSTALL` | — | Set to `1` to suppress `npm install` postinstall setup. |
| `PRISMER_FORCE_POSTINSTALL` | — | Set to `1` to run postinstall even on non-global installs. |
| `NO_COLOR` | — | Disable ANSI colour. |

### Keychain backends

The runtime probes backends in order:

1. **macOS Keychain** (`security` binary). Values written via `-X <hex>` so plaintext never appears in `ps aux`.
2. **libsecret** via `secret-tool` (Linux GNOME/KDE).
3. **pass** (`pass` store, optional GPG-backed).
4. **Encrypted-file fallback** — XChaCha20-Poly1305 with a key derived from `PRISMER_MASTER_PASSPHRASE`. Only enabled when the env var is set.

## Architecture

```
                        prismer CLI (bin/prismer.ts)
                                │
                      HTTP 127.0.0.1:3210
                                │
               ┌────────────────▼─────────────────┐
               │  Daemon (daemon/runner.ts)       │
               │  ├─ HTTP server (daemon-http.ts) │
               │  ├─ Multi-path transport         │
               │  │   ├─ WS to Cloud Relay        │
               │  │   └─ LAN probe                │
               │  ├─ Agent supervisor             │
               │  ├─ Events tailer (PARA → cloud) │
               │  ├─ Outbox (SQLite WAL)          │
               │  └─ Memory Gateway (SQLite FTS5) │
               └────────────────┬─────────────────┘
                                │
                    Installed agents (hooks)
                claude-code, codex, openclaw, hermes
```

### Data directory layout (`~/.prismer/`)

| Path | Contents |
|---|---|
| `config.toml` | User config (see above). |
| `daemon.pid` | Atomic PID file. Owned by the running daemon. |
| `daemon.port` | Bound port (default 3210). |
| `daemon.starts.json` | Start-attempt log for crash-loop detection. |
| `logs/daemon.log` | Plain-text log output; tailed by `prismer daemon logs`. |
| `outbox.sqlite` | Ordered event buffer (WAL mode) for Cloud Relay. |
| `memory.sqlite` | Local Memory Gateway store with FTS5 indices. |
| `trace/<sessionId>.jsonl.zst` | Per-session PARA traces emitted by L8 adapters. |
| `para/events.jsonl` | Live PARA event stream tailed by `events-tailer`. |
| `sandbox/<agent>.sb` | macOS seatbelt sandbox profiles for installed agents. |
| `data/paired-devices.json` | Local device pairing registry. |
| `published-agents.toml` | Mirror of cloud-published agents. |

## Security

- **Ed25519 signed packs** — Adapter manifests are attached to the matching GitHub Release and carry detached Ed25519 signatures. `install-agent.ts` verifies before wiring hooks; npm-source fallback is treated as lower trust and signalled to the user. `--skip-verify` is allowed for offline / dev.
- **API key hygiene** — Keys are passed to child processes via named FDs or keychain reads, not via argv. macOS `security` uses `-X` hex encoding. Config writes should be `chmod 0o600` (see Known Issues).
- **Sandbox profiles** — macOS seatbelt / Linux AppArmor / bwrap. Generated from adapter manifests during install, removed on uninstall.
- **Device pairing** — Offer tokens are short-lived (5 min), single-use, exchanged over TLS to Cloud Relay. Revocation currently only prunes the local registry (see Known Issues).

## Known issues

The CLI path is under active hardening. Tracked items:

- `install-agent.ts` catches Ed25519 signature failure in the CDN branch and falls through to the npm tier — a tampered pack can be silently downgraded. **Fixing imminently.**
- `prismer agent remove` does not prompt for confirmation; `--yes` is declared but unread.
- `prismer migrate` runs destructive steps on TTYs with no confirmation.
- `prismer pair revoke` is local-only; the server-side binding is not invalidated.
- `getAuthToken()` in `migrate-luminclaw-memory.ts` returns empty — the import flow requires authentication to be wired.
- Version strings in `install-agent.ts` success/already-installed paths are hardcoded to `1.9.0` instead of being read from the pack manifest.
- libsecret backend collapses "not found" and transient failures into `null` — the macOS backend distinguishes these.
- `daemon start` poll timeout of 2s can cause false-positive "failed to start" entries on slow machines and trigger the crash-loop guard.

Fixes land in v1.9.1. Open an issue or PR at [github.com/Prismer-AI/PrismerCloud](https://github.com/Prismer-AI/PrismerCloud).

## Development

```
# Build
npm run build          # tsup bundle + copy icon/smallicon

# Type check only
npm run typecheck

# Run the vitest suite
npm test

# Clean dist
npm run clean
```

`@prismer/*` dependencies resolve from the npm registry. Fresh clones of the closed-source repo cannot `npm install` until upstream packages publish — use the monorepo build scripts instead:

```
sdk/build/pack.sh --scope all --clean    # tarball all SDKs
sdk/build/verify.sh --scope all          # version parity + compile
public/install.sh --local-artifacts      # install from local tarballs
```

Release is driven from the source repo via `sdk/build/release.sh --scope prismer-cloud`, which syncs into the open-source mirror before tagging and publish. Hotfixes use `sdk/build/hotfix.sh @prismer/runtime 1.9.0.N` and do **not** bump the root `/VERSION`.

## Links

- Design: [`docs/version190/02-architecture.md`](https://github.com/Prismer-AI/PrismerCloud/blob/main/docs/version190/02-architecture.md), [`docs/version190/15-cli-design.md`](https://github.com/Prismer-AI/PrismerCloud/blob/main/docs/version190/15-cli-design.md)
- Cloud dashboard: https://prismer.cloud
- Issues: https://github.com/Prismer-AI/PrismerCloud/issues
- SDK: [`@prismer/sdk`](https://www.npmjs.com/package/@prismer/sdk)
- Plugins: [`@prismer/claude-code-plugin`](https://www.npmjs.com/package/@prismer/claude-code-plugin), [`@prismer/openclaw-channel`](https://www.npmjs.com/package/@prismer/openclaw-channel)

## License

MIT
