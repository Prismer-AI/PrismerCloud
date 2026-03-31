#!/bin/bash
# Prismer Memory & Recall API — samples (tested)
# Usage: PRISMER_API_KEY=sk-prismer-xxx bash sdk/samples/curl/im_memory.sh
set -euo pipefail

API_KEY="${PRISMER_API_KEY:?Set PRISMER_API_KEY}"
BASE="${PRISMER_BASE_URL:-https://prismer.cloud}"

echo "=== memory / write ==="
# @doc-sample: imMemoryCreate / default
# --- sample start ---
curl -s -X POST "$BASE/api/im/memory/files" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "MEMORY.md",
    "content": "# Project Memory\n\n## Key Decisions\n- Use exponential backoff for API retries\n- Cache TTL set to 5 minutes\n\n## Learned Patterns\n- OpenAI rate limits hit at ~60 RPM on free tier"
  }'
# --- sample end ---
echo ""

echo "=== memory / list ==="
# @doc-sample: imMemoryList / default
# --- sample start ---
curl -s "$BASE/api/im/memory/files" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

# Lifecycle demo: write → read → append → read
echo "=== memory / lifecycle (write → read → append) ==="
# @doc-sample: imMemoryCreate / lifecycle
# --- sample start ---
# Create a memory file
FILE_RESPONSE=$(curl -s -X POST "$BASE/api/im/memory/files" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"path": "test-notes.md", "content": "# Session Notes\n\nInitial observations."}')
echo "Created: $FILE_RESPONSE"

# Extract file ID
FILE_ID=$(echo "$FILE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null || echo "")

if [ -n "$FILE_ID" ]; then
  # Read the file
  echo ""
  echo "--- Reading file $FILE_ID ---"
  curl -s "$BASE/api/im/memory/files/$FILE_ID" \
    -H "Authorization: Bearer $API_KEY"
  echo ""

  # Append new content
  echo "--- Appending to file ---"
  curl -s -X PATCH "$BASE/api/im/memory/files/$FILE_ID" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
      "operation": "append",
      "content": "\n\n## New Finding\n- Discovered that batch requests reduce latency by 40%"
    }'
  echo ""

  # Cleanup
  echo "--- Cleanup ---"
  curl -s -X DELETE "$BASE/api/im/memory/files/$FILE_ID" \
    -H "Authorization: Bearer $API_KEY"
  echo ""
fi
# --- sample end ---
echo ""

echo "=== memory / session_load ==="
# @doc-sample: imMemoryLoad / default
# --- sample start ---
curl -s "$BASE/api/im/memory/load" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== recall / search ==="
# @doc-sample: imRecall / default
# --- sample start ---
curl -s "$BASE/api/im/recall?q=timeout+retry&limit=10" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== recall / filtered ==="
# @doc-sample: imRecall / filtered
# --- sample start ---
curl -s "$BASE/api/im/recall?q=API+reference&limit=5&source=memory" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== memory / read ==="
# @doc-sample: imMemoryRead / default
# --- sample start ---
FILE_ID="${FILE_ID:-REPLACE_WITH_FILE_ID}"
curl -s "$BASE/api/im/memory/files/$FILE_ID" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== memory / delete ==="
# @doc-sample: imMemoryDelete / default
# --- sample start ---
FILE_ID="${FILE_ID:-REPLACE_WITH_FILE_ID}"
curl -s -X DELETE "$BASE/api/im/memory/files/$FILE_ID" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== memory / compact ==="
# @doc-sample: imMemoryCompact / default
# --- sample start ---
CONVERSATION_ID="${CONVERSATION_ID:-REPLACE_WITH_CONVERSATION_ID}"
curl -s -X POST "$BASE/api/im/memory/compact" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"conversationId\": \"$CONVERSATION_ID\",
    \"summary\": \"Session covered API retry strategies, rate limit handling, and caching decisions. Key outcome: switched to exponential backoff with jitter.\"
  }"
# --- sample end ---
echo ""

echo "=== memory / update ==="
# @doc-sample: imMemoryUpdate / default
# --- sample start ---
curl -s -X PATCH "$BASE/api/im/memory/files/${MEMORY_FILE_ID:-REPLACE_WITH_FILE_ID}" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "# Updated Memory\n\n## New Section\n- Important finding discovered today\n",
    "operation": "replace"
  }'
# --- sample end ---
echo ""
