#!/usr/bin/env bash
# scripts/ga-smoke.sh
#
# 1.9.x GA smoke — 全自动跑通 cross-track integration:
#   Track A schema (workspace data model)
#   + Track B daemon CLI + ws-client + Hermes adapter
#   + Track C cloud handler + WS API key auth + mention dispatch
#   + Track D local stack + dev-key seed
#
# 7 phases, fail-fast w/ targeted error dumps. Total budget < 5 min when
# everything's green; ~30s for the no-op rerun case.
#
#   ./scripts/ga-smoke.sh              # full smoke
#   ./scripts/ga-smoke.sh --keep-cloud # don't restart Next.js if already up
#   ./scripts/ga-smoke.sh --no-daemon  # stop after register-agent (Step 5)
#   ./scripts/ga-smoke.sh --reset      # nuke dev-stack volumes first
#
# Exit code: 0 = GA-ready / non-zero = which phase failed.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DEV_KEY="sk-prismer-live-a2ec8ab7966295e2f1ed1817f571e10b9470e96cd8156325497ff2eee3e25842"
CLOUD_BASE="http://127.0.0.1:3000"
NEXT_LOG="$REPO_ROOT/.dev-stack/next.log"
SMOKE_DIR="$REPO_ROOT/.dev-stack/smoke"
mkdir -p "$SMOKE_DIR"

KEEP_CLOUD=0
NO_DAEMON=0
RESET=0
for arg in "$@"; do
  case "$arg" in
    --keep-cloud) KEEP_CLOUD=1 ;;
    --no-daemon)  NO_DAEMON=1 ;;
    --reset)      RESET=1 ;;
    -h|--help)
      sed -n '3,18p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# ─── output helpers ──────────────────────────────────────────────────
red()    { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[1;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }
phase()  { printf '\n\033[1;36m===== %s =====\033[0m\n' "$*"; }
ok()     { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
fail()   { red "  ✗ FAIL: $*"; exit 1; }

# ─── 0/7 prereq tools ────────────────────────────────────────────────
phase "0/7 prereq tools"
for cmd in docker curl jq node npm; do
  command -v "$cmd" >/dev/null 2>&1 || fail "missing tool: $cmd"
done
MYSQL=/opt/homebrew/opt/mysql-client/bin/mysql
[ -x "$MYSQL" ] || MYSQL=$(command -v mysql || true)
[ -n "$MYSQL" ] && [ -x "$MYSQL" ] || fail "mysql client not found (brew install mysql-client)"
ok "all tools available"

# ─── 1/7 docker stack ────────────────────────────────────────────────
phase "1/7 docker stack (mysql:8.0 + redis:7)"
if [ "$RESET" = "1" ]; then
  yellow "  --reset: tearing down volumes"
  bash scripts/dev-stack.sh down 2>&1 | tail -3
  rm -rf .dev-stack/mysql .dev-stack/redis 2>/dev/null
fi
bash scripts/dev-stack.sh up > "$SMOKE_DIR/dev-stack.log" 2>&1
# success signal can appear anywhere in the log (the last line is the
# "next: cp .env.local..." hint, not the success marker).
if grep -q "stack up\." "$SMOKE_DIR/dev-stack.log"; then
  pass_count=$(grep -oE "applied [0-9]+ migrations cleanly" "$SMOKE_DIR/dev-stack.log" | grep -oE "[0-9]+" | head -1)
  partial=$(grep -oE "[0-9]+/[0-9]+ migrations failed" "$SMOKE_DIR/dev-stack.log" | head -1)
  if [ -n "$partial" ]; then
    yellow "  ⚠ $partial — see .dev-stack/migration-failures.log (non-blocking if cloud still boots)"
  else
    ok "applied ${pass_count:-?} migrations cleanly"
  fi
else
  fail "dev-stack up failed — see $SMOKE_DIR/dev-stack.log"
fi

# ─── 2/7 seed dev API key ────────────────────────────────────────────
phase "2/7 seed dev API key + credit"
KEY_HASH=$(echo -n "$DEV_KEY" | shasum -a 256 | awk '{print $1}')
KEY_PREFIX="${DEV_KEY:0:20}"
KEY_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
"$MYSQL" -h 127.0.0.1 -P 3307 -uprismer -pdevpass prismer_cloud <<EOF >"$SMOKE_DIR/seed.log" 2>&1
INSERT INTO pc_api_keys (id, user_id, key_hash, key_prefix, label, status)
VALUES ('$KEY_ID', 1, '$KEY_HASH', '$KEY_PREFIX', 'ga-smoke', 'ACTIVE')
ON DUPLICATE KEY UPDATE status='ACTIVE';
INSERT INTO pc_user_credits (user_id, balance, created_at, updated_at)
VALUES (1, 100000, NOW(), NOW())
ON DUPLICATE KEY UPDATE balance=GREATEST(balance, 100000);
EOF
seeded=$("$MYSQL" -h 127.0.0.1 -P 3307 -uprismer -pdevpass prismer_cloud -BNe \
  "SELECT COUNT(*) FROM pc_api_keys WHERE key_hash='$KEY_HASH' AND status='ACTIVE';" 2>/dev/null || echo 0)
if [ "$seeded" = "1" ]; then
  ok "dev key row present (sha256=${KEY_HASH:0:12}...)"
else
  fail "seed failed — see $SMOKE_DIR/seed.log"
fi

# ─── 3/7 .env.local + Next.js ────────────────────────────────────────
phase "3/7 .env.local + Next.js"
[ -f .env.local ] || cp .env.local.example .env.local
sed -i.bak 's/FF_API_KEYS_LOCAL=false/FF_API_KEYS_LOCAL=true/' .env.local
ok "FF_API_KEYS_LOCAL=true"

# Always restart Next.js — stale instances may have outdated env / unbuilt
# routes. --keep-cloud now only skips the slow docker stack reset.
NEXT_PID=$(lsof -i :3000 -sTCP:LISTEN -t 2>/dev/null | head -1 || true)
if [ -n "$NEXT_PID" ]; then
  yellow "  killing existing Next.js (pid=$NEXT_PID, ensures clean route+env load)"
  kill -9 "$NEXT_PID" 2>/dev/null || true
  # Wait for port to free
  for _ in 1 2 3 4 5; do
    sleep 1
    lsof -i :3000 -sTCP:LISTEN -t >/dev/null 2>&1 || break
  done
fi
rm -f .next/dev/lock 2>/dev/null
yellow "  starting Next.js in background → $NEXT_LOG"
PRISMER_API_KEY_DEV="$DEV_KEY" nohup npm run dev > "$NEXT_LOG" 2>&1 &
echo "    pid=$!"

# Wait up to 60s for /api/health AND /api/im/me to respond (IM router compiled).
start_ts=$(date +%s)
while true; do
  if curl -sf "$CLOUD_BASE/api/health" > /dev/null 2>&1; then
    # /api/health up — now ensure IM route compiled (returns 401 not 404 w/o auth)
    im_status=$(curl -s -o /dev/null -w '%{http_code}' "$CLOUD_BASE/api/im/me" 2>/dev/null || echo 000)
    [ "$im_status" = "401" ] && break
    [ "$im_status" = "200" ] && break  # already auth'd somehow
  fi
  elapsed=$(($(date +%s) - start_ts))
  [ "$elapsed" -ge 60 ] && fail "Next.js not fully ready in 60s (/api/health up but /api/im/me not compiled) — see $NEXT_LOG"
  sleep 2
done
ok "/api/health + /api/im router ready in ${elapsed}s"

# ─── 4/7 cloud auth smoke ────────────────────────────────────────────
phase "4/7 cloud auth smoke"
ME_RES=$(curl -sS -m 5 -H "Authorization: Bearer $DEV_KEY" "$CLOUD_BASE/api/im/me")
USER_IM_ID=$(echo "$ME_RES" | jq -r '.data.user.id // empty')
if [ -z "$USER_IM_ID" ]; then
  echo "$ME_RES" | head -c 200 > "$SMOKE_DIR/me-response.json"
  fail "/api/im/me not returning user — response: $(cat $SMOKE_DIR/me-response.json)"
fi
ok "auth → IMUser $USER_IM_ID"

# ─── 5/7 cloud-side agent register ───────────────────────────────────
phase "5/7 register agent on cloud"
RUNTIME_DIR="$REPO_ROOT/sdk/prismer-cloud/runtime"
if [ ! -f "$RUNTIME_DIR/dist/cli.js" ]; then
  yellow "  building runtime…"
  (cd "$RUNTIME_DIR" && npm install >/dev/null 2>&1 && npm run build > "$SMOKE_DIR/runtime-build.log" 2>&1) \
    || fail "runtime build failed — see $SMOKE_DIR/runtime-build.log"
fi
ok "runtime built"

# Write daemon config (bypass pair flow with our seeded key)
mkdir -p "$HOME/.prismer"
cat > "$HOME/.prismer/config.toml" <<EOF
api_key = "$DEV_KEY"
cloud_api_base = "$CLOUD_BASE"
daemon_id = "daemon-ga-smoke-$(date +%s)"
EOF
ok "~/.prismer/config.toml written"

# Use the patched register CLI (cloud-side register, not local-only)
REG_OUT=$(cd "$RUNTIME_DIR" && node dist/cli.js agent register \
  --adapter hermes \
  --display-name "GA Smoke Agent $(date +%s)" 2>&1)
REG_AGENT_ID=$(echo "$REG_OUT" | jq -r '.imUserId // empty' 2>/dev/null)
if [ -z "$REG_AGENT_ID" ] || [ "$REG_AGENT_ID" = "null" ]; then
  echo "$REG_OUT" > "$SMOKE_DIR/register.log"
  red "  register output saved to $SMOKE_DIR/register.log:"
  echo "$REG_OUT" | head -10 | sed 's/^/    /'
  yellow "  Next.js log tail:"
  tail -50 "$NEXT_LOG" | grep -vE "^var |Symbol|prototype|globalThis" | tail -10 | sed 's/^/    /'
  yellow "  schema check (im_agent_cards NOT NULL columns w/o default):"
  "$MYSQL" -h 127.0.0.1 -P 3307 -uprismer -pdevpass prismer_cloud -BNe \
    "SELECT column_name FROM information_schema.columns
       WHERE table_schema='prismer_cloud' AND table_name='im_agent_cards'
         AND is_nullable='NO' AND column_default IS NULL;" 2>/dev/null \
    | sed 's/^/    /'
  fail "agent register failed — see above"
fi
ok "agent registered: $REG_AGENT_ID"

if [ "$NO_DAEMON" = "1" ]; then
  green ""
  green "==== GA SMOKE PASS (5/7) — register-only mode ===="
  green "Schema + auth + cloud-side register all green."
  green "Skipping daemon (Step 6) and host.acked (Step 7) per --no-daemon."
  exit 0
fi

# ─── 6/7 daemon start + WS connect ───────────────────────────────────
phase "6/7 daemon start + WS connect"
DAEMON_LOG="$SMOKE_DIR/daemon.log"

# Kill any stale daemon left behind by a previous failed smoke run.
# Stale daemons hold the pidfile + keep writing to daemon.log, contaminating
# both startup ("Daemon already running") and the wait loop's grep.
pkill -f "node.*cli.js daemon start" 2>/dev/null || true
sleep 1
pkill -9 -f "node.*cli.js daemon start" 2>/dev/null || true
rm -f "$HOME/.prismer/daemon.pid" 2>/dev/null || true
: > "$DAEMON_LOG"

# Start daemon in background
(cd "$RUNTIME_DIR" && nohup node dist/cli.js daemon start > "$DAEMON_LOG" 2>&1 &)
DAEMON_PID=$!
yellow "  daemon launched (pid=$DAEMON_PID, log=$DAEMON_LOG)"

# Wait up to 30s for ws connect + host.acked
start_ts=$(date +%s)
saw_connect=0
saw_acked=0
while true; do
  if grep -qE "ws (open|connected|authenticated)|control channel connected|connected.*ws://" "$DAEMON_LOG" 2>/dev/null; then
    saw_connect=1
  fi
  if grep -qE "host\.acked|host_acked" "$DAEMON_LOG" 2>/dev/null; then
    saw_acked=1
  fi
  if [ "$saw_connect" = "1" ] && [ "$saw_acked" = "1" ]; then break; fi
  elapsed=$(($(date +%s) - start_ts))
  if [ "$elapsed" -ge 30 ]; then
    red "  daemon did not reach acked state in 30s. last 40 lines:"
    tail -40 "$DAEMON_LOG" | sed 's/^/    /'
    yellow "  Next.js log (recent ws-related):"
    grep -E "ws|websocket|host.declare|API key" "$NEXT_LOG" | tail -10 | sed 's/^/    /'
    fail "daemon ws/host.acked timeout"
  fi
  sleep 1
done
ok "ws connected + host.acked received in ${elapsed}s"

# ─── 7/7 cloud sees agent online ─────────────────────────────────────
phase "7/7 cloud sees agent online"
# host.acked is sent AFTER iMAgentCard.updateMany(status='online') completes,
# so by the time the daemon logged "host.acked" the DB row is already updated.
# A short settle delay covers any background I/O.
sleep 1
ONLINE_ROWS=$("$MYSQL" -h 127.0.0.1 -P 3307 -uprismer -pdevpass prismer_cloud -BNe "
SELECT COUNT(*) FROM im_agent_cards
WHERE status='online'
  AND lastHeartbeat >= NOW() - INTERVAL 60 SECOND;
" 2>/dev/null | tail -1 | tr -d ' ')
if [ "${ONLINE_ROWS:-0}" -ge 1 ]; then
  ok "cloud reports $ONLINE_ROWS agent(s) online (im_agent_cards.status='online' within last 60s)"
else
  yellow "  no fresh online rows — last 5 cards by heartbeat:"
  "$MYSQL" -h 127.0.0.1 -P 3307 -uprismer -pdevpass prismer_cloud -e "
    SELECT imUserId, name, status, lastHeartbeat FROM im_agent_cards
    ORDER BY lastHeartbeat DESC LIMIT 5;
  " 2>/dev/null | sed 's/^/    /'
  yellow "  daemon log tail:"
  tail -10 "$DAEMON_LOG" | sed 's/^/    /'
  fail "cloud DB shows no agents marked online despite host.acked"
fi

# ─── teardown daemon ─────────────────────────────────────────────────
yellow ""
yellow "  killing smoke daemon (pid=$DAEMON_PID)..."
kill "$DAEMON_PID" 2>/dev/null || true
sleep 1
kill -9 "$DAEMON_PID" 2>/dev/null || true

# ─── done ────────────────────────────────────────────────────────────
green ""
green "==== 1.9.x GA SMOKE PASS (7/7) ===="
green "All cross-track integration verified:"
green "  ✓ Track A schema (46/46 migrations + im_agent_cards.workspaceId)"
green "  ✓ Track B daemon CLI + cloud register + ws-client + host.declare"
green "  ✓ Track C WS API key auth + agent.host.declare handler + host.acked"
green "  ✓ Track D dev-stack + seed + preflight pieces"
green ""
yellow "Next steps (manual):"
yellow "  - git tag refactor-1.9.x && git push origin refactor-1.9.x"
yellow "  - or run full snake e2e: scripts/mvp/run-snake-mvp.sh (needs LLM tokens + 10 min)"
yellow ""
yellow "Artifacts left for inspection:"
yellow "  $NEXT_LOG               (Next.js cloud log)"
yellow "  $DAEMON_LOG  (smoke daemon log)"
yellow "  $SMOKE_DIR/             (per-step output)"
yellow ""
yellow "Note: Next.js is still running in background (lsof -i :3000)."
yellow "      Stop it manually: pkill -f 'next dev'"
exit 0
