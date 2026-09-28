#!/bin/bash
# sandbox-verify.sh — In-container smoke tests for SDK artifacts
#
# Runs inside the release container (Node 23 + Python 3.12) or locally with a
# compatible Python selected explicitly/preferentially.
# Mounted: /artifacts/npm/*.tgz and /artifacts/pypi/*.whl
#
# Usage: docker run --rm -v ./artifacts:/artifacts node:23 /artifacts/../sandbox-verify.sh
# Or:    bash sdk/build/sandbox-verify.sh   (if artifacts are at /artifacts)
set -uo pipefail

# ── Colors ────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
BOLD='\033[1m'; RESET='\033[0m'

# ── Counters ──────────────────────────────────────────────────────
PASS=0; FAIL=0; SKIP=0

check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${RESET} $name"
    ((PASS++))
  else
    echo -e "  ${RED}✗${RESET} $name"
    ((FAIL++))
  fi
}

check_output() {
  # check_output "name" "expected_substring" command args...
  local name="$1"; local expected="$2"; shift 2
  local output
  output=$("$@" 2>&1) || true
  if echo "$output" | grep -qi "$expected"; then
    echo -e "  ${GREEN}✓${RESET} $name"
    ((PASS++))
  else
    echo -e "  ${RED}✗${RESET} $name"
    echo -e "      expected to contain: $expected"
    echo -e "      got: $(echo "$output" | head -3)"
    ((FAIL++))
  fi
}

check_exit_output() {
  # check_exit_output "name" expected_exit "expected_substring" command args...
  local name="$1"; local expected_exit="$2"; local expected="$3"; shift 3
  local output status
  output=$("$@" 2>&1)
  status=$?
  if [[ $status -eq $expected_exit ]] && echo "$output" | grep -qi "$expected"; then
    echo -e "  ${GREEN}✓${RESET} $name"
    ((PASS++))
  else
    echo -e "  ${RED}✗${RESET} $name"
    echo -e "      expected exit $expected_exit and output containing: $expected"
    echo -e "      got exit $status: $(echo "$output" | head -3)"
    ((FAIL++))
  fi
}

tar_lacks_pattern() {
  local archive="$1" pattern="$2"
  ! tar -tzf "$archive" | grep -Eq "$pattern"
}

zip_lacks_pattern() {
  local archive="$1" pattern="$2"
  ! unzip -Z1 "$archive" | grep -Eq "$pattern"
}

skip() {
  local name="$1"
  echo -e "  ${YELLOW}-${RESET} $name (skipped)"
  ((SKIP++))
}

# ── Artifact discovery ────────────────────────────────────────────
ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
PYTHON_BIN="${PYTHON_BIN:-}"

if [[ -z "$PYTHON_BIN" ]]; then
  for candidate in python3.12 python3; do
    if command -v "$candidate" >/dev/null 2>&1 &&
      "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
      PYTHON_BIN="$(command -v "$candidate")"
      break
    fi
  done
fi

if [[ ! -d "$ARTIFACT_DIR/npm" ]]; then
  echo -e "${RED}ERROR: $ARTIFACT_DIR/npm not found. Mount artifacts volume.${RESET}"
  exit 2
fi

echo -e "\n${BOLD}━━━ SDK Sandbox Smoke Tests ━━━${RESET}\n"
echo -e "Artifact dir: $ARTIFACT_DIR"
echo -e "Node: $(node --version 2>/dev/null || echo 'not found')"
echo -e "Python: $(${PYTHON_BIN:-false} --version 2>/dev/null || echo 'compatible interpreter not found')"
echo ""

# Find tgz files by scoped-name pattern (npm pack strips @ and replaces / with -)
find_tgz() {
  local pattern="$1"
  ls "$ARTIFACT_DIR/npm/"$pattern 2>/dev/null | head -1
}

AIP_TGZ=$(find_tgz "prismer-aip-sdk-*.tgz")
SDK_TGZ=$(find_tgz "prismer-sdk-*.tgz")
MCP_TGZ=$(find_tgz "prismer-mcp-server-*.tgz")
RUNTIME_TGZ=$(find_tgz "prismer-runtime-*.tgz")

AIP_WHL=$(ls "$ARTIFACT_DIR/pypi/"prismer_aip-*.whl 2>/dev/null | head -1)
# Fallbacks for historical package filenames.
if [[ -z "$AIP_WHL" ]]; then
  AIP_WHL=$(ls "$ARTIFACT_DIR/pypi/"aip_sdk-*.whl 2>/dev/null | head -1)
fi
if [[ -z "$AIP_WHL" ]]; then
  AIP_WHL=$(ls "$ARTIFACT_DIR/pypi/"aip-*.whl 2>/dev/null | head -1)
fi
PRISMER_WHL=$(ls "$ARTIFACT_DIR/pypi/"prismer-*.whl 2>/dev/null | head -1)

echo -e "${BOLD}Found artifacts:${RESET}"
for var in AIP_TGZ SDK_TGZ MCP_TGZ RUNTIME_TGZ AIP_WHL PRISMER_WHL; do
  val="${!var}"
  if [[ -n "$val" ]]; then
    echo -e "  $var = $(basename "$val")"
  else
    echo -e "  $var = ${YELLOW}(not found)${RESET}"
  fi
done
echo ""

# ══════════════════════════════════════════════════════════════════
# npm Section
# ══════════════════════════════════════════════════════════════════
echo -e "${BOLD}━━━ npm Checks ━━━${RESET}\n"

NPM_WORKDIR=$(mktemp -d)
NPM_BIN="$NPM_WORKDIR/node_modules/.bin"
BASE_PATH="$PATH"
cd "$NPM_WORKDIR"
npm init -y >/dev/null 2>&1

# Install every npm artifact in one transaction. Sequential `npm install
# --no-save` calls prune packages installed by the previous call, which would
# make the coexistence/PATH checks below exercise an incomplete environment.
NPM_TGZS=()
for tgz in "$AIP_TGZ" "$SDK_TGZ" "$MCP_TGZ" "$RUNTIME_TGZ"; do
  [[ -n "$tgz" ]] && NPM_TGZS+=("$tgz")
done

if [[ ${#NPM_TGZS[@]} -gt 0 ]]; then
  check "npm install active packages from tgz" \
    npm install "${NPM_TGZS[@]}" --no-save
else
  skip "npm install active packages (no tgz artifacts found)"
fi

# 1. Install @prismer/aip-sdk
if [[ -n "$AIP_TGZ" ]]; then
  check "@prismer/aip-sdk is installed" \
    test -f node_modules/@prismer/aip-sdk/package.json

  # 2. require('@prismer/aip-sdk') + AIPIdentity
  check "require('@prismer/aip-sdk') succeeds" \
    node -e "require('@prismer/aip-sdk')"

  check "AIPIdentity class is available" \
    node -e "const { AIPIdentity } = require('@prismer/aip-sdk'); if (typeof AIPIdentity !== 'function') process.exit(1)"

  check_output "aip --help shows protocol CLI" "Usage\|identity\|delegation\|credential" \
    "$NPM_BIN/aip" --help
else
  skip "npm install @prismer/aip-sdk (tgz not found)"
  skip "require('@prismer/aip-sdk') succeeds"
  skip "AIPIdentity class is available"
  skip "aip --help"
fi

# 3. Install @prismer/sdk
if [[ -n "$SDK_TGZ" ]]; then
  check "@prismer/sdk is installed" \
    test -f node_modules/@prismer/sdk/package.json

  # 4. require('@prismer/sdk') — THIS was the v1.8.0 crash
  check "require('@prismer/sdk') succeeds (v1.8.0 regression test)" \
    node -e "require('@prismer/sdk')"

  # 5. CLI --help — v2.0: @prismer/sdk bin renamed `prismer` → `cloud`
  # (`@prismer/runtime` keeps `prismer`). The regex matches the new bin
  # name explicitly so a future regression to the old name is caught.
  check_output "cloud CLI --help shows commands" "Usage: cloud" \
    node node_modules/@prismer/sdk/dist/cli.js --help

  # 6. CLI setup --help
  check_output "cloud CLI setup --help shows options" "Usage: cloud setup" \
    node node_modules/@prismer/sdk/dist/cli.js setup --help

  # 7. CRITICAL: aip-sdk dep must be semver, NOT file: path
  AIP_DEP=$(node -e "const p=require('./node_modules/@prismer/sdk/package.json'); console.log(p.dependencies?.['@prismer/aip-sdk'] || 'MISSING')")
  if echo "$AIP_DEP" | grep -q "^[\^~]"; then
    echo -e "  ${GREEN}✓${RESET} @prismer/sdk aip-sdk dep is semver ($AIP_DEP)"
    ((PASS++))
  elif echo "$AIP_DEP" | grep -q "file:"; then
    echo -e "  ${RED}✗${RESET} @prismer/sdk aip-sdk dep is file: path — CRITICAL BUG ($AIP_DEP)"
    ((FAIL++))
  else
    echo -e "  ${RED}✗${RESET} @prismer/sdk aip-sdk dep unexpected format ($AIP_DEP)"
    ((FAIL++))
  fi
else
  skip "npm install @prismer/sdk (tgz not found)"
  skip "require('@prismer/sdk') succeeds"
  skip "cloud CLI --help"
  skip "cloud CLI setup --help"
  skip "@prismer/sdk aip-sdk dep check"
fi

# 8. MCP server tgz
if [[ -n "$MCP_TGZ" ]]; then
  check "@prismer/mcp-server is installed" \
    test -f node_modules/@prismer/mcp-server/package.json
  check_output "prismer-mcp --help is non-blocking" "Usage: prismer-mcp" \
    "$NPM_BIN/prismer-mcp" --help
else
  skip "npm install @prismer/mcp-server (tgz not found)"
  skip "prismer-mcp --help"
fi

# 9. Install the separately published Runtime host.
if [[ -n "$RUNTIME_TGZ" ]]; then
  check "@prismer/runtime is installed" \
    test -f node_modules/@prismer/runtime/package.json

  check "require('@prismer/runtime') succeeds" \
    node -e "require('@prismer/runtime')"

  check_output "prismer runtime CLI --help shows host commands" "daemon\|adapter\|Runtime" \
    node node_modules/@prismer/runtime/dist/cli.js --help

  check "runtime tarball includes bundled catalog fallback" \
    test -f node_modules/@prismer/runtime/built-in-skills/memory/SKILL.md

  # Curated built-in skills intentionally ship validation scripts (catalog manifest).
  # Match the plugins-only test exclusion in Runtime package.json; caches are never payload.
  check "runtime tarball excludes provider caches and tests" \
    tar_lacks_pattern "$RUNTIME_TGZ" '(__pycache__|[.]pyc$|^package/plugins/(.*/)?test_[^/]*[.]py$)'
else
  skip "npm install @prismer/runtime (tgz not found)"
  skip "require('@prismer/runtime') succeeds"
  skip "prismer runtime CLI --help"
  skip "runtime bundled catalog fallback"
  skip "runtime tarball excludes provider caches and tests"
fi

# ══════════════════════════════════════════════════════════════════
# Python Section
# ══════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}━━━ Python Checks ━━━${RESET}\n"

if [[ -z "$PYTHON_BIN" ]]; then
  skip "Python not available — skipping all Python checks"
  skip "(pip install aip)"
  skip "(from aip import AIPIdentity)"
  skip "(AIPIdentity.create())"
  skip "(pip install prismer)"
  skip "(from prismer import PrismerClient)"
  skip "(python3 -m prismer --help)"
else
  PY_VENV=$(mktemp -d)/venv
  "$PYTHON_BIN" -m venv "$PY_VENV"
  source "$PY_VENV/bin/activate"

  # 10. Install aip whl
  if [[ -n "$AIP_WHL" ]]; then
    check "pip install aip from whl" \
      pip install "$AIP_WHL"

    # 11. from aip import AIPIdentity
    check "from aip import AIPIdentity" \
      python3 -c "from aip import AIPIdentity"

    # 12. AIPIdentity.create() returns a DID
    check "AIPIdentity.create() returns a DID" \
      python3 -c "
from aip import AIPIdentity
identity = AIPIdentity.create()
did = identity.did
assert did.startswith('did:key:'), f'Expected did:key: prefix, got {did}'
"
  else
    skip "pip install aip (whl not found)"
    skip "from aip import AIPIdentity"
    skip "AIPIdentity.create() returns a DID"
  fi

  # 13. Install prismer whl
  if [[ -n "$PRISMER_WHL" ]]; then
    check "prismer wheel excludes top-level tests package" \
      zip_lacks_pattern "$PRISMER_WHL" '^tests/'

    check "pip install prismer from whl" \
      pip install "$PRISMER_WHL"

    # 14. from prismer import PrismerClient
    check "from prismer import PrismerClient" \
      python3 -c "from prismer import PrismerClient"

    # 15. python3 -m prismer --help
    check_output "python3 -m prismer --help shows CLI" "usage\|Usage\|prismer\|Prismer\|Options\|options" \
      python3 -m prismer --help

    check_output "prismer-py --help shows Cloud CLI" "usage\|Usage\|Options\|options" \
      "$PY_VENV/bin/prismer-py" --help
  else
    skip "pip install prismer (whl not found)"
    skip "prismer wheel excludes top-level tests package"
    skip "from prismer import PrismerClient"
    skip "python3 -m prismer --help"
    skip "prismer-py --help"
  fi

  if [[ -x "$NPM_BIN/cloud" && -x "$NPM_BIN/prismer-runtime" && -x "$PY_VENV/bin/prismer-py" ]]; then
    NPM_FIRST_PATH="$NPM_BIN:$PY_VENV/bin:$BASE_PATH"
    PYTHON_FIRST_PATH="$PY_VENV/bin:$NPM_BIN:$BASE_PATH"

    check_output "npm-first PATH resolves cloud explicitly" "Usage: cloud" \
      env PATH="$NPM_FIRST_PATH" cloud --help
    check_output "python-first PATH resolves cloud explicitly" "Usage: cloud" \
      env PATH="$PYTHON_FIRST_PATH" cloud --help
    check_output "npm-first PATH resolves prismer-runtime explicitly" "daemon\|adapter\|Runtime" \
      env PATH="$NPM_FIRST_PATH" prismer-runtime --help
    check_output "python-first PATH resolves prismer-runtime explicitly" "daemon\|adapter\|Runtime" \
      env PATH="$PYTHON_FIRST_PATH" prismer-runtime --help
    check_output "npm-first PATH resolves prismer-py explicitly" "usage\|Usage\|Options\|options" \
      env PATH="$NPM_FIRST_PATH" prismer-py --help
    check_output "python-first PATH resolves prismer-py explicitly" "usage\|Usage\|Options\|options" \
      env PATH="$PYTHON_FIRST_PATH" prismer-py --help
    check_output "npm-first bare prismer is Runtime" "daemon\|adapter\|Runtime" \
      env PATH="$NPM_FIRST_PATH" prismer --help
    check_exit_output "python-first bare prismer refuses Runtime daemon" 2 "AMBIGUOUS_PRISMER_BIN" \
      env PATH="$PYTHON_FIRST_PATH" prismer daemon
  else
    skip "dual-install PATH-order smoke (required bins missing)"
  fi

  deactivate 2>/dev/null || true
  rm -rf "$(dirname "$PY_VENV")"
fi

cd /
rm -rf "$NPM_WORKDIR"

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}━━━ Summary ━━━${RESET}\n"
echo -e "  ${GREEN}$PASS pass${RESET}, ${RED}$FAIL fail${RESET}, ${YELLOW}$SKIP skip${RESET}\n"

if [[ $FAIL -eq 0 ]]; then
  echo -e "  ${GREEN}${BOLD}ALL CHECKS PASSED — safe to publish.${RESET}\n"
  exit 0
else
  echo -e "  ${RED}${BOLD}SMOKE TEST FAILED — do NOT publish.${RESET}\n"
  exit 1
fi
