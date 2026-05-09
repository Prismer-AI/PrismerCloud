#!/usr/bin/env bash
set -euo pipefail

ORCH_BASE_URL="${PRISMER_ORCH_BASE_URL:-http://127.0.0.1:8080}"
APPROVAL_DECISION="${PRISMER_APPROVAL_DECISION:-approved}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

json_get() {
  local expr="$1"
  python3 - "$expr" <<'PY'
import json
import sys

expr = sys.argv[1]
payload = json.load(sys.stdin)
value = payload
for part in expr.split("."):
    if not part:
        continue
    if isinstance(value, dict):
        value = value.get(part)
    else:
        value = None
        break
if value is None:
    print("")
elif isinstance(value, (dict, list)):
    print(json.dumps(value, separators=(",", ":")))
else:
    print(value)
PY
}

poll_task() {
  local task_id="$1"
  curl -fsS "${ORCH_BASE_URL}/debug/tasks/${task_id}"
}

require_cmd curl
require_cmd python3

case "${APPROVAL_DECISION}" in
  approved)
    expected_task_status="completed"
    decision_reason="demo approved"
    ;;
  rejected)
    expected_task_status="failed"
    decision_reason="demo rejected"
    ;;
  *)
    echo "unsupported PRISMER_APPROVAL_DECISION: ${APPROVAL_DECISION}" >&2
    exit 1
    ;;
esac

echo "creating approval demo task..."
create_response="$(curl -fsS -X POST "${ORCH_BASE_URL}/debug/tasks" \
  -H 'Content-Type: application/json' \
  -d '{
    "title":"Approval Demo",
    "capability":"noop",
    "input":{
      "approval":{
        "kind":"dangerous_action",
        "action":"git_push_force",
        "payload":{"branch":"main"}
      }
    },
    "auto_dispatch":true
  }')"

task_id="$(printf '%s' "${create_response}" | json_get "task.id")"
if [[ -z "${task_id}" ]]; then
  echo "failed to parse task id from response: ${create_response}" >&2
  exit 1
fi
echo "task_id=${task_id}"

pending_approval_id=""
for _ in $(seq 1 100); do
  task_json="$(poll_task "${task_id}")"
  pending_approval_id="$(printf '%s' "${task_json}" | json_get "pending_approval_id")"
  task_status="$(printf '%s' "${task_json}" | json_get "status")"
  if [[ -n "${pending_approval_id}" ]]; then
    break
  fi
  if [[ "${task_status}" == "completed" || "${task_status}" == "failed" || "${task_status}" == "cancelled" ]]; then
    echo "task reached terminal status before approval appeared: ${task_json}" >&2
    exit 1
  fi
  sleep 0.1
done

if [[ -z "${pending_approval_id}" ]]; then
  echo "timed out waiting for pending approval on task ${task_id}" >&2
  exit 1
fi
echo "approval_id=${pending_approval_id}"

echo "sending approval decision: ${APPROVAL_DECISION}"
curl -fsS -X POST "${ORCH_BASE_URL}/debug/approvals/decide" \
  -H 'Content-Type: application/json' \
  -d "{
    \"approval_id\":\"${pending_approval_id}\",
    \"status\":\"${APPROVAL_DECISION}\",
    \"decision_reason\":\"${decision_reason}\"
  }"
echo

echo "waiting for task terminal status..."
for _ in $(seq 1 100); do
  task_json="$(poll_task "${task_id}")"
  task_status="$(printf '%s' "${task_json}" | json_get "status")"
  if [[ "${task_status}" == "${expected_task_status}" ]]; then
    echo "${task_json}"
    exit 0
  fi
  if [[ "${task_status}" == "completed" || "${task_status}" == "failed" || "${task_status}" == "cancelled" ]]; then
    echo "task ended unexpectedly: ${task_json}" >&2
    exit 1
  fi
  sleep 0.1
done

echo "timed out waiting for task completion: ${task_id}" >&2
exit 1
