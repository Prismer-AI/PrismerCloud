#!/bin/bash
# ==============================================================================
# Prismer IM Server - MySQL 迁移脚本
# ==============================================================================
#
# 使用方式:
#   ./run-migration.sh create   # 创建表
#   ./run-migration.sh verify   # 验证表
#   ./run-migration.sh all      # 创建 + 验证
#
# 环境变量 (可选，也可通过命令行参数传入):
#   MYSQL_HOST     - MySQL 主机
#   MYSQL_PORT     - MySQL 端口 (默认 3306)
#   MYSQL_USER     - MySQL 用户
#   MYSQL_PASSWORD - MySQL 密码
#   MYSQL_DATABASE - 数据库名
#
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 打印带颜色的消息
info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 显示帮助
show_help() {
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  create    创建 IM Server 表 (im_* 前缀)"
    echo "  verify    验证表结构"
    echo "  all       创建 + 验证"
    echo ""
    echo "Options:"
    echo "  -h, --host      MySQL 主机 (或设置 MYSQL_HOST)"
    echo "  -P, --port      MySQL 端口 (默认 3306)"
    echo "  -u, --user      MySQL 用户 (或设置 MYSQL_USER)"
    echo "  -p, --password  MySQL 密码 (或设置 MYSQL_PASSWORD)"
    echo "  -d, --database  数据库名 (或设置 MYSQL_DATABASE)"
    echo ""
    echo "示例:"
    echo "  $0 create -h localhost -u root -p secret -d prismer_cloud"
    echo "  MYSQL_HOST=localhost MYSQL_USER=root $0 verify"
    echo ""
}

# 解析参数
COMMAND=""
while [[ $# -gt 0 ]]; do
    case $1 in
        create|verify|all)
            COMMAND=$1
            shift
            ;;
        -h|--host)
            MYSQL_HOST="$2"
            shift 2
            ;;
        -P|--port)
            MYSQL_PORT="$2"
            shift 2
            ;;
        -u|--user)
            MYSQL_USER="$2"
            shift 2
            ;;
        -p|--password)
            MYSQL_PASSWORD="$2"
            shift 2
            ;;
        -d|--database)
            MYSQL_DATABASE="$2"
            shift 2
            ;;
        --help)
            show_help
            exit 0
            ;;
        *)
            error "未知参数: $1"
            show_help
            exit 1
            ;;
    esac
done

# 检查命令
if [ -z "$COMMAND" ]; then
    error "请指定命令: create, verify, 或 all"
    show_help
    exit 1
fi

# 检查必要参数
MYSQL_PORT=${MYSQL_PORT:-3306}

if [ -z "$MYSQL_HOST" ]; then
    error "请设置 MYSQL_HOST 或使用 -h 参数"
    exit 1
fi

if [ -z "$MYSQL_USER" ]; then
    error "请设置 MYSQL_USER 或使用 -u 参数"
    exit 1
fi

if [ -z "$MYSQL_DATABASE" ]; then
    error "请设置 MYSQL_DATABASE 或使用 -d 参数"
    exit 1
fi

# 构建 MySQL 命令
MYSQL_CMD="mysql -h $MYSQL_HOST -P $MYSQL_PORT -u $MYSQL_USER"
if [ -n "$MYSQL_PASSWORD" ]; then
    MYSQL_CMD="$MYSQL_CMD -p$MYSQL_PASSWORD"
fi
MYSQL_CMD="$MYSQL_CMD $MYSQL_DATABASE"

# 执行创建
do_create() {
    info "开始创建 IM Server 表..."
    info "数据库: $MYSQL_HOST:$MYSQL_PORT/$MYSQL_DATABASE"
    echo ""

    if $MYSQL_CMD < "$SCRIPT_DIR/001_create_tables.sql"; then
        info "表创建成功!"
    else
        error "表创建失败!"
        exit 1
    fi
}

# 执行验证
do_verify() {
    info "开始验证 IM Server 表..."
    info "数据库: $MYSQL_HOST:$MYSQL_PORT/$MYSQL_DATABASE"
    echo ""

    if $MYSQL_CMD < "$SCRIPT_DIR/002_verify_tables.sql"; then
        info "表验证完成!"
    else
        error "表验证失败!"
        exit 1
    fi
}

# 执行命令
case $COMMAND in
    create)
        do_create
        ;;
    verify)
        do_verify
        ;;
    all)
        do_create
        echo ""
        do_verify
        ;;
esac

echo ""
info "完成!"
