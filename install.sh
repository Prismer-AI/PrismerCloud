#!/bin/sh
# Prismer Cloud — zero-dependency installer
# https://prismer.cloud/install.sh
#
# Usage:
#   curl -fsSL https://prismer.cloud/install.sh | sh
#   curl -fsSL https://prismer.cloud/install.sh | sh -s -- --yes
#   curl -fsSL https://prismer.cloud/install.sh | sh -s -- --no-setup
#
# What it does:
#   1. Detect OS / arch / shell
#   2. Install Node.js via fnm (only if missing)
#   3. Install @prismer/sdk + @prismer/mcp-server globally
#   4. Run `prismer setup` (opens browser unless --no-setup)
#
# Everything goes under $HOME — no sudo, no /usr/local writes.
# Uninstall: rm -rf ~/.prismer ~/.local/share/fnm

set -eu

VERSION="1.8.1"
PRISMER_HOME="${PRISMER_HOME:-$HOME/.prismer}"
FNM_DIR="${FNM_DIR:-$HOME/.local/share/fnm}"
NODE_VERSION="lts"

# ---- ANSI (degrades gracefully if not a tty) ---------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD="$(printf '\033[1m')"
  DIM="$(printf '\033[2m')"
  RED="$(printf '\033[31m')"
  GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"
  BLUE="$(printf '\033[34m')"
  RESET="$(printf '\033[0m')"
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; RESET=""
fi

info()    { printf "%s>%s %s\n" "$BLUE" "$RESET" "$1"; }
success() { printf "%s✓%s %s\n" "$GREEN" "$RESET" "$1"; }
warn()    { printf "%s!%s %s\n" "$YELLOW" "$RESET" "$1"; }
error()   { printf "%s✗%s %s\n" "$RED" "$RESET" "$1" >&2; }
die()     { error "$1"; exit 1; }

# ---- Args --------------------------------------------------------------------
ASSUME_YES=0
RUN_SETUP=1
VERBOSE=0
LOCAL_ARTIFACTS=""
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes)        ASSUME_YES=1 ;;
    --no-setup)      RUN_SETUP=0 ;;
    -v|--verbose)    VERBOSE=1 ;;
    --local)         shift; LOCAL_ARTIFACTS="${1:-}" ;;
    --version)       printf "prismer installer %s\n" "$VERSION"; exit 0 ;;
    --uninstall)
      info "Removing $PRISMER_HOME and $FNM_DIR"
      rm -rf "$PRISMER_HOME" "$FNM_DIR"
      success "Uninstalled. (Global npm packages not touched — run 'npm uninstall -g @prismer/sdk @prismer/mcp-server' yourself if needed.)"
      exit 0
      ;;
    -h|--help)
      cat <<EOF
Prismer Cloud installer v$VERSION

Usage: install.sh [options]

Options:
  -y, --yes              Non-interactive (don't prompt)
  --no-setup             Skip 'prismer setup' (browser sign-in) at the end
  --local <dir>          Install from local tgz artifacts (pre-publish testing)
  --uninstall            Remove Prismer directories and fnm
  -v, --verbose          Show all subcommand output
  --version              Print installer version
  -h, --help             This help

Homepage: https://prismer.cloud
Docs:     https://prismer.cloud/docs
EOF
      exit 0
      ;;
    *) warn "unknown argument: $1 (ignored)" ;;
  esac
  shift
done

# ---- Banner ------------------------------------------------------------------
printf "\n"
printf "  %s◆%s  %sPrismer Cloud%s  %sv%s%s\n" "$BLUE" "$RESET" "$BOLD" "$RESET" "$DIM" "$VERSION" "$RESET"
printf "  %sThe Harness for AI Agent Evolution%s\n" "$DIM" "$RESET"
printf "\n"

# ---- Detect platform ---------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) OS_ID="macos" ;;
  Linux)  OS_ID="linux" ;;
  *)      die "Unsupported OS: $OS. Supported: macOS, Linux. Windows users: please use WSL2." ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCH_ID="x64" ;;
  arm64|aarch64) ARCH_ID="arm64" ;;
  *)             die "Unsupported arch: $ARCH. Supported: x86_64, arm64." ;;
esac

info "Platform: ${BOLD}${OS_ID}-${ARCH_ID}${RESET}"

# ---- Detect shell (for PATH update) ------------------------------------------
SHELL_NAME="$(basename "${SHELL:-/bin/sh}")"
case "$SHELL_NAME" in
  zsh)  PROFILE="$HOME/.zshrc" ;;
  bash)
    if [ -f "$HOME/.bashrc" ]; then
      PROFILE="$HOME/.bashrc"
    else
      PROFILE="$HOME/.bash_profile"
    fi
    ;;
  fish) PROFILE="$HOME/.config/fish/config.fish" ;;
  *)    PROFILE="" ;;
esac

# ---- Step 1: ensure prerequisites are present --------------------------------
need_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

# Auto-install missing tools on Linux (apt/yum/apk) if we can.
# On macOS these are always present. In Docker containers we're usually root.
install_if_missing() {
  local tool="$1"
  if need_bin "$tool"; then return 0; fi

  info "$tool not found — attempting auto-install..."
  if [ "$(id -u)" = "0" ] || command -v sudo >/dev/null 2>&1; then
    local SUDO=""
    [ "$(id -u)" != "0" ] && SUDO="sudo"

    if command -v apt-get >/dev/null 2>&1; then
      $SUDO apt-get update -qq >/dev/null 2>&1
      $SUDO apt-get install -y -qq "$tool" >/dev/null 2>&1
    elif command -v yum >/dev/null 2>&1; then
      $SUDO yum install -y -q "$tool" >/dev/null 2>&1
    elif command -v apk >/dev/null 2>&1; then
      $SUDO apk add --quiet "$tool" >/dev/null 2>&1
    fi
  fi

  if ! need_bin "$tool"; then
    die "$tool is required but not found. Install it manually: apt-get install $tool / yum install $tool / brew install $tool"
  fi
  success "$tool installed"
}

# Core requirements (always present on macOS, may need install on bare Linux)
install_if_missing curl
install_if_missing tar
install_if_missing unzip
need_bin uname || die "uname not found"

# ---- Step 2: ensure Node.js -------------------------------------------------
ensure_node() {
  if command -v node >/dev/null 2>&1; then
    NODE_V="$(node -v 2>/dev/null || echo unknown)"
    success "Node.js detected: $NODE_V"
    return 0
  fi

  info "Node.js not found — installing via fnm (Fast Node Manager)..."
  info "  fnm installs cleanly under \$HOME, no sudo, no Homebrew."

  # Install fnm via its official installer. --skip-shell so we own the profile edit.
  if [ "$VERBOSE" -eq 1 ]; then
    curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell --install-dir "$FNM_DIR"
  else
    curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell --install-dir "$FNM_DIR" >/dev/null 2>&1
  fi

  if [ ! -x "$FNM_DIR/fnm" ]; then
    die "fnm install failed. Please install Node.js manually (https://nodejs.org) and re-run this script."
  fi

  success "fnm installed at $FNM_DIR"

  # Activate fnm for this shell session
  export PATH="$FNM_DIR:$PATH"
  eval "$("$FNM_DIR/fnm" env --shell bash 2>/dev/null || "$FNM_DIR/fnm" env)"

  info "Installing Node.js ($NODE_VERSION)..."
  if [ "$VERBOSE" -eq 1 ]; then
    "$FNM_DIR/fnm" install --lts
    "$FNM_DIR/fnm" use lts-latest || "$FNM_DIR/fnm" default lts-latest
  else
    "$FNM_DIR/fnm" install --lts >/dev/null 2>&1
    "$FNM_DIR/fnm" use lts-latest >/dev/null 2>&1 || "$FNM_DIR/fnm" default lts-latest >/dev/null 2>&1
  fi

  # Re-eval to make node visible
  eval "$("$FNM_DIR/fnm" env --shell bash 2>/dev/null || "$FNM_DIR/fnm" env)"

  if ! command -v node >/dev/null 2>&1; then
    die "Node.js install via fnm failed. See https://github.com/Schniz/fnm for manual setup."
  fi

  success "Node.js installed: $(node -v)"

  # Add to shell profile so it persists across sessions
  if [ -n "$PROFILE" ]; then
    FNM_BLOCK='# prismer: fnm (node version manager)
export PATH="'"$FNM_DIR"':$PATH"
eval "$('"$FNM_DIR"'/fnm env)"'
    if [ -f "$PROFILE" ] && grep -q "# prismer: fnm" "$PROFILE" 2>/dev/null; then
      :  # already present
    else
      printf "\n%s\n" "$FNM_BLOCK" >> "$PROFILE"
      info "Added fnm init to $PROFILE"
    fi
  fi
}
ensure_node

# ---- Step 3: install Prismer packages ----------------------------------------
info "Installing ${BOLD}@prismer/sdk${RESET} and ${BOLD}@prismer/mcp-server${RESET} (v${VERSION})..."

NPM_FLAGS="-g"
if [ "$VERBOSE" -eq 0 ]; then
  NPM_FLAGS="$NPM_FLAGS --loglevel=error"
fi

if [ -n "$LOCAL_ARTIFACTS" ]; then
  # Local mode: install from tgz files (pre-publish testing).
  # npm global install resolves deps per-package from registry, so we can't
  # install aip-sdk.tgz first then sdk.tgz (sdk's ^1.8.1 dep hits registry).
  # Fix: create a temp project, install both locally (npm resolves from
  # node_modules), then symlink the CLI bin into PATH.
  info "Using local artifacts from: $LOCAL_ARTIFACTS"
  AIP_TGZ=$(ls "$LOCAL_ARTIFACTS"/prismer-aip-sdk-*.tgz 2>/dev/null | head -1)
  SDK_TGZ=$(ls "$LOCAL_ARTIFACTS"/prismer-sdk-*.tgz 2>/dev/null | head -1)
  MCP_TGZ=$(ls "$LOCAL_ARTIFACTS"/prismer-mcp-server-*.tgz 2>/dev/null | head -1)
  [ -z "$AIP_TGZ" ] && die "No prismer-aip-sdk-*.tgz found in $LOCAL_ARTIFACTS"
  [ -z "$SDK_TGZ" ] && die "No prismer-sdk-*.tgz found in $LOCAL_ARTIFACTS"

  LOCAL_INSTALL_DIR="$PRISMER_HOME/local-sdk"
  rm -rf "$LOCAL_INSTALL_DIR"
  mkdir -p "$LOCAL_INSTALL_DIR"
  cd "$LOCAL_INSTALL_DIR"
  npm init -y >/dev/null 2>&1

  # Install all tgz together — npm resolves @prismer/aip-sdk locally
  INSTALL_PKGS="$AIP_TGZ $SDK_TGZ"
  [ -n "$MCP_TGZ" ] && INSTALL_PKGS="$INSTALL_PKGS $MCP_TGZ"
  # shellcheck disable=SC2086
  npm install $INSTALL_PKGS 2>&1 || die "npm install from local tgz failed"

  # Symlink CLI bin into PATH
  PRISMER_BIN="$LOCAL_INSTALL_DIR/node_modules/.bin/prismer"
  if [ -x "$PRISMER_BIN" ]; then
    mkdir -p "$PRISMER_HOME/bin"
    ln -sf "$PRISMER_BIN" "$PRISMER_HOME/bin/prismer"
    export PATH="$PRISMER_HOME/bin:$PATH"
  fi
  cd /
else
  # Registry mode: install from npm (production)
  # shellcheck disable=SC2086
  if ! npm install $NPM_FLAGS "@prismer/sdk@^${VERSION}" "@prismer/mcp-server@^${VERSION}" 2>&1; then
    die "npm install failed. Re-run with --verbose to see details, or report at https://github.com/Prismer-AI/PrismerCloud/issues"
  fi
fi

success "Prismer packages installed"

# ---- Step 4: verify prismer binary on PATH -----------------------------------
if ! command -v prismer >/dev/null 2>&1; then
  # Check common locations: fnm global bin, local-sdk bin, npm global bin
  for CANDIDATE in \
    "$PRISMER_HOME/bin/prismer" \
    "$(npm bin -g 2>/dev/null)/prismer" \
    "$(npm root -g 2>/dev/null | sed 's|/lib/node_modules||')/bin/prismer"; do
    if [ -x "$CANDIDATE" ]; then
      export PATH="$(dirname "$CANDIDATE"):$PATH"
      break
    fi
  done
fi

if ! command -v prismer >/dev/null 2>&1; then
  warn "'prismer' command not found on PATH after install."
  warn "Try: restart your shell, or run: export PATH=\"\$(npm bin -g):\$PATH\""
  exit 1
fi

success "prismer CLI ready: $(command -v prismer)"

# ---- Step 5: run setup (optional) --------------------------------------------
if [ "$RUN_SETUP" -eq 1 ]; then
  printf "\n"
  info "Running ${BOLD}prismer setup${RESET} — will open your browser to sign in."
  if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
    printf "  %sPress Enter to continue, or Ctrl-C to skip...%s" "$DIM" "$RESET"
    read -r _ || true
  fi
  if ! prismer setup; then
    warn "prismer setup exited non-zero. You can re-run it anytime: prismer setup"
  fi
fi

# ---- Done --------------------------------------------------------------------
printf "\n"
printf "  %s🎉 Installed!%s\n\n" "$GREEN$BOLD" "$RESET"
printf "  Next steps:\n"
printf "    %sprismer status%s              # verify your API key\n" "$BOLD" "$RESET"
printf "    %sprismer load example.com%s    # first API call\n" "$BOLD" "$RESET"
printf "    %sclaude mcp add prismer -- npx -y @prismer/mcp-server%s   # wire into Claude Code\n" "$BOLD" "$RESET"
printf "\n"
printf "  Docs:      %shttps://prismer.cloud/docs%s\n" "$BLUE" "$RESET"
printf "  Discord:   %shttps://discord.gg/VP2HQHbHGn%s\n" "$BLUE" "$RESET"
printf "  Community: %shttps://prismer.cloud/community%s\n" "$BLUE" "$RESET"
printf "\n"
