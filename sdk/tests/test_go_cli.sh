#!/bin/bash
# Go SDK CLI Integration Test — agent-autonomous invocation
# Uses the Go CLI's proper workflow: init → register → use IM commands
#
# Usage: bash sdk/tests/test_go_cli.sh

BASE="http://localhost:3200"
PASS="\033[32m✓\033[0m"
FAIL="\033[31m✗\033[0m"
PASSED=0
FAILED=0
FAILURES=""
TS=$(date +%s)

check() {
  if [ $1 -eq 0 ]; then
    echo -e "  $PASS $2"
    PASSED=$((PASSED + 1))
  else
    echo -e "  $FAIL $2 — $3"
    FAILED=$((FAILED + 1))
    FAILURES="$FAILURES\n  $FAIL $2 — $3"
  fi
}

echo "═══ Go SDK CLI Integration Test ═══"
echo "Target: $BASE"
echo ""

# Build Go CLI
echo "Building Go CLI..."
cd sdk/golang && go build -o /tmp/prismer-go ./cmd/prismer 2>/dev/null && cd ../..
CLI="/tmp/prismer-go"

# Use a temporary HOME so we don't pollute real config
export HOME=$(mktemp -d)
echo "Temp HOME: $HOME"

# ── Phase 1: Init + Register (proper CLI workflow) ──
echo ""
echo "── Phase 1: Init + Register ──"

# First get a temp API key via curl (since register needs an API key)
REG_PRE=$(curl -s "$BASE/api/register" -X POST -H 'Content-Type: application/json' \
  -d "{\"type\":\"agent\",\"username\":\"go-pre-$TS\",\"displayName\":\"Pre\"}")
PRE_TOKEN=$(echo "$REG_PRE" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['token'])")

# prismer init — saves API key to config
$CLI init "$PRE_TOKEN" 2>/dev/null
check $? "prismer init"

# Manually set base_url in config (CLI init doesn't support it as arg)
mkdir -p "$HOME/.prismer"
cat > "$HOME/.prismer/config.toml" << EOF
[default]
api_key = "$PRE_TOKEN"
base_url = "$BASE"

[auth]
EOF

$CLI status 2>&1 | grep -q "API Key:" && check 0 "prismer status" "" || check 1 "prismer status" "no output"

# prismer register — stores IM token in config
$CLI register "go-agent-$TS" --display-name "Go Test Agent" --agent-type assistant 2>&1
check $? "prismer register"

# Verify config has IM token
grep -q "im_token" "$HOME/.prismer/config.toml" && check 0 "config has im_token" "" || check 1 "config has im_token" "missing"

# ── Phase 2: Evolution Commands ──
echo ""
echo "── Phase 2: Evolution ──"

$CLI evolve stats 2>/dev/null; check $? "evolve stats" "error"
$CLI evolve analyze -e "Connection refused" 2>/dev/null; check $? "evolve analyze" "error"
$CLI evolve genes 2>/dev/null; check $? "evolve genes" "error"
$CLI evolve metrics 2>/dev/null; check $? "evolve metrics" "error"

# ── Phase 3: IM Commands ──
echo ""
echo "── Phase 3: IM Commands ──"

$CLI im me 2>/dev/null; check $? "im me" "error"
$CLI im discover 2>/dev/null; check $? "im discover" "error"
$CLI im conversations 2>/dev/null; check $? "im conversations" "error"
$CLI im contacts 2>/dev/null; check $? "im contacts" "error"

# Register second agent and send message
REG2=$(curl -s "$BASE/api/register" -X POST -H 'Content-Type: application/json' \
  -d "{\"type\":\"agent\",\"username\":\"go-b-$TS\",\"displayName\":\"B\"}")
UID2=$(echo "$REG2" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['imUserId'])")

$CLI im send "$UID2" "Hello from Go CLI!" 2>/dev/null; check $? "im send" "error"

# ── Phase 4: Signal Rules (Go library, not CLI) ──
echo ""
echo "── Phase 4: Signal Rules (Go) ──"
cd sdk/golang
go test -run TestExtractSignals -count=1 ./... 2>/dev/null
if [ $? -eq 0 ]; then
  check 0 "signal rules test" ""
else
  # No test file exists yet — write a quick one
  cat > signal_rules_test.go << 'GOTEST'
package prismer

import "testing"

func TestExtractSignals(t *testing.T) {
	tests := []struct{
		ctx SignalExtractionContext
		expect string
	}{
		{SignalExtractionContext{Error: "Connection timed out"}, "error:timeout"},
		{SignalExtractionContext{Error: "ECONNREFUSED"}, "error:connection_refused"},
		{SignalExtractionContext{Error: "panic: segfault"}, "error:crash"},
		{SignalExtractionContext{Error: "rate limit exceeded"}, "error:rate_limit"},
		{SignalExtractionContext{TaskStatus: "failed"}, "task.failed"},
	}
	for _, tt := range tests {
		signals := ExtractSignals(tt.ctx)
		if len(signals) == 0 {
			t.Errorf("Expected signals for %v", tt.ctx)
			continue
		}
		if signals[0].Type != tt.expect {
			t.Errorf("Expected %s, got %s", tt.expect, signals[0].Type)
		}
	}
}
GOTEST
  go test -run TestExtractSignals -count=1 . 2>/dev/null
  check $? "signal rules test" "test failed"
fi
cd ../..

# ── Summary ──
echo ""
echo "═══ Summary ═══"
echo "  Passed:  $PASSED"
echo "  Failed:  $FAILED"
if [ -n "$FAILURES" ]; then
  echo -e "\n  Failures:$FAILURES"
fi
echo ""

# Cleanup
rm -rf "$HOME"

exit $FAILED
