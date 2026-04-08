#!/bin/bash
# common.sh — Shared shell library for SDK build scripts
set -euo pipefail

# ── Paths ──────────────────────────────────────────────────────────
# Use BASH_SOURCE[0] (this file's location) for stable path resolution
_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_ROOT="$(cd "$_COMMON_DIR/.." && pwd)"
SDK_ROOT="$(cd "$BUILD_ROOT/.." && pwd)"
PROJECT_ROOT="$(cd "$SDK_ROOT/.." && pwd)"
PRISMER_CLOUD="$SDK_ROOT/prismer-cloud"
AIP_SDK="$SDK_ROOT/aip"
OPENSRC_ROOT="/Users/prismer/workspace/PrismerCloud"
OPENSRC_SDK="$OPENSRC_ROOT/sdk"
ARTIFACTS_DIR="$BUILD_ROOT/artifacts"

# ── Colors ─────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

# ── Flags ──────────────────────────────────────────────────────────
DRY_RUN=0; VERBOSE=0; YES_FLAG=0; SCOPE="all"

parse_common_flags() {
  local args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run)  DRY_RUN=1; shift ;;
      --verbose)  VERBOSE=1; shift ;;
      --yes|-y)   YES_FLAG=1; shift ;;
      --scope)    SCOPE="${2:-all}"; shift 2 ;;
      *)          args+=("$1"); shift ;;
    esac
  done
  REMAINING_ARGS=("${args[@]+"${args[@]}"}")
}

# ── Scope helpers ─────────────────────────────────────────────────
scope_includes_aip()    { [[ "$SCOPE" == "all" || "$SCOPE" == "aip" ]]; }
scope_includes_prismer() { [[ "$SCOPE" == "all" || "$SCOPE" == "prismer-cloud" ]]; }

# ── Logging ────────────────────────────────────────────────────────
log_info()    { echo -e "${BLUE}[INFO]${RESET} $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${RESET} $*"; }
log_error()   { echo -e "${RED}[ERROR]${RESET} $*"; }
log_success() { echo -e "${GREEN}[OK]${RESET} $*"; }
log_step()    { echo -e "\n${BOLD}━━━ $* ━━━${RESET}"; }
log_dry()     { echo -e "${YELLOW}[DRY-RUN]${RESET} $*"; }

# ── Helpers ────────────────────────────────────────────────────────
check_tool() {
  if ! command -v "$1" &>/dev/null; then
    log_error "$1 not found. Please install it first."
    return 1
  fi
}

run_or_dry() {
  if [[ $DRY_RUN -eq 1 ]]; then log_dry "$*"; else "$@"; fi
}

confirm_prompt() {
  if [[ $YES_FLAG -eq 1 ]]; then return 0; fi
  echo -en "${BOLD}$1 [y/N] ${RESET}"
  read -r answer
  [[ "$answer" =~ ^[Yy] ]]
}

get_version() {
  local pkg="$PRISMER_CLOUD/typescript/package.json"
  if [[ -f "$pkg" ]]; then
    grep '"version"' "$pkg" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/'
  else
    echo "unknown"
  fi
}

get_aip_version() {
  local pkg="$AIP_SDK/typescript/package.json"
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
  RESULT_NAMES+=("$1")
  RESULT_STATUSES+=("$2")
}

print_results() {
  echo ""
  log_step "Results"
  local pass=0 fail=0 skip=0
  for i in "${!RESULT_NAMES[@]}"; do
    case "${RESULT_STATUSES[$i]}" in
      pass) echo -e "  ${GREEN}✓${RESET} ${RESULT_NAMES[$i]}"; ((pass++)) ;;
      fail) echo -e "  ${RED}✗${RESET} ${RESULT_NAMES[$i]}"; ((fail++)) ;;
      skip) echo -e "  ${YELLOW}–${RESET} ${RESULT_NAMES[$i]} (skipped)"; ((skip++)) ;;
      warn) echo -e "  ${YELLOW}⚠${RESET} ${RESULT_NAMES[$i]}"; ((pass++)) ;;
    esac
  done
  echo -e "\n  ${BOLD}Total: ${GREEN}$pass pass${RESET}, ${RED}$fail fail${RESET}, ${YELLOW}$skip skip${RESET}\n"
  [[ $fail -eq 0 ]]
}

# ── Package Lists ──────────────────────────────────────────────────
NPM_PACKAGES=("typescript" "mcp" "opencode-plugin" "claude-code-plugin" "openclaw-channel")
AIP_NPM_PACKAGES=("typescript")
ALL_PACKAGES=("typescript" "python" "golang" "rust" "mcp" "opencode-plugin" "claude-code-plugin" "openclaw-channel")
AIP_PACKAGES=("typescript" "python" "golang" "rust")
