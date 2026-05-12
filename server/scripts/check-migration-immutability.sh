#!/usr/bin/env bash
# ============================================================================
# check-migration-immutability.sh — block edits to committed SQL migrations
#
# Migrations are immutable: once a file under scripts/sql/ or src/im/sql/
# has been committed to git, modifying it desyncs every env that already
# applied it. Fix forward by writing a NEW migration.
#
# This runs in pre-commit. Pure git diff — no DB access required, so works
# on any dev machine including ones that don't have docker running.
#
# Bypass (rare, only for typo fixes BEFORE first deploy): use
#   git commit --no-verify
# but immediately follow with `./scripts/db-migrate.sh status` on a fresh DB
# to confirm sha alignment.
# ============================================================================
set -euo pipefail

# Find staged modifications (status=M) to migration files. Renames (R)
# and deletions (D) are also caught.
modified=$(git diff --cached --name-only --diff-filter=MRD \
  | grep -E '^(scripts/sql/|src/im/sql/)[0-9]+_.*\.sql$' \
  || true)

if [ -z "$modified" ]; then
  exit 0
fi

printf "\033[1;31m✗ migration immutability violation\033[0m\n" >&2
echo "" >&2
echo "  These migration files are committed already and cannot be modified:" >&2
echo "$modified" | sed 's/^/    - /' >&2
echo "" >&2
echo "  Migrations are append-only. Once any environment (dev/test/prod) has" >&2
echo "  applied a migration, editing it makes that environment drift silently." >&2
echo "" >&2
echo "  Fix forward — write a NEW migration with the corrective SQL:" >&2
echo "    src/im/sql/<next-number>_<short_descriptor>.sql" >&2
echo "" >&2
echo "  Examples (already in repo):" >&2
echo "    133_v197_drop_snake_residue.sql   — undid earlier ADD COLUMN" >&2
echo "    134_v197_evolution_indexes.sql    — added missing indexes" >&2
echo "" >&2
echo "  Bypass (BEFORE first deploy only): git commit --no-verify" >&2
exit 1
