#!/bin/bash
# test.sh — Test and build every active SDK package (respects --scope)
source "$(dirname "$0")/lib/common.sh"
parse_common_flags "$@"

ONLY=""
SKIP=""
for i in "${!REMAINING_ARGS[@]}"; do
  case "${REMAINING_ARGS[$i]}" in
    --only) ONLY="${REMAINING_ARGS[$((i+1))]:-}" ;;
    --skip) SKIP="${REMAINING_ARGS[$((i+1))]:-}" ;;
  esac
done

should_run() {
  local package="$1"
  [[ -z "$ONLY" || "$ONLY" == "$package" ]] && [[ -z "$SKIP" || "$SKIP" != "$package" ]]
}

run_step() {
  local name="$1"
  shift
  if run_or_dry "$@"; then
    record_result "$name" "pass"
  else
    record_result "$name" "fail"
  fi
}

VERSION="$(get_version)"
log_step "SDK Test Suite (v$VERSION, scope: $SCOPE)"

# ── AIP TypeScript ─────────────────────────────────────────────────
if scope_includes_aip && should_run "aip-ts"; then
  log_step "AIP TypeScript"
  cd "$AIP_SDK/typescript"
  run_step "aip-ts-test" npm test
  run_step "aip-ts-build" npm run build
  cd "$PROJECT_ROOT"
fi

# ── AIP Python ─────────────────────────────────────────────────────
if scope_includes_aip && should_run "aip-python"; then
  log_step "AIP Python"
  cd "$AIP_SDK/python"
  run_step "aip-python-test" uv run --isolated --python 3.12 --extra dev pytest tests
  cd "$PROJECT_ROOT"
fi

# ── Cloud TypeScript ───────────────────────────────────────────────
if scope_includes_cloud && should_run "cloud-ts"; then
  log_step "Cloud TypeScript"
  cd "$CLOUD_SDK"
  run_step "cloud-ts-test" npm test -- --run \
    tests/unit \
    test/commands-apc-ack-meta.test.ts \
    test/commands-asset.test.ts \
    test/commands-environment.test.ts \
    test/commands-service-introspect.test.ts \
    test/commands-im-contacts-deferred.test.ts \
    test/v200-content-block-idempotency.test.ts
  run_step "cloud-ts-build" npm run build
  cd "$PROJECT_ROOT"
fi

# ── Cloud Python ───────────────────────────────────────────────────
CLOUD_PYTHON_TESTS=(
  unit_tests/test_environment_client.py
  tests/test_cli_bin_ownership.py
  tests/test_evolution_cache.py
  tests/test_hermes_install.py
  tests/test_hermes_memory_provider.py
  tests/test_offline.py
  tests/test_recall_tools_plugin.py
  tests/test_signal_rules.py
  tests/test_tasks_events_ws.py
  tests/test_v200_content_block_idempotency.py
  tests/test_webhook.py
)
if scope_includes_cloud && should_run "cloud-python"; then
  log_step "Cloud Python"
  cd "$CLOUD_SDK/python"
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "PYTHONPATH=$CLOUD_SDK/python:$AIP_SDK/python uv run --no-project --isolated --python 3.12 --with pytest --with pytest-asyncio --with httpx --with pydantic --with websockets --with click --with rich --with tomli-w --with pynacl --with qrcode pytest ${CLOUD_PYTHON_TESTS[*]}"
    record_result "cloud-python-test" "pass"
  elif PYTHONPATH="$CLOUD_SDK/python:$AIP_SDK/python" \
    PRISMER_API_KEY_TEST="${PRISMER_API_KEY_TEST:-test-local-only}" \
    uv run --no-project --isolated --python 3.12 \
      --with pytest \
      --with pytest-asyncio \
      --with httpx \
      --with pydantic \
      --with websockets \
      --with click \
      --with rich \
      --with tomli-w \
      --with pynacl \
      --with qrcode \
      pytest "${CLOUD_PYTHON_TESTS[@]}"; then
    record_result "cloud-python-test" "pass"
  else
    record_result "cloud-python-test" "fail"
  fi
  cd "$PROJECT_ROOT"
fi

# ── MCP Server ─────────────────────────────────────────────────────
if scope_includes_cloud && should_run "mcp"; then
  log_step "MCP Server"
  cd "$CLOUD_SDK/mcp"
  run_step "mcp-test" npm test
  run_step "mcp-build" npm run build
  cd "$PROJECT_ROOT"
fi

# ── Prismer Runtime ────────────────────────────────────────────────
if scope_includes_prismer && should_run "runtime"; then
  log_step "Prismer Runtime"
  cd "$PRISMER_RUNTIME"
  run_step "runtime-typecheck" npm run typecheck
  run_step "runtime-test" npm test
  run_step "runtime-build" npm run build
  cd "$PROJECT_ROOT"
fi

print_results
