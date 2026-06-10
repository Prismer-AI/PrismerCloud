# Integration Tests

End-to-end harness for the IM / Workspace / Skill / Task / Sync API surface
(release201/07–18). Each test makes **real HTTP calls** to a locally running
Next.js + IM server and writes **real rows** into MySQL — there is no mocking
layer between the test and the production code path.

This harness is additive: it lives alongside the existing vitest unit suite
(`vitest.config.ts`) and the `src/im/tests/acp-*.test.ts` standalone runners,
and is **not** a replacement for either.

## Prerequisites

The harness drives a live server — it does not start one.

```bash
# 1. Start the dev stack (MySQL 8 on :3307, Nacos, etc.)
npm run dev:stack

# 2. Start Next.js + embedded IM Hono server
npm run dev                # → http://127.0.0.1:3000

# 3. (separate terminal) run integration tests
npm run test:integration
```

The harness reads `TEST_TARGET` (default `http://127.0.0.1:3000`) — point it
at a remote env to smoke-test e.g. `cloud.prismer.dev`, but be aware that
test data will be written to that env's database.

## Running

```bash
# One-shot run (CI mode)
npm run test:integration

# Watch (rerun on edit)
npm run test:integration:watch

# Specific suite
npx vitest run --config vitest.integration.config.ts src/im/integration-tests/_smoke/harness-health.test.ts
```

## Architecture

```
src/im/integration-tests/
├── _helpers/
│   ├── env.ts            ← TEST_TARGET / TEST_DB_URL / TEST_TIMEOUT_MS
│   ├── http.ts           ← api() wrapper (real fetch, optional expectStatus)
│   ├── bootstrap.ts      ← createTestUser, createTestWorkspace, bootstrapSuite
│   ├── cleanup.ts        ← deleteTestWorkspace (hard-delete cascade)
│   ├── sse.ts            ← subscribeSSE (Phase 2F realtime)
│   └── index.ts          ← public barrel — always import from here
├── _smoke/
│   └── harness-health.test.ts
└── (Phase 2+) suites land under topic folders, e.g. tasks/, skills/, sync/
```

### `bootstrapSuite(suiteName)`

Standard 4-actor fixture used by most suites:

| Actor      | Role  | Inside workspace? |
| ---------- | ----- | ----------------- |
| `owner`    | human | yes (creator)     |
| `member`   | human | yes (member role) |
| `observer` | human | yes (member role) |
| `outsider` | human | **no**            |

Plus one `workspace` owned by `owner`. Member-add is best-effort — if the
endpoint shape changes, the suite returns the actors and the test can add
explicitly.

`ctx.cleanup()` runs the hard-delete cascade endpoint (commit `cef45d0a`).
Always call it in `afterAll`/`afterEach` — even on test failure, otherwise
data accumulates in dev MySQL.

### `api(method, path, opts)`

- Paths starting with `/api/` are used verbatim.
- Bare paths get prefixed with `/api/im` (default).
- `opts.actor` automatically sets `Authorization: Bearer <token>`.
- `opts.expectStatus` throws `IntegrationError` on mismatch, capturing the
  response body for the failure log.

### Why is the harness slow / why can't I parallelise?

- `pool: 'forks'` isolates suite state across processes (no module
  singletons leaking between suites).
- `fileParallelism: false` serialises suites — necessary today because some
  endpoints write to globally-uniqued tables (e.g. workspace slug) and the
  default test target is a single MySQL instance. Once the harness gains
  per-suite database isolation we can flip this back on.

## Gotchas

- **Turbopack does not HMR the embedded IM Hono server.** If you change code
  under `src/im/`, you must `Ctrl+C` and restart `npm run dev`. Otherwise the
  harness exercises the stale router.
- **Workspace slug clashes** — each suite calls `uniqSlug()` which mixes a
  per-process counter, the timestamp, and 4 random chars. Across machines
  this is collision-safe for our purposes; if you see 409s on workspace
  create, check `pool: 'forks'` is still on.
- **Cleanup vs deletedAt** — the hard-delete endpoint sets `deletedAt` and
  cascades to children. If a test expects to find soft-deleted state, run
  it before `ctx.cleanup()`.
- **Auth fallback** — `createTestUser` first tries `POST /api/im/register`
  (the optional-auth public endpoint). If that returns 409, it falls back
  to `POST /api/im/users/login`. Custom auth flows should bypass this
  helper and call `signToken()` directly via a future helper.

## Out of scope (Phase 1)

- Daemon ↔ cloud protocol verification — needs a separate `prismer daemon`
  process. Tracked in release201/16.
- Frontend UI tests — needs Playwright + browser harness. Tracked
  separately as `npm run test:e2e:browser`.
- Cross-env reachability — only the local dev stack is supported as the
  default target. Pointing at test/prod works but requires a valid
  `PRISMER_API_KEY_TEST`/`PRISMER_API_KEY` and is currently caller-owned.
