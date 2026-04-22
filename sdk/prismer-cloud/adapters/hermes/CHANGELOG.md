# Changelog — prismer-adapter-hermes

## v0.2.0 (2026-04-21)

### Added — Mode B HTTP dispatch server (standalone process)

New subpackage `prismer_adapter_hermes.dispatch` ships a standalone
aiohttp server that exposes:

- `POST /dispatch` — accepts `{taskId, capability, prompt, stepIdx, deadlineAt}`
  and routes the request to a fresh Hermes `AIAgent.run_conversation()`.
  Returns `{ok, output, artifacts, metadata}` on success, `{ok:false, error}`
  on failure (always HTTP 200 so circuit breakers inspect the body).
- `GET /health` — `{status: "ok", adapter: "hermes", version: "0.2.0"}`.

New entry point `prismer-hermes-serve` (wired via `[project.scripts]`) starts
the server, reads `OPENAI_API_KEY` / `OPENAI_API_BASE_URL` /
`AGENT_DEFAULT_MODEL` from env, and registers the PARA plugin with Hermes's
module-level `PluginManager` BEFORE accepting requests — so every dispatched
turn emits PARA events via the default JSONL sink without touching
`config.yaml::plugins.enabled`.

### Design — NOT a Hermes gateway fork

Deliberately does NOT modify upstream Hermes `gateway/platforms/`. The
alternative (shipping an `APIServerAdapter`-style platform inside Hermes)
would have dragged in the NousResearch coordination / model-pool machinery
we don't need. By running a dedicated process that imports `AIAgent`
directly, we stay version-tolerant across Hermes releases and keep the
PARA adapter the sole cross-cutting concern.

### Added — dependency surface (optional)

- New optional extra `[dispatch]` pulls `aiohttp>=3.9` and `hermes-agent>=0.10`.
- Core `prismer_adapter_hermes` package still imports with zero deps —
  the dispatch subpackage lazy-imports both so 0.1.x consumers (sink-only
  users, CI pipelines) see no new install surface.

### Added — tests

- `tests/test_dispatch_server.py` (13 tests) — aiohttp handler contract:
  request routing, validation (malformed JSON, missing taskId/prompt,
  non-object body), runner exception → `ok:false`, sync/async runner
  support, env-derived config precedence.
- `tests/test_agent_runner.py` (10 tests) — `run_one()` behaviour with a
  `_FakeAgent` double: session id derivation, metadata shape, error
  mapping for `failed=True` / missing `final_response` / runner raises.
- `tests/test_real_dispatch_e2e.py` (2 tests, gated on
  `RUN_REAL_DISPATCH_E2E=1`) — spins up the dispatch app in-process via
  `AppRunner` on 127.0.0.1:8765, POSTs a real prompt to a real model
  (`us-kimi-k2.5` on `http://34.60.178.0:3000/v1`), and asserts both the
  response envelope and the full PARA event sequence
  (`agent.session.started` → `prompt.submit` → `llm.pre/post` →
  `turn.end` + tool_pre/post for the shell variant).

### Version bump

0.1.2 → 0.2.0. The dispatch surface is a genuinely new API; no changes
to existing `register()` / `HermesParaAdapter` behaviour.

## v0.1.2 (2026-04-21)

### Fixed — every successful tool call was misclassified as failure

`on_post_tool_call` checked `"error" in parsed` (key membership) instead
of the value's truthiness. Hermes tools (`terminal`, `read_file`, etc.)
include `error` unconditionally in their result dict, set to `None`/`""`
on success. Result: 100 % of successful tool calls in v0.1.0/v0.1.1
emitted `agent.tool.failure` with empty error string, while
`agent.tool.post` was never emitted.

Caught only by running real Hermes against a real LLM endpoint
(http://34.60.178.0:3000/v1, model `us-kimi-k2.5`) with a tool-using
prompt. The repro test now lives at
`tests/test_adapter.py::TestPostToolCall::test_terminal_success_shape_is_not_misclassified_as_failure`
and uses the actual `terminal_tool.py:result_data` shape verbatim.

### Known limitations (deferred to v0.1.3)

- `agent.tool.pre` fires twice per tool call: once from
  `get_pre_tool_call_block_message()` (Hermes's block-check path,
  with empty `tool_call_id`) and once from `model_tools.py:503`'s
  observer fire (with populated `tool_call_id`). This is an upstream
  artifact of two distinct call sites; deduping at the adapter would
  require either dropping empty-callId events (hides the block check)
  or content-keying on `(tool_name, args, session_id)` (collides with
  legitimate back-to-back identical calls). Currently emitting both.

## v0.1.1 (2026-04-21)

### Fixed — adapter was a 100 % no-op in real Hermes (bug in v0.1.0)

`v0.1.0` was structurally wrong against the real Hermes plugin API. None of the
14 hooks ever fired. Root causes verified against `hermes_cli/plugins.py` in
NousResearch/hermes-agent v0.10.0:

- **Hook subscription API mismatch.** `register.py` called `ctx.on(name, cb)`.
  The real Hermes `PluginContext` exposes `ctx.register_hook(name, cb)` — no
  `.on()` method exists anywhere in the codebase. All 14 registrations raised
  `AttributeError` and were silently swallowed by the try/except.
- **Callback signatures wrong.** Hermes dispatches via
  `invoke_hook(name, **kwargs)` → `cb(**kwargs)`. Our methods took a single
  positional `ctx: dict` parameter, which would `TypeError` every invocation
  even if registration had worked. The unit tests fed hand-crafted dicts, so
  the signature bug went undetected.
- **8 of 14 hook names were Gateway-only events, not Plugin hooks.**
  `gateway:startup`, `session:start`, `session:end`, `session:reset`,
  `agent:start`, `agent:step`, `agent:end`, `command:*` all belong to the
  separate Gateway event dispatcher (`~/.hermes/hooks/*/HOOK.yaml` +
  `handler.py`), not the Plugin dispatcher. They will never fire from a
  `register(ctx)` entry point regardless of subscription API.
- **`tool_call_id` was read as `call_id`.** Hermes kwargs use `tool_call_id`
  (see `hermes_cli/plugins.py:856`); we read `ctx.get("call_id")`, so every
  `agent.tool.pre/post` event had `callId=""`.

### Changed

- All `HermesParaAdapter.on_*` methods now accept `**kwargs` matching Hermes's
  real invoke-time shape. Gateway-only method stubs (`on_gateway_startup`,
  `on_agent_start`, `on_agent_step`, `on_agent_end`, `on_command`) remain on
  the class for a future Gateway-side `handler.py`, but are no longer auto-
  wired.
- `_HOOK_MAP` wires 8 Plugin hooks (subset of `VALID_HOOKS`):
  `pre_tool_call`, `post_tool_call`, `pre_llm_call`, `post_llm_call`,
  `on_session_start`, `on_session_reset`, `on_session_finalize`,
  `subagent_stop`.
  `on_session_end` is deliberately NOT auto-wired: upstream fires it at
  the end of every `run_conversation()` call (per-turn, see
  `run_agent.py:11801` comment), so wiring it would either dedup turns
  2..N away or spam a per-turn `agent.session.ended` while the session
  is still alive. `on_session_finalize` is the authoritative session-end
  signal. The method is kept on the class for manual / gateway-side use.
- `register.py` now prefers `ctx.register_hook`, falls back to `ctx.on` for
  test doubles, and emits `agent.register` immediately at load time (since
  Hermes has no plugin-hook equivalent of `gateway:startup`).

### Added

- `subagent_stop` → `agent.subagent.ended` (full delegation lifecycle; was
  completely missing before). Normalises `child_status="interrupted"` →
  `"cancelled"` so wire validation passes.
- `on_session_finalize` → `agent.session.ended` with `reason="finalize"`.
- `make_subagent_ended()` event builder.
- `HermesParaAdapter(context_provider=...)` — callable invoked on
  `pre_llm_call` whose return string becomes the cache-safe inject payload
  (`{"context": "..."}` returned to Hermes). `set_context_provider()` lets
  callers install it post-construction. Replaces the non-functional
  `additional_context` keyword on `on_pre_llm_call`.
- `tests/test_real_hermes.py` — end-to-end integration against a real Hermes
  checkout, skipped unless `HERMES_REPO` env var points at one. Runs the same
  assertion path Hermes itself uses (`PluginManager.invoke_hook(**kwargs)`),
  so the class of bug above cannot slip through again.
- Concurrency hardening for the dedup set: guarded by `threading.Lock`,
  bounded via `collections.deque`, and 8-thread `session.started` test
  covers the race window. (Upstream `tools/delegate_tool.py:927` comment
  confirms `subagent_stop` is serialised on the parent thread — the lock
  is defence-in-depth against multiple Hermes instances sharing the
  adapter object rather than correcting a known upstream race.)
- Lazy home-dir resolution in `sink.py` / `descriptor.py` — `Path.home()` is
  read on every write instead of frozen at module import, so env-based tests
  and daemon identity swaps work.
- `sink.py` takes `fcntl.flock(LOCK_EX)` around each JSONL append on POSIX,
  making concurrent writes from multiple processes (daemon sidecar, other
  adapters) or threads safe for arbitrary event sizes. Previously the
  `O_APPEND` atomicity guarantee only held for writes ≤ PIPE_BUF (~4 KB),
  which Hermes `execute_code` / `patch` tool args can exceed. Regression
  test `test_concurrent_large_writes_do_not_interleave` drives 4 threads
  × 100 iterations × 8 KB payloads and asserts every line parses as JSON.
- `make_subagent_ended` omits `parentSessionId` when the value is `None`
  or empty string. Upstream `delegate_tool.py:933` passes the value via
  `getattr(parent_agent, "session_id", None)`, which can legitimately be
  `None`; emitting `parentSessionId=""` pollutes downstream PARA consumers
  that distinguish absence from empty.
- Session-lifecycle handlers validate the event BEFORE claiming the dedup
  slot, so a validation failure no longer suppresses a subsequent
  well-formed retry. (Low-probability in practice — session event payloads
  are simple — but the prior ordering had a latent lost-event window.)

### Still not wired (deliberate, tracked for future versions)

- `transform_terminal_output`, `transform_tool_result` — tool-result rewriters;
  no PARA event mapping yet.
- `pre_api_request`, `post_api_request` — provider-level hooks; overlap with
  `pre/post_llm_call` for MVP observability.
- Gateway-side events (cron triggers, channel inbound/outbound, batch
  progress) — require a companion `~/.hermes/hooks/<name>/handler.py` and
  are part of the broader v1.9.1 Hermes coverage plan.

### Known limitations (tracked for v0.1.2)

- `agent.subagent.started` asymmetry: Hermes has no pre-delegation plugin
  hook, so we emit `agent.subagent.ended` on child completion but nothing
  at child start. Upstream would need a `subagent_start` hook (or we'd
  infer it from the `pre_llm_call` `platform="subagent"` branch).
- Tool call duration: Hermes's plugin hooks don't carry timing, so
  `agent.tool.post`/`agent.tool.failure` currently emit `durationMs=0.0`.
  v0.1.2 plan: track `time.monotonic()` keyed on `tool_call_id` in
  `on_pre_tool_call` and diff in `on_post_tool_call`.
- `agent.register` re-emission on every process restart: PARA runtime
  semantics for repeated registration under a stable ID are not yet
  pinned down. If the runtime inflates telemetry on repeated registers,
  we should guard on descriptor-cache mtime.
- CI without `HERMES_REPO` silently skips `tests/test_real_hermes.py`.
  A dedicated CI job with a pinned Hermes tag is the obvious fix.

## v0.1.0 (2026-04-15) — ⚠️ superseded by v0.1.1 (no-op in real Hermes)

Initial release. See v0.1.1 for the full list of bugs that made it unusable.
Do not pin to 0.1.0.
