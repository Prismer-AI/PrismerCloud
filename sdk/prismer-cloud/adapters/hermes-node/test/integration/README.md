# Mode B end-to-end integration test

`mode-b-e2e.mjs` drives the full PARA Mode B round-trip against a **real LLM endpoint** and the **Python dispatch server** running in a separate process. It is intentionally NOT wired into any `npm test` runner — the unit tests in `../` already cover the Node transport logic in isolation with test doubles; this script checks the two halves line up on the wire.

## When to run

- Accepting a new release of `@prismer/adapter-hermes` (this package)
- Accepting a new release of `prismer-adapter-hermes` on PyPI (the `[dispatch]` extra)
- Regression after any change to `gateway/platforms/api_server.py` upstream that could affect the AIAgent construction shape
- Smoke-testing a new LLM provider / model pool before adding it to the catalog

## What it verifies

| Phase | Check |
|------|-------|
| 1 | `detectHermesLoopback()` gets a 2xx from `GET /health` on the loopback |
| 2 | `autoRegisterHermes(registry)` installs the adapter with `transport=mode_b_http_loopback` |
| 3 | `adapter.dispatch({prompt: "…TASK_C_TEXT_OK"})` returns `ok=true` with the token in `output` |
| 4 | `adapter.dispatch({prompt: "…echo TASK_C_TOOL_OK"})` invokes the terminal tool and the LLM relays the output |
| 5 | `~/.prismer/para/events.jsonl` accumulates the full PARA sequence (register, 2× session lifecycle, tool.post ok=true) |
| 6 | `adapter.health()` is still healthy after traffic |

## Prerequisites

### 1. Python side — install + configure

```bash
python3.11 -m venv ~/hermes-venv
source ~/hermes-venv/bin/activate
pip install 'prismer-adapter-hermes[dispatch]>=0.2.0'  # pulls aiohttp + hermes-agent
```

Create an isolated HERMES_HOME so the test doesn't pollute a real user config:

```bash
export HERMES_E2E_HOME=/tmp/hermes-e2e
mkdir -p "$HERMES_E2E_HOME/plugins/prismer-adapter"

# plugin manifest
cat > "$HERMES_E2E_HOME/plugins/prismer-adapter/plugin.yaml" <<'YAML'
name: prismer-adapter
version: 0.2.0
description: "Prismer PARA adapter delegate for the dispatch server."
hooks:
  - pre_tool_call
  - post_tool_call
  - pre_llm_call
  - post_llm_call
  - on_session_start
  - on_session_reset
  - on_session_finalize
  - subagent_stop
YAML

cat > "$HERMES_E2E_HOME/plugins/prismer-adapter/__init__.py" <<'PY'
from prismer_adapter_hermes.register import register as _register

def register(ctx):
    _register(ctx)
PY

cat > "$HERMES_E2E_HOME/config.yaml" <<'YAML'
plugins:
  enabled:
    - prismer-adapter
YAML
```

### 2. Launch the dispatch server

```bash
export HERMES_E2E_HOME_DIR=/tmp/hermes-e2e-home
mkdir -p "$HERMES_E2E_HOME_DIR"

HOME="$HERMES_E2E_HOME_DIR" \
HERMES_HOME="$HERMES_E2E_HOME" \
OPENAI_API_KEY="<your-key>" \
OPENAI_API_BASE_URL="<your-endpoint>" \
AGENT_DEFAULT_MODEL="<your-model>" \
HERMES_ACCEPT_HOOKS=1 \
prismer-hermes-serve --port 8765
```

Verify: `curl http://127.0.0.1:8765/health` → `{"status": "ok", "adapter": "hermes", "version": "0.2.0"}`.

### 3. Node side — build this package

```bash
cd sdk/prismer-cloud/adapters/hermes-node
npm install
npm run build          # produces dist/ that mode-b-e2e.mjs imports
```

## Running

```bash
# From the package root:
PRISMER_PARA_EVENTS_FILE=/tmp/hermes-e2e-home/.prismer/para/events.jsonl \
  node test/integration/mode-b-e2e.mjs
```

## Configuration env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `HERMES_MODE_B_PORT` | `8765` | Port the dispatch server is listening on |
| `PRISMER_PARA_EVENTS_FILE` | `$HOME/.prismer/para/events.jsonl` | Events file to inspect. Override when the server was launched with an isolated `HOME`. |

## Expected output

On success the script exits 0 and prints a summary table. Each phase logs its own banner + key data so a failure localises itself. Typical LLM round-trip latency:

- text-only dispatch: ~10s
- tool-using dispatch: ~20-25s

## On failure

All 6 phases use `process.exit(1)` with a pointed error message. Common causes:

- `PHASE 1 failed: refused` → dispatch server not running, wrong port
- `PHASE 1 failed: timeout` → server up but hung; check `/tmp/hermes-serve.log`
- `PHASE 3/4 ok=false` → upstream LLM returned an error; inspect `res.error`; typical cause is exhausted credits or wrong API key
- `PHASE 5 missing turn.end` → plugin registration didn't happen before the dispatch; the server log should say `registered prismer-adapter-hermes vX.Y.Z with hermes PluginManager`
- `PHASE 6 unhealthy` → server crashed mid-test (very rare)

## Why not in CI yet

This test requires:

- a reachable LLM endpoint (network dependency)
- an API key (secret)
- ~30-60s wall-clock per run (slow for PR gate)

Track the gating plan in v0.1.1 of this package — the shape is a weekly scheduled CI job on a runner with secrets, not a per-commit gate.
