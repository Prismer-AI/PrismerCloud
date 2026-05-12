#!/bin/sh
# Prismer Cloud — zero-dependency installer
# https://prismer.cloud/install.sh
#
# Usage (SDK — default, used by app developers):
#   curl -fsSL https://prismer.cloud/install.sh | sh
#   curl -fsSL https://prismer.cloud/install.sh | sh -s -- --yes
#   curl -fsSL https://prismer.cloud/install.sh | sh -s -- --no-setup
#
# Usage (daemon — used by people running an agent host on their Mac):
#   curl -fsSL https://prismer.cloud/install.sh | sh -s -- --component=daemon
#   curl -fsSL https://prismer.cloud/install.sh | sh -s -- \
#     --component=daemon --adapters=claude-code,codex
#
# Usage (dev/staging — target version not yet on npm):
#   cd /path/to/prismercloud   # monorepo root with sdk/ tree
#   curl -fsSL http://localhost:3000/install.sh | sh -s -- --localpack
#   curl -fsSL http://localhost:3000/install.sh | sh -s -- \
#     --component=daemon --localpack
#
# What it does:
#   1. Detect OS / arch / shell
#   2. Install Node.js via fnm (only if missing)
#   3. Install Prismer packages globally:
#        --component=sdk    (default) → @prismer/sdk + @prismer/mcp-server
#        --component=daemon          → @prismer/runtime
#   4. SDK mode: run `prismer setup` (opens browser unless --no-setup)
#      Daemon mode: install runtime service + create ~/.prismer dirs
#                           + auto-install adapters listed in --adapters
#                           + run `prismer setup` to bind the runtime
#
# Everything goes under $HOME — no sudo, no /usr/local writes.
# Uninstall: rm -rf ~/.prismer ~/.local/share/fnm
# Uninstall LaunchAgent: launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.prismer.daemon.plist

set -eu

VERSION="1.9.3"
USER_SUPPLIED_PRISMER_HOME="${PRISMER_HOME:-}"
PRISMER_HOME="${PRISMER_HOME:-$HOME/.prismer}"
PRISMER_BIN_DIR="$PRISMER_HOME/bin"
FNM_DIR="${FNM_DIR:-$HOME/.local/share/fnm}"
NODE_VERSION="lts"
START_DIR="$(pwd)"
export PRISMER_HOME

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
LOCALPACK=0            # 1 = build packages from $START_DIR (monorepo root) before install
COMPONENT="sdk"        # sdk | daemon
ADAPTERS=""            # comma-separated list passed to `prismer adapter install`
SKIP_LAUNCHAGENT=0     # daemon: install runtime + dirs but skip LaunchAgent (CI / staging tests)
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes)              ASSUME_YES=1 ;;
    --no-setup)            RUN_SETUP=0 ;;
    -v|--verbose)          VERBOSE=1 ;;
    --local)               shift; LOCAL_ARTIFACTS="${1:-}" ;;
    --localpack)           LOCALPACK=1 ;;
    --component=*)         COMPONENT="${1#--component=}" ;;
    --component)           shift; COMPONENT="${1:-sdk}" ;;
    --adapters=*)          ADAPTERS="${1#--adapters=}" ;;
    --adapters)            shift; ADAPTERS="${1:-}" ;;
    --skip-launchagent)    SKIP_LAUNCHAGENT=1 ;;
    daemon)                COMPONENT="daemon" ;;   # `... | sh -s -- daemon` shorthand
    sdk)                   COMPONENT="sdk" ;;
    --version)       printf "prismer installer %s\n" "$VERSION"; exit 0 ;;
    --uninstall)
      info "Removing $PRISMER_HOME and $FNM_DIR"
      rm -rf "$PRISMER_HOME" "$FNM_DIR"
      # Best-effort LaunchAgent removal — silent if not present.
      LA_TARGET="$HOME/Library/LaunchAgents/com.prismer.daemon.plist"
      if [ -f "$LA_TARGET" ] && [ "$(uname -s)" = "Darwin" ]; then
        launchctl bootout "gui/$(id -u)" "$LA_TARGET" >/dev/null 2>&1 || true
        rm -f "$LA_TARGET"
        success "Removed LaunchAgent $LA_TARGET"
      fi
      success "Uninstalled. (Global npm packages not touched — run 'npm uninstall -g @prismer/sdk @prismer/mcp-server @prismer/runtime' yourself if needed.)"
      exit 0
      ;;
    -h|--help)
      cat <<EOF
Prismer Cloud installer v$VERSION

Usage: install.sh [options]

Components:
  --component=sdk        (default) Install @prismer/sdk + @prismer/mcp-server
  --component=daemon     Install @prismer/runtime + LaunchAgent (macOS)
  daemon                 Shorthand for --component=daemon

Options:
  -y, --yes              Non-interactive (don't prompt)
  --no-setup             Skip 'prismer setup'
  --adapters LIST        Auto-install adapters after daemon install,
                         e.g. --adapters=claude-code,codex,hermes
                         (daemon mode only)
  --skip-launchagent     daemon mode: install runtime but skip LaunchAgent
                         (CI / staged smoke tests; manual start required)
  --local <dir>          Install from local tgz artifacts (pre-publish testing)
  --localpack            Build the relevant packages from current dir
                         (must be the Prismer monorepo root) and install
                         from those local builds. Use when the target
                         version isn't on npm yet (dev/staging).
  --uninstall            Remove Prismer directories, fnm, LaunchAgent
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

# Validate component
case "$COMPONENT" in
  sdk|daemon) ;;
  *) die "unknown --component '$COMPONENT' (use 'sdk' or 'daemon')" ;;
esac

# --adapters only makes sense in daemon mode
if [ -n "$ADAPTERS" ] && [ "$COMPONENT" != "daemon" ]; then
  warn "--adapters is only meaningful with --component=daemon (ignoring)"
  ADAPTERS=""
fi

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

ensure_prismer_bin_path() {
  mkdir -p "$PRISMER_BIN_DIR"
  export PATH="$PRISMER_BIN_DIR:$PATH"

  # A piped shell cannot mutate the parent shell. For the normal install path,
  # persist the user-level bin directory so the next terminal can run `prismer`
  # directly. Explicit PRISMER_HOME=/tmp/... is treated as an isolated test and
  # must not write a temporary path into the user's shell profile.
  if [ -n "$USER_SUPPLIED_PRISMER_HOME" ]; then
    return 0
  fi
  if [ -z "$PROFILE" ]; then
    warn "Could not detect shell profile; add this to your shell rc: export PATH=\"$PRISMER_BIN_DIR:\$PATH\""
    return 0
  fi

  PRISMER_PATH_BLOCK='# prismer: cli
export PATH="'"$PRISMER_BIN_DIR"':$PATH"'
  if [ -f "$PROFILE" ] && grep -q "# prismer: cli" "$PROFILE" 2>/dev/null; then
    :
  else
    printf "\n%s\n" "$PRISMER_PATH_BLOCK" >> "$PROFILE"
    info "Added prismer CLI path to $PROFILE"
  fi
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
need_bin uname || die "uname not found"

# ---- Step 2: ensure Node.js -------------------------------------------------
ensure_node() {
  if command -v node >/dev/null 2>&1; then
    NODE_V="$(node -v 2>/dev/null || echo unknown)"
    success "Node.js detected: $NODE_V"
    return 0
  fi

  install_if_missing unzip

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
ensure_prismer_bin_path

# ---- Step 3: install Prismer packages ----------------------------------------
NPM_FLAGS="-g"
if [ "$VERBOSE" -eq 0 ]; then
  NPM_FLAGS="$NPM_FLAGS --loglevel=error"
fi

install_sdk_from_local() {
  # SDK mode: aip-sdk + sdk + mcp-server. Same logic as 1.8.1.
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

  INSTALL_PKGS="$AIP_TGZ $SDK_TGZ"
  [ -n "$MCP_TGZ" ] && INSTALL_PKGS="$INSTALL_PKGS $MCP_TGZ"
  # shellcheck disable=SC2086
  npm install $INSTALL_PKGS 2>&1 || die "npm install from local tgz failed"

  PRISMER_BIN="$LOCAL_INSTALL_DIR/node_modules/.bin/prismer"
  if [ -x "$PRISMER_BIN" ]; then
    mkdir -p "$PRISMER_BIN_DIR"
    ln -sf "$PRISMER_BIN" "$PRISMER_BIN_DIR/prismer"
    export PATH="$PRISMER_BIN_DIR:$PATH"
  fi
  cd /
}

install_daemon_from_local() {
  # Daemon mode: @prismer/runtime only. No SDK dep — runtime is self-contained
  # in 1.9.x (drift #5 Phase 2 ships a SDK→runtime integration in v5.5+).
  RT_TGZ=$(ls "$LOCAL_ARTIFACTS"/prismer-runtime-*.tgz 2>/dev/null | head -1)
  [ -z "$RT_TGZ" ] && die "No prismer-runtime-*.tgz found in $LOCAL_ARTIFACTS"

  LOCAL_INSTALL_DIR="$PRISMER_HOME/local-runtime"
  rm -rf "$LOCAL_INSTALL_DIR"
  mkdir -p "$LOCAL_INSTALL_DIR"
  cd "$LOCAL_INSTALL_DIR"
  npm init -y >/dev/null 2>&1

  npm install "$RT_TGZ" 2>&1 || die "npm install from local tgz failed"

  PRISMER_BIN="$LOCAL_INSTALL_DIR/node_modules/.bin/prismer"
  if [ -x "$PRISMER_BIN" ]; then
    mkdir -p "$PRISMER_BIN_DIR"
    ln -sf "$PRISMER_BIN" "$PRISMER_BIN_DIR/prismer"
    export PATH="$PRISMER_BIN_DIR:$PATH"
  fi
  cd /
}

# Build a single package from source: ensure node_modules → npm run build → npm pack into $3.
# Args: <pkg_dir> <label> <artifact_dir>
build_pkg_to_artifact() {
  local pkg_dir="$1"
  local label="$2"
  local artifact_dir="$3"
  local rel="${pkg_dir#$START_DIR/}"
  info "  building ${BOLD}${label}${RESET} from ${rel}"

  if [ ! -d "$pkg_dir/node_modules" ]; then
    if [ "$VERBOSE" -eq 1 ]; then
      (cd "$pkg_dir" && npm install) || die "--localpack: npm install failed in $pkg_dir"
    else
      (cd "$pkg_dir" && npm install --silent --loglevel=error >/dev/null 2>&1) || die "--localpack: npm install failed in $pkg_dir (re-run with --verbose)"
    fi
  fi

  if [ "$VERBOSE" -eq 1 ]; then
    (cd "$pkg_dir" && npm run build && npm pack --pack-destination "$artifact_dir") || die "--localpack: build/pack failed in $pkg_dir"
  else
    (cd "$pkg_dir" && npm run build >/dev/null 2>&1 && npm pack --silent --pack-destination "$artifact_dir" >/dev/null) || die "--localpack: build/pack failed in $pkg_dir (re-run with --verbose)"
  fi
}

# Build the packages needed by $1 (sdk|daemon) from $START_DIR/sdk/...
# and stage them into a fresh tempdir, then point $LOCAL_ARTIFACTS at it.
prepare_localpack_artifacts() {
  local component_name="$1"
  local AIP_SRC SDK_SRC MCP_SRC RUNTIME_SRC SRC

  if [ "$component_name" = "sdk" ]; then
    AIP_SRC="$START_DIR/sdk/aip/typescript"
    SDK_SRC="$START_DIR/sdk/prismer-cloud/typescript"
    MCP_SRC="$START_DIR/sdk/prismer-cloud/mcp"
    for SRC in "$AIP_SRC" "$SDK_SRC" "$MCP_SRC"; do
      [ -f "$SRC/package.json" ] || die "--localpack: $SRC/package.json not found. Run install.sh from the Prismer monorepo root (cd there first)."
    done
  else
    RUNTIME_SRC="$START_DIR/sdk/prismer-cloud/runtime"
    [ -f "$RUNTIME_SRC/package.json" ] || die "--localpack: $RUNTIME_SRC/package.json not found. Run install.sh from the Prismer monorepo root (cd there first)."
    grep -q '"name": "@prismer/runtime"' "$RUNTIME_SRC/package.json" 2>/dev/null \
      || die "--localpack: $RUNTIME_SRC/package.json is not @prismer/runtime."
  fi

  ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/prismer-localpack.XXXXXX")"

  if [ "$component_name" = "sdk" ]; then
    info "Building SDK packages from local source (--localpack) → $ARTIFACT_DIR"
    build_pkg_to_artifact "$AIP_SRC" "@prismer/aip-sdk"   "$ARTIFACT_DIR"
    build_pkg_to_artifact "$SDK_SRC" "@prismer/sdk"        "$ARTIFACT_DIR"
    build_pkg_to_artifact "$MCP_SRC" "@prismer/mcp-server" "$ARTIFACT_DIR"
  else
    info "Building runtime from local source (--localpack) → $ARTIFACT_DIR"
    build_pkg_to_artifact "$RUNTIME_SRC" "@prismer/runtime" "$ARTIFACT_DIR"
  fi

  LOCAL_ARTIFACTS="$ARTIFACT_DIR"
  success "Local packages built"
}

install_daemon_from_repo_source() {
  # Local dev/staging fallback: the app may serve this install.sh before
  # @prismer/runtime@VERSION is published to npm. If the user runs the curl
  # command from the monorepo root, build and pack the runtime from source.
  RUNTIME_SRC="$START_DIR/sdk/prismer-cloud/runtime"
  if [ ! -f "$RUNTIME_SRC/package.json" ]; then
    return 1
  fi
  if ! grep '"name": "@prismer/runtime"' "$RUNTIME_SRC/package.json" >/dev/null 2>&1; then
    return 1
  fi

  info "Using local runtime source fallback: $RUNTIME_SRC"
  ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/prismer-runtime-artifacts.XXXXXX")"
  (cd "$RUNTIME_SRC" && npm run build >/dev/null 2>&1 && npm pack --silent --pack-destination "$ARTIFACT_DIR" >/dev/null) || return 1
  LOCAL_ARTIFACTS="$ARTIFACT_DIR"
  install_daemon_from_local
  return 0
}

if [ "$COMPONENT" = "sdk" ]; then
  info "Installing ${BOLD}@prismer/sdk${RESET} and ${BOLD}@prismer/mcp-server${RESET} (v${VERSION})..."
  if [ -n "$LOCAL_ARTIFACTS" ]; then
    info "Using local artifacts from: $LOCAL_ARTIFACTS"
    install_sdk_from_local
  elif [ "$LOCALPACK" -eq 1 ]; then
    prepare_localpack_artifacts sdk
    install_sdk_from_local
  else
    # shellcheck disable=SC2086
    if ! npm install $NPM_FLAGS "@prismer/sdk@${VERSION}" "@prismer/mcp-server@${VERSION}" 2>&1; then
      die "npm install failed. Re-run with --verbose to see details, or report at https://github.com/Prismer-AI/PrismerCloud/issues"
    fi
  fi
else
  info "Installing ${BOLD}@prismer/runtime${RESET} (v${VERSION}) — agent host daemon..."
  if [ -n "$LOCAL_ARTIFACTS" ]; then
    info "Using local artifacts from: $LOCAL_ARTIFACTS"
    install_daemon_from_local
  elif [ "$LOCALPACK" -eq 1 ]; then
    prepare_localpack_artifacts daemon
    install_daemon_from_local
  else
    NPM_ERR="$(mktemp "${TMPDIR:-/tmp}/prismer-runtime-npm.XXXXXX")"
    # shellcheck disable=SC2086
    if ! npm install $NPM_FLAGS "@prismer/runtime@${VERSION}" >"$NPM_ERR" 2>&1; then
      warn "npm registry install failed for @prismer/runtime@${VERSION}; trying local repo fallback"
      if ! install_daemon_from_repo_source; then
        cat "$NPM_ERR" >&2
        die "npm install failed. Re-run with --verbose to see details, or pass --localpack from the Prismer monorepo root."
      fi
    fi
    rm -f "$NPM_ERR"
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

PRISMER_BIN_RESOLVED="$(command -v prismer)"
success "prismer CLI ready: $PRISMER_BIN_RESOLVED"

# ---- Step 5: post-install (branched by component) ---------------------------

install_launchagent_inline() {
  # Inlined — install.sh is curled standalone, so we can't reference
  # ./installer/install-launchagent.sh from the repo. This block mirrors
  # installer/install-launchagent.sh in tree (kept in sync manually).
  if [ "$OS_ID" != "macos" ]; then
    warn "LaunchAgent install is macOS-only (you're on $OS_ID). Skipping autostart."
    info "On Linux, run \`prismer daemon start\` manually or write a systemd unit."
    return 0
  fi

  PRISMER_BIN_PATH="$(command -v prismer 2>/dev/null || true)"
  [ -z "$PRISMER_BIN_PATH" ] && die "prismer not found on PATH after install — cannot wire LaunchAgent"

  LA_DIR="$HOME/Library/LaunchAgents"
  LA_TARGET="$LA_DIR/com.prismer.daemon.plist"
  LABEL="com.prismer.daemon"
  DOMAIN="gui/$(id -u)"

  mkdir -p "$LA_DIR"
  mkdir -p "$PRISMER_HOME/logs"

  info "Writing LaunchAgent → $LA_TARGET"
  cat > "$LA_TARGET" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
      <string>$PRISMER_BIN_PATH</string>
      <string>daemon</string>
      <string>start</string>
      <string>--foreground</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$PRISMER_HOME/logs/daemon-stdout.log</string>
    <key>StandardErrorPath</key><string>$PRISMER_HOME/logs/daemon-stderr.log</string>
    <key>WorkingDirectory</key><string>$HOME</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PRISMER_HOME</key><string>$PRISMER_HOME</string>
      <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$PRISMER_HOME/bin</string>
    </dict>
    <key>ProcessType</key><string>Background</string>
  </dict>
</plist>
PLIST

  if ! plutil -lint "$LA_TARGET" >/dev/null 2>&1; then
    die "Generated plist failed plutil -lint. Inspect $LA_TARGET manually."
  fi

  # If a previous instance is loaded, bootout first; bootstrap fails on
  # "already loaded" with a confusing 5: Input/output error.
  launchctl bootout "$DOMAIN" "$LA_TARGET" >/dev/null 2>&1 || true
  if ! launchctl bootstrap "$DOMAIN" "$LA_TARGET" 2>&1; then
    die "launchctl bootstrap failed. The plist is at $LA_TARGET — check it and try again."
  fi
  launchctl enable "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  success "LaunchAgent installed — daemon will autostart on next login and connect after setup."
}

if [ "$COMPONENT" = "sdk" ]; then
  if [ "$RUN_SETUP" -eq 1 ]; then
    printf "\n"
    info "Running ${BOLD}prismer setup${RESET} — will open your browser to sign in."
    if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
      printf "  %sPress Enter to continue, or Ctrl-C to skip...%s" "$DIM" "$RESET"
      read -r _ || true
    fi
    if ! "$PRISMER_BIN_RESOLVED" setup; then
      warn "prismer setup exited non-zero. You can re-run it anytime: PRISMER_HOME=\"$PRISMER_HOME\" \"$PRISMER_BIN_RESOLVED\" setup"
    fi
  fi
else
  # Daemon component: scaffold dirs, install LaunchAgent, optional adapters.
  info "Scaffolding $PRISMER_HOME/{adapters,workspace,logs,bin}"
  mkdir -p "$PRISMER_HOME/adapters" "$PRISMER_HOME/workspace" "$PRISMER_HOME/logs" "$PRISMER_HOME/bin"

  if [ "$SKIP_LAUNCHAGENT" -eq 1 ]; then
    info "Skipping LaunchAgent install (--skip-launchagent)"
  else
    install_launchagent_inline
  fi

  # Auto-install adapters from --adapters=... flag.
  if [ -n "$ADAPTERS" ]; then
    printf "\n"
    info "Installing adapters: $ADAPTERS"
    OLD_IFS="$IFS"
    IFS=','
    # shellcheck disable=SC2086
    set -- $ADAPTERS
    IFS="$OLD_IFS"
    for ADAPTER_NAME in "$@"; do
      [ -z "$ADAPTER_NAME" ] && continue
      info "  prismer adapter install $ADAPTER_NAME"
      if ! "$PRISMER_BIN_RESOLVED" adapter install "$ADAPTER_NAME"; then
        warn "  adapter install $ADAPTER_NAME failed — continue manually with: PRISMER_HOME=\"$PRISMER_HOME\" \"$PRISMER_BIN_RESOLVED\" adapter install $ADAPTER_NAME"
      fi
    done
  fi

  if [ "$RUN_SETUP" -eq 1 ]; then
    printf "\n"
    SETUP_START_FLAG="--no-start"
    if [ "$SKIP_LAUNCHAGENT" -eq 1 ] || [ "$OS_ID" != "macos" ]; then
      SETUP_START_FLAG="--start"
    fi
    info "Running ${BOLD}prismer setup${RESET} — will open your browser to sign in and bind this runtime."
    if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
      printf "  %sPress Enter to continue, or Ctrl-C to skip...%s" "$DIM" "$RESET"
      read -r _ || true
    fi
    # shellcheck disable=SC2086
    if ! "$PRISMER_BIN_RESOLVED" setup $SETUP_START_FLAG; then
      warn "prismer setup exited non-zero. You can re-run it anytime: PRISMER_HOME=\"$PRISMER_HOME\" \"$PRISMER_BIN_RESOLVED\" setup --start"
    fi
  fi
fi

# ---- Done --------------------------------------------------------------------
printf "\n"
printf "  %s🎉 Installed!%s\n\n" "$GREEN$BOLD" "$RESET"
if [ "$COMPONENT" = "sdk" ]; then
  printf "  Next steps:\n"
  printf "    %sprismer status%s              # verify your API key\n" "$BOLD" "$RESET"
  printf "    %sprismer load example.com%s    # first API call\n" "$BOLD" "$RESET"
  printf "    %sclaude mcp add prismer -- npx -y @prismer/mcp-server%s   # wire into Claude Code\n" "$BOLD" "$RESET"
else
  printf "  Next steps:\n"
  if [ -n "$USER_SUPPLIED_PRISMER_HOME" ]; then
    printf "    %sexport PRISMER_HOME=\"%s\"%s\n" "$BOLD" "$PRISMER_HOME" "$RESET"
    printf "    %sexport PATH=\"%s:\$PATH\"%s\n" "$BOLD" "$PRISMER_BIN_DIR" "$RESET"
  elif [ -n "$PROFILE" ]; then
    printf "    %ssource \"%s\"%s          # or open a new terminal\n" "$DIM" "$PROFILE" "$RESET"
  fi
  printf "    %sprismer setup --start%s       # bind this runtime if setup was skipped\n" "$BOLD" "$RESET"
  printf "    %sprismer status%s              # verify setup + cloud reachability\n" "$BOLD" "$RESET"
  printf "    %sprismer adapter list%s        # see installed adapters + health\n" "$BOLD" "$RESET"
  printf "\n"
  printf "  Logs:    %s$PRISMER_HOME/logs/daemon-{stdout,stderr}.log%s\n" "$DIM" "$RESET"
  printf "  Stop:    %sprismer daemon stop%s   (LaunchAgent will restart it)\n" "$DIM" "$RESET"
  printf "  Disable: %slaunchctl bootout gui/\$(id -u) ~/Library/LaunchAgents/com.prismer.daemon.plist%s\n" "$DIM" "$RESET"
fi
printf "\n"
printf "  Docs:      %shttps://prismer.cloud/docs%s\n" "$BLUE" "$RESET"
printf "  Discord:   %shttps://discord.gg/VP2HQHbHGn%s\n" "$BLUE" "$RESET"
printf "  Community: %shttps://prismer.cloud/community%s\n" "$BLUE" "$RESET"
printf "\n"
