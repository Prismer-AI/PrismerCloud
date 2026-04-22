#!/bin/bash
# pack.sh — Package all SDK artifacts for publishing (respects --scope)
source "$(dirname "$0")/lib/common.sh"
parse_common_flags "$@"

CLEAN=0
for arg in "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"; do
  case "$arg" in --clean) CLEAN=1 ;; esac
done

VERSION="$(get_version)"
AIP_VERSION="$(get_aip_version)"
log_step "Pack SDK Artifacts (prismer-cloud: v$VERSION, aip: v$AIP_VERSION, scope: $SCOPE)"

# ── Clean ──────────────────────────────────────────────────────────
if [[ $CLEAN -eq 1 ]]; then
  log_info "Cleaning previous artifacts"
  run_or_dry rm -rf "$ARTIFACTS_DIR"
fi
mkdir -p "$ARTIFACTS_DIR/npm" "$ARTIFACTS_DIR/pypi" "$ARTIFACTS_DIR/crates"

# ── AIP npm package ───────────────────────────────────────────────
if scope_includes_aip; then
  log_step "AIP npm Package"
  local_dir="$AIP_SDK/typescript"
  if [[ -d "$local_dir" ]]; then
    cd "$local_dir"
    if [[ -f "package.json" ]] && node -e "const p=require('./package.json'); process.exit(p.scripts?.build ? 0 : 1)" 2>/dev/null; then
      run_or_dry npm run build 2>&1 | tail -2
    fi
    if [[ $DRY_RUN -eq 1 ]]; then
      log_dry "Would npm pack → $ARTIFACTS_DIR/npm/"
      record_result "pack: npm/aip-sdk" "pass"
    else
      tgz=$(npm pack --pack-destination "$ARTIFACTS_DIR/npm" 2>/dev/null)
      if [[ -n "$tgz" ]]; then
        log_success "Packed: $tgz"
        record_result "pack: npm/aip-sdk" "pass"
      else
        record_result "pack: npm/aip-sdk" "fail"
      fi
    fi
    cd "$PROJECT_ROOT"
  else
    record_result "pack: npm/aip-sdk" "skip"
  fi
fi

# ── AIP Python package ────────────────────────────────────────────
if scope_includes_aip; then
  log_step "AIP Python Package"
  cd "$AIP_SDK/python"
  if command -v python3 &>/dev/null; then
	    if [[ $DRY_RUN -eq 1 ]]; then
	      log_dry "Would python3 -m build → $ARTIFACTS_DIR/pypi/"
	      record_result "pack: pypi/aip" "pass"
	    else
	      python3 -m build -o "$ARTIFACTS_DIR/pypi" 2>&1 | tail -3
	      if ls "$ARTIFACTS_DIR/pypi/"prismer_aip-*.whl &>/dev/null; then
	        log_success "Packed: $(ls "$ARTIFACTS_DIR/pypi/"prismer_aip-*.whl | xargs -n1 basename)"
	        record_result "pack: pypi/aip" "pass"
	      elif ls "$ARTIFACTS_DIR/pypi/"aip_sdk-*.whl &>/dev/null; then
	        log_success "Packed: $(ls "$ARTIFACTS_DIR/pypi/"aip_sdk-*.whl | xargs -n1 basename)"
	        record_result "pack: pypi/aip" "pass"
	      elif ls "$ARTIFACTS_DIR/pypi/"aip-*.whl &>/dev/null; then
	        log_success "Packed: $(ls "$ARTIFACTS_DIR/pypi/"aip-*.whl | xargs -n1 basename)"
	        record_result "pack: pypi/aip" "pass"
	      else
	        record_result "pack: pypi/aip" "fail"
	      fi
	    fi
  else
    record_result "pack: pypi/aip" "skip"
  fi
  cd "$PROJECT_ROOT"
fi

# ── Prismer Cloud npm packages ────────────────────────────────────
if scope_includes_prismer; then
  log_step "Prismer Cloud npm Packages"
  for pkg in "${NPM_PACKAGES[@]}"; do
    local_dir="$PRISMER_CLOUD/$pkg"
    if [[ ! -d "$local_dir" ]]; then
      log_warn "Skip: $pkg (not found)"
      record_result "pack: npm/$pkg" "skip"
      continue
    fi
    cd "$local_dir"

    # Build if package has a scripts.build entry
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
fi

# ── Python wheel ───────────────────────────────────────────────────
if scope_includes_prismer; then
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
fi

# ── Hermes Adapter (Python) ───────────────────────────────────────────
if scope_includes_prismer; then
  log_step "Hermes Adapter (Python)"
  cd "$PRISMER_CLOUD/adapters/hermes"
  if command -v python3 &>/dev/null; then
    if [[ $DRY_RUN -eq 1 ]]; then
      log_dry "Would python3 -m build → $ARTIFACTS_DIR/pypi/"
      record_result "pack: pypi/hermes" "pass"
    else
      python3 -m build -o "$ARTIFACTS_DIR/pypi" 2>&1 | tail -3
      if ls "$ARTIFACTS_DIR/pypi/"prismer_adapter_hermes-*.whl &>/dev/null; then
        log_success "Packed: $(ls "$ARTIFACTS_DIR/pypi/"prismer_adapter_hermes-*.whl | xargs -n1 basename)"
        record_result "pack: pypi/hermes" "pass"
      else
        record_result "pack: pypi/hermes" "fail"
      fi
    fi
  else
    record_result "pack: pypi/hermes" "skip"
  fi
  cd "$PROJECT_ROOT"
fi

# ── Rust crate ─────────────────────────────────────────────────────
if scope_includes_prismer; then
  log_step "Rust Package"
  cd "$PRISMER_CLOUD/rust"
  if command -v cargo &>/dev/null; then
    if [[ $DRY_RUN -eq 1 ]]; then
      log_dry "Would cargo package"
      record_result "pack: crates" "pass"
    else
      cargo package --allow-dirty 2>&1 | tail -3
      cp target/package/prismer-sdk-*.crate "$ARTIFACTS_DIR/crates/" 2>/dev/null
      # Clean old versions — keep only latest
      cd "$ARTIFACTS_DIR/crates"
      ls -t prismer-sdk-*.crate 2>/dev/null | tail -n +2 | xargs rm -f 2>/dev/null
      cd "$PRISMER_CLOUD/rust"
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
fi

# ── Summary ────────────────────────────────────────────────────────
log_step "Artifacts"
find "$ARTIFACTS_DIR" -type f 2>/dev/null | sort | while read -r f; do
  size=$(du -h "$f" | cut -f1)
  log_info "  $size  $(basename "$f")"
done

print_results
