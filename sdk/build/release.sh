#!/bin/bash
# release.sh — Full release pipeline: verify → pack → install smoke → sync → publish
source "$(dirname "$0")/lib/common.sh"
parse_common_flags "$@"

VERSION_FLAG=""
SKIP_VERIFY=0
SKIP_SYNC=0
SKIP_PACK=0
SKIP_INSTALL_LOCAL=0
SKIP_SMOKE=0
NPM_ONLY=0
PYPI_ONLY=0
CRATES_ONLY=0
GITHUB_ONLY=0

for i in "${!REMAINING_ARGS[@]}"; do
  case "${REMAINING_ARGS[$i]}" in
    --version) VERSION_FLAG="${REMAINING_ARGS[$((i+1))]:-}" ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    --skip-sync) SKIP_SYNC=1 ;;
    --skip-pack) SKIP_PACK=1 ;;
    --skip-install-local) SKIP_INSTALL_LOCAL=1 ;;
    --skip-smoke) SKIP_SMOKE=1 ;;
    --npm-only) NPM_ONLY=1 ;;
    --pypi-only) PYPI_ONLY=1 ;;
    --crates-only) CRATES_ONLY=1 ;;
    --github-only) GITHUB_ONLY=1 ;;
  esac
done

VERSION="${VERSION_FLAG:-$(get_version)}"
if [[ "$VERSION" == "unknown" || -z "$VERSION" ]]; then
  log_error "Cannot determine version. Use --version X.Y.Z"
  exit 1
fi

canonical_path() {
  local path="$1"
  [[ -d "$path" ]] || return 1
  (cd "$path" && pwd -P)
}

ensure_external_target() {
  local source_sdk target_sdk
  source_sdk="$(canonical_path "$SDK_ROOT")" || {
    log_error "Source sdk/ not found: $SDK_ROOT"
    exit 1
  }
  target_sdk="$(canonical_path "$OPENSRC_SDK")" || return 0
  if [[ "$source_sdk" == "$target_sdk" ]]; then
    log_error "Source sdk/ and target sdk/ resolve to the same directory."
    log_error "Run release.sh from the private source repo, not from the open-source mirror."
    exit 1
  fi
}

require_target_repo() {
  if [[ $do_sync -eq 0 && $do_git -eq 0 && $do_github -eq 0 && $do_crates -eq 0 ]]; then
    return 0
  fi
  if [[ ! -d "$OPENSRC_ROOT/.git" ]]; then
    log_error "Open-source repo not found or not a git checkout: $OPENSRC_ROOT"
    exit 1
  fi
}

require_publish_credentials() {
  local cred_dir="$OPENSRC_ROOT"
  local missing=0

  if [[ $do_npm -eq 1 ]]; then
    if [[ -f "$cred_dir/.npmrc" ]]; then
      :
    elif npm whoami &>/dev/null; then
      :
    else
      log_error "npm auth missing. Add $cred_dir/.npmrc or login with npm."
      missing=1
    fi
  fi

  if [[ $do_pypi -eq 1 ]]; then
    if [[ -f "$cred_dir/.pypirc" || -n "${TWINE_CONFIG_FILE:-}" || -n "${TWINE_USERNAME:-}" || -n "${TWINE_PASSWORD:-}" ]]; then
      :
    else
      log_error "PyPI auth missing. Add $cred_dir/.pypirc or export TWINE_* credentials."
      missing=1
    fi
  fi

  if [[ $do_crates -eq 1 ]]; then
    if [[ -f "$cred_dir/.cargo-credentials" || -n "${CARGO_REGISTRY_TOKEN:-}" ]]; then
      :
    else
      log_error "crates.io auth missing. Add $cred_dir/.cargo-credentials or export CARGO_REGISTRY_TOKEN."
      missing=1
    fi
  fi

  if [[ $do_github -eq 1 ]] && ! gh auth status &>/dev/null 2>&1; then
    log_error "gh auth missing. Run gh auth login first."
    missing=1
  fi

  [[ $missing -eq 0 ]]
}

# Determine targets
do_sync=1
do_git=1
do_github=1
do_npm=1
do_pypi=1
do_crates=1

[[ $SKIP_SYNC -eq 1 ]] && do_sync=0
if [[ $NPM_ONLY -eq 1 ]]; then
  do_sync=0
  do_git=0
  do_github=0
  do_pypi=0
  do_crates=0
fi
if [[ $PYPI_ONLY -eq 1 ]]; then
  do_sync=0
  do_git=0
  do_github=0
  do_npm=0
  do_crates=0
fi
if [[ $CRATES_ONLY -eq 1 ]]; then
  do_sync=0
  do_git=0
  do_github=0
  do_npm=0
  do_pypi=0
fi
if [[ $GITHUB_ONLY -eq 1 ]]; then
  do_npm=0
  do_pypi=0
  do_crates=0
fi

ensure_external_target
require_target_repo
require_publish_credentials || exit 1

log_step "Release v$VERSION"
log_info "Scope: $SCOPE"
log_info "Source: $SDK_ROOT"
log_info "Target: $OPENSRC_ROOT"
[[ $DRY_RUN -eq 1 ]] && log_warn "DRY-RUN mode"

confirm_prompt "Release v$VERSION?"

# ── 1. Verify ───────────────────────────────────────────────────────
log_step "1/7 Verify"
if [[ $SKIP_VERIFY -eq 0 ]]; then
  "$BUILD_ROOT/verify.sh" --scope "$SCOPE" --yes
  record_result "verify" "pass"
else
  log_info "Skipping (--skip-verify)"
  record_result "verify" "skip"
fi

# ── 2. Pack ─────────────────────────────────────────────────────────
log_step "2/7 Pack Artifacts"
if [[ $SKIP_PACK -eq 0 ]]; then
  "$BUILD_ROOT/pack.sh" --scope "$SCOPE" --clean --yes
  record_result "pack" "pass"
else
  log_info "Skipping (--skip-pack, using pre-built artifacts)"
  record_result "pack" "skip"
fi

# ── 3. Local install smoke ──────────────────────────────────────────
if scope_includes_prismer; then
  log_step "3/7 Local Install Smoke"
  if [[ $SKIP_INSTALL_LOCAL -eq 0 ]]; then
    "$BUILD_ROOT/install-local.sh" --skip-pack
    record_result "install-local" "pass"
  else
    log_info "Skipping (--skip-install-local)"
    record_result "install-local" "skip"
  fi
else
  record_result "install-local" "skip"
fi

# ── 4. Sandbox smoke ────────────────────────────────────────────────
if scope_includes_prismer; then
  log_step "4/7 Sandbox Smoke"
  if [[ $SKIP_SMOKE -eq 0 ]]; then
    "$BUILD_ROOT/smoke-test.sh" --scope "$SCOPE" --skip-pack --yes
    record_result "smoke-test" "pass"
  else
    log_info "Skipping (--skip-smoke)"
    record_result "smoke-test" "skip"
  fi
else
  record_result "smoke-test" "skip"
fi

# ── 5. Sync to open source ──────────────────────────────────────────
if [[ $do_sync -eq 1 ]]; then
  log_step "5/7 Sync → PrismerCloud"
  "$BUILD_ROOT/sync.sh" --scope "$SCOPE" --yes
  record_result "sync" "pass"
else
  record_result "sync" "skip"
fi

# ── 6. Git tags + GitHub release ────────────────────────────────────
if [[ $do_git -eq 1 ]]; then
  log_step "6/7 Git Tags"
  cd "$OPENSRC_ROOT"
  TARGET_BRANCH="$(git branch --show-current)"
  confirm_prompt "Commit sdk/, tag v$VERSION, and push $TARGET_BRANCH?"
  run_or_dry git add -- sdk
  if git diff --cached --quiet -- sdk; then
    log_warn "No staged sdk/ changes to commit in $OPENSRC_ROOT"
    record_result "git-commit" "warn"
  else
    run_or_dry git commit -m "Release v$VERSION"
    record_result "git-commit" "pass"
  fi
  run_or_dry git tag "v$VERSION"
  run_or_dry git tag "sdk/prismer-cloud/golang/v$VERSION"
  run_or_dry git push origin "$TARGET_BRANCH" "v$VERSION" "sdk/prismer-cloud/golang/v$VERSION"
  record_result "git-tags" "pass"
  cd "$PROJECT_ROOT"
else
  record_result "git-commit" "skip"
  record_result "git-tags" "skip"
fi

if [[ $do_github -eq 1 ]]; then
  log_step "GitHub Release"
  cd "$OPENSRC_ROOT"
  confirm_prompt "Create GitHub Release v$VERSION?"
  run_or_dry gh release create "v$VERSION" \
    --title "v$VERSION" \
    --generate-notes \
    "$ARTIFACTS_DIR"/npm/*.tgz \
    "$ARTIFACTS_DIR"/pypi/*.whl \
    "$ARTIFACTS_DIR"/pypi/*.tar.gz 2>/dev/null
  record_result "github-release" "pass"
  cd "$PROJECT_ROOT"
else
  record_result "github-release" "skip"
fi

# ── 7. Registry publish ─────────────────────────────────────────────
log_step "7/7 Publish to Registries"

CRED_DIR="$OPENSRC_ROOT"

if [[ $do_npm -eq 1 ]]; then
  if [[ -f "$CRED_DIR/.npmrc" ]]; then
    log_info "Using $CRED_DIR/.npmrc for npm auth"
    export NPM_CONFIG_USERCONFIG="$CRED_DIR/.npmrc"
  fi
  confirm_prompt "Publish npm artifacts?"
  for tgz in "$ARTIFACTS_DIR"/npm/*.tgz; do
    [[ -f "$tgz" ]] || continue
    log_info "npm publish $(basename "$tgz")"
    run_or_dry npm publish "$tgz" --access public
  done
  record_result "npm-publish" "pass"
else
  record_result "npm-publish" "skip"
fi

if [[ $do_pypi -eq 1 ]]; then
  resolve_twine_command || exit 1
  if [[ -f "$CRED_DIR/.pypirc" ]]; then
    log_info "Using $CRED_DIR/.pypirc for PyPI auth"
    export TWINE_CONFIG_FILE="$CRED_DIR/.pypirc"
  fi
  confirm_prompt "Upload PyPI artifacts?"
  run_or_dry "${TWINE_CMD[@]}" upload "$ARTIFACTS_DIR"/pypi/*
  record_result "pypi-upload" "pass"
else
  record_result "pypi-upload" "skip"
fi

if [[ $do_crates -eq 1 ]]; then
  if [[ -f "$CRED_DIR/.cargo-credentials" ]]; then
    log_info "Loading $CRED_DIR/.cargo-credentials"
    source "$CRED_DIR/.cargo-credentials"
  fi
  confirm_prompt "Publish crates.io artifact?"
  cd "$OPENSRC_SDK/prismer-cloud/rust"
  run_or_dry cargo publish --allow-dirty
  record_result "crates-publish" "pass"
  cd "$PROJECT_ROOT"
else
  record_result "crates-publish" "skip"
fi

# ── Summary ─────────────────────────────────────────────────────────
log_step "Release Complete: v$VERSION"
print_results
