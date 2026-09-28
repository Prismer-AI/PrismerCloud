#!/bin/bash
# pack.sh — Package active npm and PyPI artifacts (respects --scope)
source "$(dirname "$0")/lib/common.sh"
parse_common_flags "$@"

CLEAN=0
NPM_ONLY=0
INSTALL_DEPS=0
for arg in "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    --npm-only) NPM_ONLY=1 ;;
    --install) INSTALL_DEPS=1 ;;
    *)
      log_error "Unknown pack option: $arg"
      exit 2
      ;;
  esac
done

VERSION="$(get_version)"
log_step "Pack SDK Artifacts (v$VERSION, scope: $SCOPE)"

if [[ $CLEAN -eq 1 ]]; then
  log_info "Cleaning previous artifacts"
  run_or_dry rm -rf "$ARTIFACTS_DIR"
fi
mkdir -p "$ARTIFACTS_DIR/npm" "$ARTIFACTS_DIR/pypi"

pack_npm() {
  local relative_dir="$1"
  local label="$2"
  local skip_install="${3:-0}"
  local package_dir="$SDK_ROOT/$relative_dir"
  local tarball

  log_step "$label npm package"
  cd "$package_dir"
  if [[ $INSTALL_DEPS -eq 1 && "$skip_install" -eq 0 ]]; then
    if ! run_or_dry npm ci --prefer-offline --no-audit --no-fund; then
      record_result "pack: $label npm dependencies" "fail"
      cd "$PROJECT_ROOT"
      return 1
    fi
  fi
  if ! run_or_dry npm run build; then
    record_result "pack: $label npm build" "fail"
    cd "$PROJECT_ROOT"
    return
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "npm pack --pack-destination $ARTIFACTS_DIR/npm"
    record_result "pack: $label npm" "pass"
  elif tarball=$(npm pack --pack-destination "$ARTIFACTS_DIR/npm" 2>/dev/null); then
    log_success "Packed: $tarball"
    record_result "pack: $label npm" "pass"
  else
    record_result "pack: $label npm" "fail"
  fi
  cd "$PROJECT_ROOT"
}

local_aip_tarball() {
  echo "$ARTIFACTS_DIR/npm/prismer-aip-sdk-$VERSION.tgz"
}

# Cloud owns a bundled AIP dependency. Never let npm resolve that dependency
# from the registry while packaging in-tree Cloud source: the Runtime bundle
# must be a coherent snapshot of this checkout.
ensure_local_aip_tarball() {
  local tarball
  tarball="$(local_aip_tarball)"
  if [[ -f "$tarball" ]]; then return 0; fi

  log_info "Cloud SDK requires an exact local AIP artifact; packing it first"
  pack_npm "${AIP_NPM_PACKAGE_DIRS[0]}" "AIP (Cloud dependency)"
  if [[ $DRY_RUN -eq 0 && ! -f "$tarball" ]]; then
    log_error "Expected local AIP artifact was not produced: $tarball"
    return 1
  fi
}

# product209/15 PKF-D2: @prismer/pkf is project-internal and NOT on the npm
# registry yet (spec15 §17.3 known boundary; pkf209/07 §6 merged the former
# pkf-core/pkf-reader pair into it). Compile + return the local tarball path so
# callers can inject it in the SAME npm install as AIP — installing unpublished
# deps one at a time re-resolves the whole graph each time and 404s/notargets
# on whichever one isn't installed yet.
local_pkf_tarballs() {
  local pkg_dir tarball pack_log
  local -a out
  out=()
  for pkg_dir in "$PROJECT_ROOT/packages/pkf"; do
    [[ -f "$pkg_dir/package.json" ]] || {
      log_error "${pkg_dir##*/} missing — PKF-D2 prerequisite" >&2
      return 1
    }
    if [[ $DRY_RUN -eq 1 ]]; then
      log_dry "npm pack --pack-destination $ARTIFACTS_DIR/npm $pkg_dir" >&2
      out+=("$ARTIFACTS_DIR/npm/${pkg_dir##*/}.tgz")
      continue
    fi
    if [[ $INSTALL_DEPS -eq 1 ]]; then
      if ! (cd "$pkg_dir" && npm ci --workspaces=false --ignore-scripts --prefer-offline --no-audit --no-fund >&2); then
        log_error "npm install ${pkg_dir##*/} dependencies failed" >&2
        return 1
      fi
    fi
    mkdir -p "$ARTIFACTS_DIR/npm"
    pack_log="$(mktemp "${TMPDIR:-/tmp}/pkf-pack.XXXXXX")"
    if ! tarball="$(cd "$pkg_dir" && npm pack --pack-destination "$ARTIFACTS_DIR/npm" 2>"$pack_log" | tail -1)"; then
      log_error "npm pack ${pkg_dir##*/} failed" >&2
      cat "$pack_log" >&2
      rm -f "$pack_log"
      return 1
    fi
    rm -f "$pack_log"
    [[ -n "$tarball" ]] || {
      log_error "npm pack ${pkg_dir##*/} produced no tarball name" >&2
      return 1
    }
    out+=("$ARTIFACTS_DIR/npm/$tarball")
  done
  if [[ ${#out[@]} -eq 0 ]]; then
    log_error "no local PKF tarballs were produced" >&2
    return 1
  fi
  printf '%s\n' "${out[@]}"
}

install_local_aip_for_cloud() {
  local tarball pkf_output _pkf_tb
  local -a pkf_tarballs install_args
  pkf_tarballs=()
  install_args=()
  tarball="$(local_aip_tarball)"
  if ! pkf_output="$(local_pkf_tarballs)"; then
    return 1
  fi
  while IFS= read -r _pkf_tb; do
    [[ -n "$_pkf_tb" ]] || continue
    pkf_tarballs+=("$_pkf_tb")
  done <<< "$pkf_output"
  if [[ ${#pkf_tarballs[@]} -eq 0 ]]; then
    log_error "no local PKF tarballs were available for Cloud SDK install"
    return 1
  fi
  install_args=("$tarball")
  install_args+=("${pkf_tarballs[@]}")
  log_step "Install exact local AIP + PKF packages into Cloud SDK"
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "npm install --prefix $CLOUD_SDK --no-save --no-package-lock --no-audit --no-fund ${install_args[*]}"
    return 0
  fi
  npm install --prefix "$CLOUD_SDK" --no-save --no-package-lock --no-audit --no-fund "${install_args[@]}"
}

pack_python() {
  local relative_dir="$1"
  local wheel_pattern="$2"
  local label="$3"
  local package_dir="$SDK_ROOT/$relative_dir"

  log_step "$label Python package"
  cd "$package_dir"
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "uv build --out-dir $ARTIFACTS_DIR/pypi"
    record_result "pack: $label PyPI" "pass"
  elif uv build --out-dir "$ARTIFACTS_DIR/pypi" && compgen -G "$ARTIFACTS_DIR/pypi/$wheel_pattern" >/dev/null; then
    record_result "pack: $label PyPI" "pass"
  else
    record_result "pack: $label PyPI" "fail"
  fi
  cd "$PROJECT_ROOT"
}

if scope_includes_aip; then
  pack_npm "${AIP_NPM_PACKAGE_DIRS[0]}" "AIP"
  if [[ $NPM_ONLY -eq 0 ]]; then
    pack_python "${AIP_PYTHON_PACKAGE_DIRS[0]}" "prismer_aip-*.whl" "AIP"
  fi
fi

if scope_includes_cloud; then
  if [[ $INSTALL_DEPS -eq 1 ]]; then
    # Reuse the release builder: locked external dependencies, then exact local
    # AIP injection. Resolving Cloud's graph with npm install is unnecessary and
    # can replace checkout packages with registry versions. PKF must be compiled
    # before Cloud's hash-verified prebuild staging hook runs.
    local_pkf_tarballs >/dev/null
    (cd "$PROJECT_ROOT" && run_or_dry npx --no-install tsx "$PROJECT_ROOT/scripts/ops/build-local-cloud-sdk-artifact.ts")
    record_result "pack: Cloud SDK npm" "pass"
  else
    ensure_local_aip_tarball
    install_local_aip_for_cloud
    pack_npm "${CLOUD_NPM_PACKAGE_DIRS[0]}" "Cloud SDK" 1
  fi
  if [[ $NPM_ONLY -eq 0 ]]; then
    pack_python "${CLOUD_PYTHON_PACKAGE_DIRS[0]}" "prismer-*.whl" "Cloud SDK"
  fi
  pack_npm "${CLOUD_NPM_PACKAGE_DIRS[1]}" "Cloud MCP"
fi

if scope_includes_prismer; then
  pkf_output="$(local_pkf_tarballs)" || exit 1
  pkf_tarballs=()
  while IFS= read -r _pkf_tb; do
    [[ -n "$_pkf_tb" ]] || continue
    pkf_tarballs+=("$_pkf_tb")
  done <<< "$pkf_output"
  if [[ ${#pkf_tarballs[@]} -eq 0 ]]; then
    log_error "no local PKF tarballs were available for prismer install"
    exit 1
  fi
  if [[ $DRY_RUN -eq 0 ]]; then
    # ONE graph resolution with the local pkf tarballs (same pattern as the
    # cloud step) — pack_npm's own unconstrained install would 404 on the
    # unpublished @prismer/pkf-core, so it runs with skip_install below.
    log_step "Install exact local PKF packages into prismer"
    npm install --prefix "$SDK_ROOT/${PRISMER_NPM_PACKAGE_DIRS[0]}" --no-save --no-package-lock --no-audit --no-fund "${pkf_tarballs[@]}"
  fi
  pack_npm "${PRISMER_NPM_PACKAGE_DIRS[0]}" "Prismer Runtime" 1
fi

log_step "Artifacts"
if [[ $DRY_RUN -eq 1 ]]; then
  log_dry "no artifacts written; existing artifact directories were not inspected"
else
  find "$ARTIFACTS_DIR" -type f 2>/dev/null | sort | while read -r artifact; do
    size=$(du -h "$artifact" | cut -f1)
    log_info "  $size  $(basename "$artifact")"
  done
fi

print_results
