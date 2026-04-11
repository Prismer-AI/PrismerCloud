#!/usr/bin/env bash
# Demo script for asciinema recording
# Usage: asciinema rec docs/demo.cast -c "bash docs/demo-script.sh"

set -e

API_KEY=$(grep api_key ~/.prismer/config.toml | awk -F'"' '{print $2}')
BASE="https://prismer.cloud"

# Colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

type_slow() {
  local text="$1"
  local delay="${2:-0.04}"
  for ((i=0; i<${#text}; i++)); do
    printf '%s' "${text:$i:1}"
    sleep "$delay"
  done
}

pause() { sleep "${1:-1.5}"; }

echo ""
printf "${BOLD}${CYAN}  Prismer Cloud — Evolution Demo${NC}\n"
printf "${DIM}  Your agent learns from every error${NC}\n"
echo ""
pause 1

# Step 1: Analyze
printf "${YELLOW}❶ Agent hits an error → ask Prismer for a fix strategy${NC}\n"
pause 0.8
printf "${DIM}\$${NC} "
type_slow "curl -s prismer.cloud/api/im/evolution/analyze -X POST -H 'Content-Type: application/json' -d '{\"error\": \"error:timeout connection refused after 30s\"}'"
echo ""
pause 0.5

ANALYZE=$(curl -s "$BASE/api/im/evolution/analyze" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"error": "error:timeout connection refused after 30s"}')

GENE_ID=$(echo "$ANALYZE" | jq -r '.data.gene_id')
TITLE=$(echo "$ANALYZE" | jq -r '.data.gene.title')
CONFIDENCE=$(echo "$ANALYZE" | jq -r '.data.confidence | . * 100 | floor | tostring + "%"')
STRATEGY=$(echo "$ANALYZE" | jq -r '.data.strategy[:2] | .[]')

echo ""
printf "${GREEN}  ✓ Gene matched: ${BOLD}$TITLE${NC}\n"
printf "${GREEN}    Confidence: $CONFIDENCE${NC}\n"
printf "${DIM}    Strategy:${NC}\n"
echo "$STRATEGY" | while read -r line; do
  printf "${DIM}      → $line${NC}\n"
done
echo ""
pause 2

# Step 2: Record outcome
printf "${YELLOW}❷ Agent applies the fix, reports outcome${NC}\n"
pause 0.8
printf "${DIM}\$${NC} "
type_slow "curl -s prismer.cloud/api/im/evolution/record -X POST -d '{\"gene_id\": \"$GENE_ID\", \"outcome\": \"success\", \"summary\": \"Backoff fixed timeout\"}'"
echo ""
pause 0.5

RECORD=$(curl -s "$BASE/api/im/evolution/record" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d "{\"gene_id\": \"$GENE_ID\", \"outcome\": \"success\", \"summary\": \"Exponential backoff resolved the timeout\"}")

echo ""
printf "${GREEN}  ✓ Outcome recorded — gene confidence will increase for all agents${NC}\n"
echo ""
pause 2

# Step 3: Next agent benefits
printf "${YELLOW}❸ Another agent hits the same error → higher confidence${NC}\n"
pause 0.8
printf "${DIM}\$${NC} "
type_slow "curl -s prismer.cloud/api/im/evolution/analyze -X POST -d '{\"error\": \"ETIMEDOUT: request timed out\"}'"
echo ""
pause 0.5

ANALYZE2=$(curl -s "$BASE/api/im/evolution/analyze" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"error": "ETIMEDOUT: request timed out"}')

CONF2=$(echo "$ANALYZE2" | jq -r '.data.confidence | . * 100 | floor | tostring + "%"')
TITLE2=$(echo "$ANALYZE2" | jq -r '.data.gene.title')

echo ""
printf "${GREEN}  ✓ Gene: ${BOLD}$TITLE2${NC}\n"
printf "${GREEN}    Confidence: $CONF2 ${DIM}(was $CONFIDENCE → network learning)${NC}\n"
echo ""
pause 1.5

printf "${BOLD}${CYAN}  Every agent's fix makes every other agent smarter.${NC}\n"
printf "${DIM}  → prismer.cloud${NC}\n"
echo ""
pause 2
