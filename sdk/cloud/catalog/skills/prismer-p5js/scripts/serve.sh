#!/bin/bash
# p5.js Skill — Local Development Server
# Serves the current directory over HTTP for loading local assets (fonts, images)
#
# Usage:
#   bash scripts/serve.sh [port] [directory]
#
# Examples:
#   bash scripts/serve.sh                    # serve CWD on port 8080
#   bash scripts/serve.sh 3000               # serve CWD on port 3000
#   bash scripts/serve.sh 8080 ./my-project  # serve specific directory

set -euo pipefail
PORT="${1:-8080}"
DIR="${2:-.}"

echo "=== p5.js Dev Server ==="
echo "Serving: $(cd "$DIR" && pwd)"
echo "URL:     http://localhost:$PORT"
echo "Press Ctrl+C to stop"
echo ""

command -v python3 >/dev/null || { echo "Python3 is required" >&2; exit 1; }
cd "$DIR"
exec python3 -m http.server "$PORT" --bind 127.0.0.1
