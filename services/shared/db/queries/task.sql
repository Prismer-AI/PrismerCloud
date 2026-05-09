-- name: ClaimTask :one
UPDATE im_tasks
SET
    assignee_id = sqlc.narg(assignee_id),
    assignee_did = sqlc.narg(assignee_did),
    assignee_type = sqlc.narg(assignee_type),
    runtime_id = sqlc.narg(runtime_id),
    status = sqlc.arg(status),
    updated_at = CURRENT_TIMESTAMP
WHERE id = sqlc.arg(task_id)
RETURNING *;

-- name: InsertTaskExecution :one
INSERT INTO im_task_executions (
    id,
    task_id,
    runtime_id,
    attempt,
    status,
    capability_used,
    cli_path,
    cli_version
) VALUES (
    sqlc.arg(id),
    sqlc.arg(task_id),
    sqlc.arg(runtime_id),
    sqlc.arg(attempt),
    sqlc.arg(status),
    sqlc.narg(capability_used),
    sqlc.narg(cli_path),
    sqlc.narg(cli_version)
)
RETURNING *;

-- name: CompleteTaskExecution :exec
UPDATE im_task_executions
SET
    status = sqlc.arg(status),
    accepted_at = COALESCE(sqlc.narg(accepted_at), accepted_at),
    completed_at = COALESCE(sqlc.narg(completed_at), CURRENT_TIMESTAMP),
    exit_code = sqlc.narg(exit_code),
    duration_ms = sqlc.narg(duration_ms),
    logs_ref = sqlc.narg(logs_ref),
    result_ref = sqlc.narg(result_ref),
    cpu_seconds = sqlc.narg(cpu_seconds),
    memory_bytes = sqlc.narg(memory_bytes)
WHERE id = sqlc.arg(execution_id);

-- name: InsertTaskLog :one
INSERT INTO im_task_logs (
    id,
    task_id,
    actor_id,
    action,
    message,
    metadata
) VALUES (
    sqlc.arg(id),
    sqlc.arg(task_id),
    sqlc.narg(actor_id),
    sqlc.arg(action),
    sqlc.narg(message),
    sqlc.arg(metadata)
)
RETURNING *;

-- name: ListPendingTasksForCapability :many
SELECT *
FROM im_tasks
WHERE capability = sqlc.arg(capability)
  AND status = 'pending'
ORDER BY created_at ASC;
