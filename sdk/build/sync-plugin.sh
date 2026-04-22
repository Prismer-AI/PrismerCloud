#!/bin/bash
# sync-plugin.sh — Sync claude-code-plugin to PrismerCloud standalone repo
#
# This script packages the claude-code-plugin from the monorepo and syncs it
# to the standalone PrismerCloud repository used for Anthropic marketplace publishing.
#
# Usage:
#   ./sync-plugin.sh [--dry-run]
#
# Environment:
#   PRISMERCLOUD_REPO - Path to PrismerCloud repo
#                       (default: /Users/prismer/workspace/opensource/PrismerCloud,
#                        resolved via sdk/build/lib/common.sh for single source of truth)

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Source common.sh for OPENSRC_ROOT (honors PRISMERCLOUD_REPO env var)
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
SOURCE_DIR="$PROJECT_ROOT/sdk/prismer-cloud/claude-code-plugin"
TARGET_REPO="$OPENSRC_ROOT"
TARGET_DIR="$TARGET_REPO/sdk/prismer-cloud/claude-code-plugin"

# ── Helpers ───────────────────────────────────────────────────────────────
log_info() { echo "[sync-plugin] $*"; }
log_error() { echo "[sync-plugin] ERROR: $*" >&2; }
log_dry() { echo "[sync-plugin] DRY-RUN: $*"; }

# ── Parse arguments ─────────────────────────────────────────────────────
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) log_error "Unknown argument: $arg"; exit 1 ;;
  esac
done

# ── Validate paths ─────────────────────────────────────────────────────
if [[ ! -d "$SOURCE_DIR" ]]; then
  log_error "Source directory not found: $SOURCE_DIR"
  exit 1
fi

if [[ ! -d "$TARGET_REPO" ]]; then
  log_error "Target repo not found: $TARGET_REPO"
  log_error "Set PRISMERCLOUD_REPO environment variable or ensure repo exists at default path"
  exit 1
fi

log_info "Source: $SOURCE_DIR"
log_info "Target: $TARGET_DIR"
[[ $DRY_RUN -eq 1 ]] && log_info "Mode: DRY-RUN"

# ── Step 1: Package the plugin ────────────────────────────────────────────
log_info "Step 1: Packaging claude-code-plugin..."
PACK_FILE="$SOURCE_DIR/@prismer-claude-code-plugin-*.tgz"

if [[ $DRY_RUN -eq 1 ]]; then
  log_dry "Would run: npm pack (in $SOURCE_DIR)"
else
  cd "$SOURCE_DIR"
  npm pack --quiet
  PACK_FILE=$(ls -t @prismer-claude-code-plugin-*.tgz 2>/dev/null | head -1)
  if [[ ! -f "$PACK_FILE" ]]; then
    log_error "npm pack failed: no .tgz file generated"
    exit 1
  fi
  log_info "Packaged: $PACK_FILE"
fi

# ── Step 2: Sync to target repo ───────────────────────────────────────────
log_info "Step 2: Syncing to PrismerCloud repo..."

# Create target directory if it doesn't exist
if [[ ! -d "$TARGET_DIR" ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "Would create directory: $TARGET_DIR"
  else
    mkdir -p "$TARGET_DIR"
    log_info "Created: $TARGET_DIR"
  fi
fi

# Copy plugin files (exclude node_modules, .cache, dist, test files)
if [[ $DRY_RUN -eq 1 ]]; then
  log_dry "Would sync files from $SOURCE_DIR to $TARGET_DIR"
  log_dry "Excluded: node_modules, .cache, dist, test, *.test.*"
else
  rsync -av --delete \
    --exclude='node_modules' \
    --exclude='.cache' \
    --exclude='dist' \
    --exclude='*.test.*' \
    --exclude='*.test.mjs' \
    --exclude='*.test.ts' \
    --exclude='tests/' \
    --exclude='.git/' \
    --exclude='.DS_Store' \
    "$SOURCE_DIR/" "$TARGET_DIR/"
  log_info "Synced files to $TARGET_DIR"
fi

# ── Step 3: Copy package file to target ───────────────────────────────────
if [[ $DRY_RUN -eq 1 ]]; then
  log_dry "Would copy $PACK_FILE to $TARGET_REPO/sdk/prismer-cloud/"
else
  cp "$PACK_FILE" "$TARGET_REPO/sdk/prismer-cloud/"
  log_info "Copied package to $TARGET_REPO/sdk/prismer-cloud/"
fi

# ── Step 4: Verify version consistency ────────────────────────────────────
log_info "Step 3: Verifying version consistency..."

if [[ $DRY_RUN -eq 1 ]]; then
  log_dry "Would verify versions in package.json, plugin.json, marketplace.json"
else
  SOURCE_PKG_VER=$(grep -m1 '"version"' "$SOURCE_DIR/package.json" | sed -E 's/.*"([^"]+)".*/\1/')
  SOURCE_PLUGIN_VER=$(grep -m1 '"version"' "$SOURCE_DIR/.claude-plugin/plugin.json" | sed -E 's/.*"([^"]+)".*/\1/')
  SOURCE_MP_VER=$(grep -m1 '"version"' "$SOURCE_DIR/.claude-plugin/marketplace.json" | sed -E 's/.*"([^"]+)".*/\1/')
  
  TARGET_PKG_VER=$(grep -m1 '"version"' "$TARGET_DIR/package.json" | sed -E 's/.*"([^"]+)".*/\1/')
  TARGET_PLUGIN_VER=$(grep -m1 '"version"' "$TARGET_DIR/.claude-plugin/plugin.json" | sed -E 's/.*"([^"]+)".*/\1/')
  TARGET_MP_VER=$(grep -m1 '"version"' "$TARGET_DIR/.claude-plugin/marketplace.json" | sed -E 's/.*"([^"]+)".*/\1/')

  VERSION_MISMATCH=0
  if [[ "$SOURCE_PKG_VER" != "$TARGET_PKG_VER" ]]; then
    log_error "package.json version mismatch: source=$SOURCE_PKG_VER, target=$TARGET_PKG_VER"
    VERSION_MISMATCH=1
  fi
  if [[ "$SOURCE_PLUGIN_VER" != "$TARGET_PLUGIN_VER" ]]; then
    log_error "plugin.json version mismatch: source=$SOURCE_PLUGIN_VER, target=$TARGET_PLUGIN_VER"
    VERSION_MISMATCH=1
  fi
  if [[ "$SOURCE_MP_VER" != "$TARGET_MP_VER" ]]; then
    log_error "marketplace.json version mismatch: source=$SOURCE_MP_VER, target=$TARGET_MP_VER"
    VERSION_MISMATCH=1
  fi

  if [[ $VERSION_MISMATCH -eq 1 ]]; then
    log_error "Version mismatch detected! Run sdk/build/version.sh to sync versions first."
    exit 1
  fi

  log_info "Version consistency verified: $SOURCE_PKG_VER"
fi

# ── Done ─────────────────────────────────────────────────────────────────
if [[ $DRY_RUN -eq 1 ]]; then
  log_info "Dry-run complete. No changes made."
else
  log_info "Sync complete!"
  log_info "Next steps:"
  log_info "  1. cd $TARGET_REPO"
  log_info "  2. Review changes with: git status"
  log_info "  3. Commit and push to trigger marketplace update"
fi
