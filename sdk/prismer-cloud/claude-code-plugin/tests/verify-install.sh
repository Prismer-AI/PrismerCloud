#!/bin/bash
# ============================================================================
# Prismer Plugin — 安装路径验证
# ============================================================================
#
# 验证 npm pack 产物内容正确：
#   - 必要文件全部包含
#   - 不应包含的文件被排除
#   - 版本号一致
#
# 用法: bash tests/verify-install.sh
# ============================================================================

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PLUGIN_DIR"

passed=0
failed=0

ok()   { passed=$((passed + 1)); echo "  ✓ $1"; }
fail() { failed=$((failed + 1)); echo "  ✗ $1 — $2"; }

echo ""
echo "=== Plugin Install Verification ==="
echo "Dir: $PLUGIN_DIR"
echo ""

# ── Step 1: npm pack ──
echo "--- Step 1: npm pack ---"

TARBALL=$(npm pack --pack-destination /tmp 2>/dev/null | tail -1)
TARBALL_PATH="/tmp/$TARBALL"

if [ -f "$TARBALL_PATH" ]; then
  ok "npm pack succeeded: $TARBALL"
else
  fail "npm pack" "tarball not created"
  exit 1
fi

# Get file list
FILES=$(tar tf "$TARBALL_PATH")

# ── Step 2: Required files ──
echo ""
echo "--- Step 2: Required files ---"

check_exists() {
  if echo "$FILES" | grep -q "$1"; then
    ok "$1"
  else
    fail "$1" "missing from tarball"
  fi
}

check_exists "package/hooks/hooks.json"
check_exists "package/.claude-plugin/plugin.json"

# 9 hook scripts
for script in session-start.mjs session-stop.mjs session-end.mjs \
              pre-bash-suggest.mjs pre-web-cache.mjs \
              post-bash-journal.mjs post-web-save.mjs post-tool-failure.mjs \
              subagent-start.mjs; do
  check_exists "package/scripts/$script"
done

# lib modules
for lib in logger.mjs signals.mjs resolve-config.mjs renderer.mjs html-to-markdown.mjs; do
  check_exists "package/scripts/lib/$lib"
done

# CLI
check_exists "package/scripts/cli.mjs"

# Skills (at least the core ones)
for skill in evolve-analyze evolve-create evolve-record evolve-session-review \
             community-browse community-search debug-log prismer-setup plugin-dev; do
  check_exists "package/skills/$skill/SKILL.md"
done

# ── Step 3: Excluded files ──
echo ""
echo "--- Step 3: Excluded files ---"

check_absent() {
  if echo "$FILES" | grep -q "$1"; then
    fail "Exclude $1" "should NOT be in tarball"
  else
    ok "Excluded: $1"
  fi
}

check_absent ".mcp.json"
check_absent "package/tests/"
check_absent "package/.dev-cache/"
check_absent "package/node_modules/"
check_absent "package/.git"

# ── Step 4: Version consistency ──
echo ""
echo "--- Step 4: Version check ---"

PKG_VERSION=$(node -p "require('./package.json').version")
PLUGIN_VERSION=$(node -p "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf-8')).version")

if [ "$PKG_VERSION" = "$PLUGIN_VERSION" ]; then
  ok "Version consistent: package.json=$PKG_VERSION, plugin.json=$PLUGIN_VERSION"
else
  fail "Version mismatch" "package.json=$PKG_VERSION vs plugin.json=$PLUGIN_VERSION"
fi

# ── Step 5: File count ──
echo ""
echo "--- Step 5: File count ---"

FILE_COUNT=$(echo "$FILES" | grep -v '/$' | wc -l | tr -d ' ')
if [ "$FILE_COUNT" -ge 30 ] && [ "$FILE_COUNT" -le 60 ]; then
  ok "Tarball has $FILE_COUNT files (expected 30-60)"
else
  fail "File count" "$FILE_COUNT files (expected 30-60)"
fi

# ── Cleanup ──
rm -f "$TARBALL_PATH"

# ── Summary ──
echo ""
echo "=== Results ==="
echo "  $passed passed"
[ "$failed" -gt 0 ] && echo "  $failed failed"
echo ""

exit "$failed"
