#!/usr/bin/env bash
# scripts/check-anti-patterns.sh — guard against re-introducing 1.9.0 屎山.
# Source of truth: docs/refactor/07-kill-list.md
#
# Run locally: npm run check:anti-patterns
# Run in CI: same; non-zero exit fails the pipeline.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

red() { printf '\033[1;31m%s\033[0m\n' "$*"; }
green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }

fail=0
report_fail() {
  red "❌ $1"
  fail=$((fail + 1))
}

# scan_from_file (defined below) takes a file containing a list of paths
# and a regex pattern; returns 0 if a non-comment line matches. We strip
# lines that are line-comments / JSDoc / shell comments before pattern
# matching, so prose mentioning a forbidden symbol in `// 1.9.0
# RelayClient is gone` doesn't trip the guard.
#
# Limitation: doesn't track multi-line `/* ... */` block boundaries —
# block-commented forbidden tokens across multiple lines after `/*` may
# still match. Acceptable for our domain (the kill-list symbols don't
# appear in long block comments today); a stricter parser belongs in a
# real lint plugin, not a shell guard.

# ─── 1. forbidden files / dirs (1.9.0 anti-pattern modules) ───────────
forbidden_paths=(
  "src/im/services/relay.service.ts"
  "src/im/ws/relay-handler.ts"
  "src/im/services/task-dispatcher.ts"
  "src/im/services/task-router.ts"
  "src/im/services/remote-command.service.ts"
  "src/im/services/push.service.ts"
  "sdk/prismer-cloud/wire"
  "sdk/prismer-cloud/sandbox-runtime"
  "sdk/prismer-cloud/adapters-core"
  "sdk/prismer-cloud/runtime/python"
  "sdk/prismer-cloud/python/prismer_adapter_hermes"
)
for p in "${forbidden_paths[@]}"; do
  if [ -e "$p" ]; then
    report_fail "Anti-pattern reintroduced: $p (see 07-kill-list.md §A/B)"
  fi
done

# ─── 2. forbidden imports / class references ──────────────────────────
# Portable file-list builder (works on macOS bash 3.2 — no mapfile).
list_ts_files() {
  # Args: one or more roots. Excludes typical generated dirs.
  find "$@" \
    -type d \( -name node_modules -o -name generated -o -name dist -o -name .next -o -name build -o -name target \) -prune \
    -o -type f \( -name '*.ts' -o -name '*.tsx' \) -print 2>/dev/null
}

SCAN_FILES_TMP="$(mktemp)"
trap 'rm -f "$SCAN_FILES_TMP"' EXIT
list_ts_files src sdk/prismer-cloud > "$SCAN_FILES_TMP"

scan_from_file() {
  local pattern="$1"
  local list="$2"
  local matched=1
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    [ -f "$f" ] || continue
    local hits
    hits="$(sed -E \
              -e '/^[[:space:]]*\/\//d' \
              -e '/^[[:space:]]*\*/d' \
              -e '/^[[:space:]]*\/\*/d' \
              -e '/^[[:space:]]*#/d' \
              -e 's@[[:space:]]+//.*$@@' \
              "$f" \
            | grep -nE "$pattern" || true)"
    if [ -n "$hits" ]; then
      grep -nE "$pattern" "$f" 2>/dev/null \
        | while IFS=: read -r lineno rest; do
            if ! echo "$rest" | grep -qE '^[[:space:]]*(//|\*|/\*|#)'; then
              printf '%s:%s:%s\n' "$f" "$lineno" "$rest"
            fi
          done
      matched=0
    fi
  done < "$list"
  return $matched
}

if scan_from_file "from.*['\"]@prismer/wire['\"]" "$SCAN_FILES_TMP"; then
  report_fail "@prismer/wire imported (forbidden — IM ServerEvents is the protocol layer)"
fi

if scan_from_file "(\bRelayService\b|\bRelayClient\b|\bTransportManager\b|\bConnectionProber\b|\bMultiPathTransport\b)" "$SCAN_FILES_TMP"; then
  report_fail "1.9.0 anti-pattern class referenced"
fi

# ─── 3. runtime/ must stay TS-only (no python subprocess / package) ───
if [ -d sdk/prismer-cloud/runtime ]; then
  RUNTIME_FILES_TMP="$(mktemp)"
  trap 'rm -f "$SCAN_FILES_TMP" "$RUNTIME_FILES_TMP"' EXIT
  list_ts_files sdk/prismer-cloud/runtime/src > "$RUNTIME_FILES_TMP"
  if scan_from_file "spawn\(\s*['\"]python|exec\(\s*['\"]python|PythonShell|child_process.*python" "$RUNTIME_FILES_TMP"; then
    report_fail "runtime/ spawning python subprocess (must be TS-only — see 07-kill-list.md §3 + 00-design-principles)"
  fi
  if find sdk/prismer-cloud/runtime/src -type f -name '*.py' 2>/dev/null | grep -q .; then
    report_fail "runtime/ contains .py files (must be TS-only)"
  fi
fi

# ─── 4. schema must not declare 1.9.0 binding tables ──────────────────
if [ -f prisma/schema.prisma ]; then
  # IMPairingOffer is the 1.9.3 simplified (5min TTL, consumed-once) — allowed.
  # The 1.9.0 anti-pattern is persistent desktop_binding / device_token / remote_command.
  if grep -E "^model (IMDesktopBinding|IMDeviceToken|IMRemoteCommand)\b" prisma/schema.prisma 2>/dev/null; then
    report_fail "1.9.0 binding/device/remote-command table reintroduced in schema.prisma"
  fi
fi

# ─── 5. don't re-add forbidden /ws sub-endpoints ──────────────────────
SRC_FILES_TMP="$(mktemp)"
trap 'rm -f "$SCAN_FILES_TMP" "$RUNTIME_FILES_TMP" "$SRC_FILES_TMP"' EXIT
list_ts_files src > "$SRC_FILES_TMP"
if scan_from_file "['\"]/ws/(daemon|client)/" "$SRC_FILES_TMP"; then
  report_fail "/ws/daemon/* or /ws/client/* sub-endpoint declared (use single /ws — see 07-kill-list.md §A)"
fi

# ─── 6. summary ───────────────────────────────────────────────────────
echo
if [ $fail -eq 0 ]; then
  green "✓ No anti-patterns detected"
  exit 0
else
  red "✗ $fail anti-pattern(s) detected — see 07-kill-list.md"
  exit 1
fi
