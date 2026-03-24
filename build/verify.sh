#!/bin/bash
# verify.sh — Pre-release verification for PrismerCloud
# Checks version consistency, builds, tests, and publish readiness.

source "$(dirname "$0")/lib/common.sh"

# ── Parse flags ───────────────────────────────────────────────────
parse_common_flags "$@"

VERSION_OVERRIDE=""
SKIP_TESTS=0
SKIP_BUILD=0

args=()
set -- "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)    VERSION_OVERRIDE="$2"; shift 2 ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    *)            args+=("$1"); shift ;;
  esac
done
REMAINING_ARGS=("${args[@]+"${args[@]}"}")

# ── Determine version ────────────────────────────────────────────
if [[ -n "$VERSION_OVERRIDE" ]]; then
  VERSION="$VERSION_OVERRIDE"
  log_info "Using provided version: $VERSION"
else
  VERSION="$(get_version)"
  log_info "Canonical version from sdk/typescript/package.json: $VERSION"
fi

if [[ "$VERSION" == "unknown" ]]; then
  log_error "Could not determine version. Pass --version <ver> or check sdk/typescript/package.json."
  exit 1
fi

echo ""
log_info "Starting pre-release verification for v${VERSION}"
[[ $DRY_RUN -eq 1 ]] && log_dry "Dry-run mode — no builds or tests will execute"

# ══════════════════════════════════════════════════════════════════
# Phase 1: Version Consistency
# ══════════════════════════════════════════════════════════════════
log_step "Phase 1: Version Consistency"

check_version_json() {
  local file="$1" label="$2"
  if [[ ! -f "$file" ]]; then
    log_error "$label — file not found: $file"
    record_result "version: $label" "fail"
    return
  fi
  if grep -q "\"version\": *\"$VERSION\"" "$file" 2>/dev/null; then
    log_success "$label — v${VERSION}"
    record_result "version: $label" "pass"
  else
    log_error "$label — expected v${VERSION}"
    record_result "version: $label" "fail"
  fi
}

check_version_pattern() {
  local file="$1" label="$2" pattern="$3"
  if [[ ! -f "$file" ]]; then
    log_error "$label — file not found: $file"
    record_result "version: $label" "fail"
    return
  fi
  if grep -q "$pattern" "$file" 2>/dev/null; then
    log_success "$label — v${VERSION}"
    record_result "version: $label" "pass"
  else
    log_error "$label — expected pattern: $pattern"
    record_result "version: $label" "fail"
  fi
}

# JSON package.json files
check_version_json "$SDK_DIR/typescript/package.json"       "sdk/typescript/package.json"
check_version_json "$SDK_DIR/mcp/package.json"              "sdk/mcp/package.json"
check_version_json "$SDK_DIR/opencode-plugin/package.json"  "sdk/opencode-plugin/package.json"
check_version_json "$SDK_DIR/claude-code-plugin/package.json" "sdk/claude-code-plugin/package.json"
check_version_json "$SDK_DIR/openclaw-channel/package.json" "sdk/openclaw-channel/package.json"

# Plugin manifest
check_version_json "$SDK_DIR/claude-code-plugin/.claude-plugin/plugin.json" "sdk/claude-code-plugin/.claude-plugin/plugin.json"

# Python pyproject.toml
check_version_pattern "$SDK_DIR/python/pyproject.toml" \
  "sdk/python/pyproject.toml" \
  "version = \"$VERSION\""

# Rust Cargo.toml
check_version_pattern "$SDK_DIR/rust/Cargo.toml" \
  "sdk/rust/Cargo.toml" \
  "version = \"$VERSION\""

# Python __init__.py
check_version_pattern "$SDK_DIR/python/prismer/__init__.py" \
  "sdk/python/prismer/__init__.py" \
  "__version__ = \"$VERSION\""

# MCP index.ts
check_version_pattern "$SDK_DIR/mcp/src/index.ts" \
  "sdk/mcp/src/index.ts" \
  "version: '$VERSION'"

# ══════════════════════════════════════════════════════════════════
# Phase 2: Package Manifests
# ══════════════════════════════════════════════════════════════════
log_step "Phase 2: Package Manifests"

for pkg in "${NPM_PACKAGES[@]}"; do
  local_pkg="$SDK_DIR/$pkg/package.json"
  if [[ ! -f "$local_pkg" ]]; then
    log_warn "$pkg — package.json not found"
    record_result "manifest: $pkg publishConfig" "warn"
    continue
  fi
  if grep -q '"publishConfig"' "$local_pkg" && grep -q '"access"' "$local_pkg"; then
    log_success "$pkg — publishConfig.access found"
    record_result "manifest: $pkg publishConfig" "pass"
  else
    log_warn "$pkg — publishConfig.access not found (needed for scoped publish)"
    record_result "manifest: $pkg publishConfig" "warn"
  fi
done

# Check Go module path
if [[ -f "$SDK_DIR/golang/go.mod" ]]; then
  go_module="$(head -1 "$SDK_DIR/golang/go.mod" | awk '{print $2}')"
  log_success "Go module: $go_module"
  record_result "manifest: go.mod module path" "pass"
else
  log_warn "sdk/golang/go.mod not found"
  record_result "manifest: go.mod module path" "warn"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: Build Verification
# ══════════════════════════════════════════════════════════════════
if [[ $SKIP_BUILD -eq 1 ]]; then
  log_step "Phase 3: Build Verification (skipped)"
  record_result "build: TypeScript SDK" "skip"
  record_result "build: Python SDK" "skip"
  record_result "build: Go SDK" "skip"
  record_result "build: Rust SDK" "skip"
  record_result "build: MCP Server" "skip"
  record_result "build: OpenCode Plugin" "skip"
else
  log_step "Phase 3: Build Verification"

  # TypeScript SDK
  log_info "Building TypeScript SDK..."
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "cd sdk/typescript && npm install && npm run build"
    record_result "build: TypeScript SDK" "skip"
  else
    if (cd "$SDK_DIR/typescript" && npm install 2>&1 && npm run build 2>&1); then
      if [[ -f "$SDK_DIR/typescript/dist/index.js" ]]; then
        log_success "TypeScript SDK — dist/index.js exists"
        record_result "build: TypeScript SDK" "pass"
      else
        log_error "TypeScript SDK — dist/index.js not found after build"
        record_result "build: TypeScript SDK" "fail"
      fi
    else
      log_error "TypeScript SDK — build failed"
      record_result "build: TypeScript SDK" "fail"
    fi
  fi

  # Python SDK
  log_info "Building Python SDK..."
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "cd sdk/python && python3 -m venv .venv && pip install build && python -m build"
    record_result "build: Python SDK" "skip"
  else
    if (
      cd "$SDK_DIR/python"
      if [[ ! -d .venv ]]; then
        local py=$(command -v python3.11 || command -v python3.12 || command -v python3.10 || command -v python3)
        "$py" -m venv .venv
      fi
      source .venv/bin/activate
      pip install --quiet build
      python -m build 2>&1
      deactivate
    ); then
      if ls "$SDK_DIR/python/dist/"*.whl 1>/dev/null 2>&1; then
        log_success "Python SDK — wheel exists in dist/"
        record_result "build: Python SDK" "pass"
      else
        log_error "Python SDK — no .whl found in dist/"
        record_result "build: Python SDK" "fail"
      fi
    else
      log_error "Python SDK — build failed"
      record_result "build: Python SDK" "fail"
    fi
  fi

  # Go SDK
  log_info "Building Go SDK..."
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "cd sdk/golang && go build ./..."
    record_result "build: Go SDK" "skip"
  else
    if (cd "$SDK_DIR/golang" && go build ./... 2>&1); then
      log_success "Go SDK — build succeeded"
      record_result "build: Go SDK" "pass"
    else
      log_error "Go SDK — build failed"
      record_result "build: Go SDK" "fail"
    fi
  fi

  # Rust SDK
  log_info "Building Rust SDK..."
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "cd sdk/rust && cargo build"
    record_result "build: Rust SDK" "skip"
  else
    if (cd "$SDK_DIR/rust" && cargo build 2>&1); then
      log_success "Rust SDK — build succeeded"
      record_result "build: Rust SDK" "pass"
    else
      log_error "Rust SDK — build failed"
      record_result "build: Rust SDK" "fail"
    fi
  fi

  # MCP Server
  log_info "Building MCP Server..."
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "cd sdk/mcp && npm install && npm run build"
    record_result "build: MCP Server" "skip"
  else
    if (cd "$SDK_DIR/mcp" && npm install 2>&1 && npm run build 2>&1); then
      if [[ -f "$SDK_DIR/mcp/dist/index.js" ]]; then
        log_success "MCP Server — dist/index.js exists"
        record_result "build: MCP Server" "pass"
      else
        log_error "MCP Server — dist/index.js not found after build"
        record_result "build: MCP Server" "fail"
      fi
    else
      log_error "MCP Server — build failed"
      record_result "build: MCP Server" "fail"
    fi
  fi

  # OpenCode Plugin
  log_info "Building OpenCode Plugin..."
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "cd sdk/opencode-plugin && npm install && npm run build"
    record_result "build: OpenCode Plugin" "skip"
  else
    if (cd "$SDK_DIR/opencode-plugin" && npm install 2>&1 && npm run build 2>&1); then
      if [[ -f "$SDK_DIR/opencode-plugin/dist/index.js" ]]; then
        log_success "OpenCode Plugin — dist/index.js exists"
        record_result "build: OpenCode Plugin" "pass"
      else
        log_error "OpenCode Plugin — dist/index.js not found after build"
        record_result "build: OpenCode Plugin" "fail"
      fi
    else
      log_error "OpenCode Plugin — build failed"
      record_result "build: OpenCode Plugin" "fail"
    fi
  fi
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Test Verification
# ══════════════════════════════════════════════════════════════════
if [[ $SKIP_TESTS -eq 1 ]]; then
  log_step "Phase 4: Test Verification (skipped)"
  record_result "tests" "skip"
else
  log_step "Phase 4: Test Verification"
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "$REPO_ROOT/build/test.sh --yes"
    record_result "tests" "skip"
  else
    if [[ -x "$REPO_ROOT/build/test.sh" ]]; then
      if "$REPO_ROOT/build/test.sh" --yes; then
        log_success "All tests passed"
        record_result "tests" "pass"
      else
        log_error "Tests failed"
        record_result "tests" "fail"
      fi
    else
      log_warn "build/test.sh not found or not executable — skipping tests"
      record_result "tests" "skip"
    fi
  fi
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: Publish Readiness (informational)
# ══════════════════════════════════════════════════════════════════
log_step "Phase 5: Publish Readiness"

# npm auth
if npm whoami &>/dev/null; then
  log_success "npm — authenticated as $(npm whoami)"
  record_result "publish: npm auth" "pass"
else
  log_warn "npm — not authenticated (run 'npm login')"
  record_result "publish: npm auth" "warn"
fi

# Cargo registry token
if [[ -n "${CARGO_REGISTRY_TOKEN:-}" ]]; then
  log_success "Cargo — CARGO_REGISTRY_TOKEN is set"
  record_result "publish: Cargo token" "pass"
else
  log_warn "Cargo — CARGO_REGISTRY_TOKEN not set"
  record_result "publish: Cargo token" "warn"
fi

# GitHub CLI auth
if gh auth status &>/dev/null; then
  log_success "GitHub CLI — authenticated"
  record_result "publish: gh auth" "pass"
else
  log_warn "GitHub CLI — not authenticated (run 'gh auth login')"
  record_result "publish: gh auth" "warn"
fi

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
print_results
