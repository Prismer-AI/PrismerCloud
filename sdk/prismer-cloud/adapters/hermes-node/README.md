# @prismer/adapter-hermes

Runtime-side Mode B HTTP loopback adapter for [NousResearch Hermes](https://github.com/NousResearch/hermes-agent), used by the Prismer runtime daemon (`@prismer/runtime`).

## Role in the Prismer PARA bridge

Hermes <-> Prismer integration has two halves:

| Side | Package | Role |
|------|---------|------|
| **Node (runtime)** | **`@prismer/adapter-hermes`** (this package) | Daemon calls `dispatch()` on this adapter → HTTP POST to Hermes loopback |
| **Python (Hermes plugin)** | `prismer-adapter-hermes` on PyPI | (v0.1.x) translates Hermes hooks to PARA events; (v0.2.0+) hosts `/dispatch` HTTP server inside Hermes gateway mode |

This package does NOT depend on the Python side at install time — they communicate via the HTTP contract documented in [`docs/version190/22-adapter-integration-contract.md`](../../../docs/version190/22-adapter-integration-contract.md) §3.2 Mode B.

## Install

```bash
npm install @prismer/adapter-hermes
# Requires @prismer/runtime (peer dep)
```

## Usage — daemon startup hook

```ts
import { autoRegisterHermes } from '@prismer/adapter-hermes';
import { AdapterRegistry } from '@prismer/runtime';

const registry = new AdapterRegistry();
// … other adapters register via autoRegisterAdapters() (CLI shims) …

const result = await autoRegisterHermes(registry);
if (result.installed) {
  log.info(`Hermes Mode B adapter installed at ${result.loopbackUrl}`);
} else {
  log.debug(`Hermes Mode B not reachable (${result.reason}); using CLI shim fallback`);
}
```

`autoRegisterHermes()` probes `http://127.0.0.1:8765/health` (configurable). If reachable, it replaces any previously-registered `hermes` adapter (typically the CLI shim) with a Mode B adapter whose `dispatch()` is an HTTP POST to `http://127.0.0.1:8765/dispatch`.

## Usage — manual construction

```ts
import { buildHermesAdapter } from '@prismer/adapter-hermes';

const adapter = buildHermesAdapter({ port: 19876 });
registry.register(adapter);
```

## Dispatch wire format

```
POST http://127.0.0.1:<port>/dispatch
Content-Type: application/json

{
  "taskId": "t_abc",
  "capability": "code.write",
  "prompt": "...",
  "stepIdx": 2,
  "deadlineAt": 1776756848133,
  "metadata": { /* free-form */ }
}

→ 200 OK
{
  "ok": true,
  "output": "...",
  "artifacts": [{ "path": "...", "bytes": 123 }],
  "metadata": { /* free-form */ }
}
```

On non-2xx / JSON parse failure / network error, `dispatch()` returns:

```ts
{ ok: false, error: "mode_b_<status>:<detail>" | "mode_b_invalid_response:<...>" | "mode_b_network:<...>" }
```

## Health check

```
GET http://127.0.0.1:<port>/health → 200
```

`adapter.health()` returns `{ healthy: true }` on 2xx, `{ healthy: false, reason: "loopback_<status>" }` otherwise.

## Security

- Only `http://127.0.0.1:<explicit-port>` is accepted as the loopback URL. `localhost`, other hosts, HTTPS, and any non-empty pathname/query/hash are rejected at construction time. This prevents a compromised plugin from pointing the daemon at a remote or locally-proxied service.
- No credentials or secrets are sent in the loopback request. Hermes is expected to run under the same user identity as the daemon.

## Compatibility

| `@prismer/adapter-hermes` | `@prismer/runtime` | `prismer-adapter-hermes` (PyPI) | Hermes |
|---|---|---|---|
| 0.1.x | ≥ 1.9.0 | ≥ 0.2.0 (for /dispatch) | ≥ 0.10.0 gateway mode |

For v0.1.x, the PyPI package does **not yet** ship the `/dispatch` server — that arrives in 0.2.0 alongside the Hermes `gateway/platforms/dispatch.py` adapter. Until then this Node package produces a `not_found:refused` result at auto-register time and daemon falls back to the CLI shim.

## License

MIT
