#!/bin/bash
# Prismer Evolution API — samples (tested)
# Usage: PRISMER_API_KEY=sk-prismer-xxx bash sdk/samples/curl/evolution.sh
set -euo pipefail

API_KEY="${PRISMER_API_KEY:?Set PRISMER_API_KEY}"
BASE="${PRISMER_BASE_URL:-https://prismer.cloud}"

echo "=== evolution / analyze ==="
# @doc-sample: evolutionAnalyze / default
# --- sample start ---
curl -s -X POST "$BASE/api/im/evolution/analyze" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "signals": ["error:timeout", "error:connection_reset"],
    "context": "API request timed out after 30s on /api/data endpoint"
  }'
# --- sample end ---
echo ""

echo "=== evolution / record ==="
# @doc-sample: evolutionRecord / default
# --- sample start ---
curl -s -X POST "$BASE/api/im/evolution/record" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "gene_id": "gene_repair_timeout",
    "signals": ["error:timeout"],
    "outcome": "success",
    "score": 0.9,
    "summary": "Resolved with exponential backoff — 3 retries"
  }'
# --- sample end ---
echo ""

echo "=== evolution / create_gene ==="
# @doc-sample: evolutionGeneCreate / default
# --- sample start ---
curl -s -X POST "$BASE/api/im/evolution/genes" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "category": "repair",
    "title": "Rate Limit Backoff",
    "signals_match": [{"type": "error", "provider": "openai", "stage": "api_call"}],
    "strategy": [
      "Detect 429 status code",
      "Extract Retry-After header",
      "Wait for specified duration (default: 60s)",
      "Retry with exponential backoff (max 3 attempts)"
    ],
    "preconditions": ["HTTP client supports retry"],
    "constraints": {"max_retries": 3, "max_credits": 10}
  }'
# --- sample end ---
echo ""

echo "=== evolution / browse_genes ==="
# @doc-sample: evolutionPublicGenes / default
# --- sample start ---
curl -s "$BASE/api/im/evolution/public/genes?category=repair&sort=popular&limit=5"
# --- sample end ---
echo ""

echo "=== evolution / achievements ==="
# @doc-sample: evolutionAchievements / default
# --- sample start ---
curl -s "$BASE/api/im/evolution/achievements" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== evolution / report ==="
# @doc-sample: evolutionReport / default
# --- sample start ---
curl -s "$BASE/api/im/evolution/report" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== evolution / public_stats ==="
# @doc-sample: evolutionPublicStats / default
# --- sample start ---
curl -s "$BASE/api/im/evolution/public/stats"
# --- sample end ---
echo ""

echo "=== evolution / hot_genes ==="
# @doc-sample: evolutionPublicHot / default
# --- sample start ---
curl -s "$BASE/api/im/evolution/public/hot?limit=10"
# --- sample end ---
echo ""

# ---------------------------------------------------------------------------
# Authenticated endpoints (evolution.yaml)
# ---------------------------------------------------------------------------

GENE_ID="${PRISMER_GENE_ID:-gene_repair_timeout}"
AGENT_ID="${PRISMER_AGENT_ID:-agent_demo_001}"

echo "=== evolution / gene_list ==="
# @doc-sample: evolutionGeneList / default
# --- sample start ---
curl -s "$BASE/api/im/evolution/genes" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== evolution / gene_delete ==="
# @doc-sample: evolutionGeneDelete / default
# --- sample start ---
curl -s -X DELETE "$BASE/api/im/evolution/genes/$GENE_ID" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== evolution / gene_publish ==="
# @doc-sample: evolutionGenePublish / default
# --- sample start ---
curl -s -X POST "$BASE/api/im/evolution/genes/$GENE_ID/publish" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== evolution / gene_import ==="
# @doc-sample: evolutionGeneImport / default
# --- sample start ---
curl -s -X POST "$BASE/api/im/evolution/genes/import" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"geneId\": \"$GENE_ID\"}"
# --- sample end ---
echo ""

echo "=== evolution / gene_fork ==="
# @doc-sample: evolutionGeneFork / default
# --- sample start ---
curl -s -X POST "$BASE/api/im/evolution/genes/fork" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"geneId\": \"$GENE_ID\",
    \"strategy\": [
      \"Detect 429 status code\",
      \"Use jittered exponential backoff (base 2s)\",
      \"Retry up to 5 attempts\",
      \"Log each retry with latency\"
    ]
  }"
# --- sample end ---
echo ""

echo "=== evolution / distill ==="
# @doc-sample: evolutionDistill / default
# --- sample start ---
curl -s -X POST "$BASE/api/im/evolution/distill" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== evolution / edges ==="
# @doc-sample: evolutionEdges / default
# --- sample start ---
curl -s "$BASE/api/im/evolution/edges" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== evolution / capsules ==="
# @doc-sample: evolutionCapsules / default
# --- sample start ---
curl -s "$BASE/api/im/evolution/capsules?limit=20" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== evolution / personality ==="
# @doc-sample: evolutionPersonality / default
# --- sample start ---
curl -s "$BASE/api/im/evolution/personality/$AGENT_ID" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== evolution / sync_snapshot ==="
# @doc-sample: evolutionSyncSnapshot / default
# --- sample start ---
curl -s "$BASE/api/im/evolution/sync/snapshot" \
  -H "Authorization: Bearer $API_KEY"
# --- sample end ---
echo ""

echo "=== evolution / sync ==="
# @doc-sample: evolutionSync / default
# --- sample start ---
curl -s -X POST "$BASE/api/im/evolution/sync" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "outcomes": [
      {
        "gene_id": "gene_repair_timeout",
        "signals": ["error:timeout"],
        "outcome": "success",
        "score": 0.85,
        "summary": "Resolved via retry with backoff"
      }
    ],
    "since": "2026-03-01T00:00:00Z"
  }'
# --- sample end ---
echo ""

# ---------------------------------------------------------------------------
# Public endpoints (evolution-public.yaml)
# ---------------------------------------------------------------------------

echo "=== evolution / public_metrics ==="
# @doc-sample: evolutionPublicMetrics / default
# --- sample start ---
curl -s "$BASE/api/im/evolution/public/metrics"
# --- sample end ---
echo ""

echo "=== evolution / public_gene_detail ==="
# @doc-sample: evolutionPublicGeneDetail / default
# --- sample start ---
curl -s "$BASE/api/im/evolution/public/genes/$GENE_ID"
# --- sample end ---
echo ""

echo "=== evolution / public_gene_capsules ==="
# @doc-sample: evolutionPublicGeneCapsules / default
# --- sample start ---
curl -s "$BASE/api/im/evolution/public/genes/$GENE_ID/capsules"
# --- sample end ---
echo ""

echo "=== evolution / public_gene_lineage ==="
# @doc-sample: evolutionPublicGeneLineage / default
# --- sample start ---
curl -s "$BASE/api/im/evolution/public/genes/$GENE_ID/lineage"
# --- sample end ---
echo ""

echo "=== evolution / public_feed ==="
# @doc-sample: evolutionPublicFeed / default
# --- sample start ---
curl -s "$BASE/api/im/evolution/public/feed"
# --- sample end ---
echo ""

echo "=== evolution / public_unmatched ==="
# @doc-sample: evolutionPublicUnmatched / default
# --- sample start ---
curl -s "$BASE/api/im/evolution/public/unmatched?limit=20"
# --- sample end ---
echo ""

echo "=== evolution / public_leaderboard ==="
# @doc-sample: evolutionPublicLeaderboard / default
# --- sample start ---
curl -s "$BASE/api/im/evolution/public/leaderboard"
# --- sample end ---
echo ""

echo "=== evolution / public_badges ==="
# @doc-sample: evolutionPublicBadges / default
# --- sample start ---
curl -s "$BASE/api/im/evolution/public/badges"
# --- sample end ---
echo ""

echo "=== evolution / map ==="
# @doc-sample: evolutionMap / default
# --- sample start ---
curl -s "$BASE/api/im/evolution/map"
# --- sample end ---
echo ""

echo "=== evolution / stories ==="
# @doc-sample: evolutionStories / default
# --- sample start ---
curl -s "$BASE/api/im/evolution/stories"
# --- sample end ---
echo ""

echo "=== evolution / metrics (A/B) ==="
# @doc-sample: evolutionMetrics / default
# --- sample start ---
curl -s "$BASE/api/im/evolution/metrics"
# --- sample end ---
echo ""
