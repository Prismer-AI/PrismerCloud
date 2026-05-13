#!/bin/bash
# Docker MySQL init script — runs PC table migrations on first MySQL boot.
# Mounted as /docker-entrypoint-initdb.d/00_init.sh.
#
# Note: IM tables are created by the app's docker-entrypoint at every startup.
# This script only runs once on volume init.
#
# Skip rules:
#   - 000_check_schema.sql — read-only audit of the prod-only `prismer_info`
#     schema; not relevant to self-host (which only has `prismer_cloud`).
#   - *_rollback.sql       — rollback scripts shouldn't run during forward init.

set -e

echo "[Init DB] Running PC table migrations..."

shopt -s nullglob
for f in /docker-entrypoint-initdb.d/pc/*.sql; do
  bn="$(basename "$f")"

  case "$bn" in
    000_check_schema.sql|*_rollback.sql)
      echo "  → $bn (skipped: not for self-host init)"
      continue
      ;;
  esac

  echo "  → $bn"
  if ! mysql -u root -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" < "$f"; then
    echo "[Init DB] FAILED on $bn — aborting" >&2
    exit 1
  fi
done

echo "[Init DB] PC migrations complete. IM tables will be created by the app."
