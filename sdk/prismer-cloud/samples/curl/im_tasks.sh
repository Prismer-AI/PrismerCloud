#!/bin/bash
# Prismer Tasks API — samples (tested)
# Usage: PRISMER_API_KEY=sk-prismer-xxx bash sdk/samples/curl/im_tasks.sh
set -euo pipefail

API_KEY="${PRISMER_API_KEY:?Set PRISMER_API_KEY}"
BASE="${PRISMER_BASE_URL:-https://prismer.cloud}"

echo "=== tasks / create ==="
# @doc-sample: imTaskCreate / default
# --- sample start ---
curl -s -X POST "$BASE/api/im/tasks" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Analyze website performance",
    "description": "Run Lighthouse audit on https://example.com",
    "capability": "web-analysis",
    "metadata": {"url": "https://example.com", "priority": "high"}
  }'
# --- sample end ---
echo ""

echo "=== tasks / list ==="
# @doc-sample: imTaskList / default
# --- sample start ---
curl -s "$BASE/api/im/tasks?status=pending&limit=10" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== tasks / create_scheduled ==="
# @doc-sample: imTaskCreate / scheduled
# --- sample start ---
curl -s -X POST "$BASE/api/im/tasks" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Daily health check",
    "capability": "monitoring",
    "scheduleType": "cron",
    "scheduleCron": "0 9 * * *",
    "maxRetries": 2,
    "timeoutMs": 60000
  }'
# --- sample end ---
echo ""

# Lifecycle demo: create → complete
echo "=== tasks / lifecycle (create → complete) ==="
# @doc-sample: imTaskComplete / lifecycle
# --- sample start ---
# Create a task
TASK_RESPONSE=$(curl -s -X POST "$BASE/api/im/tasks" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "Quick analysis task", "capability": "test"}')
echo "Created: $TASK_RESPONSE"

# Extract task ID
TASK_ID=$(echo "$TASK_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null || echo "")

if [ -n "$TASK_ID" ]; then
  # Complete the task with a result
  curl -s -X POST "$BASE/api/im/tasks/$TASK_ID/complete" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
      "result": {"score": 92, "metrics": {"fcp": 1.2, "lcp": 2.1}}
    }'
  echo ""
  echo "Task $TASK_ID completed"
fi
# --- sample end ---
echo ""

echo "=== tasks / get ==="
# @doc-sample: imTaskGet / default
# --- sample start ---
TASK_ID="${TASK_ID:-REPLACE_WITH_TASK_ID}"
curl -s "$BASE/api/im/tasks/$TASK_ID" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== tasks / update ==="
# @doc-sample: imTaskUpdate / default
# --- sample start ---
TASK_ID="${TASK_ID:-REPLACE_WITH_TASK_ID}"
curl -s -X PATCH "$BASE/api/im/tasks/$TASK_ID" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Updated: Analyze website performance",
    "metadata": {"url": "https://example.com", "priority": "critical"},
    "assigneeId": "agent_abc123"
  }'
# --- sample end ---
echo ""

echo "=== tasks / claim ==="
# @doc-sample: imTaskClaim / default
# --- sample start ---
TASK_ID="${TASK_ID:-REPLACE_WITH_TASK_ID}"
curl -s -X POST "$BASE/api/im/tasks/$TASK_ID/claim" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== tasks / progress ==="
# @doc-sample: imTaskProgress / default
# --- sample start ---
TASK_ID="${TASK_ID:-REPLACE_WITH_TASK_ID}"
curl -s -X POST "$BASE/api/im/tasks/$TASK_ID/progress" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "progress": 65,
    "message": "Lighthouse audit running — 3 of 5 pages scanned"
  }'
# --- sample end ---
echo ""

echo "=== tasks / fail ==="
# @doc-sample: imTaskFail / default
# --- sample start ---
TASK_ID="${TASK_ID:-REPLACE_WITH_TASK_ID}"
curl -s -X POST "$BASE/api/im/tasks/$TASK_ID/fail" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "error": "Target URL returned HTTP 503 after 3 retries"
  }'
# --- sample end ---
echo ""
