#!/bin/bash
# common.sh — Shared shell library for SDK build scripts
set -euo pipefail

# ── Paths ──────────────────────────────────────────────────────────
# Use BASH_SOURCE[0] (this file's location) for stable path resolution
_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_ROOT="$(cd "$_COMMON_DIR/.." && pwd)"
SDK_ROOT="$(cd "$BUILD_ROOT/.." && pwd)"
PROJECT_ROOT="$(cd "$SDK_ROOT/.." && pwd)"
CLOUD_SDK="$SDK_ROOT/cloud"
PRISMER_RUNTIME="$SDK_ROOT/prismer"
LEGACY_SDK_ROOT="$SDK_ROOT/prismer-cloud"
AIP_SDK="$SDK_ROOT/aip"
OPENSRC_ROOT="${OPENSRC_ROOT:-/Users/prismer/workspace/PrismerCloud}"
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

  case "$SCOPE" in
    aip|cloud|prismer|all) ;;
    prismer-cloud)
      log_warn "--scope prismer-cloud is a deprecated compatibility alias for cloud + prismer; it will be removed in 3.0.0"
      ;;
    *)
      log_error "Invalid scope: $SCOPE (expected aip|cloud|prismer|all)"
      return 2
      ;;
  esac
}

# ── Scope helpers ─────────────────────────────────────────────────
scope_includes_aip()     { [[ "$SCOPE" == "all" || "$SCOPE" == "aip" ]]; }
scope_includes_cloud()   { [[ "$SCOPE" == "all" || "$SCOPE" == "cloud" || "$SCOPE" == "prismer-cloud" ]]; }
scope_includes_prismer() { [[ "$SCOPE" == "all" || "$SCOPE" == "prismer" || "$SCOPE" == "prismer-cloud" ]]; }

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

# Root /VERSION is the single source of truth. Fallback to TS package.json for
# legacy compatibility if VERSION file is missing.
get_version() {
  local version_file="$PROJECT_ROOT/VERSION"
  if [[ -f "$version_file" ]]; then
    local v
    v="$(tr -d '[:space:]' < "$version_file")"
    if [[ -n "$v" ]]; then echo "$v"; return; fi
  fi
  local pkg="$CLOUD_SDK/package.json"
  if [[ -f "$pkg" ]]; then
    grep '"version"' "$pkg" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/'
  else
    echo "unknown"
  fi
}

# AIP shares the same root VERSION (monorepo single source of truth).
get_aip_version() { get_version; }

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
      pass) echo -e "  ${GREEN}✓${RESET} ${RESULT_NAMES[$i]}"; ((pass += 1)) ;;
      fail) echo -e "  ${RED}✗${RESET} ${RESULT_NAMES[$i]}"; ((fail += 1)) ;;
      skip) echo -e "  ${YELLOW}–${RESET} ${RESULT_NAMES[$i]} (skipped)"; ((skip += 1)) ;;
      warn) echo -e "  ${YELLOW}⚠${RESET} ${RESULT_NAMES[$i]}"; ((pass += 1)) ;;
    esac
  done
  echo -e "\n  ${BOLD}Total: ${GREEN}$pass pass${RESET}, ${RED}$fail fail${RESET}, ${YELLOW}$skip skip${RESET}\n"
  [[ $fail -eq 0 ]]
}

# ── Package Lists ──────────────────────────────────────────────────
AIP_NPM_PACKAGE_DIRS=("aip/typescript")
CLOUD_NPM_PACKAGE_DIRS=("cloud" "cloud/mcp")
PRISMER_NPM_PACKAGE_DIRS=("prismer")
AIP_PYTHON_PACKAGE_DIRS=("aip/python")
CLOUD_PYTHON_PACKAGE_DIRS=("cloud/python")
