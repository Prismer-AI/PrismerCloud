#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

export PRISMER_APPROVAL_DECISION="rejected"
exec "${SCRIPT_DIR}/demo_approval_flow.sh"
