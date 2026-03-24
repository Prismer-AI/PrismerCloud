#!/bin/bash
# release.sh — Full release orchestrator for PrismerCloud SDKs
source "$(dirname "$0")/lib/common.sh"
parse_common_flags "$@"

# ── Parse script-specific flags ──────────────────────────────────
VERSION_FLAG=""
SKIP_VERIFY=0
GITHUB_ONLY=0
NPM_ONLY=0
PYPI_ONLY=0
CRATES_ONLY=0
args=()
i=0
while [[ $i -lt ${#REMAINING_ARGS[@]} ]]; do
  case "${REMAINING_ARGS[$i]}" in
    --version)
      ((i++))
      VERSION_FLAG="${REMAINING_ARGS[$i]}"
      ;;
    --skip-verify)
      SKIP_VERIFY=1
      ;;
    --github-only)
      GITHUB_ONLY=1
      ;;
    --npm-only)
      NPM_ONLY=1
      ;;
    --pypi-only)
      PYPI_ONLY=1
      ;;
    --crates-only)
      CRATES_ONLY=1
      ;;
    *)
      args+=("${REMAINING_ARGS[$i]}")
      ;;
  esac
  ((i++))
done
REMAINING_ARGS=("${args[@]+"${args[@]}"}")

# ── Determine version ─────────────────────────────────────────────
if [[ -n "$VERSION_FLAG" ]]; then
  VERSION="$VERSION_FLAG"
else
  VERSION="$(get_version)"
fi

if [[ "$VERSION" == "unknown" || -z "$VERSION" ]]; then
  log_error "Could not determine version. Use --version <ver> or ensure sdk/typescript/package.json exists."
  exit 1
fi

# ── Determine which registries to target ──────────────────────────
do_git_tags=1
do_github=1
do_npm=1
do_pypi=1
do_crates=1

if [[ $GITHUB_ONLY -eq 1 ]]; then
  do_npm=0; do_pypi=0; do_crates=0
elif [[ $NPM_ONLY -eq 1 ]]; then
  do_git_tags=0; do_github=0; do_pypi=0; do_crates=0
elif [[ $PYPI_ONLY -eq 1 ]]; then
  do_git_tags=0; do_github=0; do_npm=0; do_crates=0
elif [[ $CRATES_ONLY -eq 1 ]]; then
  do_git_tags=0; do_github=0; do_npm=0; do_pypi=0
fi

# ── Pre-flight ────────────────────────────────────────────────────
log_step "Pre-flight"
log_info "Version:    $VERSION"
log_info "Packages:   ${ALL_PACKAGES[*]}"

TARGETS=""
[[ $do_git_tags -eq 1 ]] && TARGETS="$TARGETS git-tags"
[[ $do_github -eq 1 ]]   && TARGETS="$TARGETS github"
[[ $do_npm -eq 1 ]]      && TARGETS="$TARGETS npm"
[[ $do_pypi -eq 1 ]]     && TARGETS="$TARGETS pypi"
[[ $do_crates -eq 1 ]]   && TARGETS="$TARGETS crates.io"
log_info "Targets:   $TARGETS"

if [[ $DRY_RUN -eq 1 ]]; then
  log_warn "DRY-RUN mode — no changes will be made"
fi

confirm_prompt "Proceed with release v$VERSION?"

# ── Verify ────────────────────────────────────────────────────────
log_step "Verify"
if [[ $SKIP_VERIFY -eq 1 ]]; then
  log_info "Skipping verification (--skip-verify)"
  record_result "verify" "skip"
else
  if "$REPO_ROOT/build/verify.sh" --skip-tests --yes; then
    record_result "verify" "pass"
  else
    log_error "Verification failed. Use --skip-verify to bypass."
    record_result "verify" "fail"
    print_results
    exit 1
  fi
fi

# ── Pack ──────────────────────────────────────────────────────────
log_step "Pack"
if "$REPO_ROOT/build/pack.sh" --clean --yes; then
  record_result "pack" "pass"
else
  log_error "Packing failed."
  record_result "pack" "fail"
  print_results
  exit 1
fi

# ── Git tags ──────────────────────────────────────────────────────
if [[ $do_git_tags -eq 1 ]]; then
  log_step "Git Tags"
  confirm_prompt "Create and push git tags v$VERSION?"
  run_or_dry git tag "v$VERSION"
  run_or_dry git tag "sdk/golang/v$VERSION"
  run_or_dry git push origin "v$VERSION" "sdk/golang/v$VERSION"
  record_result "git-tags" "pass"
else
  record_result "git-tags" "skip"
fi

# ── GitHub Release ────────────────────────────────────────────────
if [[ $do_github -eq 1 ]]; then
  log_step "GitHub Release"
  confirm_prompt "Create GitHub Release v$VERSION?"
  run_or_dry gh release create "v$VERSION" \
    --title "v$VERSION" \
    --generate-notes \
    "$ARTIFACTS_DIR"/npm/*.tgz \
    "$ARTIFACTS_DIR"/pypi/*.whl \
    "$ARTIFACTS_DIR"/pypi/*.tar.gz
  record_result "github-release" "pass"
else
  record_result "github-release" "skip"
fi

# ── npm publish ───────────────────────────────────────────────────
if [[ $do_npm -eq 1 ]]; then
  log_step "npm Publish"
  confirm_prompt "Publish ${#NPM_PACKAGES[@]} packages to npm?"
  for tgz in "$ARTIFACTS_DIR"/npm/*.tgz; do
    log_info "Publishing $(basename "$tgz")"
    run_or_dry npm publish "$tgz" --access public
  done
  record_result "npm-publish" "pass"
else
  record_result "npm-publish" "skip"
fi

# ── PyPI upload ───────────────────────────────────────────────────
if [[ $do_pypi -eq 1 ]]; then
  log_step "PyPI Upload"
  confirm_prompt "Upload to PyPI?"
  run_or_dry twine upload "$ARTIFACTS_DIR"/pypi/*
  record_result "pypi-upload" "pass"
else
  record_result "pypi-upload" "skip"
fi

# ── crates.io ─────────────────────────────────────────────────────
if [[ $do_crates -eq 1 ]]; then
  log_step "crates.io Publish"
  confirm_prompt "Publish to crates.io?"
  cd "$SDK_DIR/rust"
  run_or_dry cargo publish --allow-dirty
  record_result "crates-publish" "pass"
else
  record_result "crates-publish" "skip"
fi

# ── Summary ───────────────────────────────────────────────────────
log_step "Release Complete"
log_success "Released v$VERSION"
print_results
