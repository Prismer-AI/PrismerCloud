-- name: CreateTaskApproval :one
INSERT INTO im_task_approvals (
    id,
    task_id,
    kind,
    action,
    payload,
    requested_by_did,
    approver_did,
    approver_im_user_id,
    request_signature,
    expires_at,
    metadata
) VALUES (
    sqlc.arg(id),
    sqlc.narg(task_id),
    sqlc.arg(kind),
    sqlc.arg(action),
    sqlc.arg(payload),
    sqlc.arg(requested_by_did),
    sqlc.narg(approver_did),
    sqlc.narg(approver_im_user_id),
    sqlc.arg(request_signature),
    sqlc.narg(expires_at),
    sqlc.arg(metadata)
)
RETURNING *;

-- name: GetPendingApproval :one
SELECT *
FROM im_task_approvals
WHERE id = sqlc.arg(approval_id)
  AND status = 'pending'
LIMIT 1;

-- name: DecideTaskApproval :exec
UPDATE im_task_approvals
SET
    status = sqlc.arg(status),
    decided_at = CURRENT_TIMESTAMP,
    decision_reason = sqlc.narg(decision_reason),
    decision_signature = sqlc.narg(decision_signature),
    delegation_proof = sqlc.narg(delegation_proof)
WHERE id = sqlc.arg(approval_id);
