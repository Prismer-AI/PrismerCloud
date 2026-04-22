## v1.9.0 (2026-04-19)

### Fixed — **Plugin entry compatible with openclaw 2026.4.15 loader** (v1.9.0 closure §14.4 gap N2)

**Problem:** openclaw's plugin loader (`jiti(candidate.source)` in `dist/plugins/loader.js`) evaluates our `index.ts` eagerly, including ALL static `import` statements. The v1.9.0 entry added:

- `import { registerParaAdapter } from "./src/para/register.js"`
- `import { startModeBBridge } from "./src/para/mode-b-bridge.js"`

Those modules transitively import `openclaw/plugin-sdk/hook-runtime` (a subpath that isn't listed in openclaw's `package.json#exports`) and `@prismer/adapters-core` / `@prismer/wire` (workspace packages that aren't published to npm at v1.9.0). When either fails to resolve, jiti throws during the top-level import pass, `moduleExport` stays `undefined`, and openclaw's `resolvePluginModuleExport()` returns `{}` — surfaced by the loader as the generic "missing register/activate export". End users saw an error completely unrelated to the actual cause.

**Fix (index.ts):**
- Demote PARA and Mode-B imports from static to **dynamic** `await import(...)` inside `register()`. A resolver failure is now caught by a local `try/catch` and logged as non-fatal; the channel always registers.
- Wrap both PARA + Mode-B bootstrap in fire-and-forget IIFEs so `register()` stays synchronous (openclaw's loader warns when register returns a promise).
- Add `activate(api)` alias on the default export and `export const register` / `export const activate` named exports so any interop path the loader takes resolves to a function.
- Bump declared `version: "1.9.0"` on the exported plugin object so `plugins list` and the diagnostic chain show the right version.

**Verification:**
```
$ openclaw plugins list | tail
│ Prismer │ prismer │ loaded │ global:prismer/index.ts │ 1.9.0 │
$ openclaw plugins doctor
No plugin issues detected.
```
The `[openclaw-para] PARA adapter registration skipped (non-fatal)` and `[openclaw-mode-b] daemon notify failed (non-fatal)` lines are expected graceful-degrade paths — they fire only when the daemon or PARA workspace packages aren't reachable, which is the common case for end users who install only the channel.

**Tests:** `tests/channel.test.ts` gains two N2-regression cases covering `mod.register`, `mod.default.register`, `mod.default.activate`, and the "PARA/Mode-B imports don't block module evaluation" invariant. Existing 116 test cases unaffected.

### Fixed — **PARA hooks fire during `openclaw agent --local`** (v1.9.0 Docker closure report break #5)

**Problem:** `openclaw agent --local` runs in a gateway-less mode where the `InternalHookEvent` surface (`api.registerHook`, which is what v1.8.0 wired) never fires. Result: `~/.prismer/para/events.jsonl` stayed empty for one-shot agent runs even though the channel plugin WAS loading (LLM responses worked fine via the channel tool surface).

**Fix:** `src/para/register.ts` now wires PARA events through BOTH OpenClaw hook surfaces:
- `api.registerHook(event, handler)` — gateway-mode InternalHookEvent surface (unchanged from 1.8.x)
- `api.on(hookName, handler)` — typed plugin-hook registry, fires in BOTH gateway and agent-only modes

7 new typed hooks wired:

| OpenClaw typed hook | PARA event |
|---|---|
| `gateway_start` | `agent.register` |
| `session_start` | `agent.register` (first-time) + `agent.session.started` |
| `session_end` | `agent.session.ended` |
| `before_prompt_build` | `agent.prompt.submit` |
| `agent_end` | `agent.turn.end` / `agent.turn.failure` |
| `before_tool_call` | `agent.tool.pre` |
| `after_tool_call` | `agent.tool.post` / `agent.tool.failure` |

**Supporting changes:**
- `src/para/adapter.ts` — 7 new `onSessionStart` / `onBeforePromptBuild` / etc. handler methods. Existing 13 InternalHookEvent handlers unchanged.
- `src/para/plugin-hook-types.ts` — local shims for upstream `PluginHook*` types (not re-exported from `openclaw/plugin-sdk` top-level; structural types kept a subset of the upstream shape).
- Graceful degradation: if `api.on` is absent (older OpenClaw hosts), adapter logs to stderr and continues with InternalHookEvent-only coverage. Individual `api.on` calls are try/catch-wrapped so unknown hook names (version skew) don't abort registration.

**Non-goals:**
- Did NOT touch `sdk/prismer-cloud/claude-code-plugin` — claude-code already works via its hooks.json.
- Did NOT remove the `hookConfigPath` write in runtime `install-agent.ts` for openclaw — kept for smoke-test parity (`agent doctor` fingerprint check). Added a comment clarifying that OpenClaw ignores the file; real wiring is in-process.

### Fixed — **esbuild version mismatch in container**
- Pin `esbuild@0.27.7` as explicit devDependency to prevent host/binary version mismatch (`0.27.7` JS vs `0.27.3` native) in container builds
- Add `overrides.esbuild` to force all transitive copies (via vitest -> vite, openclaw -> tsx) to the same version
- Add `pretest` script: auto-runs `npm rebuild esbuild` if the native binary fails to load
- Root cause: `tsx` (dep of `openclaw`) declares `esbuild: ~0.27.0` (tilde range), allowing npm to resolve a different patch version for the native platform package in container environments with stale caches

### Added — **PARA Adapter Layer**

Implements the PARA (Prismer Agent Runtime ABI) adapter for OpenClaw per `docs/version190/03-para-spec.md` §4.6.1.  This is a pure observation layer — existing channel functionality (messaging, discovery, tools) is unchanged.

**New modules:**
- `src/para/adapter.ts` — `OpenClawParaAdapter` class with one method per §4.6.1 hook row
- `src/para/register.ts` — `registerParaAdapter()` wires adapter into `OpenClawPluginApi.registerHook()`
- `src/para/sink.ts` — `defaultJsonlSink`, `stableAdapterId`, `buildAgentDescriptor`

**New dependencies:**
- `@prismer/wire@0.1.0` — PARA event schemas (Zod ^3 peer)
- `@prismer/adapters-core@0.1.0` — event builders, `EventDispatcher`, `PermissionLeaseManager`

**Hook wiring — 11/13 wired (2 stubbed TODO):**
| OpenClaw hook | PARA event | Status |
|---|---|---|
| `gateway:startup` | `agent.register` | ✅ wired |
| `agent:bootstrap` | `agent.bootstrap.injected` | ✅ wired |
| `command:new` | `agent.command { commandKind: 'new' }` | ✅ wired |
| `command:reset` | `agent.command { commandKind: 'reset' }` | ✅ wired |
| `command:stop` | `agent.command { commandKind: 'stop' }` | ✅ wired |
| `command` | `agent.command { commandKind: 'other' }` | ✅ wired |
| `session:compact:before` | `agent.compact.pre` | ⏳ TODO: not in OpenClaw SDK yet |
| `session:compact:after` | `agent.compact.post` | ⏳ TODO: not in OpenClaw SDK yet |
| `session:patch` | `agent.config.changed { configSource: 'skills' }` | ✅ wired |
| `message:received` | `agent.channel.inbound` | ✅ wired |
| `message:transcribed` | `agent.channel.transcribed` | ✅ wired |
| `message:preprocessed` | `agent.channel.preprocessed` | ✅ wired |
| `message:sent` | `agent.channel.outbound.sent` | ✅ wired |

**`openclaw.plugin.json`:** added `prismer.tiersSupported: [1,2,3]` and `prismer.paraVersion: "0.1.0"`.

**Tests:** 55 new PARA tests (adapter 21, register 17, sink 17); all 145 tests pass.

**Zod version trade-off (documented):** `@prismer/openclaw-channel` uses `zod ^4.x` for channel code while `@prismer/wire` uses `zod ^3.x` for PARA schemas.  Both coexist in separate node_modules subtrees.  The adapter passes raw event objects to `EventDispatcher.emit()` which validates with wire's internal zod v3 — no cross-version calls from adapter.ts.  The `metadata` field on `agent.channel.inbound` is omitted (the `z.record(z.unknown())` zod v3 syntax fails with non-empty records under zod v4 peer resolution; tracked for fix in wire v0.2.0).

---

## v1.8.2 (2026-04-13)

- Version bump for 1.8.2 coordinated release.

---

## v1.8.1 (2026-04-10)

### Fixed — **Documentation**
- README prerequisite added: `npm i -g openclaw` before `openclaw plugins install @prismer/openclaw-channel` (the openclaw CLI isn't assumed to be installed).
- Version bump to 1.8.1 coordinated release.

---

## v1.8.0 (2026-04-04)

### Added — **Workspace Projection Renderer**
- `renderer.ts`: Full OpenClaw workspace bootstrap renderer — converts workspace superset (strategies, personality, identity, memory, extensions) into local file tree
  - Strategies rendered as `skills/<slug>/SKILL.md` with frontmatter + body (signals, preconditions, success rate)
  - Bootstrap files: SOUL.md (personality), IDENTITY.md (DID + capabilities), MEMORY.md, AGENTS.md, USER.md
  - Per-file truncation (20KB) and total budget (150KB) to prevent workspace bloat
  - Checksum-based meta for incremental sync
- `prismer_workspace_sync` tool (15th tool): Sync full workspace from Prismer Cloud to local OpenClaw workspace directory
  - Fetches strategies, memory, personality, identity, and extensions slots
  - Writes to `~/.openclaw/workspace/` (or `workspace-<profile>` for multi-profile)
  - Supports `OPENCLAW_WORKSPACE` env var override and `OPENCLAW_PROFILE` for named profiles
- `scope` parameter added to `prismer_evolve_analyze`, `prismer_evolve_record`, `prismer_evolve_report` for data isolation across projects/teams
- Total tools: 15 (was 14 in v1.7.3)

## v1.7.4 (2026-04-01)

### Added — **Evolution Loop Enhancement**
- Evolution hints now include explicit tool call guidance: after resolving an issue, agents are prompted to call `prismer_evolve_record` and `prismer_memory_write`
- When no gene matches, agents are prompted to call `prismer_evolve_report` to teach the system
- Parity test suite: 23 integration tests (Rust baseline)

### Changed
- Version alignment with platform v1.7.4
# @prismer/openclaw-channel — Changelog

## v1.7.3 (2026-03-27)

### Added
- LICENSE file (MIT)
- CHANGELOG.md

## v1.7.2 (2026-03-15)

### Added
- **prismer_evolve_distill** tool — trigger server-side pattern extraction
- **prismer_evolve_browse** tool — browse public genes with pagination
- **prismer_evolve_import** tool — import public gene to agent's collection
- **prismer_memory_write** / **prismer_memory_read** / **prismer_recall** — 3 memory tools
- **prismer_discover** / **prismer_send** — agent discovery + messaging
- Scope parameter support across all evolution tools
- Total tools: 14 (was 8 in v1.7.1)

### Changed
- `prismer_evolve_analyze` supports SignalTag[] format
- `prismer_evolve_record` accepts optional metadata
- Gateway WebSocket reconnection improved

## v1.7.1 (2026-03-07)

### Added
- Initial channel registration + gateway
- 8 tools (load, parse, evolve_analyze, evolve_record, evolve_report, gene_create, discover, send)
