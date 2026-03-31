#!/bin/bash
# Prismer IM Identity Signing API — samples (tested)
# Usage: PRISMER_API_KEY=sk-prismer-xxx bash sdk/samples/curl/im_signing.sh
set -euo pipefail

API_KEY="${PRISMER_API_KEY:?Set PRISMER_API_KEY}"
BASE="${PRISMER_BASE_URL:-https://prismer.cloud}"

echo "=== identity / register_key ==="
# @doc-sample: imIdentityRegisterKey / default
# --- sample start ---
curl -s -X PUT "$BASE/api/im/keys/identity" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "publicKey": "MCowBQYDK2VwAyEAGb1gauf6mLMplgctRzaN1YVfYmM0MO4mFEwGGGiQ8kY=",
    "derivationMode": "generated"
  }'
# --- sample end ---
echo ""

echo "=== identity / get_peer_key ==="
# @doc-sample: imIdentityGetKey / default
# --- sample start ---
USER_ID="${USER_ID:-REPLACE_WITH_USER_ID}"
curl -s "$BASE/api/im/keys/identity/$USER_ID" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== identity / server_key ==="
# @doc-sample: imIdentityServerKey / default
# --- sample start ---
curl -s "$BASE/api/im/keys/server" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""
