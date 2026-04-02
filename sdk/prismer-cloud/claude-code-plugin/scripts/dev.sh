#!/bin/bash
# ============================================================================
# Prismer Plugin — 本地开发模式
# ============================================================================
#
# 用法:
#   ./scripts/dev.sh              # 启动 Claude Code，加载本地插件
#   ./scripts/dev.sh --resume     # 恢复上次会话
#
# 工作原理:
#   使用 claude --plugin-dir 直接从文件系统加载插件，
#   跳过 npm install 流程。修改 hook 后 /clear 即可生效。
#
# 开发循环:
#   1. 编辑 scripts/*.mjs
#   2. 在 Claude Code 中输入 /clear
#   3. 新代码立即生效（无需卸载/安装）
#
# 日志:
#   tail -f .dev-cache/prismer-debug.log
#
# ============================================================================

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEV_CACHE="${PLUGIN_DIR}/.dev-cache"

mkdir -p "$DEV_CACHE"

echo "┌─────────────────────────────────────────────┐"
echo "│  Prismer Plugin — Dev Mode                  │"
echo "├─────────────────────────────────────────────┤"
echo "│  Plugin:  ${PLUGIN_DIR}                     │"
echo "│  Cache:   ${DEV_CACHE}                      │"
echo "│  修改 hook 后 /clear 即可生效               │"
echo "│  日志: tail -f .dev-cache/prismer-debug.log │"
echo "└─────────────────────────────────────────────┘"

# 使用独立 cache 避免污染生产环境
export CLAUDE_PLUGIN_DATA="$DEV_CACHE"

# 启用 debug 日志级别
export PRISMER_LOG_LEVEL="${PRISMER_LOG_LEVEL:-debug}"

exec claude --plugin-dir "$PLUGIN_DIR" "$@"
