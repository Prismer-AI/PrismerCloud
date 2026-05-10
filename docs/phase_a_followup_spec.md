# Phase A Follow-Up Spec and Plan

> Status: follow-up execution spec
> Baseline commit: `c8ccd86 feat: wire phase a daemon admission`
> Date: 2026-05-09
> Related docs:
> - `docs/PHASE_A_PLAN.md`
> - `docs/PHASE_A_PLAN_V2.md`
> - `docs/phase_a_protocol_contract.md`
> - `docs/phase_a_local_run.md`

## 1. Purpose

Phase A must move from the current admission/setup baseline to a publishable local-agent execution loop:

```text
new user setup -> local daemon online -> cloud task dispatch -> local execution -> logs/progress -> approval gate -> recoverable completion
```

The current baseline already wires the W2/W3 admission pieces: runtime signing keys, key rotation/revocation APIs, setup handoff, task idempotency/state version, and basic server/API/UI smoke paths. This spec records the remaining work needed to make the system reliable enough for a Phase A core release.

## 2. Release Goal

A fresh user can run one setup command, see their local runtime online in the UI, dispatch a task to that runtime, approve or reject gated actions, and recover safely from retries, reconnects, and duplicate messages.

Release-level acceptance:

- `setup -> daemon online -> task executed` completes within 5-10 minutes on a fresh local environment.
- Runtime online/offline state is accurate enough for user-facing routing.
- Duplicate stateful messages do not cause duplicate task state transitions.
- Stale writes are rejected instead of overwriting newer task state.
- In-flight tasks survive daemon reconnect without lost terminal state.
- Approval decisions are authorized, auditable, and idempotent.
- Feature flags can roll back strict behavior without schema rollback.

## 3. Non-Goals for Phase A Core

- Full production multi-tenant scheduling optimization.
- Kubernetes deployment or autoscaling.
- Protobuf transport migration.
- Full Windows service parity, unless release time allows.
- Full Personal Assistant product polish. PA can ship after Phase A core if setup, dispatch, runner, and approval are stable.
- Four-language SDK parity for every new Phase A API. TypeScript must be complete; other SDKs can follow once the contract is frozen.

## 4. Current Baseline

Committed in `c8ccd86`:

- Runtime signing key API:
  - `POST /api/runtimes/signing-keys`
  - `POST /api/runtimes/signing-keys/rotate`
  - `DELETE /api/runtimes/signing-keys/[id]`
- Setup UI/API handoff:
  - `server/src/app/setup/page.tsx`
  - `server/src/app/api/runtimes/route.ts`
  - `sdk/prismer-cloud/typescript/src/cli.ts`
  - `install.sh`
- Protocol/signing utilities:
  - `server/src/lib/contracts/wsMessageSigning.ts`
  - `services/shared/identity/canonical.go`
  - `services/shared/identity/keystore.go`
- Task mutation hardening:
  - idempotency key support
  - state version helpers
  - response `ETag` / `X-State-Version`
- Local smoke coverage:
  - `/dashboard` loads
  - `/setup?daemon=1` loads
  - `/api/runtimes` returns authenticated 401 when unauthenticated

Validation already run on the baseline:

```bash
bash scripts/phase_a/schema_contract_guard.sh
cd services && go test ./...
cd server && npx tsx --test src/lib/phase-a/signing-keys.test.ts src/im/utils/task-state-version.test.ts src/lib/contracts/wsMessageSigning.test.ts src/lib/contracts/wsMessage.test.ts
cd server && npx tsc --noEmit --pretty false --incremental false --skipLibCheck
cd server && npm run build
cd sdk/prismer-cloud/typescript && npm run build
git diff --check
git diff --cached --check
```

## 5. Functional Spec

### 5.1 Runtime Admission

Requirements:

- `prismer setup --with-daemon` gets or verifies the user's API key.
- Setup derives or loads a stable DID/key for daemon admission.
- Setup registers the runtime public key through the server API.
- Setup writes daemon launch values into `~/.prismer/config.toml`.
- Daemon reads config values when explicit env vars are absent.
- Daemon sends signed `runtime.hello`.
- Orchestrator validates DID allowlist, join token, signing key, revoke state, timestamp skew, and payload hash when strict mode is enabled.
- Runtime appears in server/UI with online/offline status.

Failure behavior:

- Duplicate DID registration updates the existing runtime instead of creating conflicting rows.
- Revoked key is rejected.
- Expired or stale timestamp is rejected with a recoverable error.
- Missing strict-signature inputs degrade only when feature flags allow it.

Feature flags:

- `strict_signature`
- `runtime_ws_accepted`
- `daemon_auto_setup`

### 5.2 Task Dispatch

Requirements:

- Server task creation records a dispatch intent or equivalent retry-safe signal.
- Orchestrator matches pending tasks to online runtimes by capability.
- `task.push` is stateful and requires ack.
- Duplicate `task.push` does not create duplicate execution rows or duplicate terminal states.
- LISTEN/NOTIFY or realtime dispatch has polling fallback.
- In-flight tasks are re-discoverable after orchestrator restart.

Failure behavior:

- If no runtime matches, task stays pending with an explicit reason.
- If daemon disconnects mid-task, task becomes retryable or remains in a recoverable in-flight state.
- If dispatch event is lost, fallback polling dispatches the pending task within SLA.

Acceptance targets:

- UI create -> daemon receives `task.push` p95 <= 1.5s in local/small deployment.
- Pending task fallback dispatch <= 30s.
- Duplicate dispatch attempts update state once.

### 5.3 Execution Runner

Requirements:

- Daemon supports at least `noop` and one local CLI capability path.
- Runner passes context cancellation through to the child process.
- Runner enforces timeout and kills child process on expiry.
- Runner emits stdout/stderr/progress via `task.log_chunk` with stable stream IDs and monotonic seq.
- Runner sanitizes output, strips unsafe control characters, and caps chunk size.
- Runner prevents workdir escape and dangerous argument injection.
- Runner emits a single terminal `task.finished` or `task.rejected`.

Failure behavior:

- Timeout produces a clear failed/cancelled terminal state.
- Cancel is idempotent.
- Runner crash cannot produce both success and failure terminal states.
- Log retransmit after reconnect resumes from server committed seq.

Acceptance targets:

- 10,000 continuous log lines preserve seq with no gaps.
- Cancel during execution produces one terminal state.
- Path escape attempts are rejected.

### 5.4 WebSocket Idempotency and Replay

Requirements:

- Stateful messages use `(execution_id, state_version)` as the state transition key.
- Dedup insert and state mutation happen in one transaction when backed by SQL.
- Same `(execution_id, state_version)` with same payload returns dedup ack.
- Same `(execution_id, state_version)` with different payload returns collision error.
- Stale `state_version` is rejected.
- Stream messages use `(execution_id, stream_id, stream_seq)`.
- Daemon performs `stream.resume_request` after reconnect for tracked executions.
- Tokens and private key material never appear in logs.

Failure behavior:

- DB/state mutation failure rolls back dedup state.
- Replay outside allowed window is rejected for signed critical mutations.
- Legacy envelope support remains best effort and can be disabled later.

Acceptance targets:

- Replaying the same stateful message 100 times mutates state once.
- Payload divergence returns 409.
- Stale state returns a deterministic stale-state error.
- Forced token injection in logs is masked.

### 5.5 Approval Gate

Requirements:

- Daemon can request approval at execution time with `approval.request`.
- Server persists approval records with status `pending`, `approved`, `rejected`, or `expired`.
- UI/API can list pending approvals and decide approve/reject.
- Approval decision is authorized by approver identity or policy.
- `approval.decision` reaches the daemon and unblocks the waiting runner.
- Repeated decisions are idempotent.
- Rejection sets a deterministic task/execution state and audit log.

Failure behavior:

- Unauthorized decision is rejected and audited.
- Duplicate decision returns the existing result.
- Approval timeout leaves a recoverable state or fails according to policy.
- Feature flag can switch approval to record-only mode.

Feature flags:

- `approval_enforce`
- `approval_record_only`

Acceptance targets:

- Decision p95 <= 5s in local/small deployment.
- Unauthorized approval rejection rate = 100%.
- Duplicate approve/reject is idempotent.

### 5.6 Polymorphic Assignee

Requirements:

- New task flows prefer `creatorDid`, `assigneeDid`, and `assigneeType`.
- Existing `creatorId` and `assigneeId` remain readable during compatibility window.
- Migration script backfills DID fields where possible.
- Historical tasks that cannot map to DID are marked or exposed as `legacy`.
- Claim/close/list APIs use DID first and legacy fallback second.

Failure behavior:

- Missing DID does not cause 500 during compatibility window.
- `STRICT_DID_REQUIRED=false` restores legacy behavior.
- Migration supports dry run and rollback logs.

Acceptance targets:

- Backfill success rate is measured and reported.
- `assigneeType` non-null rate >= 99% for new tasks.
- Legacy tasks remain queryable.

### 5.7 One-Click Setup and Release

Requirements:

- `install.sh` supports dry-run, idempotent re-run, explicit `--with-daemon`, and clear failure output.
- Daemon artifacts have checksum/signature verification.
- macOS launchd and Linux systemd install/uninstall paths are documented and tested.
- Setup page shows runtime registration status and recoverable errors.
- Release notes include feature flags and rollback steps.

Failure behavior:

- Signature mismatch blocks install.
- Missing service permissions produce clear recovery instructions.
- Download failure does not leave partial executable state without diagnostics.

Acceptance targets:

- `bash install.sh --dry-run` passes.
- Running install twice does not corrupt config.
- Signed artifact verification failure exits non-zero.

### 5.8 Observability and E2E

Requirements:

- Add metrics or structured logs for runtime online count, dispatch latency, execution duration, approval latency, log lag, reconnect count, and failure reason.
- Add E2E tests for happy path and failure paths.
- Add release checklist and local runbook updates.

Acceptance targets:

- E2E happy path passes from clean SQLite/local setup.
- Failure matrix covers daemon crash, orchestrator restart, network partition, approval reject, stale state, replay, runner timeout, and cancel.
- Build and test gates are documented and runnable locally.

## 6. Execution Plan

### P0 - Reliability Base

Goal: finish the W3 reliability foundation before adding more product surface.

Tasks:

1. Implement orchestrator ack/dedup/state-version behavior.
   - Primary paths:
     - `services/orchestrator/internal/transport`
     - `services/orchestrator/internal/dispatcher`
     - `services/shared/proto`
     - `services/shared/db`
   - Acceptance:
     - duplicate stateful messages mutate state once
     - payload divergence returns collision error
     - stale state is rejected

2. Remove or harden token-in-query behavior for WS admission.
   - Primary paths:
     - `services/orchestrator/internal/transport`
     - daemon WS client package
   - Acceptance:
     - auth material is not logged
     - token/key redaction tests pass

3. Add dispatch fallback polling.
   - Primary paths:
     - `services/orchestrator/internal/dispatcher`
     - server task creation service
   - Acceptance:
     - simulated lost dispatch signal still dispatches pending task
     - no duplicate execution on repeated dispatch attempts

Verification gate:

```bash
cd /home/willamhou/codes/PrismerCloud && bash scripts/phase_a/schema_contract_guard.sh
cd /home/willamhou/codes/PrismerCloud/services && go test ./...
cd /home/willamhou/codes/PrismerCloud/server && npx tsx --test src/lib/contracts/wsMessage.test.ts src/lib/contracts/wsMessageSigning.test.ts
```

Rollback:

- Disable `idempotent_ws`.
- Disable strict protocol enforcement.
- Keep schema additions, roll back behavior only.

### P1 - Execution and Approval Loop

Goal: turn admission into a real task execution loop.

Tasks:

1. Complete daemon runner safety.
   - timeout, cancel, child process kill, output sanitize, chunk size caps
   - path/workdir boundary checks
   - one terminal state per execution

2. Complete log streaming and stream resume.
   - stable stream IDs
   - monotonic seq
   - `stream.resume_request` / `stream.resume_ack` for reconnect

3. Complete approval API and UI.
   - `GET /api/approvals`
   - approve/reject endpoints
   - pending approvals view
   - repeated decision idempotency
   - unauthorized decision audit

Verification gate:

```bash
cd /home/willamhou/codes/PrismerCloud/services && go test ./daemon/... ./orchestrator/...
cd /home/willamhou/codes/PrismerCloud/server && npm run build
```

Manual demos:

```bash
PRISMER_HTTP_ADDR=:8080 bash scripts/phase_a/run_orchestrator.sh
bash scripts/phase_a/run_daemon.sh
bash scripts/phase_a/demo_approval_flow.sh
bash scripts/phase_a/demo_approval_reject_flow.sh
```

Rollback:

- Disable `approval_enforce`.
- Fall back to record-only approvals.
- Disable automatic dispatch and keep manual dispatch/debug path.

### P2 - Data Model and Setup Productization

Goal: make the release usable by new users and compatible with historical data.

Tasks:

1. Implement polymorphic assignee migration and API fallback.
   - dry-run migration
   - rollback log
   - DID-first claim/close/list
   - legacy fallback

2. Harden install and daemon release flow.
   - artifact checksum/signature
   - idempotent install
   - macOS/Linux service install/uninstall
   - failure diagnostics

3. Improve setup/dashboard UX.
   - runtime status
   - setup failure states
   - next-step actions after daemon registration
   - execution logs and approval states where relevant

Verification gate:

```bash
cd /home/willamhou/codes/PrismerCloud/server && npx tsx scripts/migrate-task-assignee.ts --dry-run
cd /home/willamhou/codes/PrismerCloud && bash install.sh --dry-run
cd /home/willamhou/codes/PrismerCloud/server && npm run build
cd /home/willamhou/codes/PrismerCloud/sdk/prismer-cloud/typescript && npm run build
```

Rollback:

- Set `STRICT_DID_REQUIRED=false`.
- Disable `daemon_auto_setup`.
- Keep manual setup docs active.

### P3 - Release Hardening

Goal: prove the Phase A core release under expected failure modes.

Tasks:

1. Add service E2E tests.
   - happy path
   - daemon crash/reconnect
   - orchestrator restart
   - network partition
   - approval reject
   - runner timeout
   - stale state and replay

2. Add observability checks.
   - runtime online count
   - dispatch latency
   - execution duration
   - approval latency
   - log lag
   - reconnect count
   - structured failure reason

3. Finalize docs and release checklist.
   - update local runbook
   - add feature flag table
   - add rollback checklist
   - add release notes script or template

Verification gate:

```bash
cd /home/willamhou/codes/PrismerCloud/services && go test ./...
cd /home/willamhou/codes/PrismerCloud/server && npm run build
cd /home/willamhou/codes/PrismerCloud/sdk/prismer-cloud/typescript && npm run build
cd /home/willamhou/codes/PrismerCloud && bash scripts/phase_a/schema_contract_guard.sh
```

Release decision:

- Ship `phase-a-core` if setup, runtime admission, dispatch, runner, approval, and reconnect recovery pass.
- Defer PA, full Windows service parity, and full multi-language SDK parity if they threaten core stability.

## 7. Suggested Next Task Order

1. P0.1: orchestrator ack/dedup/state-version.
2. P0.3: dispatch fallback polling.
3. P1.1: daemon runner safety.
4. P1.2: log streaming and stream resume.
5. P1.3: approval API/UI.
6. P2.1: polymorphic assignee migration.
7. P2.2: install/release hardening.
8. P3: E2E and release hardening.

This order keeps the reliability base ahead of product polish. Setup and UI can only be trusted once retry, replay, dispatch, and terminal-state behavior are deterministic.

## 8. Open Questions

- Should Phase A core require one real CLI capability beyond `noop`, or is `noop` plus approval demo enough for the first release candidate?
- Should Windows service support block Phase A core, or be tracked as a post-core platform task?
- Should approval policy be fully configurable in Phase A, or limited to dangerous-action and budget-threshold rules?
- Should PA be included in Phase A core, or explicitly deferred until after dispatch/approval is stable?

## 9. Feature Flag Table

| Flag | Default Before Release | Release Target | Purpose |
| --- | --- | --- | --- |
| `idempotent_ws` | off or shadow | on | Enforce stateful WS dedup and stale-state rejection. |
| `strict_signature` | shadow | on for admission and critical events | Reject invalid/revoked/stale signed messages. |
| `approval_enforce` | off | on for gated actions | Block execution until approval decision. |
| `approval_record_only` | on fallback | off by default | Keep approval audit without blocking execution. |
| `daemon_auto_setup` | off in dev | on in release | Let setup install/start daemon automatically. |
| `STRICT_DID_REQUIRED` | false | false during compatibility window | Allow legacy tasks while DID migration completes. |

## 10. Done Definition

Phase A follow-up work is done when:

- A clean local run completes setup, daemon online, dispatch, execution, logs, approval approve, and approval reject.
- Failure matrix passes for duplicate, stale, reconnect, timeout, cancel, unauthorized approval, and artifact verification failure.
- Build/test gates pass for services, server, SDK, and schema contract.
- Docs include setup, local run, release, feature flags, and rollback.
- Work can be disabled through feature flags without destructive database rollback.
