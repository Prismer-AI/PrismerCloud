#!/bin/bash
# version.sh — Bump version across all SDK packages
source "$(dirname "$0")/lib/common.sh"
parse_common_flags "$@"

# ── Parse version argument ─────────────────────────────────────────
TARGET=""
for arg in "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"; do
  case "$arg" in
    --patch) ;;  # handled below
    --minor) ;;
    --major) ;;
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
  echo "Usage: version.sh <X.Y.Z> | --patch | --minor | --major"
  exit 1
fi

log_step "Version Bump: $CURRENT → $TARGET"

# ── prismer-cloud suite ────────────────────────────────────────────
VERSION_FILES=(
  # package.json files
  "$PRISMER_CLOUD/typescript/package.json"
  "$PRISMER_CLOUD/mcp/package.json"
  "$PRISMER_CLOUD/opencode-plugin/package.json"
  "$PRISMER_CLOUD/claude-code-plugin/package.json"
  "$PRISMER_CLOUD/openclaw-channel/package.json"
  # plugin.json
  "$PRISMER_CLOUD/claude-code-plugin/.claude-plugin/plugin.json"
  # pyproject.toml
  "$PRISMER_CLOUD/python/pyproject.toml"
  # Cargo.toml
  "$PRISMER_CLOUD/rust/Cargo.toml"
)

# Files with hardcoded version strings
HARDCODED_FILES=(
  "$PRISMER_CLOUD/mcp/src/index.ts"
)

# Python __init__.py
PYTHON_INIT="$PRISMER_CLOUD/python/prismer/__init__.py"

# ── aip suite ──────────────────────────────────────────────────────
AIP_VERSION_FILES=(
  "$AIP_SDK/typescript/package.json"
  "$AIP_SDK/python/pyproject.toml"
  "$AIP_SDK/rust/Cargo.toml"
)

# ── Do the bump ───────────────────────────────────────────────────
bump_json() {
  local file="$1"
  if [[ ! -f "$file" ]]; then log_warn "Skip (not found): $file"; return; fi
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "Would update $file: $CURRENT → $TARGET"
  else
    sed -i '' "s/\"version\": *\"$CURRENT\"/\"version\": \"$TARGET\"/" "$file"
    log_info "Updated: $file"
  fi
}

bump_toml() {
  local file="$1"
  if [[ ! -f "$file" ]]; then log_warn "Skip (not found): $file"; return; fi
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "Would update $file: $CURRENT → $TARGET"
  else
    sed -i '' "s/^version = \"$CURRENT\"/version = \"$TARGET\"/" "$file"
    log_info "Updated: $file"
  fi
}

bump_hardcoded() {
  local file="$1"
  if [[ ! -f "$file" ]]; then log_warn "Skip (not found): $file"; return; fi
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "Would update $file: $CURRENT → $TARGET"
  else
    sed -i '' "s/version: '$CURRENT'/version: '$TARGET'/" "$file"
    sed -i '' "s/version: \"$CURRENT\"/version: \"$TARGET\"/" "$file"
    log_info "Updated: $file"
  fi
}

# prismer-cloud JSON
for f in "${VERSION_FILES[@]}"; do
  bump_json "$f"
done

# prismer-cloud TOML
bump_toml "$PRISMER_CLOUD/python/pyproject.toml"
bump_toml "$PRISMER_CLOUD/rust/Cargo.toml"

# prismer-cloud hardcoded
for f in "${HARDCODED_FILES[@]}"; do
  bump_hardcoded "$f"
done

# Python __init__.py
if [[ -f "$PYTHON_INIT" ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "Would update $PYTHON_INIT"
  else
    sed -i '' "s/__version__ = \"$CURRENT\"/__version__ = \"$TARGET\"/" "$PYTHON_INIT"
    log_info "Updated: $PYTHON_INIT"
  fi
fi

# aip suite
for f in "${AIP_VERSION_FILES[@]}"; do
  if [[ "$f" == *.json ]]; then bump_json "$f"
  elif [[ "$f" == *.toml ]]; then bump_toml "$f"
  fi
done

# ── Verify ────────────────────────────────────────────────────────
log_step "Verify"
FOUND=$(grep -rl "\"$TARGET\"\|'$TARGET'\|= \"$TARGET\"" "$PRISMER_CLOUD" --include="*.json" --include="*.toml" --include="*.ts" 2>/dev/null | wc -l | tr -d ' ')
log_success "Found $TARGET in $FOUND files"
log_success "Version bumped: $CURRENT → $TARGET"
