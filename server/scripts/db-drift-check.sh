#!/usr/bin/env bash
# ============================================================================
# db-drift-check.sh — DB ⇄ Prisma schema 漂移闸门
#
# 跑 `prisma migrate diff` 把活 DB 跟 Prisma schema 比对，过滤掉已知 cosmetic
# 差异（TEXT defaults、updatedAt ON UPDATE、FK 约束、FULLTEXT 索引、pc_*
# 表、索引命名差异等 by-design 的），只对**真漂移**报警：
#
#   FAIL (exit 1, blocking)：
#     - ADD COLUMN   (Prisma 有但 DB 没)
#     - DROP COLUMN  (DB 有但 Prisma 没 — 通常是 migration bug 留下死列)
#     - CREATE TABLE (Prisma 有但 DB 没)
#     - DROP TABLE   (DB 有但 Prisma 没，且不是 pc_* 前端先行表)
#
#   WARN (exit 0, 不 blocking)：
#     - CreateIndex / DropIndex 真改动 (性能影响而非正确性)
#
# 由 dev-stack.sh cmd_up 末尾调用；也可独立 `npm run db:check`。
#
# Env knobs:
#   DATABASE_URL          连接串，默认 mysql://prismer:devpass@127.0.0.1:3307/prismer_cloud
#   DRIFT_STRICT_INDEX=1  把 index drift 也升级成 blocking
#   DRIFT_VERBOSE=1       打印完整 diff
# ============================================================================
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-mysql://prismer:devpass@127.0.0.1:3307/prismer_cloud}"
SCHEMA_PATH="${SCHEMA_PATH:-prisma/schema.mysql.prisma}"

DRIFT_FILE="$(mktemp -t prisma-drift.XXXXXX)"
trap 'rm -f "$DRIFT_FILE"' EXIT

if [ ! -f "$SCHEMA_PATH" ]; then
  echo "[db-drift] ✗ schema not found: $SCHEMA_PATH" >&2
  exit 1
fi

if ! npx --yes prisma migrate diff \
       --from-url "$DATABASE_URL" \
       --to-schema-datamodel "$SCHEMA_PATH" \
       --script > "$DRIFT_FILE" 2>/dev/null; then
  echo "[db-drift] ✗ prisma migrate diff failed (DB unreachable? schema invalid?)" >&2
  exit 2
fi

# Counts — note grep -c on empty match returns 0 but exits 1 under set -e,
# so wrap with `|| true`.
add_col=$(grep -c "ADD COLUMN"  "$DRIFT_FILE" || true)
drop_col=$(grep -c "DROP COLUMN" "$DRIFT_FILE" || true)
create_table=$(grep -c "^-- CreateTable" "$DRIFT_FILE" || true)
# DROP TABLE excluding by-design out-of-Prisma tables:
#   pc_*               — frontend-first, managed by Next.js raw SQL (CLAUDE.md)
#   schema_migrations  — our migration tracking table (scripts/db-migrate.sh)
drop_table_real=$(grep "^DROP TABLE" "$DRIFT_FILE" \
  | grep -vE '`(pc_|schema_migrations)' | wc -l | tr -d ' ' || true)
create_index=$(grep -c "^-- CreateIndex" "$DRIFT_FILE" || true)
drop_index=$(grep -c "^-- DropIndex" "$DRIFT_FILE" || true)

real_drift=$((add_col + drop_col + create_table + drop_table_real))

# ── Report ───────────────────────────────────────────────────────────────
if [ "$real_drift" -eq 0 ]; then
  echo "[db-drift] ✓ no real drift (column/table aligned)"
else
  echo "[db-drift] ✗ FOUND $real_drift real drift item(s):"
  [ "$add_col"        -gt 0 ] && echo "    + $add_col ADD COLUMN   (Prisma expects, DB missing)"
  [ "$drop_col"       -gt 0 ] && echo "    + $drop_col DROP COLUMN  (DB has, Prisma missing — likely migration bug)"
  [ "$create_table"   -gt 0 ] && echo "    + $create_table CREATE TABLE (missing from DB)"
  [ "$drop_table_real" -gt 0 ] && echo "    + $drop_table_real DROP TABLE  (DB has, Prisma missing, non-pc_*)"
  echo
  echo "[db-drift] offending statements:"
  grep -E "(ADD COLUMN|DROP COLUMN|^CREATE TABLE|^DROP TABLE)" "$DRIFT_FILE" \
    | grep -vE '`(pc_|schema_migrations)' \
    | sed 's/^/    /' \
    | head -30
  echo
  echo "[db-drift] remediation:"
  echo "    - If a recent SQL migration added cols Prisma doesn't know about:"
  echo "        update prisma/schema.mysql.prisma to declare them"
  echo "    - If Prisma model has cols DB lacks: write a new"
  echo "        src/im/sql/<NNN>_<descriptor>.sql ALTER TABLE ... ADD COLUMN"
  echo "    - If a migration left snake_case residue (017-style bug):"
  echo "        add a drop_column_if_exists migration (see 133_v197_drop_snake_residue.sql)"
fi

# ── Index drift (informational unless DRIFT_STRICT_INDEX=1) ──────────────
index_changes=$((create_index + drop_index))
if [ "$index_changes" -gt 0 ]; then
  echo
  echo "[db-drift] ℹ  $create_index CreateIndex / $drop_index DropIndex (most are cosmetic: FK / FULLTEXT / name renames)"
  if [ "${DRIFT_VERBOSE:-0}" = "1" ]; then
    grep -E "^(CREATE.*INDEX|DROP INDEX)" "$DRIFT_FILE" | sed 's/^/    /'
  else
    echo "    (set DRIFT_VERBOSE=1 to list)"
  fi
  if [ "${DRIFT_STRICT_INDEX:-0}" = "1" ]; then
    echo "[db-drift] ✗ DRIFT_STRICT_INDEX=1 → treating index drift as blocking"
    exit 1
  fi
fi

# ── Exit ─────────────────────────────────────────────────────────────────
if [ "$real_drift" -gt 0 ]; then
  exit 1
fi
exit 0
