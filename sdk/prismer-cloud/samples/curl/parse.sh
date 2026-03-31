#!/bin/bash
# Prismer Parse API — samples (tested)
# Usage: PRISMER_API_KEY=sk-prismer-xxx bash sdk/samples/curl/parse.sh
set -euo pipefail

API_KEY="${PRISMER_API_KEY:?Set PRISMER_API_KEY}"
BASE="${PRISMER_BASE_URL:-https://prismer.cloud}"

echo "=== parseDocument / pdf_fast ==="
# @doc-sample: parseDocument / pdf_fast
# --- sample start ---
curl -s -X POST "$BASE/api/parse" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://arxiv.org/pdf/2301.00234v1",
    "mode": "fast"
  }'
# --- sample end ---
echo ""

echo "=== parseDocument / with_options ==="
# @doc-sample: parseDocument / with_options
# --- sample start ---
curl -s -X POST "$BASE/api/parse" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://arxiv.org/pdf/2301.00234v1",
    "mode": "fast"
  }'
# --- sample end ---
echo ""
