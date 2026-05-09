#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

export PRISMER_ORCH_WS_URL="${PRISMER_ORCH_WS_URL:-ws://127.0.0.1:8080/ws/runtime}"
export PRISMER_DAEMON_DID="${PRISMER_DAEMON_DID:-did:key:local-dev-daemon}"
export PRISMER_DAEMON_VERSION="${PRISMER_DAEMON_VERSION:-0.1.0-dev}"
export PRISMER_DAEMON_CAPABILITIES="${PRISMER_DAEMON_CAPABILITIES:-noop@local=/usr/bin/env}"
export PRISMER_DAEMON_HEARTBEAT_INTERVAL_MS="${PRISMER_DAEMON_HEARTBEAT_INTERVAL_MS:-5000}"
export GOCACHE="${GOCACHE:-/tmp/gocache}"
export GOSUMDB="${GOSUMDB:-off}"
export GOPROXY="${GOPROXY:-off}"

mkdir -p "${GOCACHE}"

cd "${REPO_ROOT}/services"
exec go run ./daemon/cmd/daemon
