#!/bin/bash
# Docker MySQL init script — runs PC table migrations
# Mounted as /docker-entrypoint-initdb.d/00_init.sh
# Note: IM tables are created by Prisma db push in the app entrypoint

set -e

echo "[Init DB] Running PC table migrations..."
for f in /docker-entrypoint-initdb.d/pc/*.sql; do
  [ -f "$f" ] || continue
  echo "  → $(basename $f)"
  mysql -u root -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" < "$f"
done

echo "[Init DB] PC migrations complete. IM tables will be created by the app."
