#!/bin/sh
# Docker entrypoint — wait for MySQL, apply SQL migrations, exec server.
#
# Strategy: prefer raw SQL files (idempotent CREATE TABLE IF NOT EXISTS) over
# `prisma db push` because:
#   1. Prisma can't emit `DEFAULT (...)` for TEXT columns on MySQL 8 → push aborts
#      on the very first im_agent_protocols.capabilities default.
#   2. Raw SQL preserves explicit collation declarations the FK chain depends on.
#
# Order: scripts/sql/*.sql (PC tables, also baked into mysql init on first boot,
# so re-runs no-op) → src/im/sql/*.sql (IM tables, never auto-applied otherwise).
#
# Both directories are sorted by filename via `ls | sort -V`, matching the order
# expected by scripts/db-migrate.sh.
set -eu

DB_HOST="${REMOTE_MYSQL_HOST:-mysql}"
DB_PORT="${REMOTE_MYSQL_PORT:-3306}"
DB_USER="${REMOTE_MYSQL_USER:-prismer}"
DB_PASS="${REMOTE_MYSQL_PASSWORD:-prismer}"
DB_NAME="${REMOTE_MYSQL_DATABASE:-prismer_cloud}"

mysql_ok() {
  mysqladmin ping --skip-ssl -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" --silent >/dev/null 2>&1
}

apply_sql_dir() {
  dir="$1"
  label="$2"
  if [ ! -d "$dir" ]; then
    echo "[Entrypoint] $label dir $dir missing, skipping"
    return 0
  fi

  ok=0
  skipped=0
  failed=0
  # ls | sort -V handles 100_v191 vs 99_x correctly
  for f in $(ls "$dir" 2>/dev/null | grep -E '\.sql$' | sort -V); do
    bn="$(basename "$f")"

    # Skip files that target prod-only schemas or are rollback scripts.
    case "$bn" in
      000_check_schema.sql|*_rollback.sql)
        skipped=$((skipped+1))
        continue
        ;;
    esac

    set +e
    out=$(mysql --skip-ssl -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" < "$dir/$f" 2>&1)
    rc=$?
    set -e
    # Filter known-noisy lines
    err=$(echo "$out" | grep -E '^ERROR ' | grep -vE 'Duplicate (column|key)|already exists' || true)
    if [ "$rc" -eq 0 ] && [ -z "$err" ]; then
      if echo "$out" | grep -qE 'Duplicate (column|key)|already exists'; then
        skipped=$((skipped+1))
      else
        ok=$((ok+1))
      fi
    else
      failed=$((failed+1))
      echo "[Entrypoint]   FAIL $bn"
      echo "$err" | head -2 | sed 's/^/[Entrypoint]     /'
    fi
  done
  echo "[Entrypoint] $label: $ok applied, $skipped already-applied, $failed failed"
}

if command -v mysql >/dev/null 2>&1; then
  echo "[Entrypoint] Waiting for MySQL at $DB_HOST:$DB_PORT..."
  i=0
  while ! mysql_ok; do
    i=$((i+1))
    if [ "$i" -gt 60 ]; then
      echo "[Entrypoint] MySQL did not become ready within 60s, continuing anyway"
      break
    fi
    sleep 1
  done
  echo "[Entrypoint] MySQL ready (waited ${i}s)"

  apply_sql_dir "/app/scripts/sql"  "PC SQL"
  apply_sql_dir "/app/src/im/sql"   "IM SQL"
else
  echo "[Entrypoint] mysql client not in image, skipping SQL migrations (mysql_init handles PC tables on first boot, IM tables will be missing)"
fi

echo "[Entrypoint] Starting server..."
exec "$@"
