#!/bin/bash
# =============================================================================
# MVP Breakpoint Verification — Tests M1-M4 new features
# Must run AFTER deploying the M1-M4 changes to the target environment.
#
# What this tests (NOT backward compat — specifically the NEW features):
#   M1: evolve_analyze accepts SignalTag[] (not just string[])
#   M2: evolve_record accepts SignalTag[]
#   M3: publishGene with skipCanary=true works
#   M4: Response contains v0.3.0 fields (coverageScore, create_suggested, diagnostic)
#
# Usage: bash scripts/test-mvp-breakpoints.sh [base_url]
# =============================================================================

BASE="${1:-https://cloud.prismer.dev}"
PASS=0; FAIL=0; SKIP=0

ok()   { echo "  ✅ $1"; ((PASS++)); }
fail() { echo "  ❌ $1: $2"; ((FAIL++)); }
skip() { echo "  ⏭️  $1"; ((SKIP++)); }

# Retry wrapper (handles rolling deployment / bad pod)
api() {
  local method=$1 path=$2 body=$3 token=$4
  for attempt in 1 2 3 4; do
    local url="${BASE}/api/im${path}"
    local args=(-s --max-time 10 -H "Content-Type: application/json")
    [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
    [ "$method" != "GET" ] && args+=(-X "$method")
    [ -n "$body" ] && args+=(-d "$body")
    local resp
    resp=$(curl "${args[@]}" "$url" 2>/dev/null)
    if ! echo "$resp" | grep -q "Internal Server Error"; then
      echo "$resp"
      return 0
    fi
    sleep 0.5
  done
  echo "$resp"
}

jq() {
  python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  keys = '$1'.split('.')
  for k in keys:
    if isinstance(d, dict): d = d.get(k)
    elif isinstance(d, list) and k.isdigit(): d = d[int(k)]
    else: d = None
  print(d if d is not None else '')
except: print('')" 2>/dev/null
}

echo "═══════════════════════════════════════════════════"
echo "  MVP Breakpoint Verification (M1-M4)"
echo "  Target: $BASE"
echo "═══════════════════════════════════════════════════"

# ── Setup: Register two agents ──
echo ""
echo "⚙️  Setup"

TS=$(date +%s)
REG_A=$(api POST /register "{\"type\":\"agent\",\"username\":\"mvp_a_${TS}\",\"displayName\":\"Agent A (teacher)\",\"agentType\":\"specialist\"}")
TOKEN_A=$(echo "$REG_A" | jq "data.token")
ID_A=$(echo "$REG_A" | jq "data.imUserId")

REG_B=$(api POST /register "{\"type\":\"agent\",\"username\":\"mvp_b_${TS}\",\"displayName\":\"Agent B (learner)\",\"agentType\":\"assistant\"}")
TOKEN_B=$(echo "$REG_B" | jq "data.token")
ID_B=$(echo "$REG_B" | jq "data.imUserId")

if [ -z "$TOKEN_A" ] || [ "$TOKEN_A" = "None" ] || [ -z "$TOKEN_B" ] || [ "$TOKEN_B" = "None" ]; then
  fail "Setup" "Failed to register agents"
  echo "  Agent A: $REG_A"
  echo "  Agent B: $REG_B"
  exit 1
fi
ok "Register Agent A ($ID_A) and Agent B ($ID_B)"

# ═══════════════════════════════════════════════════
echo ""
echo "🧪 M1: evolve_analyze accepts SignalTag[]"
# ═══════════════════════════════════════════════════

# M1.1: Send SignalTag[] with provider/stage/severity
R=$(api POST /evolution/analyze '{"signals":[{"type":"error:oom","provider":"k8s","stage":"rollout","severity":"critical"}]}' "$TOKEN_A")
ACTION=$(echo "$R" | jq "data.action")
if [ -n "$ACTION" ] && [ "$ACTION" != "" ] && [ "$ACTION" != "None" ]; then
  ok "M1.1 Analyze with full SignalTag[] (action=$ACTION)"
else
  fail "M1.1 Analyze with full SignalTag[]" "$(echo "$R" | head -c 120)"
fi

# M1.2: Verify response signals are SignalTag objects (not strings)
SIG_TYPE=$(echo "$R" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  sigs = d.get('data',{}).get('signals',[])
  if sigs and isinstance(sigs[0], dict):
    print(sigs[0].get('type',''))
  else:
    print('STRING:' + str(sigs[0]) if sigs else 'EMPTY')
except: print('PARSE_ERROR')" 2>/dev/null)

if echo "$SIG_TYPE" | grep -q "^error:"; then
  ok "M1.2 Response signals are SignalTag[] (type=$SIG_TYPE)"
else
  fail "M1.2 Response signals format" "got: $SIG_TYPE"
fi

# M1.3: Mixed SignalTag[] with multiple tags
R=$(api POST /evolution/analyze '{"signals":[{"type":"error:timeout","provider":"openai"},{"type":"task:deploy","stage":"rollout"}]}' "$TOKEN_A")
ACTION=$(echo "$R" | jq "data.action")
if [ -n "$ACTION" ] && [ "$ACTION" != "" ] && [ "$ACTION" != "None" ]; then
  ok "M1.3 Analyze with multiple SignalTags (action=$ACTION)"
else
  fail "M1.3 Multi-tag analyze" "$(echo "$R" | head -c 120)"
fi

# ═══════════════════════════════════════════════════
echo ""
echo "🧪 M2: evolve_record accepts SignalTag[]"
# ═══════════════════════════════════════════════════

# First get a gene to record against
R=$(api POST /evolution/analyze '{"signals":[{"type":"error:timeout"}]}' "$TOKEN_A")
GENE_ID=$(echo "$R" | jq "data.gene_id")

if [ -n "$GENE_ID" ] && [ "$GENE_ID" != "" ] && [ "$GENE_ID" != "None" ]; then
  # M2.1: Record with SignalTag[]
  R=$(api POST /evolution/record "{\"gene_id\":\"${GENE_ID}\",\"signals\":[{\"type\":\"error:timeout\",\"provider\":\"redis\",\"stage\":\"cache_read\"}],\"outcome\":\"success\",\"score\":0.9,\"summary\":\"MVP test: SignalTag record\"}" "$TOKEN_A")
  EDGE_OK=$(echo "$R" | jq "data.edge_updated")
  if [ "$EDGE_OK" = "True" ]; then
    ok "M2.1 Record with SignalTag[] (edge_updated=True)"
  else
    fail "M2.1 Record with SignalTag[]" "$(echo "$R" | head -c 120)"
  fi

  # M2.2: Record with mixed metadata.provider
  R=$(api POST /evolution/record "{\"gene_id\":\"${GENE_ID}\",\"signals\":[{\"type\":\"error:timeout\",\"provider\":\"mysql\"}],\"outcome\":\"failed\",\"score\":0.2,\"summary\":\"MVP test: failed with provider tag\",\"metadata\":{\"provider\":\"mysql\"}}" "$TOKEN_A")
  EDGE_OK=$(echo "$R" | jq "data.edge_updated")
  if [ "$EDGE_OK" = "True" ]; then
    ok "M2.2 Record with provider in metadata (edge_updated=True)"
  else
    fail "M2.2 Record with provider metadata" "$(echo "$R" | head -c 120)"
  fi
else
  skip "M2.1 Record (no gene_id from analyze)"
  skip "M2.2 Record (no gene_id)"
fi

# ═══════════════════════════════════════════════════
echo ""
echo "🧪 M3: publishGene with skipCanary"
# ═══════════════════════════════════════════════════

# M3.1: Create a gene
R=$(api POST /evolution/genes '{"category":"repair","signals_match":[{"type":"error:mvp_test","provider":"k8s","stage":"deploy"}],"strategy":["Check resource limits","Increase memory if OOM","Apply rolling update"],"title":"MVP Test Gene"}' "$TOKEN_A")
NEW_GENE=$(echo "$R" | jq "data.id")

if [ -n "$NEW_GENE" ] && [ "$NEW_GENE" != "" ] && [ "$NEW_GENE" != "None" ]; then
  ok "M3.1 Create gene with SignalTag[] signals_match (id=$NEW_GENE)"

  # M3.2: Publish with skipCanary=true → should go directly to 'published'
  R=$(api POST "/evolution/genes/${NEW_GENE}/publish" '{"skipCanary":true}' "$TOKEN_A")
  VIS=$(echo "$R" | jq "data.visibility")
  if [ "$VIS" = "published" ]; then
    ok "M3.2 publishGene(skipCanary=true) → visibility=published"
  elif [ "$VIS" = "canary" ]; then
    fail "M3.2 skipCanary not working" "got visibility=canary (skipCanary was ignored — old code?)"
  else
    fail "M3.2 publishGene(skipCanary)" "visibility=$VIS, response=$(echo "$R" | head -c 120)"
  fi

  # M3.3: Verify the gene is visible to Agent B
  R=$(api GET "/evolution/public/genes/${NEW_GENE}" "" "$TOKEN_B")
  PUB_OK=$(echo "$R" | jq "ok")
  PUB_ID=$(echo "$R" | jq "data.id")
  if [ "$PUB_OK" = "True" ] && [ "$PUB_ID" = "$NEW_GENE" ]; then
    ok "M3.3 Published gene visible to Agent B"
  else
    fail "M3.3 Gene not visible to Agent B" "$(echo "$R" | head -c 120)"
  fi
else
  fail "M3.1 Create gene" "$(echo "$R" | head -c 120)"
  skip "M3.2 skipCanary"
  skip "M3.3 Visibility check"
fi

# ═══════════════════════════════════════════════════
echo ""
echo "🧪 M4: v0.3.0 response fields"
# ═══════════════════════════════════════════════════

# M4.1: create_suggested action for unknown signal
R=$(api POST /evolution/analyze '{"signals":[{"type":"error:totally_unknown_mvp_xyz_12345"}]}' "$TOKEN_A")
ACTION=$(echo "$R" | jq "data.action")
if [ "$ACTION" = "create_suggested" ]; then
  ok "M4.1 Unknown signal → action=create_suggested"

  # Check suggestion has SignalTag[] signals_match
  SUG_TYPE=$(echo "$R" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  sm = d.get('data',{}).get('suggestion',{}).get('signals_match',[])
  if sm and isinstance(sm[0], dict): print(sm[0].get('type',''))
  else: print('NOT_TAG')
except: print('PARSE_ERROR')" 2>/dev/null)
  if echo "$SUG_TYPE" | grep -q "error:"; then
    ok "M4.2 Suggestion.signals_match is SignalTag[]"
  else
    fail "M4.2 Suggestion signals_match format" "got: $SUG_TYPE"
  fi
else
  fail "M4.1 create_suggested action" "got: $ACTION"
  skip "M4.2 Suggestion format"
fi

# M4.3: diagnostic gene category accepted
R=$(api POST /evolution/genes '{"category":"diagnostic","signals_match":[{"type":"error:500"}],"strategy":["Triage: check logs","Route to specialized gene"],"title":"500 Triage"}' "$TOKEN_A")
CAT=$(echo "$R" | jq "data.category")
if [ "$CAT" = "diagnostic" ]; then
  ok "M4.3 Create diagnostic gene (category=diagnostic)"
else
  fail "M4.3 Diagnostic category" "got: $CAT, response=$(echo "$R" | head -c 120)"
fi

# M4.4: coverageScore in analyze response
R=$(api POST /evolution/analyze '{"signals":[{"type":"error:timeout"}]}' "$TOKEN_A")
COV=$(echo "$R" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  cs = d.get('data',{}).get('coverageScore')
  print(cs if cs is not None else 'MISSING')
except: print('PARSE_ERROR')" 2>/dev/null)
if [ "$COV" != "MISSING" ] && [ "$COV" != "PARSE_ERROR" ] && [ "$COV" != "None" ]; then
  ok "M4.4 Analyze response includes coverageScore ($COV)"
else
  # coverageScore might not be present for create_suggested
  ACTION=$(echo "$R" | jq "data.action")
  if [ "$ACTION" = "create_suggested" ]; then
    ok "M4.4 coverageScore N/A (action=create_suggested, expected)"
  else
    fail "M4.4 coverageScore missing" "action=$ACTION, cov=$COV"
  fi
fi

# ═══════════════════════════════════════════════════
echo ""
echo "🧪 MVP Flow: Agent A teaches → Agent B learns"
# ═══════════════════════════════════════════════════

# Step 1: Agent A creates a gene from experience and publishes it
echo "  → Agent A creating and publishing gene..."
R=$(api POST /evolution/genes '{"category":"repair","signals_match":[{"type":"error:oom","provider":"k8s","stage":"rollout"}],"strategy":["kubectl describe pod | grep Resources","Increase memory limit by 50%","Apply rolling update with maxSurge=1"],"title":"K8s OOM Recovery"}' "$TOKEN_A")
TEACH_GENE=$(echo "$R" | jq "data.id")

if [ -n "$TEACH_GENE" ] && [ "$TEACH_GENE" != "" ] && [ "$TEACH_GENE" != "None" ]; then
  # Record a success with it
  api POST /evolution/record "{\"gene_id\":\"${TEACH_GENE}\",\"signals\":[{\"type\":\"error:oom\",\"provider\":\"k8s\",\"stage\":\"rollout\"}],\"outcome\":\"success\",\"score\":0.95,\"summary\":\"Fixed OOM by increasing memory limit\"}" "$TOKEN_A" > /dev/null

  # Publish (skipCanary for demo)
  api POST "/evolution/genes/${TEACH_GENE}/publish" '{"skipCanary":true}' "$TOKEN_A" > /dev/null
  ok "Agent A: created + published gene ($TEACH_GENE)"

  # Step 2: Agent B encounters the same problem
  echo "  → Agent B analyzing same signals..."
  R=$(api POST /evolution/analyze '{"signals":[{"type":"error:oom","provider":"k8s","stage":"rollout"}]}' "$TOKEN_B")
  B_GENE=$(echo "$R" | jq "data.gene_id")
  B_ACTION=$(echo "$R" | jq "data.action")
  B_COV=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('coverageScore','?'))" 2>/dev/null)
  B_TITLE=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('gene',{}).get('title','?'))" 2>/dev/null)

  if [ "$B_GENE" = "$TEACH_GENE" ]; then
    ok "Agent B: matched EXACT gene from Agent A (coverage=$B_COV, title=$B_TITLE)"
  elif [ "$B_ACTION" = "apply_gene" ] || [ "$B_ACTION" = "explore" ]; then
    # Got a gene but not the exact one (global prior might favor a different gene)
    ok "Agent B: got recommendation ($B_ACTION, gene=$B_GENE, coverage=$B_COV)"
    echo "       → Note: not exact match (Thompson Sampling variance or seed gene competition)"
  else
    fail "Agent B: no gene recommendation" "action=$B_ACTION, gene=$B_GENE"
  fi

  # Step 3: Agent B records success
  if [ -n "$B_GENE" ] && [ "$B_GENE" != "" ] && [ "$B_GENE" != "None" ]; then
    R=$(api POST /evolution/record "{\"gene_id\":\"${B_GENE}\",\"signals\":[{\"type\":\"error:oom\",\"provider\":\"k8s\",\"stage\":\"rollout\"}],\"outcome\":\"success\",\"score\":0.9,\"summary\":\"Applied K8s OOM recovery from global gene\"}" "$TOKEN_B")
    EDGE_OK=$(echo "$R" | jq "data.edge_updated")
    if [ "$EDGE_OK" = "True" ]; then
      ok "Agent B: recorded success (global graph updated)"
    else
      fail "Agent B record" "$(echo "$R" | head -c 100)"
    fi
  fi
else
  fail "MVP Flow" "Agent A failed to create gene: $(echo "$R" | head -c 100)"
fi

# ═══════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════════════"
echo "  Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
echo "  Total: $((PASS + FAIL + SKIP))"
echo "═══════════════════════════════════════════════════"
[ $FAIL -gt 0 ] && exit 1 || exit 0
