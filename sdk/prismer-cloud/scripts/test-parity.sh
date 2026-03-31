#!/bin/bash
#
# SDK Cross-Language Parity Test Runner
#
# Runs parity tests for all 4 SDKs and compares pass/fail across languages.
# Each test has an ID (P1.1, P2.1, etc.) shared across all languages.
#
# Usage:
#   PRISMER_API_KEY_TEST="sk-prismer-..." ./sdk/prismer-cloud/scripts/test-parity.sh
#   PRISMER_API_KEY_TEST="..." PRISMER_BASE_URL_TEST="https://cloud.prismer.dev" ./sdk/prismer-cloud/scripts/test-parity.sh
#
# Options:
#   --ts-only    Run TypeScript only
#   --py-only    Run Python only
#   --go-only    Run Go only
#   --rs-only    Run Rust only

set -e

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
SDK="$ROOT/sdk/prismer-cloud"

if [ -z "$PRISMER_API_KEY_TEST" ]; then
  echo "❌ PRISMER_API_KEY_TEST is required"
  exit 1
fi

export PRISMER_API_KEY_TEST
export PRISMER_BASE_URL_TEST="${PRISMER_BASE_URL_TEST:-https://cloud.prismer.dev}"

echo "🧪 SDK Cross-Language Parity Tests"
echo "   Base URL: $PRISMER_BASE_URL_TEST"
echo ""

RESULTS=()
PASS=0
FAIL=0

run_ts() {
  echo "━━━ TypeScript ━━━"
  cd "$SDK/typescript"
  if npx vitest run tests/integration/sdk-parity.test.ts --reporter=verbose 2>&1 | tee /tmp/parity-ts.log; then
    RESULTS+=("TS:PASS")
    ((PASS++))
  else
    RESULTS+=("TS:FAIL")
    ((FAIL++))
  fi
  echo ""
}

run_py() {
  echo "━━━ Python ━━━"
  cd "$SDK/python"
  if python -m pytest tests/test_parity.py -v 2>&1 | tee /tmp/parity-py.log; then
    RESULTS+=("PY:PASS")
    ((PASS++))
  else
    RESULTS+=("PY:FAIL")
    ((FAIL++))
  fi
  echo ""
}

run_go() {
  echo "━━━ Go ━━━"
  cd "$SDK/golang"
  if go test -tags=integration -v -run TestParity -timeout 120s 2>&1 | tee /tmp/parity-go.log; then
    RESULTS+=("GO:PASS")
    ((PASS++))
  else
    RESULTS+=("GO:FAIL")
    ((FAIL++))
  fi
  echo ""
}

run_rs() {
  echo "━━━ Rust ━━━"
  cd "$SDK/rust"
  if cargo test --test parity -- --nocapture 2>&1 | tee /tmp/parity-rs.log; then
    RESULTS+=("RS:PASS")
    ((PASS++))
  else
    RESULTS+=("RS:FAIL")
    ((FAIL++))
  fi
  echo ""
}

# Parse args
case "${1:-all}" in
  --ts-only) run_ts ;;
  --py-only) run_py ;;
  --go-only) run_go ;;
  --rs-only) run_rs ;;
  *)
    run_ts
    run_py
    run_go
    run_rs
    ;;
esac

# Summary
echo "════════════════════════════════════════"
echo "  PARITY RESULTS: ${RESULTS[*]}"
echo "  Passed: $PASS / $((PASS + FAIL))"
echo "════════════════════════════════════════"

if [ $FAIL -gt 0 ]; then
  echo ""
  echo "⚠️  Parity mismatch detected. Check logs:"
  echo "  TypeScript: /tmp/parity-ts.log"
  echo "  Python:     /tmp/parity-py.log"
  echo "  Go:         /tmp/parity-go.log"
  echo "  Rust:       /tmp/parity-rs.log"
  exit 1
fi
