-- Minimal SQL mirror for Phase A shared queries.
-- Source of truth remains server/prisma/schema.prisma.
-- Keep this file aligned with the subset of tables/columns queried by sqlc.

CREATE TABLE im_runtimes (
    id                TEXT PRIMARY KEY,
    owner_did         TEXT NOT NULL,
    owner_im_user_id  TEXT,
    type              TEXT NOT NULL DEFAULT 'local',
    did               TEXT NOT NULL UNIQUE,
    public_key        TEXT NOT NULL,
    hostname          TEXT,
    os                TEXT,
    arch              TEXT,
    version           TEXT,
    endpoint          TEXT,
    capabilities      TEXT NOT NULL DEFAULT '[]',
    status            TEXT NOT NULL DEFAULT 'offline',
    load              REAL NOT NULL DEFAULT 0,
    last_heartbeat_at DATETIME,
    registered_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_im_runtimes_owner_did_status ON im_runtimes(owner_did, status);
CREATE INDEX idx_im_runtimes_status_last_heartbeat_at ON im_runtimes(status, last_heartbeat_at);
CREATE INDEX idx_im_runtimes_type_status ON im_runtimes(type, status);

CREATE TABLE im_daemon_sessions (
    id                 TEXT PRIMARY KEY,
    runtime_id         TEXT NOT NULL,
    started_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    terminated_at      DATETIME,
    termination_reason TEXT,
    version            TEXT NOT NULL,
    pid                INTEGER,
    remote_addr        TEXT,
    user_agent         TEXT,
    task_count         INTEGER NOT NULL DEFAULT 0,
    log_bytes          INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(runtime_id) REFERENCES im_runtimes(id) ON DELETE CASCADE
);

CREATE INDEX idx_im_daemon_sessions_runtime_started_at ON im_daemon_sessions(runtime_id, started_at);

CREATE TABLE im_tasks (
    id                  TEXT PRIMARY KEY,
    title               TEXT NOT NULL,
    description         TEXT,
    capability          TEXT,
    input               TEXT NOT NULL DEFAULT '{}',
    context_uri         TEXT,
    creator_id          TEXT NOT NULL,
    creator_did         TEXT,
    assignee_id         TEXT,
    assignee_did        TEXT,
    assignee_type       TEXT,
    scope               TEXT NOT NULL DEFAULT 'global',
    conversation_id     TEXT,
    status              TEXT NOT NULL DEFAULT 'pending',
    progress            REAL,
    status_message      TEXT,
    schedule_type       TEXT,
    schedule_at         DATETIME,
    schedule_cron       TEXT,
    interval_ms         INTEGER,
    next_run_at         DATETIME,
    last_run_at         DATETIME,
    run_count           INTEGER NOT NULL DEFAULT 0,
    max_runs            INTEGER,
    result              TEXT,
    result_uri          TEXT,
    error               TEXT,
    budget              REAL,
    cost                REAL NOT NULL DEFAULT 0,
    runtime_id          TEXT,
    requires_approval   BOOLEAN NOT NULL DEFAULT FALSE,
    pending_approval_id TEXT,
    timeout_ms          INTEGER NOT NULL DEFAULT 300000,
    deadline            DATETIME,
    completed_at        DATETIME,
    max_retries         INTEGER NOT NULL DEFAULT 0,
    retry_delay_ms      INTEGER NOT NULL DEFAULT 60000,
    retry_count         INTEGER NOT NULL DEFAULT 0,
    metadata            TEXT NOT NULL DEFAULT '{}',
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_im_tasks_status ON im_tasks(status);
CREATE INDEX idx_im_tasks_assignee_id_status ON im_tasks(assignee_id, status);
CREATE INDEX idx_im_tasks_assignee_did_status ON im_tasks(assignee_did, status);
CREATE INDEX idx_im_tasks_capability_status ON im_tasks(capability, status);
CREATE INDEX idx_im_tasks_runtime_id ON im_tasks(runtime_id);

CREATE TABLE im_task_executions (
    id               TEXT PRIMARY KEY,
    task_id          TEXT NOT NULL,
    runtime_id       TEXT NOT NULL,
    attempt          INTEGER NOT NULL DEFAULT 1,
    status           TEXT NOT NULL DEFAULT 'dispatched',
    started_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    accepted_at      DATETIME,
    completed_at     DATETIME,
    exit_code        INTEGER,
    duration_ms      INTEGER,
    capability_used  TEXT,
    cli_path         TEXT,
    cli_version      TEXT,
    logs_ref         TEXT,
    result_ref       TEXT,
    cpu_seconds      REAL,
    memory_bytes     INTEGER,
    FOREIGN KEY(task_id) REFERENCES im_tasks(id) ON DELETE CASCADE,
    FOREIGN KEY(runtime_id) REFERENCES im_runtimes(id)
);

CREATE INDEX idx_im_task_executions_task_attempt ON im_task_executions(task_id, attempt);
CREATE INDEX idx_im_task_executions_runtime_status ON im_task_executions(runtime_id, status);

CREATE TABLE phase_a_msg_dedup_stateful (
    execution_id  TEXT NOT NULL,
    state_version INTEGER NOT NULL,
    msg_id        TEXT NOT NULL,
    msg_type      TEXT NOT NULL,
    payload_hash  TEXT NOT NULL,
    received_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (execution_id, state_version)
);

CREATE INDEX idx_phase_a_msg_dedup_stateful_received_at ON phase_a_msg_dedup_stateful(received_at);

CREATE TABLE im_task_logs (
    id         TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL,
    actor_id    TEXT,
    action      TEXT NOT NULL,
    message     TEXT,
    metadata    TEXT NOT NULL DEFAULT '{}',
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(task_id) REFERENCES im_tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_im_task_logs_task_created_at ON im_task_logs(task_id, created_at);

CREATE TABLE im_execution_stream_cursors (
    execution_id       TEXT NOT NULL,
    stream_id          TEXT NOT NULL,
    last_committed_seq INTEGER NOT NULL DEFAULT 0,
    updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (execution_id, stream_id)
);

CREATE INDEX idx_im_execution_stream_cursors_execution_id ON im_execution_stream_cursors(execution_id);

CREATE TABLE im_task_approvals (
    id                 TEXT PRIMARY KEY,
    task_id            TEXT,
    kind               TEXT NOT NULL,
    action             TEXT NOT NULL,
    payload            TEXT NOT NULL DEFAULT '{}',
    requested_by_did   TEXT NOT NULL,
    requested_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    approver_did       TEXT,
    approver_im_user_id TEXT,
    status             TEXT NOT NULL DEFAULT 'pending',
    decided_at         DATETIME,
    decision_reason    TEXT,
    request_signature  TEXT NOT NULL,
    decision_signature TEXT,
    delegation_proof   TEXT,
    expires_at         DATETIME,
    metadata           TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(task_id) REFERENCES im_tasks(id) ON DELETE SET NULL
);

CREATE INDEX idx_im_task_approvals_task_id ON im_task_approvals(task_id);
CREATE INDEX idx_im_task_approvals_approver_status ON im_task_approvals(approver_did, status);
CREATE INDEX idx_im_task_approvals_requested_by_did ON im_task_approvals(requested_by_did);

CREATE TABLE im_signing_keys (
    id          TEXT PRIMARY KEY,
    did         TEXT NOT NULL,
    key_version INTEGER NOT NULL DEFAULT 1,
    public_key  TEXT NOT NULL,
    algorithm   TEXT NOT NULL DEFAULT 'ed25519',
    key_id      TEXT UNIQUE,
    revoked_at  DATETIME,
    expires_at  DATETIME,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata    TEXT NOT NULL DEFAULT '{}',
    UNIQUE(did, key_version)
);

CREATE INDEX idx_im_signing_keys_did_revoked_at ON im_signing_keys(did, revoked_at);
CREATE INDEX idx_im_signing_keys_expires_at ON im_signing_keys(expires_at);
