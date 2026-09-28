#!/bin/bash
# version.sh — Align every active package to the root X.Y.Z release version
source "$(dirname "$0")/lib/common.sh"
parse_common_flags "$@"

if [[ "$SCOPE" != "all" ]]; then
  log_error "Version changes are monorepo-wide; use --scope all"
  exit 2
fi

TARGET=""
BUMP=""
REPAIR=0
for arg in "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"; do
  case "$arg" in
    --patch|--minor|--major) BUMP="$arg" ;;
    --repair) REPAIR=1 ;;
    *) TARGET="$arg" ;;
  esac
done

CURRENT="$(get_version)"

is_semver() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
}

if ! is_semver "$CURRENT"; then
  log_error "Root VERSION must be X.Y.Z: $CURRENT"
  exit 1
fi

if [[ -n "$TARGET" && -n "$BUMP" ]]; then
  log_error "Choose an explicit X.Y.Z or one of --patch/--minor/--major"
  exit 1
fi

if [[ -z "$TARGET" && $REPAIR -eq 1 ]]; then
  TARGET="$CURRENT"
elif [[ -z "$TARGET" ]]; then
  IFS='.' read -r major minor patch <<< "$CURRENT"
  case "${BUMP:---patch}" in
    --patch) patch=$((patch + 1)) ;;
    --minor) minor=$((minor + 1)); patch=0 ;;
    --major) major=$((major + 1)); minor=0; patch=0 ;;
  esac
  TARGET="$major.$minor.$patch"
fi

if ! is_semver "$TARGET"; then
  log_error "Target version must be X.Y.Z; registry package versions cannot use four segments: $TARGET"
  exit 1
fi
if [[ "$TARGET" == "$CURRENT" && $REPAIR -ne 1 ]]; then
  log_error "Version unchanged: $CURRENT"
  exit 1
fi

IFS='.' read -r target_major target_minor _target_patch <<< "$TARGET"
NEXT_MINOR="$target_major.$((target_minor + 1)).0"

log_step "Version alignment: $CURRENT → $TARGET"

write_version_file() {
  local file="$1"
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "write $TARGET to $file"
  else
    printf '%s\n' "$TARGET" > "$file"
    log_info "Updated: $file"
  fi
}

bump_json() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "update JSON version in $file"
    return
  fi
  node - "$file" "$TARGET" <<'NODE'
const fs = require('node:fs');
const [file, version] = process.argv.slice(2);
const json = JSON.parse(fs.readFileSync(file, 'utf8'));
json.version = version;
if (json.packages?.['']?.version) json.packages[''].version = version;
fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
NODE
  log_info "Updated: $file"
}

set_json_dependency() {
  local file="$1"
  local dependency="$2"
  local range="$3"
  [[ -f "$file" ]] || return 0
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "set $dependency=$range in $file"
    return
  fi
  node - "$file" "$dependency" "$range" <<'NODE'
const fs = require('node:fs');
const [file, dependency, range] = process.argv.slice(2);
const json = JSON.parse(fs.readFileSync(file, 'utf8'));
if (json.dependencies?.[dependency]) json.dependencies[dependency] = range;
if (json.packages?.['']?.dependencies?.[dependency]) json.packages[''].dependencies[dependency] = range;
fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
NODE
  log_info "Updated dependency: $file"
}

bump_pyproject() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "update Python version in $file"
    return
  fi
  node - "$file" "$TARGET" <<'NODE'
const fs = require('node:fs');
const [file, version] = process.argv.slice(2);
const source = fs.readFileSync(file, 'utf8').replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`);
fs.writeFileSync(file, source);
NODE
  log_info "Updated: $file"
}

set_python_aip_dependency() {
  local file="$1"
  local range="prismer-aip>=$TARGET,<$NEXT_MINOR"
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "set $range in $file"
    return
  fi
  node - "$file" "$range" <<'NODE'
const fs = require('node:fs');
const [file, range] = process.argv.slice(2);
const source = fs.readFileSync(file, 'utf8').replace(/prismer-aip>=[^",]+,<[^"\]]+/, range);
fs.writeFileSync(file, source);
NODE
  log_info "Updated dependency: $file"
}

bump_generated_sources() {
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "update src/lib/version.ts, sdk/prismer/src/cli/index.ts, sdk/cloud/mcp/src/index.ts"
    log_dry "update sdk/cloud/python/prismer/__init__.py"
    return
  fi
  node - "$PROJECT_ROOT/src/lib/version.ts" "$TARGET" <<'NODE'
const fs = require('node:fs');
const [file, version] = process.argv.slice(2);
const today = new Date().toISOString().slice(0, 10);
const source = fs.readFileSync(file, 'utf8');
// BUILD_DATE only advances when the version itself changes; a --repair run
// at the same version must be a byte-for-byte no-op for this file.
const versioned = source.replace(/^export const VERSION = '[^']+'/m, `export const VERSION = '${version}'`);
const updated =
  versioned === source
    ? versioned
    : versioned.replace(/^export const BUILD_DATE = '[^']+'/m, `export const BUILD_DATE = '${today}'`);
fs.writeFileSync(file, updated);
NODE
  node - "$PRISMER_RUNTIME/src/cli/index.ts" "$TARGET" <<'NODE'
const fs = require('node:fs');
const [file, version] = process.argv.slice(2);
const source = fs.readFileSync(file, 'utf8').replace(/^const VERSION = '[^']+'/m, `const VERSION = '${version}'`);
fs.writeFileSync(file, source);
NODE
  node - "$CLOUD_SDK/mcp/src/index.ts" "$TARGET" <<'NODE'
const fs = require('node:fs');
const [file, version] = process.argv.slice(2);
const source = fs.readFileSync(file, 'utf8').replace(/(name:\s*'prismer',\s*\n\s*version:)\s*'[^']+'/m, `$1 '${version}'`);
fs.writeFileSync(file, source);
NODE
  node - "$CLOUD_SDK/python/prismer/__init__.py" "$TARGET" <<'NODE'
const fs = require('node:fs');
const [file, version] = process.argv.slice(2);
const source = fs.readFileSync(file, 'utf8').replace(/^__version__ = "[^"]+"/m, `__version__ = "${version}"`);
fs.writeFileSync(file, source);
NODE
  log_info "Updated generated source versions"
}

write_version_file "$PROJECT_ROOT/VERSION"

for manifest in \
  "$PROJECT_ROOT/package.json" \
  "$PROJECT_ROOT/apps/desktop/package.json" \
  "$AIP_SDK/typescript/package.json" \
  "$CLOUD_SDK/package.json" \
  "$CLOUD_SDK/mcp/package.json" \
  "$PRISMER_RUNTIME/package.json"; do
  bump_json "$manifest"
done

for lockfile in \
  "$PROJECT_ROOT/package-lock.json" \
  "$PROJECT_ROOT/apps/desktop/package-lock.json" \
  "$AIP_SDK/typescript/package-lock.json" \
  "$PRISMER_RUNTIME/package-lock.json" \
  "$CLOUD_SDK/package-lock.json" \
  "$CLOUD_SDK/mcp/package-lock.json"; do
  bump_json "$lockfile"
done

bump_pyproject "$AIP_SDK/python/pyproject.toml"
bump_pyproject "$CLOUD_SDK/python/pyproject.toml"
set_json_dependency "$CLOUD_SDK/package.json" "@prismer/aip-sdk" "^$TARGET"
set_json_dependency "$CLOUD_SDK/package-lock.json" "@prismer/aip-sdk" "^$TARGET"
set_python_aip_dependency "$CLOUD_SDK/python/pyproject.toml"
bump_generated_sources

log_success "Version alignment prepared: $CURRENT → $TARGET"
