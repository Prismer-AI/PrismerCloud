#!/bin/bash
# verify.sh — Pre-release versions, manifests, tests, and auth checks
source "$(dirname "$0")/lib/common.sh"
parse_common_flags "$@"

SKIP_BUILD=0
for arg in "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"; do
  case "$arg" in --skip-build|--skip-tests) SKIP_BUILD=1 ;; esac
done

VERSION="$(get_version)"
log_step "Pre-Release Verification (v$VERSION, scope: $SCOPE)"

check_contains() {
  local file="$1"
  local expected="$2"
  local label="$3"
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "check $file contains $expected"
    record_result "$label" "pass"
  elif [[ ! -f "$file" ]]; then
    log_error "Missing: $file"
    record_result "$label" "fail"
  elif grep -Fq "$expected" "$file"; then
    record_result "$label" "pass"
  else
    log_error "Mismatch in $file (expected: $expected)"
    record_result "$label" "fail"
  fi
}

check_publish_config() {
  local relative_dir="$1"
  local manifest="$SDK_ROOT/$relative_dir/package.json"
  if node -e "const p=require(process.argv[1]); process.exit(p.publishConfig?.access === 'public' ? 0 : 1)" "$manifest"; then
    record_result "manifest: $relative_dir" "pass"
  else
    record_result "manifest: $relative_dir" "fail"
  fi
}

log_step "Phase 1: Version consistency"
if scope_includes_aip; then
  check_contains "$AIP_SDK/typescript/package.json" "\"version\": \"$VERSION\"" "version: aip/typescript"
  check_contains "$AIP_SDK/python/pyproject.toml" "version = \"$VERSION\"" "version: aip/python"
fi

if scope_includes_cloud; then
  check_contains "$CLOUD_SDK/package.json" "\"version\": \"$VERSION\"" "version: cloud/typescript"
  check_contains "$CLOUD_SDK/python/pyproject.toml" "version = \"$VERSION\"" "version: cloud/python"
  check_contains "$CLOUD_SDK/mcp/package.json" "\"version\": \"$VERSION\"" "version: cloud/mcp"
  check_contains "$CLOUD_SDK/mcp/src/index.ts" "version: '$VERSION'" "version: cloud/mcp source"
  check_contains "$CLOUD_SDK/package.json" "\"@prismer/aip-sdk\": \"^$VERSION\"" "dependency: cloud/aip npm"
  check_contains "$CLOUD_SDK/python/pyproject.toml" "prismer-aip>=$VERSION,<" "dependency: cloud/aip PyPI"
fi

if scope_includes_prismer; then
  check_contains "$PRISMER_RUNTIME/package.json" "\"version\": \"$VERSION\"" "version: prismer/runtime"
  check_contains "$PRISMER_RUNTIME/src/cli/index.ts" "const VERSION = '$VERSION'" "version: runtime CLI"
  check_contains "$PRISMER_RUNTIME/package-lock.json" "\"version\": \"$VERSION\"" "version: runtime lock"
fi

if [[ "$SCOPE" == "all" && $DRY_RUN -eq 0 ]]; then
  if npx tsx "$PROJECT_ROOT/scripts/check-version-consistency.ts"; then
    record_result "monorepo version consistency" "pass"
  else
    record_result "monorepo version consistency" "fail"
  fi
fi

log_step "Phase 2: Package manifests"
if scope_includes_aip; then check_publish_config "${AIP_NPM_PACKAGE_DIRS[0]}"; fi
if scope_includes_cloud; then
  check_publish_config "${CLOUD_NPM_PACKAGE_DIRS[0]}"
  check_publish_config "${CLOUD_NPM_PACKAGE_DIRS[1]}"
fi
if scope_includes_prismer; then check_publish_config "${PRISMER_NPM_PACKAGE_DIRS[0]}"; fi

log_step "Phase 3: Test and build"
if [[ $SKIP_BUILD -eq 0 ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    "$BUILD_ROOT/test.sh" --scope "$SCOPE" --yes --dry-run
  else
    "$BUILD_ROOT/test.sh" --scope "$SCOPE" --yes
  fi
  record_result "test+build" "pass"
else
  record_result "test+build" "skip"
fi

log_step "Phase 4: Publish readiness"
if [[ $DRY_RUN -eq 1 ]]; then
  log_dry "npm, PyPI, and GitHub authentication checks"
  record_result "registry auth" "pass"
else
  if command -v npm &>/dev/null && npm whoami &>/dev/null 2>&1; then
    record_result "npm auth" "pass"
  else
    log_warn "npm is not authenticated"
    record_result "npm auth" "warn"
  fi
  if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
    record_result "github auth" "pass"
  else
    log_warn "GitHub CLI is not authenticated"
    record_result "github auth" "warn"
  fi
fi

print_results
