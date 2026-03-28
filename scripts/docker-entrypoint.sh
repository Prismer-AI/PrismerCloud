#!/bin/sh
# Docker entrypoint — runs Prisma migration then starts the app
set -e

echo "[Entrypoint] Running Prisma db push for IM tables..."
prisma db push --schema=prisma/schema.mysql.prisma --skip-generate 2>&1 || {
  echo "[Entrypoint] WARNING: Prisma db push failed (may already be applied)"
}

echo "[Entrypoint] Starting server..."
exec node server.js
