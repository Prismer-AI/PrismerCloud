#!/bin/bash
# pack.sh — Package all SDK artifacts for publishing
source "$(dirname "$0")/lib/common.sh"
parse_common_flags "$@"

CLEAN=0
for arg in "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"; do
  case "$arg" in --clean) CLEAN=1 ;; esac
done

VERSION="$(get_version)"
log_step "Pack SDK Artifacts (v$VERSION)"

# ── Clean ──────────────────────────────────────────────────────────
if [[ $CLEAN -eq 1 ]]; then
  log_info "Cleaning previous artifacts"
  run_or_dry rm -rf "$ARTIFACTS_DIR"
fi
mkdir -p "$ARTIFACTS_DIR/npm" "$ARTIFACTS_DIR/pypi" "$ARTIFACTS_DIR/crates"

# ── npm packages ───────────────────────────────────────────────────
log_step "npm Packages"
for pkg in "${NPM_PACKAGES[@]}"; do
  local_dir="$PRISMER_CLOUD/$pkg"
  if [[ ! -d "$local_dir" ]]; then
    log_warn "Skip: $pkg (not found)"
    record_result "pack: npm/$pkg" "skip"
    continue
  fi
  cd "$local_dir"

  # Build if package has a scripts.build entry (not openclaw.build or other nested "build")
  if [[ -f "package.json" ]] && node -e "const p=require('./package.json'); process.exit(p.scripts?.build ? 0 : 1)" 2>/dev/null; then
    run_or_dry npm run build 2>&1 | tail -2
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "Would npm pack → $ARTIFACTS_DIR/npm/"
    record_result "pack: npm/$pkg" "pass"
  else
    tgz=$(npm pack --pack-destination "$ARTIFACTS_DIR/npm" 2>/dev/null)
    if [[ -n "$tgz" ]]; then
      log_success "Packed: $tgz"
      record_result "pack: npm/$pkg" "pass"
    else
      record_result "pack: npm/$pkg" "fail"
    fi
  fi
  cd "$PROJECT_ROOT"
done

# ── Python wheel ───────────────────────────────────────────────────
log_step "Python Package"
cd "$PRISMER_CLOUD/python"
if command -v python3 &>/dev/null; then
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "Would python3 -m build"
    record_result "pack: pypi" "pass"
  else
    python3 -m build -o "$ARTIFACTS_DIR/pypi" 2>&1 | tail -3
    if ls "$ARTIFACTS_DIR/pypi/"*.whl &>/dev/null; then
      record_result "pack: pypi" "pass"
    else
      record_result "pack: pypi" "fail"
    fi
  fi
else
  record_result "pack: pypi" "skip"
fi
cd "$PROJECT_ROOT"

# ── Rust crate ─────────────────────────────────────────────────────
log_step "Rust Package"
cd "$PRISMER_CLOUD/rust"
if command -v cargo &>/dev/null; then
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "Would cargo package"
    record_result "pack: crates" "pass"
  else
    cargo package --allow-dirty 2>&1 | tail -3
    cp target/package/prismer-sdk-*.crate "$ARTIFACTS_DIR/crates/" 2>/dev/null
    if ls "$ARTIFACTS_DIR/crates/"*.crate &>/dev/null; then
      record_result "pack: crates" "pass"
    else
      record_result "pack: crates" "warn"
    fi
  fi
else
  record_result "pack: crates" "skip"
fi
cd "$PROJECT_ROOT"

# ── Summary ────────────────────────────────────────────────────────
log_step "Artifacts"
find "$ARTIFACTS_DIR" -type f 2>/dev/null | while read -r f; do
  size=$(du -h "$f" | cut -f1)
  log_info "  $size  $(basename "$f")"
done

print_results
