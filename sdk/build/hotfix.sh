#!/bin/bash
# hotfix.sh — Bump a SINGLE package to X.Y.Z.N without touching root /VERSION.
#
# Usage:
#   sdk/build/hotfix.sh <package> <X.Y.Z.N>
#   sdk/build/hotfix.sh <package> --auto       # auto-increment N (1.8.2 → 1.8.2.1, 1.8.2.1 → 1.8.2.2)
#
# Packages:
#   aip-ts          sdk/aip/typescript
#   aip-py          sdk/aip/python
#   aip-rs          sdk/aip/rust
#   sdk-ts          sdk/prismer-cloud/typescript
#   sdk-py          sdk/prismer-cloud/python
#   sdk-rs          sdk/prismer-cloud/rust
#   mcp             sdk/prismer-cloud/mcp
#   plugin-claude   sdk/prismer-cloud/claude-code-plugin
#   plugin-opencode sdk/prismer-cloud/opencode-plugin
#   openclaw        sdk/prismer-cloud/openclaw-channel
#
# Hotfixes do NOT touch:
#   - root /VERSION
#   - other packages
#   - root package.json
#   - src/lib/version.ts
#
# Tag convention after publish: hotfix-<package>-vX.Y.Z.N

set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
parse_common_flags "$@"
set -- "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"

PKG="${1:-}"
TARGET="${2:-}"

if [[ -z "$PKG" || -z "$TARGET" ]]; then
  echo "Usage: hotfix.sh <package> <X.Y.Z.N | --auto>"
  echo ""
  echo "Packages: aip-ts aip-py aip-rs sdk-ts sdk-py sdk-rs mcp plugin-claude plugin-opencode openclaw"
  exit 1
fi

# ── Resolve package paths ─────────────────────────────────────────
case "$PKG" in
  aip-ts)          PKG_DIR="$AIP_SDK/typescript"; KIND="json" ;;
  aip-py)          PKG_DIR="$AIP_SDK/python"; KIND="toml-py" ;;
  aip-rs)          PKG_DIR="$AIP_SDK/rust"; KIND="toml" ;;
  sdk-ts)          PKG_DIR="$PRISMER_CLOUD/typescript"; KIND="json" ;;
  sdk-py)          PKG_DIR="$PRISMER_CLOUD/python"; KIND="toml-py" ;;
  sdk-rs)          PKG_DIR="$PRISMER_CLOUD/rust"; KIND="toml" ;;
  mcp)             PKG_DIR="$PRISMER_CLOUD/mcp"; KIND="json-mcp" ;;
  plugin-claude)   PKG_DIR="$PRISMER_CLOUD/claude-code-plugin"; KIND="json-plugin" ;;
  plugin-opencode) PKG_DIR="$PRISMER_CLOUD/opencode-plugin"; KIND="json" ;;
  openclaw)        PKG_DIR="$PRISMER_CLOUD/openclaw-channel"; KIND="json" ;;
  *) log_error "Unknown package: $PKG"; exit 1 ;;
esac

if [[ ! -d "$PKG_DIR" ]]; then
  log_error "Package dir not found: $PKG_DIR"
  exit 1
fi

# ── Read current package version ──────────────────────────────────
read_pkg_version() {
  case "$KIND" in
    json|json-mcp|json-plugin)
      grep '"version"' "$PKG_DIR/package.json" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/' ;;
    toml|toml-py)
      local f="$PKG_DIR/Cargo.toml"; [[ "$KIND" == "toml-py" ]] && f="$PKG_DIR/pyproject.toml"
      grep -E '^version = ' "$f" | head -1 | sed 's/version = "\([^"]*\)"/\1/' ;;
  esac
}

CURRENT="$(read_pkg_version)"

# ── Resolve --auto ─────────────────────────────────────────────────
if [[ "$TARGET" == "--auto" ]]; then
  # If current is X.Y.Z, target = X.Y.Z.1; if X.Y.Z.N, target = X.Y.Z.(N+1)
  if [[ "$CURRENT" =~ ^([0-9]+\.[0-9]+\.[0-9]+)\.([0-9]+)$ ]]; then
    BASE="${BASH_REMATCH[1]}"
    N="${BASH_REMATCH[2]}"
    TARGET="$BASE.$((N + 1))"
  elif [[ "$CURRENT" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    TARGET="$CURRENT.1"
  else
    log_error "Cannot auto-bump from version: $CURRENT"
    exit 1
  fi
fi

# ── Validate hotfix format X.Y.Z.N ────────────────────────────────
if [[ ! "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  log_error "Hotfix version must be 4-segment (X.Y.Z.N): got '$TARGET'"
  log_error "For X.Y.Z bumps, use sdk/build/version.sh instead (it bumps everything)."
  exit 1
fi

# ── Validate hotfix base matches root /VERSION ────────────────────
ROOT_VERSION="$(get_version)"
TARGET_BASE="${TARGET%.*}"
if [[ "$TARGET_BASE" != "$ROOT_VERSION" ]]; then
  log_warn "Hotfix base ($TARGET_BASE) does not match root /VERSION ($ROOT_VERSION)."
  log_warn "Hotfixes should patch the current shipped version. Continue anyway?"
  if ! confirm_prompt "Proceed?"; then exit 1; fi
fi

log_step "Hotfix: $PKG $CURRENT → $TARGET"
log_info "Root /VERSION ($ROOT_VERSION) will NOT change."

# ── Apply bump (single package only) ──────────────────────────────
case "$KIND" in
  json|json-mcp|json-plugin)
    if [[ $DRY_RUN -eq 1 ]]; then
      log_dry "Would update $PKG_DIR/package.json"
    else
      sed -i '' "s/\"version\": *\"[^\"]*\"/\"version\": \"$TARGET\"/" "$PKG_DIR/package.json"
      log_info "Updated: $PKG_DIR/package.json"
    fi
    # Plugin extras
    if [[ "$KIND" == "json-plugin" && -f "$PKG_DIR/.claude-plugin/plugin.json" ]]; then
      if [[ $DRY_RUN -eq 0 ]]; then
        sed -i '' "s/\"version\": *\"[^\"]*\"/\"version\": \"$TARGET\"/" "$PKG_DIR/.claude-plugin/plugin.json"
        log_info "Updated: $PKG_DIR/.claude-plugin/plugin.json"
      fi
    fi
    # MCP extras
    if [[ "$KIND" == "json-mcp" && -f "$PKG_DIR/src/index.ts" ]]; then
      if [[ $DRY_RUN -eq 0 ]]; then
        sed -i '' "s/version: '[^']*'/version: '$TARGET'/" "$PKG_DIR/src/index.ts"
        sed -i '' "s/version: \"[^\"]*\"/version: \"$TARGET\"/" "$PKG_DIR/src/index.ts"
        log_info "Updated: $PKG_DIR/src/index.ts"
      fi
    fi
    ;;
  toml-py)
    if [[ $DRY_RUN -eq 1 ]]; then
      log_dry "Would update $PKG_DIR/pyproject.toml"
    else
      sed -i '' "s/^version = \"[^\"]*\"/version = \"$TARGET\"/" "$PKG_DIR/pyproject.toml"
      log_info "Updated: $PKG_DIR/pyproject.toml"
      INIT_FILE="$PKG_DIR/$(basename "$PKG_DIR")/__init__.py"
      if [[ -f "$INIT_FILE" ]]; then
        sed -i '' "s/__version__ = \"[^\"]*\"/__version__ = \"$TARGET\"/" "$INIT_FILE"
        log_info "Updated: $INIT_FILE"
      fi
    fi
    ;;
  toml)
    if [[ $DRY_RUN -eq 1 ]]; then
      log_dry "Would update $PKG_DIR/Cargo.toml"
    else
      sed -i '' "s/^version = \"[^\"]*\"/version = \"$TARGET\"/" "$PKG_DIR/Cargo.toml"
      log_info "Updated: $PKG_DIR/Cargo.toml"
    fi
    ;;
esac

log_success "Hotfix bump complete: $PKG $CURRENT → $TARGET"
log_info "Next: test → publish → tag with 'hotfix-$PKG-v$TARGET'"
