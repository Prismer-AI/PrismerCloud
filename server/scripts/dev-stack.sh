#!/usr/bin/env bash
# scripts/dev-stack.sh — manage docker-based local dev stack
# Subcommands: up | down | status | reset | logs
#
# Usage:
#   ./scripts/dev-stack.sh up       # bring up mysql+redis, wait healthy, prisma push
#   ./scripts/dev-stack.sh down     # stop containers (keeps data)
#   ./scripts/dev-stack.sh status   # exit 0 iff both healthy
#   ./scripts/dev-stack.sh reset    # down + delete volumes + up
#   ./scripts/dev-stack.sh logs     # tail logs

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="docker-compose.dev.yml"
HEALTH_TIMEOUT_S=60

color_green="\033[1;32m"
color_red="\033[1;31m"
color_yellow="\033[1;33m"
color_reset="\033[0m"

log_info()  { echo -e "${color_yellow}[dev-stack]${color_reset} $*"; }
log_ok()    { echo -e "${color_green}[dev-stack] ✓${color_reset} $*"; }
log_err()   { echo -e "${color_red}[dev-stack] ✗${color_reset} $*" >&2; }

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    log_err "docker not installed. Install OrbStack or Docker Desktop first."
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    log_err "docker daemon not running. Start OrbStack/Docker Desktop."
    exit 1
  fi
}

wait_healthy() {
  local container="$1"
  local elapsed=0
  while [ "$elapsed" -lt "$HEALTH_TIMEOUT_S" ]; do
    local status
    status=$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || echo "missing")
    if [ "$status" = "healthy" ]; then
      log_ok "$container healthy"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
    log_info "waiting for $container ($status)... ${elapsed}s/${HEALTH_TIMEOUT_S}s"
  done
  log_err "$container did not become healthy within ${HEALTH_TIMEOUT_S}s"
  docker logs --tail 30 "$container" >&2 || true
  return 1
}

MIGRATION_LOG=".dev-stack/migration-failures.log"

apply_sql() {
  # $1 = file path on host, $2 = label
  # The only fixup we apply is stripping `USE prismer_info;` — those scripts
  # target the prod DB name but we apply them to local `prismer_cloud`. That
  # is cross-environment plumbing, not a schema fix.
  #
  # We deliberately do NOT shim TEXT @default("") → DEFAULT ('') anymore.
  # Per docs/refactor/06-local-dev-workflow.md §"数据库必须是 MySQL 8.0",
  # any schema/migration that doesn't apply to fresh MySQL 8.0 is Track A's
  # to fix at source. Failures get logged to MIGRATION_LOG so dispatcher /
  # Track A can pick up a complete picture.
  local f="$1"
  local label="$2"
  local err
  err="$(sed -E '/^[[:space:]]*USE[[:space:]]+prismer_info[[:space:]]*;/Id' "$f" \
         | docker exec -i prismer-dev-mysql \
             mysql -uprismer -pdevpass prismer_cloud 2>&1)"
  # MySQL error lines look like: "ERROR 1064 (42000) at line 17: ..." — anchor on that.
  if echo "$err" | grep -qE '^ERROR [0-9]+'; then
    log_err "migration failed: $label"
    {
      echo "──── $label ($(date '+%Y-%m-%d %H:%M:%S')) ────"
      echo "$err" | grep -E '^ERROR [0-9]+'
      echo
    } >> "$MIGRATION_LOG"
    echo "$err" | grep -E '^ERROR [0-9]+' | head -3 >&2
    return 1
  fi
}

apply_schema() {
  # Migration discipline (see docs/db-migration.md for full design):
  #   1. SQL files under scripts/sql/ + src/im/sql/ are canonical (NOT
  #      `prisma db push` — Prisma renders TEXT @default("") as bare
  #      `DEFAULT ''` which MySQL 8.0 InnoDB rejects).
  #   2. Applied state tracked in `schema_migrations` (filename + sha256)
  #      by scripts/db-migrate.sh. Subsequent `up` only applies NEW files.
  #   3. Modifying an applied migration = HARD FAIL (sha mismatch). Fix
  #      forward by writing a NEW migration.
  #   4. Drift gate confirms DB state matches Prisma schema after apply.
  #
  # Result: clone the repo on any device → run dev-stack up → land in the
  # SAME state every time. Bug fixes propagate via NEW migration files
  # committed to git.
  if ! command -v docker >/dev/null; then
    log_err "docker required to apply migrations"
    return 1
  fi

  # ─ Legacy adoption: populated DB without tracking table → baseline first
  local existing_tables tracking_exists
  existing_tables="$(docker exec prismer-dev-mysql \
    mysql -uprismer -pdevpass -Nse \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='prismer_cloud';" \
    2>/dev/null || echo 0)"
  tracking_exists="$(docker exec prismer-dev-mysql \
    mysql -uprismer -pdevpass -Nse \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='prismer_cloud' AND table_name='schema_migrations';" \
    2>/dev/null || echo 0)"

  if [ "${existing_tables:-0}" -gt 10 ] && [ "${tracking_exists:-0}" -eq 0 ]; then
    log_info "legacy DB detected ($existing_tables tables, no tracking) — auto-baselining..."
    if ! ./scripts/db-migrate.sh baseline; then
      log_err "baseline failed — see above"
      return 1
    fi
    log_ok "baseline complete — future migrations will be tracked"
  fi

  # ─ Apply pending migrations (idempotent; checksum-gated) ───────────
  log_info "applying pending migrations..."
  if ! ./scripts/db-migrate.sh up; then
    log_err "migration apply failed — see above"
    log_err "  (if 'MODIFIED migration' error: someone edited an applied SQL file."
    log_err "   Never modify applied migrations. Write a NEW migration with the fix.)"
    return 1
  fi

  # ─ Generate Prisma client ───────────────────────────────────────────
  if [ -f prisma/schema.mysql.prisma ]; then
    log_info "generating Prisma client (mysql)..."
    npx prisma generate --schema=prisma/schema.mysql.prisma >/dev/null
    log_ok "prisma client generated"
  fi

  # ─ Drift gate (Prisma ⇄ MySQL) ──────────────────────────────────────
  if [ "${DEV_STACK_SKIP_DRIFT:-0}" != "1" ] && [ -x scripts/db-drift-check.sh ]; then
    log_info "checking schema drift (Prisma ⇄ MySQL)..."
    if ./scripts/db-drift-check.sh; then
      log_ok "schema aligned"
    else
      log_err "schema drift detected — fix before running cloud, or rerun with DEV_STACK_SKIP_DRIFT=1 to bypass"
      return 1
    fi
  fi
}

yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }

cmd_up() {
  check_docker
  log_info "starting docker stack..."
  docker compose -f "$COMPOSE_FILE" up -d
  wait_healthy prismer-dev-mysql
  wait_healthy prismer-dev-redis
  apply_schema
  log_ok "stack up. mysql=localhost:3307 redis=localhost:6380"
  log_info "next: cp .env.local.example .env.local (if not done) && npm run dev"
}

cmd_down() {
  check_docker
  log_info "stopping docker stack (data kept)..."
  docker compose -f "$COMPOSE_FILE" down
  log_ok "stack down"
}

cmd_status() {
  check_docker
  local mysql_status redis_status
  mysql_status=$(docker inspect -f '{{.State.Health.Status}}' prismer-dev-mysql 2>/dev/null || echo "missing")
  redis_status=$(docker inspect -f '{{.State.Health.Status}}' prismer-dev-redis 2>/dev/null || echo "missing")
  echo "mysql: $mysql_status"
  echo "redis: $redis_status"
  if [ "$mysql_status" = "healthy" ] && [ "$redis_status" = "healthy" ]; then
    log_ok "all healthy"
    exit 0
  else
    log_err "stack not healthy"
    exit 1
  fi
}

cmd_reset() {
  check_docker
  log_info "RESET: deleting volumes (mysql + redis data will be wiped)..."
  docker compose -f "$COMPOSE_FILE" down -v
  rm -rf .dev-stack/mysql/data .dev-stack/redis/data
  log_info "starting fresh stack..."
  cmd_up
}

cmd_logs() {
  check_docker
  docker compose -f "$COMPOSE_FILE" logs -f --tail=50
}

case "${1:-}" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  status) cmd_status ;;
  reset)  cmd_reset ;;
  logs)   cmd_logs ;;
  *)
    cat <<USAGE
Usage: $0 {up|down|status|reset|logs}

  up      — start mysql+redis, wait healthy, push Prisma schema
  down    — stop containers (data kept)
  status  — exit 0 iff both containers healthy
  reset   — wipe data and restart
  logs    — tail container logs
USAGE
    exit 2
    ;;
esac
