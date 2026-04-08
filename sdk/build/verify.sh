#!/bin/bash
# verify.sh — Pre-release verification (versions + builds + manifests, respects --scope)
source "$(dirname "$0")/lib/common.sh"
parse_common_flags "$@"

SKIP_TESTS=0; SKIP_BUILD=0
for arg in "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
  esac
done

VERSION="$(get_version)"
AIP_VERSION="$(get_aip_version)"
log_step "Pre-Release Verification (prismer-cloud: v$VERSION, aip: v$AIP_VERSION, scope: $SCOPE)"

# ── Phase 1: Version Consistency ───────────────────────────────────
log_step "Phase 1: Version Consistency"

check_version() {
  local file="$1" expected="$2" label="${3:-$(basename "$(dirname "$file")")}"
  if [[ ! -f "$file" ]]; then
    log_warn "Not found: $file"
    record_result "version: $label" "skip"
    return
  fi
  if grep -q "$expected" "$file"; then
    record_result "version: $label" "pass"
  else
    log_error "Version mismatch in $file (expected $expected)"
    record_result "version: $label" "fail"
  fi
}

if scope_includes_prismer; then
  check_version "$PRISMER_CLOUD/typescript/package.json" "\"version\": \"$VERSION\"" "pc/typescript"
  check_version "$PRISMER_CLOUD/mcp/package.json" "\"version\": \"$VERSION\"" "pc/mcp"
  check_version "$PRISMER_CLOUD/opencode-plugin/package.json" "\"version\": \"$VERSION\"" "pc/opencode"
  check_version "$PRISMER_CLOUD/claude-code-plugin/package.json" "\"version\": \"$VERSION\"" "pc/claude-code"
  check_version "$PRISMER_CLOUD/openclaw-channel/package.json" "\"version\": \"$VERSION\"" "pc/openclaw"
  check_version "$PRISMER_CLOUD/python/pyproject.toml" "version = \"$VERSION\"" "pc/python"
  check_version "$PRISMER_CLOUD/rust/Cargo.toml" "version = \"$VERSION\"" "pc/rust"
  check_version "$PRISMER_CLOUD/mcp/src/index.ts" "'$VERSION'" "pc/mcp-hardcoded"
  check_version "$PRISMER_CLOUD/claude-code-plugin/.claude-plugin/plugin.json" "\"version\": \"$VERSION\"" "pc/plugin.json"
fi

if scope_includes_aip; then
  check_version "$AIP_SDK/typescript/package.json" "\"version\": \"$AIP_VERSION\"" "aip/typescript"
  check_version "$AIP_SDK/python/pyproject.toml" "version = \"$AIP_VERSION\"" "aip/python"
  check_version "$AIP_SDK/rust/Cargo.toml" "version = \"$AIP_VERSION\"" "aip/rust"
fi

# ── Phase 2: Package Manifests ─────────────────────────────────────
log_step "Phase 2: Package Manifests"

if scope_includes_prismer; then
  for pkg in "${NPM_PACKAGES[@]}"; do
    local_pkg="$PRISMER_CLOUD/$pkg/package.json"
    if [[ -f "$local_pkg" ]]; then
      if grep -q '"access": "public"' "$local_pkg" || [[ "$pkg" == "claude-code-plugin" ]]; then
        record_result "manifest: $pkg publishConfig" "pass"
      else
        log_warn "$pkg missing publishConfig.access=public"
        record_result "manifest: $pkg publishConfig" "warn"
      fi
    fi
  done
fi

# ── Phase 3: Build Verification ────────────────────────────────────
if [[ $SKIP_BUILD -eq 0 ]]; then
  log_step "Phase 3: Build Verification"
  "$BUILD_ROOT/test.sh" --yes --scope "$SCOPE" 2>&1 | tail -20
else
  log_info "Skipping build (--skip-build)"
fi

# ── Phase 4: Publish Readiness ─────────────────────────────────────
log_step "Phase 4: Publish Readiness"

if command -v npm &>/dev/null && npm whoami &>/dev/null 2>&1; then
  record_result "npm auth" "pass"
else
  record_result "npm auth" "warn"
  log_warn "npm not authenticated (run: npm login --scope=@prismer)"
fi

if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
  record_result "github auth" "pass"
else
  record_result "github auth" "warn"
  log_warn "gh not authenticated (run: gh auth login)"
fi

if [[ -n "${CARGO_REGISTRY_TOKEN:-}" ]]; then
  record_result "cargo auth" "pass"
else
  record_result "cargo auth" "warn"
  log_warn "CARGO_REGISTRY_TOKEN not set"
fi

print_results
