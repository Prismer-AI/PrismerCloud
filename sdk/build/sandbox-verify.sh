#!/bin/bash
# sandbox-verify.sh — In-container smoke tests for SDK artifacts
#
# Runs INSIDE a Docker container (node 23 + python 3.12, NO cargo).
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

skip() {
  local name="$1"
  echo -e "  ${YELLOW}-${RESET} $name (skipped)"
  ((SKIP++))
}

# ── Artifact discovery ────────────────────────────────────────────
ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"

if [[ ! -d "$ARTIFACT_DIR/npm" ]]; then
  echo -e "${RED}ERROR: $ARTIFACT_DIR/npm not found. Mount artifacts volume.${RESET}"
  exit 2
fi

echo -e "\n${BOLD}━━━ SDK Sandbox Smoke Tests ━━━${RESET}\n"
echo -e "Artifact dir: $ARTIFACT_DIR"
echo -e "Node: $(node --version 2>/dev/null || echo 'not found')"
echo -e "Python: $(python3 --version 2>/dev/null || echo 'not found')"
echo ""

# Find tgz files by scoped-name pattern (npm pack strips @ and replaces / with -)
find_tgz() {
  local pattern="$1"
  ls "$ARTIFACT_DIR/npm/"$pattern 2>/dev/null | head -1
}

AIP_TGZ=$(find_tgz "prismer-aip-sdk-*.tgz")
SDK_TGZ=$(find_tgz "prismer-sdk-*.tgz")
MCP_TGZ=$(find_tgz "prismer-mcp-server-*.tgz")
SANDBOX_TGZ=$(find_tgz "prismer-sandbox-runtime-*.tgz")
WIRE_TGZ=$(find_tgz "prismer-wire-*.tgz")
ADAPTERS_CORE_TGZ=$(find_tgz "prismer-adapters-core-*.tgz")
CLAUDE_TGZ=$(find_tgz "prismer-claude-code-plugin-*.tgz")
OPENCODE_TGZ=$(find_tgz "prismer-opencode-plugin-*.tgz")
OPENCLAW_TGZ=$(find_tgz "prismer-openclaw-channel-*.tgz")

AIP_WHL=$(ls "$ARTIFACT_DIR/pypi/"prismer_aip-*.whl 2>/dev/null | head -1)
# Fallback: legacy naming with _sdk
if [[ -z "$AIP_WHL" ]]; then
  AIP_WHL=$(ls "$ARTIFACT_DIR/pypi/"aip_sdk-*.whl 2>/dev/null | head -1)
fi
# Fallback: older naming without _sdk
if [[ -z "$AIP_WHL" ]]; then
  AIP_WHL=$(ls "$ARTIFACT_DIR/pypi/"aip-*.whl 2>/dev/null | head -1)
fi
PRISMER_WHL=$(ls "$ARTIFACT_DIR/pypi/"prismer-*.whl 2>/dev/null | head -1)

echo -e "${BOLD}Found artifacts:${RESET}"
for var in AIP_TGZ SDK_TGZ MCP_TGZ SANDBOX_TGZ WIRE_TGZ ADAPTERS_CORE_TGZ CLAUDE_TGZ OPENCODE_TGZ OPENCLAW_TGZ AIP_WHL PRISMER_WHL; do
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
cd "$NPM_WORKDIR"
npm init -y >/dev/null 2>&1

# 1. Install @prismer/aip-sdk
if [[ -n "$AIP_TGZ" ]]; then
  check "npm install @prismer/aip-sdk from tgz" \
    npm install "$AIP_TGZ" --no-save

  # 2. require('@prismer/aip-sdk') + AIPIdentity
  check "require('@prismer/aip-sdk') succeeds" \
    node -e "require('@prismer/aip-sdk')"

  check "AIPIdentity class is available" \
    node -e "const { AIPIdentity } = require('@prismer/aip-sdk'); if (typeof AIPIdentity !== 'function') process.exit(1)"
else
  skip "npm install @prismer/aip-sdk (tgz not found)"
  skip "require('@prismer/aip-sdk') succeeds"
  skip "AIPIdentity class is available"
fi

# 3. Install @prismer/sdk
if [[ -n "$SDK_TGZ" ]]; then
  check "npm install @prismer/sdk from tgz" \
    npm install "$AIP_TGZ" "$SDK_TGZ" --no-save

  # 4. require('@prismer/sdk') — THIS was the v1.8.0 crash
  check "require('@prismer/sdk') succeeds (v1.8.0 regression test)" \
    node -e "require('@prismer/sdk')"

  # 5. CLI library export
  check "require('@prismer/sdk/cli') succeeds" \
    node -e "require('@prismer/sdk/cli')"

  # 6. registerSdkCliCommands export
  check "registerSdkCliCommands is exported" \
    node -e "const cli=require('@prismer/sdk/cli'); if (typeof cli.registerSdkCliCommands !== 'function') process.exit(1)"

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
  skip "require('@prismer/sdk/cli') succeeds"
  skip "registerSdkCliCommands is exported"
  skip "@prismer/sdk aip-sdk dep check"
fi

# 8. MCP server tgz
if [[ -n "$MCP_TGZ" ]]; then
  check "npm install @prismer/mcp-server from tgz" \
    npm install "$MCP_TGZ" --no-save
else
  skip "npm install @prismer/mcp-server (tgz not found)"
fi

# 8b. Shared local tgz deps for adapter/plugin packages
if [[ -n "$SANDBOX_TGZ" ]]; then
  check "npm install @prismer/sandbox-runtime from tgz" \
    npm install "$SANDBOX_TGZ" --no-save
else
  skip "npm install @prismer/sandbox-runtime (tgz not found)"
fi

if [[ -n "$WIRE_TGZ" ]]; then
  check "npm install @prismer/wire from tgz" \
    npm install "$SANDBOX_TGZ" "$WIRE_TGZ" --no-save
else
  skip "npm install @prismer/wire (tgz not found)"
fi

if [[ -n "$ADAPTERS_CORE_TGZ" ]]; then
  check "npm install @prismer/adapters-core from tgz" \
    npm install "$SANDBOX_TGZ" "$WIRE_TGZ" "$ADAPTERS_CORE_TGZ" --no-save
else
  skip "npm install @prismer/adapters-core (tgz not found)"
fi

# 9. Plugin tgz files (3 packages)
for info in "CLAUDE_TGZ:@prismer/claude-code-plugin" "OPENCODE_TGZ:@prismer/opencode-plugin" "OPENCLAW_TGZ:@prismer/openclaw-channel"; do
  var="${info%%:*}"
  pkg="${info#*:}"
  tgz="${!var}"
  if [[ -n "$tgz" ]]; then
    install_args=("$tgz")
    install_flags=(--no-save)
    if [[ "$pkg" == "@prismer/claude-code-plugin" || "$pkg" == "@prismer/openclaw-channel" ]]; then
      install_args=("$SANDBOX_TGZ" "$WIRE_TGZ" "$ADAPTERS_CORE_TGZ" "$tgz")
    fi
    if [[ "$pkg" == "@prismer/openclaw-channel" ]]; then
      install_flags+=(--legacy-peer-deps)
    fi
    check "npm install $pkg from tgz" \
      npm install "${install_args[@]}" "${install_flags[@]}"
  else
    skip "npm install $pkg (tgz not found)"
  fi
done

# 9b. CRITICAL: scan every installed @prismer/* package for file: deps.
# A file: path in a published tarball guarantees `npm install <pkg>` failure
# for end users (v1.8.0 shipped with this bug; see CLAUDE.md v1.8.1 notes).
# Generalizes the single-package check #7 to cover ALL @prismer/* packages.
if [[ -d "node_modules/@prismer" ]]; then
  FILE_DEP_VIOLATIONS=$(node -e "
    const fs = require('fs');
    const path = require('path');
    const root = 'node_modules/@prismer';
    const viols = [];
    for (const name of fs.readdirSync(root)) {
      const pkgPath = path.join(root, name, 'package.json');
      if (!fs.existsSync(pkgPath)) continue;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const [dep, ver] of Object.entries(pkg[section] || {})) {
          if (typeof ver === 'string' && ver.startsWith('file:')) {
            viols.push(pkg.name + ' ' + section + '.' + dep + ' = ' + ver);
          }
        }
      }
    }
    console.log(viols.join('\n'));
  ")
  if [[ -z "$FILE_DEP_VIOLATIONS" ]]; then
    echo -e "  ${GREEN}✓${RESET} No file: deps in any installed @prismer/* package"
    ((PASS++))
  else
    echo -e "  ${RED}✗${RESET} file: deps found (will break 'npm install' for end users):"
    echo "$FILE_DEP_VIOLATIONS" | sed 's/^/      /'
    ((FAIL++))
  fi
else
  skip "scan @prismer/* for file: deps (no packages installed)"
fi

# Clean up npm workdir
cd /
rm -rf "$NPM_WORKDIR"

# ══════════════════════════════════════════════════════════════════
# Python Section
# ══════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}━━━ Python Checks ━━━${RESET}\n"

if ! command -v python3 &>/dev/null; then
  skip "Python not available — skipping all Python checks"
  skip "(pip install aip)"
  skip "(from aip import AIPIdentity)"
  skip "(AIPIdentity.create())"
  skip "(pip install prismer)"
  skip "(from prismer import PrismerClient)"
  skip "(python3 -m prismer --help)"
else
  PY_VENV=$(mktemp -d)/venv
  python3 -m venv "$PY_VENV"
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
    check "pip install prismer from whl" \
      pip install "$PRISMER_WHL"

    # 14. from prismer import PrismerClient
    check "from prismer import PrismerClient" \
      python3 -c "from prismer import PrismerClient"

    # 15. python3 -m prismer --help
    check_output "python3 -m prismer --help shows CLI" "usage\|Usage\|prismer\|Prismer\|Options\|options" \
      python3 -m prismer --help
  else
    skip "pip install prismer (whl not found)"
    skip "from prismer import PrismerClient"
    skip "python3 -m prismer --help"
  fi

  deactivate 2>/dev/null || true
  rm -rf "$(dirname "$PY_VENV")"
fi

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
