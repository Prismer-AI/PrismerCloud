#!/bin/bash
# sync.sh — Whole-directory sync to open source repo (rsync --delete)
source "$(dirname "$0")/lib/common.sh"
parse_common_flags "$@"

log_step "Sync SDK → PrismerCloud (WHOLE-DIRECTORY REPLACE)"

# ── Validate ───────────────────────────────────────────────────────
if [[ ! -d "$PRISMER_CLOUD" ]]; then
  log_error "Source not found: $PRISMER_CLOUD"
  exit 1
fi

if [[ ! -d "$OPENSRC_ROOT" ]]; then
  log_error "Open source repo not found: $OPENSRC_ROOT"
  log_info "Clone it: git clone git@github.com:Prismer-AI/PrismerCloud.git $OPENSRC_ROOT"
  exit 1
fi

VERSION="$(get_version)"
log_info "Version: $VERSION"
log_info "Source:  $SDK_ROOT"
log_info "Target:  $OPENSRC_SDK"

RSYNC_EXCLUDES=(
  --exclude='node_modules'
  --exclude='.venv'
  --exclude='dist'
  --exclude='target'
  --exclude='*.egg-info'
  --exclude='__pycache__'
  --exclude='prismer-cloud/**/*.tgz'
  --exclude='*.pyc'
  --exclude='.DS_Store'
  --exclude='package-lock.json'
  --exclude='.next'
  --exclude='.pytest_cache'
  --exclude='.cache'
)

# ── Step 1: Clean target SDK directory ─────────────────────────────
log_step "Step 1: Clean target"
if [[ $DRY_RUN -eq 1 ]]; then
  log_dry "Would rm -rf $OPENSRC_SDK"
else
  confirm_prompt "This will DELETE $OPENSRC_SDK and replace with source. Continue?"
  rm -rf "$OPENSRC_SDK"
  log_info "Cleaned $OPENSRC_SDK"
fi

# ── Step 2: Rsync with --delete ────────────────────────────────────
log_step "Step 2: Rsync (whole-directory replace)"
if [[ $DRY_RUN -eq 1 ]]; then
  log_dry "Would rsync -av --delete ..."
  rsync -avn --delete "${RSYNC_EXCLUDES[@]}" "$SDK_ROOT/" "$OPENSRC_SDK/" 2>&1 | tail -5
else
  rsync -av --delete "${RSYNC_EXCLUDES[@]}" "$SDK_ROOT/" "$OPENSRC_SDK/" 2>&1
fi

# ── Step 3: Clean non-publishable build artifacts ──────────────────
if [[ $DRY_RUN -eq 0 ]]; then
  rm -f "$OPENSRC_SDK/prismer-cloud/golang/prismer" 2>/dev/null
  # Keep build/artifacts/ — contains packed tgz/whl/crate for publish
fi

# ── Step 4: Also sync build/ scripts to open source ────────────────
# The open source repo has its own build/ — sync ours as reference
# but don't overwrite their release.sh/pack.sh (they have registry-specific logic)
log_step "Step 3: Verify"
if [[ $DRY_RUN -eq 0 ]]; then
  FILE_COUNT=$(find "$OPENSRC_SDK" -type f 2>/dev/null | wc -l | tr -d ' ')
  DIR_COUNT=$(find "$OPENSRC_SDK" -type d 2>/dev/null | wc -l | tr -d ' ')
  log_success "Synced: $FILE_COUNT files in $DIR_COUNT directories"

  # Verify key packages exist
  for pkg in typescript python golang rust mcp; do
    if [[ -d "$OPENSRC_SDK/prismer-cloud/$pkg" ]]; then
      log_success "  ✓ prismer-cloud/$pkg"
    else
      log_error "  ✗ prismer-cloud/$pkg MISSING"
    fi
  done
  if [[ -d "$OPENSRC_SDK/aip" ]]; then
    log_success "  ✓ aip/"
  fi
else
  log_dry "Dry run complete"
fi

log_success "Sync complete. Next: cd $OPENSRC_ROOT && build/verify.sh"
