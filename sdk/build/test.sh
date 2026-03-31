#!/bin/bash
# test.sh — Build and test all SDK packages
source "$(dirname "$0")/lib/common.sh"
parse_common_flags "$@"

ONLY=""
SKIP=""
for arg in "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"; do
  case "$arg" in
    --only)   shift_next=1 ;;
    --skip)   shift_skip=1 ;;
    *)
      if [[ "${shift_next:-}" == "1" ]]; then ONLY="$arg"; shift_next=0
      elif [[ "${shift_skip:-}" == "1" ]]; then SKIP="$arg"; shift_skip=0; fi
      ;;
  esac
done
# Re-parse --only/--skip properly
for i in "${!REMAINING_ARGS[@]}"; do
  case "${REMAINING_ARGS[$i]}" in
    --only) ONLY="${REMAINING_ARGS[$((i+1))]:-}" ;;
    --skip) SKIP="${REMAINING_ARGS[$((i+1))]:-}" ;;
  esac
done

should_run() {
  local pkg="$1"
  if [[ -n "$ONLY" && "$ONLY" != "$pkg" ]]; then return 1; fi
  if [[ -n "$SKIP" && "$SKIP" == "$pkg" ]]; then return 1; fi
  return 0
}

VERSION="$(get_version)"
log_step "SDK Test Suite (v$VERSION)"

# ── TypeScript SDK ─────────────────────────────────────────────────
if should_run "typescript" || should_run "ts"; then
  log_step "TypeScript SDK"
  cd "$PRISMER_CLOUD/typescript"
  if run_or_dry npm run build; then
    record_result "ts-build" "pass"
  else
    record_result "ts-build" "fail"
  fi
  cd "$PROJECT_ROOT"
else
  record_result "ts-build" "skip"
fi

# ── MCP Server ─────────────────────────────────────────────────────
if should_run "mcp"; then
  log_step "MCP Server"
  cd "$PRISMER_CLOUD/mcp"
  if run_or_dry npm run build; then
    record_result "mcp-build" "pass"
  else
    record_result "mcp-build" "fail"
  fi
  cd "$PROJECT_ROOT"
else
  record_result "mcp-build" "skip"
fi

# ── OpenCode Plugin ────────────────────────────────────────────────
if should_run "opencode"; then
  log_step "OpenCode Plugin"
  cd "$PRISMER_CLOUD/opencode-plugin"
  if run_or_dry npm run build; then
    record_result "opencode-build" "pass"
  else
    record_result "opencode-build" "fail"
  fi
  cd "$PROJECT_ROOT"
else
  record_result "opencode-build" "skip"
fi

# ── Claude Code Plugin ────────────────────────────────────────────
if should_run "claude-code"; then
  log_step "Claude Code Plugin"
  # No build step — validate hooks.json + skill files
  if [[ -f "$PRISMER_CLOUD/claude-code-plugin/hooks/hooks.json" ]]; then
    node -e "JSON.parse(require('fs').readFileSync('$PRISMER_CLOUD/claude-code-plugin/hooks/hooks.json','utf8'))" 2>/dev/null
    if [[ $? -eq 0 ]]; then
      record_result "claude-code-validate" "pass"
    else
      record_result "claude-code-validate" "fail"
    fi
  else
    record_result "claude-code-validate" "fail"
  fi
else
  record_result "claude-code-validate" "skip"
fi

# ── Python SDK ─────────────────────────────────────────────────────
if should_run "python" || should_run "py"; then
  log_step "Python SDK"
  cd "$PRISMER_CLOUD/python"
  if command -v python3 &>/dev/null; then
    if run_or_dry python3 -c "import ast; ast.parse(open('prismer/client.py').read())"; then
      record_result "python-syntax" "pass"
    else
      record_result "python-syntax" "fail"
    fi
  else
    record_result "python-syntax" "skip"
  fi
  cd "$PROJECT_ROOT"
else
  record_result "python-syntax" "skip"
fi

# ── Go SDK ─────────────────────────────────────────────────────────
if should_run "golang" || should_run "go"; then
  log_step "Go SDK"
  cd "$PRISMER_CLOUD/golang"
  if command -v go &>/dev/null; then
    if run_or_dry go build ./...; then
      record_result "go-build" "pass"
    else
      record_result "go-build" "fail"
    fi
  else
    record_result "go-build" "skip"
  fi
  cd "$PROJECT_ROOT"
else
  record_result "go-build" "skip"
fi

# ── Rust SDK ───────────────────────────────────────────────────────
if should_run "rust"; then
  log_step "Rust SDK"
  cd "$PRISMER_CLOUD/rust"
  if command -v cargo &>/dev/null; then
    if run_or_dry cargo check; then
      record_result "rust-check" "pass"
    else
      record_result "rust-check" "fail"
    fi
  else
    record_result "rust-check" "skip"
  fi
  cd "$PROJECT_ROOT"
else
  record_result "rust-check" "skip"
fi

# ── Next.js Build ──────────────────────────────────────────────────
if should_run "next" || should_run "server"; then
  log_step "Next.js Build"
  cd "$PROJECT_ROOT"
  if run_or_dry npx next build; then
    record_result "next-build" "pass"
  else
    record_result "next-build" "fail"
  fi
else
  record_result "next-build" "skip"
fi

print_results
