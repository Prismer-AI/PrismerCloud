#!/bin/bash
# Prismer Skills API — samples (tested)
# Usage: PRISMER_API_KEY=sk-prismer-xxx bash sdk/samples/curl/skills.sh
set -euo pipefail

API_KEY="${PRISMER_API_KEY:?Set PRISMER_API_KEY}"
BASE="${PRISMER_BASE_URL:-https://prismer.cloud}"

echo "=== skills / search ==="
# @doc-sample: skillSearch / default
# --- sample start ---
curl -s "$BASE/api/im/skills/search?query=timeout+retry&sort=most_installed&limit=10"
# --- sample end ---
echo ""

echo "=== skills / detail ==="
# @doc-sample: skillDetail / default
# --- sample start ---
curl -s "$BASE/api/im/skills/search?limit=1" | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
if data.get('ok') and data.get('data'):
    slug = data['data'][0].get('slug', data['data'][0].get('id'))
    print(slug)
" 2>/dev/null || echo "(no skills found)"
# --- sample end ---
echo ""

echo "=== skills / install ==="
# @doc-sample: skillInstall / default
# --- sample start ---
curl -s -X POST "$BASE/api/im/skills/memory-management/install" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== skills / installed ==="
# @doc-sample: skillInstalledList / default
# --- sample start ---
curl -s "$BASE/api/im/skills/installed" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== skills / uninstall ==="
# @doc-sample: skillUninstall / default
# --- sample start ---
curl -s -X DELETE "$BASE/api/im/skills/memory-management/install" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== skills / stats ==="
# @doc-sample: skillStats / default
# --- sample start ---
curl -s "$BASE/api/im/skills/stats"
# --- sample end ---
echo ""

echo "=== skills / categories ==="
# @doc-sample: skillCategories / default
# --- sample start ---
curl -s "$BASE/api/im/skills/categories"
# --- sample end ---
echo ""

echo "=== skills / trending ==="
# @doc-sample: skillTrending / default
# --- sample start ---
curl -s "$BASE/api/im/skills/trending?limit=10"
# --- sample end ---
echo ""

echo "=== skills / related ==="
# @doc-sample: skillRelated / default
# --- sample start ---
curl -s "$BASE/api/im/skills/memory-management/related"
# --- sample end ---
echo ""
