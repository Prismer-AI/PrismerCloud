#!/bin/bash
# version.sh — Bump version across SDK packages (respects --scope)
source "$(dirname "$0")/lib/common.sh"
parse_common_flags "$@"

# ── Parse version argument ─────────────────────────────────────────
TARGET=""
for arg in "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"; do
  case "$arg" in
    --patch|--minor|--major) ;;  # handled below
    *)       TARGET="$arg" ;;
  esac
done

CURRENT="$(get_version)"

if [[ -z "$TARGET" ]]; then
  # Semver bump
  IFS='.' read -r major minor patch <<< "$CURRENT"
  for arg in "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"; do
    case "$arg" in
      --patch) patch=$((patch + 1)) ;;
      --minor) minor=$((minor + 1)); patch=0 ;;
      --major) major=$((major + 1)); minor=0; patch=0 ;;
    esac
  done
  TARGET="$major.$minor.$patch"
fi

if [[ "$TARGET" == "$CURRENT" || -z "$TARGET" ]]; then
  log_error "Version unchanged or invalid. Current: $CURRENT"
  echo "Usage: version.sh <X.Y.Z> | --patch | --minor | --major [--scope aip|prismer-cloud|all]"
  exit 1
fi

log_step "Version Bump: $CURRENT → $TARGET (scope: $SCOPE)"

# ── Write root /VERSION (single source of truth) ───────────────────
# Only when bumping the full monorepo (scope=all). For scope-limited
# bumps we still update the file because all SDKs share /VERSION
# (hotfixes use sdk/build/hotfix.sh instead and do NOT touch /VERSION).
VERSION_FILE="$PROJECT_ROOT/VERSION"
if [[ $DRY_RUN -eq 1 ]]; then
  log_dry "Would write $TARGET to $VERSION_FILE"
else
  echo "$TARGET" > "$VERSION_FILE"
  log_info "Updated: $VERSION_FILE"
fi

# ── Bump helpers ───────────────────────────────────────────────────
bump_json() {
  local file="$1"
  if [[ ! -f "$file" ]]; then log_warn "Skip (not found): $file"; return; fi
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "Would update $file"
  else
    sed -i '' "s/\"version\": *\"[^\"]*\"/\"version\": \"$TARGET\"/" "$file"
    log_info "Updated: $file"
  fi
}

bump_toml() {
  local file="$1"
  if [[ ! -f "$file" ]]; then log_warn "Skip (not found): $file"; return; fi
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "Would update $file"
  else
    sed -i '' "s/^version = \"[^\"]*\"/version = \"$TARGET\"/" "$file"
    log_info "Updated: $file"
  fi
}

bump_hardcoded() {
  local file="$1"
  if [[ ! -f "$file" ]]; then log_warn "Skip (not found): $file"; return; fi
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "Would update $file"
  else
    sed -i '' "s/version: '[^']*'/version: '$TARGET'/" "$file"
    sed -i '' "s/version: \"[^\"]*\"/version: \"$TARGET\"/" "$file"
    log_info "Updated: $file"
  fi
}

bump_marketplace() {
  local file="$1"
  if [[ ! -f "$file" ]]; then log_warn "Skip (not found): $file"; return; fi
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "Would update $file"
  else
    # Bump plugins[].version in marketplace.json
    sed -i '' "s/\"version\": *\"[^\"]*\"/\"version\": \"$TARGET\"/" "$file"
    log_info "Updated: $file"
  fi
}

bump_python_init() {
  local file="$1"
  if [[ ! -f "$file" ]]; then log_warn "Skip (not found): $file"; return; fi
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "Would update $file"
  else
    sed -i '' "s/__version__ = \"[^\"]*\"/__version__ = \"$TARGET\"/" "$file"
    log_info "Updated: $file"
  fi
}

# ── prismer-cloud suite ────────────────────────────────────────────
#
# VERSION POLICY
# --------------
# Platform-coupled packages follow the root /VERSION:
#   - sdk/prismer-cloud/typescript/
#   - sdk/prismer-cloud/python/
#   - sdk/prismer-cloud/rust/
#   - sdk/prismer-cloud/mcp/
#   - sdk/prismer-cloud/runtime/
#   - sdk/prismer-cloud/sandbox-runtime/
#   - sdk/prismer-cloud/claude-code-plugin/
#   - sdk/prismer-cloud/opencode-plugin/
#   - sdk/prismer-cloud/openclaw-channel/
#
# Independent packages stay on their own 0.x line and MUST NOT be bumped by
# the coordinated platform release:
#   - sdk/prismer-cloud/wire/
#   - sdk/prismer-cloud/adapters-core/
#   - sdk/prismer-cloud/adapters/hermes-node/
#   - sdk/prismer-cloud/adapters/hermes/
#
# Use sdk/build/hotfix.sh for independent-package patch releases.
if scope_includes_prismer; then
  log_step "prismer-cloud packages"

  # JSON (package.json + plugin.json + marketplace.json)
  bump_json "$PRISMER_CLOUD/runtime/package.json"
  bump_json "$PRISMER_CLOUD/sandbox-runtime/package.json"
  bump_json "$PRISMER_CLOUD/typescript/package.json"
  bump_json "$PRISMER_CLOUD/mcp/package.json"
  bump_json "$PRISMER_CLOUD/opencode-plugin/package.json"
  bump_json "$PRISMER_CLOUD/claude-code-plugin/package.json"
  bump_json "$PRISMER_CLOUD/openclaw-channel/package.json"
  bump_json "$PRISMER_CLOUD/claude-code-plugin/.claude-plugin/plugin.json"
  bump_marketplace "$PRISMER_CLOUD/claude-code-plugin/.claude-plugin/marketplace.json"

  # TOML
  bump_toml "$PRISMER_CLOUD/python/pyproject.toml"
  bump_toml "$PRISMER_CLOUD/rust/Cargo.toml"

  # Hardcoded version strings
  bump_hardcoded "$PRISMER_CLOUD/mcp/src/index.ts"

  # Python __init__.py
  bump_python_init "$PRISMER_CLOUD/python/prismer/__init__.py"

  # Guard rail: fail loudly if the excluded packages somehow get touched
  for INDEP in "$PRISMER_CLOUD/wire/package.json" \
               "$PRISMER_CLOUD/adapters-core/package.json" \
               "$PRISMER_CLOUD/adapters/hermes-node/package.json" \
               "$PRISMER_CLOUD/adapters/hermes/pyproject.toml"; do
    if [[ -f "$INDEP" ]]; then
      INDEP_VER=$(grep -m1 -E '("version"|^version) *[:=]' "$INDEP" | sed -E 's/.*"([^"]+)".*/\1/')
      if [[ "$INDEP_VER" == "$TARGET" ]]; then
        log_warn "Independent package at $INDEP reports version $TARGET — this may be coincidental, but the exclusion policy expects 0.x. Verify intentional."
      fi
    fi
  done
fi

# ── aip suite ──────────────────────────────────────────────────────
if scope_includes_aip; then
  log_step "aip packages"

  bump_json "$AIP_SDK/typescript/package.json"
  bump_toml "$AIP_SDK/python/pyproject.toml"
  bump_toml "$AIP_SDK/rust/Cargo.toml"
fi

# ── Root package.json + src/lib/version.ts BUILD_DATE ──────────────
if scope_includes_prismer; then
  bump_json "$PROJECT_ROOT/package.json"
  if [[ -f "$PROJECT_ROOT/src/lib/version.ts" ]]; then
    if [[ $DRY_RUN -eq 1 ]]; then
      log_dry "Would update VERSION + BUILD_DATE in src/lib/version.ts"
    else
      TODAY="$(date +%Y-%m-%d)"
      sed -i '' "s/^export const VERSION = '[^']*'/export const VERSION = '$TARGET'/" "$PROJECT_ROOT/src/lib/version.ts"
      sed -i '' "s/^export const BUILD_DATE = '[^']*'/export const BUILD_DATE = '$TODAY'/" "$PROJECT_ROOT/src/lib/version.ts"
      log_info "Updated VERSION + BUILD_DATE in src/lib/version.ts"
    fi
  fi
fi

# ── Verify ─────────────────────────────────────────────────────────
log_step "Verify"
FOUND=$(grep -rl "\"$TARGET\"\|'$TARGET'\|= \"$TARGET\"" "$SDK_ROOT" --include="*.json" --include="*.toml" --include="*.ts" --include="*.py" 2>/dev/null | wc -l | tr -d ' ')
log_success "Found $TARGET in $FOUND files"
log_success "Version bumped: $CURRENT → $TARGET"
