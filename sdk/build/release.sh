#!/bin/bash
# release.sh — Test, verify, pack, then publish AIP → Cloud → Runtime
source "$(dirname "$0")/lib/common.sh"
parse_common_flags "$@"

VERSION_FLAG=""
SKIP_VERIFY=0
SKIP_SYNC=0
SKIP_PACK=0
NPM_ONLY=0
PYPI_ONLY=0
GITHUB_ONLY=0

for i in "${!REMAINING_ARGS[@]}"; do
  case "${REMAINING_ARGS[$i]}" in
    --version) VERSION_FLAG="${REMAINING_ARGS[$((i+1))]:-}" ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    --skip-sync) SKIP_SYNC=1 ;;
    --skip-pack) SKIP_PACK=1 ;;
    --npm-only) NPM_ONLY=1 ;;
    --pypi-only) PYPI_ONLY=1 ;;
    --github-only) GITHUB_ONLY=1 ;;
  esac
done

VERSION="${VERSION_FLAG:-$(get_version)}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  log_error "Release version must be X.Y.Z: $VERSION"
  exit 1
fi

do_sync=1
do_git=1
do_github=1
do_npm=1
do_pypi=1
[[ $SKIP_SYNC -eq 1 ]] && do_sync=0
if [[ $NPM_ONLY -eq 1 ]]; then do_sync=0; do_git=0; do_github=0; do_pypi=0; fi
if [[ $PYPI_ONLY -eq 1 ]]; then do_sync=0; do_git=0; do_github=0; do_npm=0; fi
if [[ $GITHUB_ONLY -eq 1 ]]; then do_sync=0; do_npm=0; do_pypi=0; fi

case "$SCOPE" in
  all) RELEASE_TAG="v$VERSION" ;;
  aip) RELEASE_TAG="aip/v$VERSION" ;;
  cloud) RELEASE_TAG="cloud/v$VERSION" ;;
  prismer) RELEASE_TAG="runtime/v$VERSION" ;;
  prismer-cloud) RELEASE_TAG="sdk/v$VERSION" ;;
esac

log_step "Release $RELEASE_TAG (scope: $SCOPE)"
[[ $DRY_RUN -eq 1 ]] && log_warn "DRY-RUN mode"
confirm_prompt "Release $RELEASE_TAG?"

# Preserve the caller's raw scope, including the temporary prismer-cloud alias.
if [[ $SKIP_VERIFY -eq 0 ]]; then
  log_step "1/6 Test"
  if [[ $DRY_RUN -eq 1 ]]; then
    "$BUILD_ROOT/test.sh" --scope "$SCOPE" --yes --dry-run
  else
    "$BUILD_ROOT/test.sh" --scope "$SCOPE" --yes
  fi
  record_result "test" "pass"

  log_step "2/6 Verify"
  if [[ $DRY_RUN -eq 1 ]]; then
    "$BUILD_ROOT/verify.sh" --scope "$SCOPE" --yes --skip-build --dry-run
  else
    "$BUILD_ROOT/verify.sh" --scope "$SCOPE" --yes --skip-build
  fi
  record_result "verify" "pass"
else
  record_result "test" "skip"
  record_result "verify" "skip"
fi

log_step "3/6 Sync"
if [[ $do_sync -eq 1 ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "$BUILD_ROOT/sync.sh --scope $SCOPE --yes"
  else
    "$BUILD_ROOT/sync.sh" --scope "$SCOPE" --yes
  fi
  record_result "sync" "pass"
else
  record_result "sync" "skip"
fi

log_step "4/6 Pack"
if [[ $SKIP_PACK -eq 0 ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    "$BUILD_ROOT/pack.sh" --scope "$SCOPE" --clean --yes --dry-run
  else
    "$BUILD_ROOT/pack.sh" --scope "$SCOPE" --clean --yes
  fi
  record_result "pack" "pass"
else
  record_result "pack" "skip"
fi

log_step "5/6 Git + GitHub"
if [[ $do_git -eq 1 ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "git commit, tag, and push $RELEASE_TAG in $OPENSRC_ROOT"
  else
    cd "$OPENSRC_ROOT"
    confirm_prompt "Commit and push $RELEASE_TAG?"
    git add -A
    git commit -m "Release $RELEASE_TAG"
    git tag "$RELEASE_TAG"
    git push origin main "$RELEASE_TAG"
    cd "$PROJECT_ROOT"
  fi
  record_result "git-tag" "pass"
else
  record_result "git-tag" "skip"
fi

if [[ $do_github -eq 1 ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "gh release create $RELEASE_TAG with scoped npm/PyPI artifacts"
  else
    cd "$OPENSRC_ROOT"
    confirm_prompt "Create GitHub release $RELEASE_TAG?"
    shopt -s nullglob
    release_artifacts=(
      "$ARTIFACTS_DIR"/npm/*.tgz
      "$ARTIFACTS_DIR"/pypi/*.whl
      "$ARTIFACTS_DIR"/pypi/*.tar.gz
    )
    gh release create "$RELEASE_TAG" --title "$RELEASE_TAG" --generate-notes \
      "${release_artifacts[@]}"
    shopt -u nullglob
    cd "$PROJECT_ROOT"
  fi
  record_result "github-release" "pass"
else
  record_result "github-release" "skip"
fi

CRED_DIR="$OPENSRC_ROOT"
if [[ -f "$CRED_DIR/.npmrc" ]]; then export NPM_CONFIG_USERCONFIG="$CRED_DIR/.npmrc"; fi
if [[ -f "$CRED_DIR/.pypirc" ]]; then export TWINE_CONFIG_FILE="$CRED_DIR/.pypirc"; fi

publish_npm_pattern() {
  local label="$1"
  local pattern="$2"
  if [[ $do_npm -eq 0 ]]; then
    record_result "$label npm" "skip"
    return
  fi
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "npm publish $ARTIFACTS_DIR/npm/$pattern --access public"
    record_result "$label npm" "pass"
    return
  fi

  local artifacts=("$ARTIFACTS_DIR"/npm/$pattern)
  if [[ ! -f "${artifacts[0]}" ]]; then
    log_error "Missing npm artifact: $pattern"
    record_result "$label npm" "fail"
    return
  fi
  for artifact in "${artifacts[@]}"; do
    npm publish "$artifact" --access public
  done
  record_result "$label npm" "pass"
}

publish_pypi_pattern() {
  local label="$1"
  local pattern="$2"
  if [[ $do_pypi -eq 0 ]]; then
    record_result "$label PyPI" "skip"
    return
  fi
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "twine upload $ARTIFACTS_DIR/pypi/$pattern"
    record_result "$label PyPI" "pass"
    return
  fi

  local artifacts=("$ARTIFACTS_DIR"/pypi/$pattern)
  if [[ ! -f "${artifacts[0]}" ]]; then
    log_error "Missing PyPI artifact: $pattern"
    record_result "$label PyPI" "fail"
    return
  fi
  twine upload "${artifacts[@]}"
  record_result "$label PyPI" "pass"
}

publish_aip() {
  log_step "Publish AIP"
  publish_npm_pattern "AIP" "prismer-aip-sdk-*.tgz"
  publish_pypi_pattern "AIP" "prismer_aip-*"
}

publish_cloud() {
  log_step "Publish Cloud SDK"
  publish_npm_pattern "Cloud SDK" "prismer-sdk-*.tgz"
  publish_pypi_pattern "Cloud SDK" "prismer-[0-9]*"
  publish_npm_pattern "Cloud MCP" "prismer-mcp-server-*.tgz"
}

publish_prismer() {
  log_step "Publish Prismer Runtime"
  publish_npm_pattern "Prismer Runtime" "prismer-runtime-*.tgz"
}

log_step "6/6 Registry publish"
if scope_includes_aip; then publish_aip; fi
if scope_includes_cloud; then publish_cloud; fi
if scope_includes_prismer; then publish_prismer; fi

log_step "Release complete: $RELEASE_TAG"
print_results
