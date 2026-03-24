#!/bin/bash
# pack.sh — Package all PrismerCloud SDK artifacts for release.

source "$(dirname "$0")/lib/common.sh"

# ── Parse flags ───────────────────────────────────────────────────
parse_common_flags "$@"

ONLY_PKG=""
CLEAN=0

args=()
set -- "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)  ONLY_PKG="$2"; shift 2 ;;
    --clean) CLEAN=1; shift ;;
    *)       args+=("$1"); shift ;;
  esac
done
REMAINING_ARGS=("${args[@]+"${args[@]}"}")

# ── Setup ─────────────────────────────────────────────────────────
if [[ $CLEAN -eq 1 ]]; then
  log_info "Cleaning artifacts directory..."
  run_or_dry rm -rf "$ARTIFACTS_DIR"
fi

mkdir -p "$ARTIFACTS_DIR"/{npm,pypi,crates}

VERSION="$(get_version)"
log_info "Packing artifacts for v${VERSION}"
[[ $DRY_RUN -eq 1 ]] && log_dry "Dry-run mode — no packages will be created"

should_pack() {
  [[ -z "$ONLY_PKG" ]] || [[ "$ONLY_PKG" == "$1" ]]
}

# ── Pack functions ────────────────────────────────────────────────

pack_npm() {
  local pkg_dir="$1" pkg_name="$2"
  log_step "Packing $pkg_name"
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "cd sdk/$pkg_dir && npm install && npm pack → artifacts/npm/"
    record_result "$pkg_name" "skip"
    return
  fi
  cd "$SDK_DIR/$pkg_dir"
  [[ -d node_modules ]] || npm install --prefer-offline --no-audit 2>&1
  # Build if package has build script
  if grep -q '"build"' package.json; then
    npm run build 2>&1
  fi
  npm pack 2>&1
  mv *.tgz "$ARTIFACTS_DIR/npm/"
  record_result "$pkg_name" "pass"
}

pack_python() {
  log_step "Packing prismer (Python)"
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "cd sdk/python && python -m build && twine check → artifacts/pypi/"
    record_result "prismer (Python)" "skip"
    return
  fi
  cd "$SDK_DIR/python"
  rm -rf dist build *.egg-info
  if [[ ! -d .venv ]]; then
    local py=$(command -v python3.11 || command -v python3.12 || command -v python3.10 || command -v python3)
    "$py" -m venv .venv
  fi
  source .venv/bin/activate
  pip install --quiet build twine
  python -m build 2>&1
  twine check dist/* 2>&1
  cp dist/* "$ARTIFACTS_DIR/pypi/"
  deactivate
  record_result "prismer (Python)" "pass"
}

pack_rust() {
  log_step "Packing prismer-sdk (Rust)"
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "cd sdk/rust && cargo package → artifacts/crates/"
    record_result "prismer-sdk (Rust)" "skip"
    return
  fi
  cd "$SDK_DIR/rust"
  cargo package --allow-dirty 2>&1
  cp target/package/prismer-sdk-*.crate "$ARTIFACTS_DIR/crates/" 2>/dev/null || true
  record_result "prismer-sdk (Rust)" "pass"
}

pack_golang() {
  log_step "Verifying Go SDK (tag-based release)"
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "cd sdk/golang && go build ./... && go vet ./..."
    record_result "Go SDK (tag-based)" "skip"
    return
  fi
  cd "$SDK_DIR/golang"
  go build ./...
  go vet ./...
  record_result "Go SDK (tag-based)" "pass"
}

# ── Pack all requested packages ───────────────────────────────────

should_pack "typescript"       && pack_npm "typescript"       "@prismer/sdk (TypeScript)"
should_pack "mcp"              && pack_npm "mcp"              "@prismer/mcp-server"
should_pack "opencode-plugin"  && pack_npm "opencode-plugin"  "@prismer/opencode-plugin"
should_pack "claude-code-plugin" && pack_npm "claude-code-plugin" "@prismer/claude-code-plugin"
should_pack "openclaw-channel" && pack_npm "openclaw-channel" "@prismer/openclaw-channel"
should_pack "python"           && pack_python
should_pack "rust"             && pack_rust
should_pack "golang"           && pack_golang

# ── Artifact manifest ─────────────────────────────────────────────
log_step "Artifact Manifest"

if [[ $DRY_RUN -eq 1 ]]; then
  log_dry "Would list artifacts in $ARTIFACTS_DIR"
else
  if find "$ARTIFACTS_DIR" -type f | grep -q .; then
    echo ""
    log_info "Artifacts in $ARTIFACTS_DIR:"
    echo ""
    find "$ARTIFACTS_DIR" -type f | sort | while read -r f; do
      size="$(du -h "$f" | cut -f1 | xargs)"
      rel="${f#"$ARTIFACTS_DIR/"}"
      printf "  %-50s %s\n" "$rel" "$size"
    done

    echo ""
    log_step "SHA-256 Checksums"
    echo ""
    find "$ARTIFACTS_DIR" -type f | sort | xargs shasum -a 256
  else
    log_warn "No artifacts were generated."
  fi
fi

# ── Summary ───────────────────────────────────────────────────────
print_results
