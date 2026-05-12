#!/usr/bin/env bash
# scripts/dev-up.sh — one-shot local dev boot
# = dev-stack.sh up + Next.js (with LAN access) + daemon hints
#
# Step order is intentional: verify schema BEFORE killing the user's
# running dev server. That way if drift / migration / docker fails,
# the user's existing cloud keeps serving until they fix the issue.
# (Drift check is read-only — running the old cloud against the same
# DB during the few-second check is safe.)
#
# Usage: ./scripts/dev-up.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ════════════════════════════════════════════════════════════════════════
# Step 1: .env.local precondition (cheap, no side effects)
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
# Step 2: docker stack + migrations + drift gate
# This runs FIRST so any failure (docker down, migration broken, schema
# drift) bails out before we touch the user's running dev server. On
# fresh init: applies all SQL. On steady state: skipped migrations +
# drift check (a couple of seconds, read-only).
# ════════════════════════════════════════════════════════════════════════
echo "[dev-up] step 1/4: docker stack + migrations + drift gate..."
./scripts/dev-stack.sh up

# ════════════════════════════════════════════════════════════════════════
# Step 3: stop stale Next.js dev server holding :3000
# Only reached if step 2 passed. If you're here, schema is verified
# aligned — safe to swap servers.
# ════════════════════════════════════════════════════════════════════════
echo "[dev-up] step 2/4: stop stale dev server on :3000 (if any)..."
EXISTING_PID="$(lsof -tiTCP:3000 -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [ -n "$EXISTING_PID" ]; then
  EXISTING_CMD="$(ps -p "$EXISTING_PID" -o command= 2>/dev/null || true)"
  # Only kill if it looks like our dev server (next dev / tsx server.ts /
  # prismer-cloud-next). Don't touch unrelated node processes that someone
  # may have intentionally bound to 3000.
  if echo "$EXISTING_CMD" | grep -qE "tsx server\.ts|next[- ]dev|next-server|prismer-cloud-next|server\.ts"; then
    echo "[dev-up]   stopping stale dev server (pid $EXISTING_PID)"
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
  else
    echo "[dev-up]   WARN: :3000 held by unrelated process (pid $EXISTING_PID): $EXISTING_CMD"
    echo "[dev-up]         not killing — set FORCE_DEV_KILL=1 to override or kill manually"
    if [ "${FORCE_DEV_KILL:-0}" = "1" ]; then
      echo "[dev-up]   FORCE_DEV_KILL=1 — killing anyway"
      kill -TERM "$EXISTING_PID" 2>/dev/null || true
      sleep 2
      kill -KILL "$EXISTING_PID" 2>/dev/null || true
    fi
  fi
fi
# .next/dev/lock is advisory flock; the kernel releases on process exit, but
# the file lingers and Next still checks for it on some versions. Remove to
# be safe.
rm -f .next/dev/lock 2>/dev/null || true

# ════════════════════════════════════════════════════════════════════════
# Step 4: detect LAN IP for mobile/real-device access
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
# one-time setup commands so the user can self-serve. macOS-only; on
# Linux we skip this block.
FIREWALL_HINT=""
if [ -x /usr/libexec/ApplicationFirewall/socketfilterfw ] && [ -n "$LAN_IP" ]; then
  FW_STATE="$(/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null | tail -1)"
  if echo "$FW_STATE" | grep -qE 'enabled|State = [12]'; then
    NODE_BIN="$(command -v node || true)"
    if [ -n "$NODE_BIN" ]; then
      # --getappblocked needs sudo on some macOS versions; tolerate either result.
      NODE_FW="$(/usr/libexec/ApplicationFirewall/socketfilterfw --getappblocked "$NODE_BIN" 2>&1 || true)"
      if ! echo "$NODE_FW" | grep -qiE 'permitted|allowed'; then
        # printf instead of heredoc — heredoc body inside $() command
        # substitution still gets quote-scanned, and the contraction
        # "isn't" was breaking shell parsing.
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
# Step 5: print URLs + daemon hint, then exec Next.js
# Bind 0.0.0.0 so LAN clients can connect. zsh/macOS commonly exports
# HOSTNAME=<machine>.local; if we preserve it, server.ts binds loopback-ish
# IPv6 ([::1]) and iPhones cannot reach :3000. Keep an explicit override
# knob for unusual local setups, but default hard to 0.0.0.0 for the
# release54 LAN gate.
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
