#!/bin/bash
# test.sh — Run all SDK tests against production
source "$(dirname "$0")/lib/common.sh"
parse_common_flags "$@"

# ── Parse script-specific flags ──────────────────────────────────
ONLY=""
SKIP=""
INCLUDE_INTEGRATION=0
args=()
i=0
while [[ $i -lt ${#REMAINING_ARGS[@]} ]]; do
  case "${REMAINING_ARGS[$i]}" in
    --only)
      ((i++))
      ONLY="${REMAINING_ARGS[$i]}"
      ;;
    --skip)
      ((i++))
      SKIP="${REMAINING_ARGS[$i]}"
      ;;
    --include-integration)
      INCLUDE_INTEGRATION=1
      ;;
    *)
      args+=("${REMAINING_ARGS[$i]}")
      ;;
  esac
  ((i++))
done
REMAINING_ARGS=("${args[@]+"${args[@]}"}")

# ── Helpers ───────────────────────────────────────────────────────
should_skip() {
  local name="$1"
  # If --only is set, skip everything except that test
  if [[ -n "$ONLY" && "$name" != "$ONLY" ]]; then
    return 0
  fi
  # If --skip matches, skip it
  if [[ -n "$SKIP" && "$SKIP" == "$name" ]]; then
    return 0
  fi
  return 1
}

run_test() {
  local name="$1" func="$2"
  log_step "Testing: $name"
  if should_skip "$name"; then
    record_result "$name" "skip"
    return
  fi
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "Would run $name tests"
    record_result "$name" "skip"
    return
  fi
  if (set +e; $func; ); then
    record_result "$name" "pass"
  else
    record_result "$name" "fail"
  fi
}

# ── Test Functions ────────────────────────────────────────────────
test_typescript() {
  cd "$SDK_DIR/typescript"
  [[ -d node_modules ]] || npm install --prefer-offline --no-audit 2>&1
  # Run unit tests only (webhook + storage-offline). Integration/file-upload need PRISMER_API_KEY_TEST.
  PRISMER_BASE_URL=https://prismer.cloud npx vitest run tests/webhook.test.ts tests/storage-offline.test.ts 2>&1
}

test_python() {
  cd "$SDK_DIR/python"
  if [[ ! -d .venv ]]; then
    # Use python3.11+ (SDK requires >=3.10)
    local py=$(command -v python3.11 || command -v python3.12 || command -v python3.10 || command -v python3)
    "$py" -m venv .venv 2>&1
  fi
  source .venv/bin/activate
  pip install --quiet --upgrade pip 2>&1
  pip install --quiet '.[dev]' 2>&1
  # Run webhook tests only (no conftest — it requires API key).
  PRISMER_BASE_URL=https://prismer.cloud python -m pytest tests/test_webhook.py -v --noconftest 2>&1
}

test_golang() {
  cd "$SDK_DIR/golang"
  # Run webhook tests only. Integration tests need PRISMER_API_KEY_TEST.
  GOFLAGS="" PRISMER_BASE_URL=https://prismer.cloud go test -v -run "^TestVerify|^TestParse|^TestNew|^TestPrismerWebhook" ./... 2>&1
}

test_rust() {
  cd "$SDK_DIR/rust"
  cargo test 2>&1
}

test_mcp() {
  cd "$SDK_DIR/mcp"
  [[ -d node_modules ]] || npm install --prefer-offline --no-audit 2>&1
  npm run build 2>&1
}

test_opencode() {
  cd "$SDK_DIR/opencode-plugin"
  [[ -d node_modules ]] || npm install --prefer-offline --no-audit 2>&1
  # Ensure @types/node is installed (not in source devDependencies)
  npm install --save-dev @types/node 2>&1 | tail -1
  npm run build 2>&1
}

test_claude_code() {
  cd "$SDK_DIR/claude-code-plugin"
  local files=(".claude-plugin/plugin.json" "hooks/hooks.json" ".mcp.json")
  for f in "${files[@]}"; do
    if [[ ! -f "$f" ]]; then
      log_error "Missing file: $f"
      return 1
    fi
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1]))' "$f" 2>&1
    if [[ $? -ne 0 ]]; then
      log_error "Failed to parse $f"
      return 1
    fi
  done
  log_success "JSON files validated"
}

test_openclaw() {
  # OpenClaw channel is source-distributed (OpenClaw compiles it).
  # Validate files exist and JSON is parseable.
  cd "$SDK_DIR/openclaw-channel"
  for f in index.ts openclaw.plugin.json package.json; do
    if [[ ! -f "$f" ]]; then
      log_error "Missing file: $f"
      return 1
    fi
  done
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1]))' openclaw.plugin.json 2>&1
  log_success "OpenClaw channel files validated"
}

test_integration() {
  PRISMER_BASE_URL=https://prismer.cloud npx tsx "$SDK_DIR/tests/sdk-integration.ts" 2>&1
}

# ── Run Tests ─────────────────────────────────────────────────────
log_step "Running SDK tests against production"
log_info "PRISMER_BASE_URL=https://prismer.cloud"

run_test "typescript"   test_typescript
run_test "python"       test_python
run_test "golang"       test_golang
run_test "rust"         test_rust
run_test "mcp"          test_mcp
run_test "opencode"     test_opencode
run_test "claude-code"  test_claude_code
run_test "openclaw"     test_openclaw

if [[ $INCLUDE_INTEGRATION -eq 1 ]]; then
  run_test "integration" test_integration
else
  log_info "Skipping integration tests (use --include-integration to enable)"
  record_result "integration" "skip"
fi

# ── Results ───────────────────────────────────────────────────────
print_results
exit $?
