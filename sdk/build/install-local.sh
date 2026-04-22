#!/bin/bash
# install-local.sh — End-to-end local install for pre-publish smoke testing.
# Packs all SDK artifacts then runs public/install.sh --local against them.
# No npm registry, no CDN — pure offline smoke test of the installer path.
#
# Usage: sdk/build/install-local.sh [options]
#
#   --skip-pack           Assume tgz already exist in $ARTIFACTS_DIR/npm; skip pack step.
#   --clean               Pass --clean to pack.sh (wipe old artifacts before packing).
#   --with-setup          Let install.sh run 'prismer setup' (opens browser). Default: skip.
#   --with-agent-detect   Let install.sh run agent auto-detect wizard. Default: skip.
#   --dry-run             Print the install.sh invocation that WOULD be run; exit 0.
#   -h, --help            Print this help and exit 0.

source "$(dirname "$0")/lib/common.sh"

# ── Local flag parsing (don't use parse_common_flags — DRY_RUN needs special handling here) ──
SKIP_PACK=0
CLEAN=0
WITH_SETUP=0
WITH_AGENT_DETECT=0
DRY_RUN=0

_usage() {
  cat <<EOF
install-local.sh — End-to-end local install for pre-publish smoke testing.
Packs all SDK artifacts then runs public/install.sh --local against them.

Usage:
  bash sdk/build/install-local.sh [options]

Options:
  --skip-pack           Assume tgz already exist in artifacts/npm; skip pack step.
  --clean               Pass --clean to pack.sh (wipe old artifacts first).
  --with-setup          Let install.sh run 'prismer setup' (browser sign-in). Default: skip.
  --with-agent-detect   Let install.sh run agent auto-detect wizard. Default: skip.
  --dry-run             Print the install.sh command that WOULD be run; exit 0.
  -h, --help            Print this help and exit 0.

Examples:
  # Full smoke test (pack + install, non-interactive):
  bash sdk/build/install-local.sh

  # Reuse existing artifacts; dry-run to confirm command:
  bash sdk/build/install-local.sh --skip-pack --dry-run

  # Clean re-pack then install:
  bash sdk/build/install-local.sh --clean

  # Pack and install with setup wizard enabled:
  bash sdk/build/install-local.sh --with-setup
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-pack)         SKIP_PACK=1 ;;
    --clean)             CLEAN=1 ;;
    --with-setup)        WITH_SETUP=1 ;;
    --with-agent-detect) WITH_AGENT_DETECT=1 ;;
    --dry-run)           DRY_RUN=1 ;;
    -h|--help)           _usage; exit 0 ;;
    *) log_warn "Unknown argument: $1 (ignored)" ;;
  esac
  shift
done

SDK_BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NPM_ARTIFACTS="$ARTIFACTS_DIR/npm"

VERSION="$(get_version)"
log_step "Local Install Smoke Test — prismer-cloud v$VERSION"

# ── Step 1: Pack ────────────────────────────────────────────────────
if [[ $SKIP_PACK -eq 0 ]]; then
  log_step "Step 1: Packing SDK artifacts"
  PACK_ARGS=(--scope all)
  [[ $CLEAN -eq 1 ]] && PACK_ARGS+=(--clean)
  [[ $DRY_RUN -eq 1 ]] && PACK_ARGS+=(--dry-run)

  log_info "Running: pack.sh ${PACK_ARGS[*]}"
  if ! bash "$SDK_BUILD_DIR/pack.sh" "${PACK_ARGS[@]}"; then
    log_error "pack.sh failed — cannot proceed with local install."
    log_info  "Tip: check the output above, fix any build errors, then retry."
    exit 1
  fi
  log_success "Pack step completed."
else
  log_info "Skipping pack step (--skip-pack). Using existing artifacts in:"
  log_info "  $NPM_ARTIFACTS"
fi

# ── Step 2: Verify required tgz presence ───────────────────────────
if [[ $DRY_RUN -eq 0 ]] || [[ $SKIP_PACK -eq 1 ]]; then
  log_step "Step 2: Verifying required tgz artifacts"

  REQUIRED_PATTERNS=(
    "prismer-sdk-*.tgz"
    "prismer-runtime-*.tgz"
    "prismer-sandbox-runtime-*.tgz"
    "prismer-mcp-server-*.tgz"
    "prismer-aip-sdk-*.tgz"
    "prismer-wire-*.tgz"
    "prismer-adapters-core-*.tgz"
  )

  missing=0
  for pattern in "${REQUIRED_PATTERNS[@]}"; do
    match=$(ls "$NPM_ARTIFACTS"/$pattern 2>/dev/null | head -1)
    if [[ -z "$match" ]]; then
      log_error "Missing: $pattern in $NPM_ARTIFACTS"
      missing=1
    else
      log_success "Found: $(basename "$match")"
    fi
  done

  if [[ $missing -eq 1 ]]; then
    log_error "One or more required tgz files are missing."
    log_info  "Hint: run without --skip-pack to pack first, e.g.:"
    log_info  "  bash sdk/build/install-local.sh"
    exit 1
  fi
fi

# ── Step 3: Build install.sh invocation ────────────────────────────
log_step "Step 3: Invoking public/install.sh --local"

INSTALL_ARGS=(
  --local "$NPM_ARTIFACTS"
  --yes
)

[[ $WITH_SETUP -eq 0 ]]        && INSTALL_ARGS+=(--no-setup)
[[ $WITH_AGENT_DETECT -eq 0 ]] && INSTALL_ARGS+=(--skip-agent-detect)

INSTALL_CMD=("bash" "$PROJECT_ROOT/public/install.sh" "${INSTALL_ARGS[@]}")

if [[ $DRY_RUN -eq 1 ]]; then
  log_dry "Would run:"
  log_dry "  ${INSTALL_CMD[*]}"
  log_success "Dry-run complete — no install performed, no \$HOME changes."
  exit 0
fi

log_info "Command: ${INSTALL_CMD[*]}"
"${INSTALL_CMD[@]}"
INSTALL_EXIT=$?

if [[ $INSTALL_EXIT -eq 0 ]]; then
  log_success "Local install smoke test passed."
else
  log_error "install.sh exited with code $INSTALL_EXIT."
  exit $INSTALL_EXIT
fi
