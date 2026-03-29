#!/bin/bash
# version.sh — Atomic version bumper for all PrismerCloud SDK manifests
source "$(dirname "$0")/lib/common.sh"
parse_common_flags "$@"

# ── Parse script-specific flags ──────────────────────────────────
FROM_VERSION=""
BUMP_PATCH=0
BUMP_MINOR=0
BUMP_MAJOR=0
NEW_VERSION=""
args=()
i=0
while [[ $i -lt ${#REMAINING_ARGS[@]} ]]; do
  case "${REMAINING_ARGS[$i]}" in
    --from)
      ((i++))
      FROM_VERSION="${REMAINING_ARGS[$i]}"
      ;;
    --patch)
      BUMP_PATCH=1
      ;;
    --minor)
      BUMP_MINOR=1
      ;;
    --major)
      BUMP_MAJOR=1
      ;;
    *)
      args+=("${REMAINING_ARGS[$i]}")
      ;;
  esac
  ((i++))
done
REMAINING_ARGS=("${args[@]+"${args[@]}"}")

# ── Determine current (old) version ──────────────────────────────
if [[ -n "$FROM_VERSION" ]]; then
  OLD="$FROM_VERSION"
else
  OLD="$(get_version)"
fi

if [[ "$OLD" == "unknown" || -z "$OLD" ]]; then
  log_error "Could not determine current version. Use --from <ver>."
  exit 1
fi

# ── Determine new version ────────────────────────────────────────
BUMP_COUNT=$(( BUMP_PATCH + BUMP_MINOR + BUMP_MAJOR ))

if [[ $BUMP_COUNT -gt 1 ]]; then
  log_error "Only one of --patch, --minor, --major can be specified."
  exit 1
fi

if [[ $BUMP_COUNT -eq 1 ]]; then
  IFS=. read -r V_MAJOR V_MINOR V_PATCH <<< "$OLD"
  if [[ $BUMP_PATCH -eq 1 ]]; then
    NEW_VERSION="$V_MAJOR.$V_MINOR.$((V_PATCH + 1))"
  elif [[ $BUMP_MINOR -eq 1 ]]; then
    NEW_VERSION="$V_MAJOR.$((V_MINOR + 1)).0"
  elif [[ $BUMP_MAJOR -eq 1 ]]; then
    NEW_VERSION="$((V_MAJOR + 1)).0.0"
  fi
elif [[ ${#REMAINING_ARGS[@]} -gt 0 ]]; then
  NEW_VERSION="${REMAINING_ARGS[0]}"
else
  log_error "Usage: version.sh [--dry-run] [--from <ver>] <new-version>"
  log_error "       version.sh --patch|--minor|--major"
  exit 1
fi

NEW="$NEW_VERSION"

# ── Validate version format ───────────────────────────────────────
if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  log_error "Invalid version format: $NEW (expected X.Y.Z)"
  exit 1
fi

if [[ "$OLD" == "$NEW" ]]; then
  log_error "New version is the same as current version: $OLD"
  exit 1
fi

# ── Display plan ──────────────────────────────────────────────────
log_step "Version Bump: $OLD → $NEW"

if [[ $DRY_RUN -eq 1 ]]; then
  log_warn "DRY-RUN mode — no files will be modified"
fi

JSON_FILES=(
  "$SDK_DIR/typescript/package.json"
  "$SDK_DIR/mcp/package.json"
  "$SDK_DIR/opencode-plugin/package.json"
  "$SDK_DIR/claude-code-plugin/package.json"
  "$SDK_DIR/claude-code-plugin/.claude-plugin/plugin.json"
  "$SDK_DIR/openclaw-channel/package.json"
)

TOML_FILES=(
  "$SDK_DIR/python/pyproject.toml"
  "$SDK_DIR/rust/Cargo.toml"
)

SOURCE_FILES=(
  "$SDK_DIR/python/prismer/__init__.py"
  "$SDK_DIR/mcp/src/index.ts"
  "$SDK_DIR/rust/src/cli.rs"
)

README_FILES=(
  "$REPO_ROOT/sdk/README.md"
  "$REPO_ROOT/sdk/typescript/README.md"
  "$REPO_ROOT/sdk/python/README.md"
  "$REPO_ROOT/sdk/golang/README.md"
  "$REPO_ROOT/sdk/rust/README.md"
)

log_info "JSON files:"
for f in "${JSON_FILES[@]}"; do echo "  - ${f#$REPO_ROOT/}"; done
log_info "TOML files:"
for f in "${TOML_FILES[@]}"; do echo "  - ${f#$REPO_ROOT/}"; done
log_info "Source files:"
for f in "${SOURCE_FILES[@]}"; do echo "  - ${f#$REPO_ROOT/}"; done
log_info "README files:"
for f in "${README_FILES[@]}"; do echo "  - ${f#$REPO_ROOT/}"; done
log_info "Also: sdk/rust/Cargo.lock (cargo update)"

confirm_prompt "Update all files from $OLD to $NEW?"

# ── Helper: update JSON version field ─────────────────────────────
update_json_version() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    log_warn "File not found, skipping: $file"
    return
  fi
  run_or_dry sed -i '' "s/\"version\": \"$OLD\"/\"version\": \"$NEW\"/" "$file"
  log_info "Updated $(basename "$file")"
}

# ── Update JSON files ─────────────────────────────────────────────
log_step "Updating JSON files"
FILE_COUNT=0

for f in "${JSON_FILES[@]}"; do
  update_json_version "$f"
  ((FILE_COUNT++))
done

# ── Update TOML files ─────────────────────────────────────────────
log_step "Updating TOML files"

if [[ -f "$SDK_DIR/python/pyproject.toml" ]]; then
  run_or_dry sed -i '' "s/^version = \"$OLD\"/version = \"$NEW\"/" "$SDK_DIR/python/pyproject.toml"
  log_info "Updated pyproject.toml"
  ((FILE_COUNT++))
else
  log_warn "File not found: sdk/python/pyproject.toml"
fi

if [[ -f "$SDK_DIR/rust/Cargo.toml" ]]; then
  run_or_dry sed -i '' "s/^version = \"$OLD\"/version = \"$NEW\"/" "$SDK_DIR/rust/Cargo.toml"
  log_info "Updated Cargo.toml"
  ((FILE_COUNT++))
else
  log_warn "File not found: sdk/rust/Cargo.toml"
fi

# ── Update source files ──────────────────────────────────────────
log_step "Updating source files"

if [[ -f "$SDK_DIR/python/prismer/__init__.py" ]]; then
  run_or_dry sed -i '' "s/__version__ = \"$OLD\"/__version__ = \"$NEW\"/" "$SDK_DIR/python/prismer/__init__.py"
  log_info "Updated prismer/__init__.py"
  ((FILE_COUNT++))
else
  log_warn "File not found: sdk/python/prismer/__init__.py"
fi

if [[ -f "$SDK_DIR/mcp/src/index.ts" ]]; then
  run_or_dry sed -i '' "s/version: '$OLD'/version: '$NEW'/" "$SDK_DIR/mcp/src/index.ts"
  log_info "Updated mcp/src/index.ts"
  ((FILE_COUNT++))
else
  log_warn "File not found: sdk/mcp/src/index.ts"
fi

if [[ -f "$SDK_DIR/rust/src/cli.rs" ]]; then
  run_or_dry sed -i '' "s/version = \"$OLD\"/version = \"$NEW\"/" "$SDK_DIR/rust/src/cli.rs"
  log_info "Updated rust/src/cli.rs"
  ((FILE_COUNT++))
else
  log_warn "File not found: sdk/rust/src/cli.rs"
fi

# ── Update README files ──────────────────────────────────────────
log_step "Updating README files"

for readme in "${README_FILES[@]}"; do
  if [[ -f "$readme" ]]; then
    run_or_dry sed -i '' "s/(v$OLD)/(v$NEW)/g" "$readme"
    run_or_dry sed -i '' "s/\"$OLD\"/\"$NEW\"/g" "$readme"
    log_info "Updated $(basename "$readme") ($(dirname "${readme#$REPO_ROOT/}"))"
    ((FILE_COUNT++))
  else
    log_warn "File not found: $readme"
  fi
done

# ── Update Cargo.lock ─────────────────────────────────────────────
log_step "Updating Cargo.lock"

if [[ $DRY_RUN -eq 0 ]]; then
  if [[ -f "$SDK_DIR/rust/Cargo.toml" ]]; then
    cd "$SDK_DIR/rust" && cargo update --workspace 2>/dev/null || true
    log_info "Updated Cargo.lock"
  fi
else
  log_dry "Would run cargo update --workspace in sdk/rust/"
fi

# ── Verify: check for stale old version strings ──────────────────
log_step "Verification"

STALE_FILES=()
while IFS= read -r file; do
  # Skip binary files, node_modules, .git, Cargo.lock
  case "$file" in
    */node_modules/*|*/.git/*|*/Cargo.lock|*/target/*|*/.venv/*) continue ;;
  esac
  STALE_FILES+=("$file")
done < <(grep -rl "\"$OLD\"" "$SDK_DIR" 2>/dev/null || true)

if [[ ${#STALE_FILES[@]} -gt 0 ]]; then
  log_warn "Found remaining references to \"$OLD\" in:"
  for f in "${STALE_FILES[@]}"; do
    echo "  - ${f#$REPO_ROOT/}"
  done
  log_warn "These may need manual review."
else
  log_success "No stale version references found."
fi

# ── Summary ───────────────────────────────────────────────────────
log_step "Summary"
if [[ $DRY_RUN -eq 1 ]]; then
  log_dry "Would have updated $FILE_COUNT files from $OLD to $NEW"
else
  log_success "Updated $FILE_COUNT files from $OLD to $NEW"
fi
