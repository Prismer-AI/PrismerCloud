#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

export PRISMER_STORE_BACKEND="${PRISMER_STORE_BACKEND:-sql}"
export PRISMER_DB_DRIVER="${PRISMER_DB_DRIVER:-sqlite3}"
export PRISMER_DB_DSN="${PRISMER_DB_DSN:-file:/tmp/prismer-orchestrator.db?_foreign_keys=on}"
export PRISMER_DB_APPLY_SCHEMA="${PRISMER_DB_APPLY_SCHEMA:-true}"
export PRISMER_HTTP_ADDR="${PRISMER_HTTP_ADDR:-:8080}"
export PRISMER_WS_ALLOW_ALL_ORIGINS="${PRISMER_WS_ALLOW_ALL_ORIGINS:-true}"
export GOCACHE="${GOCACHE:-/tmp/gocache}"
export GOSUMDB="${GOSUMDB:-off}"
export GOPROXY="${GOPROXY:-off}"

mkdir -p "${GOCACHE}"

cd "${REPO_ROOT}/services"
exec go run -tags 'sqlite_mattn gorilla_websocket' ./orchestrator/cmd/orchestrator
