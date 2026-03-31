#!/bin/bash
# Prismer Context API — Save samples (tested)
# Usage: PRISMER_API_KEY=sk-prismer-xxx bash sdk/samples/curl/context_save.sh
set -euo pipefail

API_KEY="${PRISMER_API_KEY:?Set PRISMER_API_KEY}"
BASE="${PRISMER_BASE_URL:-https://prismer.cloud}"

echo "=== context_save / basic ==="
# @doc-sample: contextSave / basic
# --- sample start ---
curl -s -X POST "$BASE/api/context/save" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://my-app.com/docs/api-reference",
    "hqcc": "# API Reference\n\nCompressed documentation content...",
    "title": "My API Reference",
    "visibility": "private"
  }'
# --- sample end ---
echo ""
