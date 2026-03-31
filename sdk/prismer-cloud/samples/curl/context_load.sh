#!/bin/bash
# Prismer Context API — Load samples (tested)
# Usage: PRISMER_API_KEY=sk-prismer-xxx bash sdk/samples/curl/context_load.sh
set -euo pipefail

API_KEY="${PRISMER_API_KEY:?Set PRISMER_API_KEY}"
BASE="${PRISMER_BASE_URL:-https://prismer.cloud}"

echo "=== context_load / single_url ==="
# @doc-sample: contextLoad / single_url
# --- sample start ---
curl -s -X POST "$BASE/api/context/load" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input": "https://example.com"}'
# --- sample end ---
echo ""

echo "=== context_load / batch_urls ==="
# @doc-sample: contextLoad / batch_urls
# --- sample start ---
curl -s -X POST "$BASE/api/context/load" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "input": ["https://example.com", "https://httpbin.org/html"],
    "processUncached": true
  }'
# --- sample end ---
echo ""

echo "=== context_load / search_query ==="
# @doc-sample: contextLoad / search_query
# --- sample start ---
curl -s -X POST "$BASE/api/context/load" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "input": "latest AI research papers",
    "inputType": "query",
    "search": {"topK": 3}
  }'
# --- sample end ---
echo ""
