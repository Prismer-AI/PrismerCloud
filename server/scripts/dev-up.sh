#!/usr/bin/env bash
# scripts/dev-up.sh — one-shot local dev boot
# = kill stale :3000 + dev-stack.sh up + Next.js (with LAN access) + daemon hints
#
# Local dev is "always run the latest" by definition: latest code, latest
# schema, latest migrations, latest config, latest deps. The script reflects
# that:
#
#   1/4  Kill any process on :3000 — no zombie servers running stale code
#   2/4  Docker stack + migrations + drift gate — fail-fast so the new dev
#        process never starts against a half-applied schema
#   3/4  Detect LAN IP (real-device URL hint)
#   4/4  exec next dev
#
# We DO NOT preserve a stale server "in case migration fails". The whole point
# of running dev:full is to upgrade to the latest; if migrations fail, fix
# them, don't keep an outdated process serving fake-current code.
#
# Usage: ./scripts/dev-up.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ════════════════════════════════════════════════════════════════════════
# Precondition: .env.local
# ════════════════════════════════════════════════════════════════════════
if [ ! -f .env.local ]; then
  echo "[dev-up] .env.local not found. Copying from .env.local.example..."
  cp .env.local.example .env.local
  echo "[dev-up] Edit .env.local to add OPENAI_API_KEY etc., then re-run."
  exit 1
fi

if ! grep -q '^LOCAL_ONLY=1' .env.local; then
  echo "[dev-up] WARNING: LOCAL_ONLY=1 not set in .env.local. Nacos will be hit."
fi

# ════════════════════════════════════════════════════════════════════════
# Step 1/4: kill any process holding :3000
#
# Local dev owns :3000. Whatever is there — our own dev server, a leftover
# from a previous session, or a stray node process — gets terminated so the
# new server starts clean. Done BEFORE migrations + docker so the new
# process always boots against the latest schema/code, and so a migration
# failure leaves NOTHING on :3000 (no zombie running stale code).
# ════════════════════════════════════════════════════════════════════════
echo "[dev-up] step 1/4: kill any process on :3000..."
EXISTING_PID="$(lsof -tiTCP:3000 -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [ -n "$EXISTING_PID" ]; then
  echo "[dev-up]   stopping pid $EXISTING_PID"
  kill -TERM "$EXISTING_PID" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    sleep 1
    kill -0 "$EXISTING_PID" 2>/dev/null || break
  done
  if kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "[dev-up]   didn't exit in 5s, SIGKILL"
    kill -KILL "$EXISTING_PID" 2>/dev/null || true
    sleep 1
  fi
fi
# .next/dev/lock is advisory flock; the kernel releases on process exit, but
# the file lingers and Next still checks for it on some versions.
rm -f .next/dev/lock 2>/dev/null || true

# ════════════════════════════════════════════════════════════════════════
# Step 2/4: docker stack + migrations + drift gate
# Fail-fast: don't start a new dev server against a half-applied schema.
# ════════════════════════════════════════════════════════════════════════
echo "[dev-up] step 2/4: docker stack + migrations + drift gate..."
./scripts/dev-stack.sh up

# ════════════════════════════════════════════════════════════════════════
# Step 3/4: detect LAN IP for mobile/real-device access
# ════════════════════════════════════════════════════════════════════════
echo "[dev-up] step 3/4: detect LAN IP for mobile/real-device access..."
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo '')"

if [ -z "$LAN_IP" ]; then
  echo "[dev-up]   (no LAN IP detected — Wi-Fi off? Skipping LAN access info.)"
else
  echo "[dev-up]   LAN IP: $LAN_IP"
fi

# Probe mac firewall (read-only — never sudo here).
# When the firewall is on AND node isn't already permitted for inbound
# connections, real-device LAN access will silently time out. Print the
# one-time setup commands so the user can self-serve. macOS-only.
FIREWALL_HINT=""
if [ -x /usr/libexec/ApplicationFirewall/socketfilterfw ] && [ -n "$LAN_IP" ]; then
  FW_STATE="$(/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null | tail -1)"
  if echo "$FW_STATE" | grep -qE 'enabled|State = [12]'; then
    NODE_BIN="$(command -v node || true)"
    if [ -n "$NODE_BIN" ]; then
      NODE_FW="$(/usr/libexec/ApplicationFirewall/socketfilterfw --getappblocked "$NODE_BIN" 2>&1 || true)"
      if ! echo "$NODE_FW" | grep -qiE 'permitted|allowed'; then
        FIREWALL_HINT="$(printf '%s\n' \
          "  WARN: Firewall is on but node is not in the allowlist —" \
          "        real-device LAN access will time out. One-time setup" \
          "        (see docs/refactor/dev-firewall-setup.md):" \
          "          sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add \"$NODE_BIN\"" \
          "          sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp \"$NODE_BIN\"" \
          "")"
      fi
    fi
  fi
fi

# ════════════════════════════════════════════════════════════════════════
# Step 4/4: print URLs + daemon hint, then exec Next.js
# Bind 0.0.0.0 so LAN clients can connect. zsh/macOS commonly exports
# HOSTNAME=<machine>.local; if we preserve it, server.ts binds loopback-ish
# IPv6 ([::1]) and iPhones cannot reach :3000. Keep an explicit override
# knob (NEXT_HOSTNAME) for unusual local setups.
# ════════════════════════════════════════════════════════════════════════
cat <<EOF

[dev-up] step 4/4: starting Next.js + IM (in-process) on :3000...

  Local:    http://127.0.0.1:3000
$([ -n "$LAN_IP" ] && echo "  LAN:      http://$LAN_IP:3000   (use this from iPhone real device)")
  WS:       ws://127.0.0.1:3000/ws

  To start daemon in another terminal:
    export PRISMER_BASE_URL=http://127.0.0.1:3000
    export LOCAL_ONLY=1
    prismer pair          # first run only — visit dashboard, scan QR / approve
    prismer daemon start  # listens on :3210, connects ws://127.0.0.1:3000/ws

${FIREWALL_HINT}
EOF

export HOSTNAME="${NEXT_HOSTNAME:-0.0.0.0}"
exec npm run dev
