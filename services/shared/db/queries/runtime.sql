-- name: RegisterRuntime :one
INSERT INTO im_runtimes (
    id,
    owner_did,
    owner_im_user_id,
    type,
    did,
    public_key,
    hostname,
    os,
    arch,
    version,
    endpoint,
    capabilities,
    status,
    load,
    last_heartbeat_at
) VALUES (
    sqlc.arg(id),
    sqlc.arg(owner_did),
    sqlc.narg(owner_im_user_id),
    sqlc.arg(type),
    sqlc.arg(did),
    sqlc.arg(public_key),
    sqlc.narg(hostname),
    sqlc.narg(os),
    sqlc.narg(arch),
    sqlc.narg(version),
    sqlc.narg(endpoint),
    sqlc.arg(capabilities),
    sqlc.arg(status),
    sqlc.arg(load),
    CURRENT_TIMESTAMP
)
ON CONFLICT(did) DO UPDATE SET
    owner_did = excluded.owner_did,
    owner_im_user_id = excluded.owner_im_user_id,
    type = excluded.type,
    public_key = excluded.public_key,
    hostname = excluded.hostname,
    os = excluded.os,
    arch = excluded.arch,
    version = excluded.version,
    endpoint = excluded.endpoint,
    capabilities = excluded.capabilities,
    status = excluded.status,
    load = excluded.load,
    last_heartbeat_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
RETURNING *;

-- name: HeartbeatRuntime :exec
UPDATE im_runtimes
SET
    status = sqlc.arg(status),
    load = sqlc.arg(load),
    last_heartbeat_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE id = sqlc.arg(runtime_id);

-- name: ListOnlineRuntimes :many
SELECT *
FROM im_runtimes
WHERE status IN ('online', 'idle', 'busy')
ORDER BY load ASC, last_heartbeat_at DESC;

-- name: StartDaemonSession :one
INSERT INTO im_daemon_sessions (
    id,
    runtime_id,
    version,
    pid,
    remote_addr,
    user_agent
) VALUES (
    sqlc.arg(id),
    sqlc.arg(runtime_id),
    sqlc.arg(version),
    sqlc.narg(pid),
    sqlc.narg(remote_addr),
    sqlc.narg(user_agent)
)
RETURNING *;

-- name: TerminateDaemonSession :exec
UPDATE im_daemon_sessions
SET
    terminated_at = CURRENT_TIMESTAMP,
    termination_reason = sqlc.arg(termination_reason)
WHERE id = sqlc.arg(session_id);
