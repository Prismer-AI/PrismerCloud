#!/bin/bash
# sync.sh — Sync sdk/ from source development repo
source "$(dirname "$0")/lib/common.sh"
parse_common_flags "$@"

# ── Parse script-specific flags ──────────────────────────────────
NO_CLEAN=0
args=()
for arg in "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"; do
  case "$arg" in
    --no-clean) NO_CLEAN=1 ;;
    *)          args+=("$arg") ;;
  esac
done
REMAINING_ARGS=("${args[@]+"${args[@]}"}")

# ── Validate source SDK ──────────────────────────────────────────
log_step "Validating source SDK"

if [[ ! -d "$SOURCE_SDK" ]]; then
  log_error "Source SDK not found: $SOURCE_SDK"
  exit 1
fi

EXPECTED_SUBDIRS=("typescript" "python" "golang" "rust" "mcp")
for subdir in "${EXPECTED_SUBDIRS[@]}"; do
  if [[ ! -d "$SOURCE_SDK/$subdir" ]]; then
    log_error "Expected subdirectory missing: $SOURCE_SDK/$subdir"
    exit 1
  fi
done
log_success "Source SDK validated: $SOURCE_SDK"

# ── Clean existing SDK directory ─────────────────────────────────
if [[ $NO_CLEAN -eq 0 ]]; then
  log_step "Cleaning existing SDK directory"
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "Would rm -rf $SDK_DIR"
  else
    rm -rf "$SDK_DIR" 2>/dev/null || true
    log_info "Cleaned $SDK_DIR"
  fi
else
  log_info "Skipping clean (--no-clean)"
fi

# ── Rsync from source ────────────────────────────────────────────
log_step "Syncing SDK"

RSYNC_EXCLUDES=(
  --exclude='node_modules'
  --exclude='.venv'
  --exclude='dist'
  --exclude='target'
  --exclude='build'
  --exclude='*.egg-info'
  --exclude='__pycache__'
  --exclude='*.tgz'
  --exclude='*.pyc'
  --exclude='.DS_Store'
  --exclude='package-lock.json'
  --exclude='.next'
  --exclude='.pytest_cache'
)

if [[ $DRY_RUN -eq 1 ]]; then
  log_dry "Would rsync -av ${RSYNC_EXCLUDES[*]} $SOURCE_SDK/ $SDK_DIR/"
  rsync -avn "${RSYNC_EXCLUDES[@]}" "$SOURCE_SDK/" "$SDK_DIR/" 2>&1
else
  rsync -av "${RSYNC_EXCLUDES[@]}" "$SOURCE_SDK/" "$SDK_DIR/" 2>&1
fi

# ── Remove Go compiled binary if present ─────────────────────────
if [[ $DRY_RUN -eq 1 ]]; then
  if [[ -f "$SDK_DIR/golang/prismer" ]]; then
    log_dry "Would remove Go compiled binary: $SDK_DIR/golang/prismer"
  fi
else
  rm -f "$SDK_DIR/golang/prismer"
fi

# ── Summary ───────────────────────────────────────────────────────
log_step "Sync Summary"

if [[ $DRY_RUN -eq 1 ]]; then
  log_dry "Dry run complete — no files were actually synced"
else
  FILE_COUNT=$(find "$SDK_DIR" -type f | wc -l | tr -d ' ')
  DIR_COUNT=$(find "$SDK_DIR" -type d | wc -l | tr -d ' ')
  log_success "Synced $FILE_COUNT files in $DIR_COUNT directories to $SDK_DIR"
fi
