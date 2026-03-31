#!/bin/bash
# release.sh — Full release pipeline: build → sync → verify → pack → publish
source "$(dirname "$0")/lib/common.sh"
parse_common_flags "$@"

VERSION_FLAG=""; SKIP_VERIFY=0; SKIP_SYNC=0; SKIP_PACK=0
NPM_ONLY=0; PYPI_ONLY=0; CRATES_ONLY=0; GITHUB_ONLY=0

for i in "${!REMAINING_ARGS[@]}"; do
  case "${REMAINING_ARGS[$i]}" in
    --version)    VERSION_FLAG="${REMAINING_ARGS[$((i+1))]:-}" ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    --skip-sync)  SKIP_SYNC=1 ;;
    --skip-pack)  SKIP_PACK=1 ;;
    --npm-only)   NPM_ONLY=1 ;;
    --pypi-only)  PYPI_ONLY=1 ;;
    --crates-only) CRATES_ONLY=1 ;;
    --github-only) GITHUB_ONLY=1 ;;
  esac
done

VERSION="${VERSION_FLAG:-$(get_version)}"
if [[ "$VERSION" == "unknown" || -z "$VERSION" ]]; then
  log_error "Cannot determine version. Use --version X.Y.Z"
  exit 1
fi

# Determine targets
do_sync=1; do_git=1; do_github=1; do_npm=1; do_pypi=1; do_crates=1
[[ $SKIP_SYNC -eq 1 ]] && do_sync=0
if [[ $NPM_ONLY -eq 1 ]]; then do_sync=0; do_git=0; do_github=0; do_pypi=0; do_crates=0; fi
if [[ $PYPI_ONLY -eq 1 ]]; then do_sync=0; do_git=0; do_github=0; do_npm=0; do_crates=0; fi
if [[ $CRATES_ONLY -eq 1 ]]; then do_sync=0; do_git=0; do_github=0; do_npm=0; do_pypi=0; fi
if [[ $GITHUB_ONLY -eq 1 ]]; then do_sync=0; do_npm=0; do_pypi=0; do_crates=0; fi

log_step "Release v$VERSION"
log_info "Source: $SDK_ROOT"
log_info "Target: $OPENSRC_ROOT"
[[ $DRY_RUN -eq 1 ]] && log_warn "DRY-RUN mode"

confirm_prompt "Release v$VERSION to all registries?"

# ── 1. Build & Test ────────────────────────────────────────────────
log_step "1/6 Build & Test"
if [[ $SKIP_VERIFY -eq 0 ]]; then
  "$BUILD_ROOT/test.sh" --yes
  record_result "build+test" "pass"
else
  log_info "Skipping (--skip-verify)"
  record_result "build+test" "skip"
fi

# ── 2. Sync to Open Source ─────────────────────────────────────────
if [[ $do_sync -eq 1 ]]; then
  log_step "2/6 Sync → PrismerCloud"
  "$BUILD_ROOT/sync.sh" --yes
  record_result "sync" "pass"
else
  record_result "sync" "skip"
fi

# ── 3. Pack ────────────────────────────────────────────────────────
log_step "3/6 Pack Artifacts"
if [[ $SKIP_PACK -eq 0 ]]; then
  "$BUILD_ROOT/pack.sh" --clean --yes
  record_result "pack" "pass"
else
  log_info "Skipping (--skip-pack, using pre-built artifacts)"
  record_result "pack" "skip"
fi

# ── 4. Git Tags ────────────────────────────────────────────────────
if [[ $do_git -eq 1 ]]; then
  log_step "4/6 Git Tags"
  cd "$OPENSRC_ROOT"
  confirm_prompt "Create tags v$VERSION + sdk/golang/v$VERSION?"
  run_or_dry git add -A
  run_or_dry git commit -m "Release v$VERSION"
  run_or_dry git tag "v$VERSION"
  run_or_dry git tag "sdk/prismer-cloud/golang/v$VERSION"
  run_or_dry git push origin main "v$VERSION" "sdk/prismer-cloud/golang/v$VERSION"
  record_result "git-tags" "pass"
  cd "$PROJECT_ROOT"
else
  record_result "git-tags" "skip"
fi

# ── 5. GitHub Release ──────────────────────────────────────────────
if [[ $do_github -eq 1 ]]; then
  log_step "5/6 GitHub Release"
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

# ── 6. Registry Publish ───────────────────────────────────────────
log_step "6/6 Publish to Registries"

# Auto-detect credential files from the open source repo root
CRED_DIR="$OPENSRC_ROOT"

if [[ $do_npm -eq 1 ]]; then
  # npm reads .npmrc from cwd or home — copy to HOME if found in repo
  if [[ -f "$CRED_DIR/.npmrc" ]]; then
    log_info "Using $CRED_DIR/.npmrc for npm auth"
    export NPM_CONFIG_USERCONFIG="$CRED_DIR/.npmrc"
  elif ! npm whoami &>/dev/null; then
    log_warn "No .npmrc found and npm not logged in. Publish may fail."
  fi
  confirm_prompt "Publish to npm?"
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
  # twine reads .pypirc from home — point to repo copy
  if [[ -f "$CRED_DIR/.pypirc" ]]; then
    log_info "Using $CRED_DIR/.pypirc for PyPI auth"
    export TWINE_CONFIG_FILE="$CRED_DIR/.pypirc"
  fi
  confirm_prompt "Upload to PyPI?"
  run_or_dry twine upload "$ARTIFACTS_DIR"/pypi/*
  record_result "pypi-upload" "pass"
else
  record_result "pypi-upload" "skip"
fi

if [[ $do_crates -eq 1 ]]; then
  # Auto-source cargo credentials
  if [[ -f "$CRED_DIR/.cargo-credentials" ]]; then
    log_info "Loading $CRED_DIR/.cargo-credentials"
    source "$CRED_DIR/.cargo-credentials"
  elif [[ -z "${CARGO_REGISTRY_TOKEN:-}" ]]; then
    log_warn "No .cargo-credentials and CARGO_REGISTRY_TOKEN not set. Publish may fail."
  fi
  confirm_prompt "Publish to crates.io?"
  cd "$OPENSRC_SDK/prismer-cloud/rust"
  run_or_dry cargo publish --allow-dirty
  record_result "crates-publish" "pass"
  cd "$PROJECT_ROOT"
else
  record_result "crates-publish" "skip"
fi

# ── Summary ────────────────────────────────────────────────────────
log_step "Release Complete: v$VERSION"
print_results
