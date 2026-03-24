#!/bin/bash
# common.sh — Shared shell library for PrismerCloud build scripts
# Source this file at the top of every build script:
#   source "$(dirname "$0")/lib/common.sh"

set -euo pipefail

# ── Paths ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SDK_DIR="$REPO_ROOT/sdk"
SOURCE_SDK="/Users/prismer/workspace/prismer-cloud-next/sdk"
ARTIFACTS_DIR="$REPO_ROOT/build/artifacts"

# ── Colors ─────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Flags ──────────────────────────────────────────────────────────
DRY_RUN=0
VERBOSE=0
YES_FLAG=0

parse_common_flags() {
  local args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run)  DRY_RUN=1; shift ;;
      --verbose)  VERBOSE=1; shift ;;
      --yes|-y)   YES_FLAG=1; shift ;;
      *)          args+=("$1"); shift ;;
    esac
  done
  REMAINING_ARGS=("${args[@]+"${args[@]}"}")
}

# ── Logging ────────────────────────────────────────────────────────
log_info()    { echo -e "${BLUE}[INFO]${RESET} $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${RESET} $*"; }
log_error()   { echo -e "${RED}[ERROR]${RESET} $*"; }
log_success() { echo -e "${GREEN}[OK]${RESET} $*"; }
log_step()    { echo -e "\n${BOLD}━━━ $* ━━━${RESET}"; }
log_dry()     { echo -e "${YELLOW}[DRY-RUN]${RESET} $*"; }

# ── Helpers ────────────────────────────────────────────────────────
check_tool() {
  local tool="$1"
  if ! command -v "$tool" &>/dev/null; then
    log_error "$tool not found. Please install it first."
    return 1
  fi
}

run_or_dry() {
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "$*"
  else
    "$@"
  fi
}

confirm_prompt() {
  if [[ $YES_FLAG -eq 1 ]]; then return 0; fi
  echo -en "${BOLD}$1 [y/N] ${RESET}"
  read -r answer
  [[ "$answer" =~ ^[Yy] ]]
}

get_version() {
  # Read canonical version from TypeScript SDK package.json
  local pkg="$SDK_DIR/typescript/package.json"
  if [[ -f "$pkg" ]]; then
    grep '"version"' "$pkg" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/'
  else
    echo "unknown"
  fi
}

# ── Result Tracking ────────────────────────────────────────────────
declare -a RESULT_NAMES=()
declare -a RESULT_STATUSES=()

record_result() {
  local name="$1" status="$2"
  RESULT_NAMES+=("$name")
  RESULT_STATUSES+=("$status")
}

print_results() {
  echo ""
  log_step "Results"
  local pass=0 fail=0 skip=0
  for i in "${!RESULT_NAMES[@]}"; do
    local name="${RESULT_NAMES[$i]}"
    local status="${RESULT_STATUSES[$i]}"
    case "$status" in
      pass) echo -e "  ${GREEN}✓${RESET} $name"; ((pass++)) ;;
      fail) echo -e "  ${RED}✗${RESET} $name"; ((fail++)) ;;
      skip) echo -e "  ${YELLOW}–${RESET} $name (skipped)"; ((skip++)) ;;
      warn) echo -e "  ${YELLOW}⚠${RESET} $name"; ((pass++)) ;;
    esac
  done
  echo ""
  echo -e "  ${BOLD}Total: ${GREEN}$pass pass${RESET}, ${RED}$fail fail${RESET}, ${YELLOW}$skip skip${RESET}"
  echo ""
  [[ $fail -eq 0 ]]
}

# ── Package Lists ──────────────────────────────────────────────────
NPM_PACKAGES=("typescript" "mcp" "opencode-plugin" "claude-code-plugin" "openclaw-channel")
ALL_PACKAGES=("typescript" "python" "golang" "rust" "mcp" "opencode-plugin" "claude-code-plugin" "openclaw-channel")
