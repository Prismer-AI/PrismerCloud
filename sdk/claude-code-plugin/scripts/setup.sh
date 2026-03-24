#!/usr/bin/env bash
#
# Prismer Evolution — Claude Code Plugin Setup
#
# Usage:
#   bash setup.sh
#   bash setup.sh --hooks-only
#   bash setup.sh --mcp-only
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/../templates"
CLAUDE_DIR="$HOME/.claude"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[prismer]${NC} $*"; }
ok()    { echo -e "${GREEN}[prismer]${NC} $*"; }
warn()  { echo -e "${YELLOW}[prismer]${NC} $*"; }
error() { echo -e "${RED}[prismer]${NC} $*"; }

# ── Parse args ──────────────────────────────────────────────
INSTALL_HOOKS=true
INSTALL_MCP=true
for arg in "$@"; do
  case "$arg" in
    --hooks-only) INSTALL_MCP=false ;;
    --mcp-only)   INSTALL_HOOKS=false ;;
    --help|-h)
      echo "Usage: setup.sh [--hooks-only | --mcp-only]"
      echo ""
      echo "  --hooks-only   Only install hooks.json (L2 integration)"
      echo "  --mcp-only     Only install MCP server config (L3 integration)"
      echo "  (default)      Install both hooks and MCP config"
      exit 0
      ;;
  esac
done

# ── Pre-flight checks ──────────────────────────────────────
info "Checking prerequisites..."

# Check for prismer CLI
if command -v prismer &>/dev/null; then
  PRISMER_VERSION=$(prismer --version 2>/dev/null || echo "unknown")
  ok "prismer CLI found (${PRISMER_VERSION})"
else
  warn "prismer CLI not found. Install with: npm install -g @prismer/sdk"
  warn "Hooks (L2) require the CLI. MCP (L3) works without it."
  if [ "$INSTALL_HOOKS" = true ] && [ "$INSTALL_MCP" = false ]; then
    error "Cannot install hooks without prismer CLI. Aborting."
    exit 1
  fi
fi

# Check for npx (needed for MCP)
if [ "$INSTALL_MCP" = true ]; then
  if ! command -v npx &>/dev/null; then
    error "npx not found. Install Node.js (v18+) first."
    exit 1
  fi
  ok "npx found"
fi

# Ensure ~/.claude directory exists
mkdir -p "$CLAUDE_DIR"

# ── Install hooks.json ──────────────────────────────────────
if [ "$INSTALL_HOOKS" = true ]; then
  info "Installing hooks.json..."
  HOOKS_TARGET="$CLAUDE_DIR/hooks.json"

  if [ -f "$HOOKS_TARGET" ]; then
    BACKUP="$HOOKS_TARGET.backup.$TIMESTAMP"
    warn "Existing hooks.json found — backing up to $BACKUP"
    cp "$HOOKS_TARGET" "$BACKUP"
  fi

  cp "$TEMPLATE_DIR/hooks.json" "$HOOKS_TARGET"
  ok "hooks.json installed at $HOOKS_TARGET"
fi

# ── Install MCP config ─────────────────────────────────────
if [ "$INSTALL_MCP" = true ]; then
  info "Installing MCP server config..."
  MCP_TARGET="$CLAUDE_DIR/mcp_servers.json"

  if [ -f "$MCP_TARGET" ]; then
    # Merge: add prismer entry to existing config
    BACKUP="$MCP_TARGET.backup.$TIMESTAMP"
    warn "Existing mcp_servers.json found — backing up to $BACKUP"
    cp "$MCP_TARGET" "$BACKUP"

    # Check if prismer key already exists
    if python3 -c "import json; d=json.load(open('$MCP_TARGET')); exit(0 if 'prismer' in d else 1)" 2>/dev/null; then
      warn "prismer entry already exists in mcp_servers.json — skipping merge"
    else
      # Merge prismer config into existing file
      python3 -c "
import json
with open('$MCP_TARGET') as f:
    existing = json.load(f)
with open('$TEMPLATE_DIR/mcp_servers.json') as f:
    prismer = json.load(f)
existing.update(prismer)
with open('$MCP_TARGET', 'w') as f:
    json.dump(existing, f, indent=2)
    f.write('\n')
" 2>/dev/null
      if [ $? -eq 0 ]; then
        ok "Merged prismer into existing mcp_servers.json"
      else
        # Fallback: just copy the template
        warn "Could not merge — overwriting with prismer config"
        cp "$TEMPLATE_DIR/mcp_servers.json" "$MCP_TARGET"
      fi
    fi
  else
    cp "$TEMPLATE_DIR/mcp_servers.json" "$MCP_TARGET"
    ok "mcp_servers.json installed at $MCP_TARGET"
  fi
fi

# ── API Key reminder ───────────────────────────────────────
echo ""
info "Setup complete! Next steps:"
echo ""
if [ "$INSTALL_MCP" = true ]; then
  echo "  1. Set your API key in $CLAUDE_DIR/mcp_servers.json:"
  echo "     Replace \"sk-prismer-...\" with your actual API key"
  echo ""
fi
echo "  2. (Optional) Add evolution guidance to your project CLAUDE.md:"
echo "     cat $TEMPLATE_DIR/CLAUDE.md.template >> your-project/CLAUDE.md"
echo ""
echo "  3. Restart Claude Code to pick up the new configuration"
echo ""
ok "Prismer Evolution plugin is ready."
