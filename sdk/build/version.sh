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
if scope_includes_prismer; then
  log_step "prismer-cloud packages"

  # JSON (package.json + plugin.json)
  bump_json "$PRISMER_CLOUD/typescript/package.json"
  bump_json "$PRISMER_CLOUD/mcp/package.json"
  bump_json "$PRISMER_CLOUD/opencode-plugin/package.json"
  bump_json "$PRISMER_CLOUD/claude-code-plugin/package.json"
  bump_json "$PRISMER_CLOUD/openclaw-channel/package.json"
  bump_json "$PRISMER_CLOUD/claude-code-plugin/.claude-plugin/plugin.json"

  # TOML
  bump_toml "$PRISMER_CLOUD/python/pyproject.toml"
  bump_toml "$PRISMER_CLOUD/rust/Cargo.toml"

  # Hardcoded version strings
  bump_hardcoded "$PRISMER_CLOUD/mcp/src/index.ts"

  # Python __init__.py
  bump_python_init "$PRISMER_CLOUD/python/prismer/__init__.py"
fi

# ── aip suite ──────────────────────────────────────────────────────
if scope_includes_aip; then
  log_step "aip packages"

  bump_json "$AIP_SDK/typescript/package.json"
  bump_toml "$AIP_SDK/python/pyproject.toml"
  bump_toml "$AIP_SDK/rust/Cargo.toml"
fi

# ── Verify ─────────────────────────────────────────────────────────
log_step "Verify"
FOUND=$(grep -rl "\"$TARGET\"\|'$TARGET'\|= \"$TARGET\"" "$SDK_ROOT" --include="*.json" --include="*.toml" --include="*.ts" --include="*.py" 2>/dev/null | wc -l | tr -d ' ')
log_success "Found $TARGET in $FOUND files"
log_success "Version bumped: $CURRENT → $TARGET"
