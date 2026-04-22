# Changelog — @prismer/adapter-hermes

## v0.1.0 (unreleased, 2026-04-21)

Initial skeleton — runtime-side Node.js adapter for NousResearch Hermes
Mode B HTTP loopback transport. Companion to the Python-side
`prismer-adapter-hermes` on PyPI (which ships the hook-translation
half today and will add the `/dispatch` server in 0.2.0).

### Added

- `buildHermesAdapter(config)` — constructs an `AdapterImpl` conforming
  to `@prismer/runtime`'s contract. Defaults to `http://127.0.0.1:8765`
  and advertises Hermes identity (`name: "hermes"`, tiers `[1,2,3,4]`,
  capabilities `["code","llm","cache-safe-inject"]`).
- `detectHermesLoopback(opts)` — short-timeout `/health` probe. Returns
  `{ found, loopbackUrl, reason }` without raising. Default timeout
  500 ms so daemon startup isn't blocked when Hermes isn't running.
- `autoRegisterHermes(registry, opts)` — one-shot wiring: probe, build,
  register (replacing any existing `hermes` entry, e.g. the CLI shim
  installed by `@prismer/runtime`'s generic auto-register).
- Security guards copied from `@prismer/runtime`'s internal Mode B
  factory: only `http://127.0.0.1:<explicit-port>` origin accepted,
  HTTPS / `localhost` / non-empty pathname / search / hash rejected
  at construction time.
- Test suite (vitest): 24 tests across `detect`, `build`, `auto-register`.
  Dependency injection via `fetchImpl` keeps tests offline.

### Deliberately NOT yet done (v0.2.0 scope)

- Hermes upstream `gateway/platforms/dispatch.py` adapter — the Python
  side of the Mode B handshake lives in the PyPI package and needs a
  ~80-line `BasePlatformAdapter` subclass that wires the `/dispatch`
  + `/health` routes into Hermes's gateway-mode aiohttp server. See
  [investigation report in v1.9.0 design docs](../../../docs/version190/)
  for the feasibility analysis (no Hermes fork required).
- Integration test against a running Hermes gateway mode instance —
  requires the Python side to land first.
- Integration into `@prismer/runtime`'s `autoRegisterAdapters()` —
  kept separate for now so daemon can opt in without a hard dep.

### Not owned

- CLI shim fallback when Mode B isn't available: that's
  `@prismer/runtime`'s `createCliAdapter` + `auto-register.ts`.
- Outbound PARA events from Hermes: that's
  `prismer-adapter-hermes` on PyPI.
