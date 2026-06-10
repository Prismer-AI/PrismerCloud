#!/usr/bin/env bash
# ============================================================================
# db-migrate.sh — checksum-tracked SQL migration runner
#
# Industry-standard migration discipline without taking on a third-party
# tool (golang-migrate would force renaming all 75 files to *.up.sql).
#
# Tracks applied migrations in `schema_migrations` table:
#
#   CREATE TABLE schema_migrations (
#     filename   VARCHAR(255) PRIMARY KEY,
#     checksum   CHAR(64) NOT NULL,              -- sha256(file)
#     applied_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
#     applied_by VARCHAR(100) NULL
#   );
#
# Rules (enforced — exit 1 on violation):
#   - Files in `scripts/sql/` + `src/im/sql/` are migration sources.
#   - Sorted by filename within each dir; scripts/sql/ runs first.
#   - Already-applied (filename + matching sha) → skip silently.
#   - Filename matches but sha differs → ERROR (someone modified an
#     applied migration; write a NEW migration instead).
#   - New filename → apply, record sha.
#
# Subcommands:
#   up                 (default) apply all new migrations, fail on drift
#   status             list applied vs pending, no changes
#   baseline           mark all current files as applied (no SQL runs)
#                      use this ONCE when adopting tracking on a populated DB
#
# Env:
#   DB_HOST=127.0.0.1  DB_PORT=3307  DB_USER=prismer  DB_PASS=devpass
#   DB_NAME=prismer_cloud  DB_CONTAINER=prismer-dev-mysql  (if set, uses docker exec)
# ============================================================================
set -euo pipefail

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3307}"
DB_USER="${DB_USER:-prismer}"
DB_PASS="${DB_PASS:-devpass}"
DB_NAME="${DB_NAME:-prismer_cloud}"
DB_CONTAINER="${DB_CONTAINER:-prismer-dev-mysql}"

CMD="${1:-up}"

color_red="\033[1;31m"; color_green="\033[1;32m"; color_yellow="\033[1;33m"; color_dim="\033[2m"; color_reset="\033[0m"
log()     { printf "${color_dim}[db-migrate]${color_reset} %s\n" "$*"; }
log_ok()  { printf "${color_green}[db-migrate] ✓${color_reset} %s\n" "$*"; }
log_err() { printf "${color_red}[db-migrate] ✗${color_reset} %s\n" "$*" >&2; }
log_warn(){ printf "${color_yellow}[db-migrate] ⚠${color_reset} %s\n" "$*"; }

# ── DB shim — prefer docker exec on the dev container; fall back to host mysql ─
# mysql warnings (esp. "[Warning] Using a password on the command line ... is
# insecure") leak into captured query output and break checksum equality
# (`recorded != checksum` false-positive → bogus "MODIFIED migration"). Pass the
# password via MYSQL_PWD to suppress it at the source, AND strip any residual
# `[Warning]` line (any prefix) as belt-and-suspenders.
if [ -n "$DB_CONTAINER" ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$DB_CONTAINER"; then
  mysql_q() {
    docker exec -i -e MYSQL_PWD=rootdev "$DB_CONTAINER" mysql -uroot -N -s "$DB_NAME" "$@" 2>&1 | sed '/\[Warning\]/d'
  }
  mysql_apply() {
    # Apply a SQL file. Echo errors back to caller, return non-zero on fail.
    docker exec -i -e MYSQL_PWD=rootdev "$DB_CONTAINER" mysql -uroot "$DB_NAME" < "$1" 2>&1 | sed '/\[Warning\]/d'
  }
elif command -v mysql >/dev/null; then
  mysql_q() {
    MYSQL_PWD="$DB_PASS" mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -N -s "$DB_NAME" "$@" 2>&1 | sed '/\[Warning\]/d'
  }
  mysql_apply() {
    MYSQL_PWD="$DB_PASS" mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" "$DB_NAME" < "$1" 2>&1 | sed '/\[Warning\]/d'
  }
else
  log_err "neither docker ($DB_CONTAINER) nor host mysql available"
  exit 2
fi

# ── Ensure tracking table exists ────────────────────────────────────────
ensure_tracking_table() {
  mysql_q -e "
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   VARCHAR(255) NOT NULL,
      checksum   CHAR(64)     NOT NULL,
      applied_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      applied_by VARCHAR(100) NULL,
      PRIMARY KEY (filename),
      INDEX idx_applied (applied_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  " >/dev/null
}

# ── Collect migration files in apply order ─────────────────────────────
collect_migrations() {
  # scripts/sql/*.sql in their declared order (4 fixed files)
  for f in scripts/sql/010_create_pc_tables.sql \
           scripts/sql/020_create_billing_tables.sql \
           scripts/sql/030_create_pc_api_keys.sql \
           scripts/sql/040_create_pc_notifications.sql; do
    [ -f "$f" ] && echo "$f"
  done
  # src/im/sql/[0-9]*.sql sorted, skipping 002 read-only diagnostic
  for f in $(ls src/im/sql/[0-9]*.sql 2>/dev/null | sort); do
    case "$(basename "$f")" in
      002_*) continue ;;
    esac
    echo "$f"
  done
}

file_sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

# ── Commands ────────────────────────────────────────────────────────────
cmd_baseline() {
  ensure_tracking_table
  log "BASELINE: marking all current migration files as already-applied"
  log "  (use ONCE on a populated DB to adopt tracking; subsequent runs use 'up')"
  local count=0
  for f in $(collect_migrations); do
    local filename checksum
    filename="$(basename "$f")"
    checksum="$(file_sha256 "$f")"
    mysql_q -e "
      INSERT INTO schema_migrations (filename, checksum, applied_by)
      VALUES ('$filename', '$checksum', 'baseline')
      ON DUPLICATE KEY UPDATE checksum=VALUES(checksum), applied_at=applied_at;
    " >/dev/null
    count=$((count + 1))
  done
  log_ok "baselined $count files"
}

cmd_status() {
  ensure_tracking_table
  local applied pending modified
  applied=0; pending=0; modified=0
  printf "  %-50s  %s\n" "FILENAME" "STATUS"
  for f in $(collect_migrations); do
    local filename checksum recorded
    filename="$(basename "$f")"
    checksum="$(file_sha256 "$f")"
    recorded="$(mysql_q -e "SELECT checksum FROM schema_migrations WHERE filename='$filename';" || true)"
    if [ -z "$recorded" ]; then
      printf "  %-50s  ${color_yellow}pending${color_reset}\n" "$filename"
      pending=$((pending + 1))
    elif [ "$recorded" != "$checksum" ]; then
      printf "  %-50s  ${color_red}MODIFIED${color_reset} (applied=%s… current=%s…)\n" \
        "$filename" "${recorded:0:8}" "${checksum:0:8}"
      modified=$((modified + 1))
    else
      applied=$((applied + 1))
    fi
  done
  echo
  log "applied=$applied  pending=$pending  modified=$modified"
  [ "$modified" -gt 0 ] && return 1 || return 0
}

cmd_up() {
  ensure_tracking_table
  local applied=0 skipped=0 failed=0 modified=0
  for f in $(collect_migrations); do
    local filename checksum recorded
    filename="$(basename "$f")"
    checksum="$(file_sha256 "$f")"
    recorded="$(mysql_q -e "SELECT checksum FROM schema_migrations WHERE filename='$filename';" || true)"

    if [ -n "$recorded" ] && [ "$recorded" = "$checksum" ]; then
      skipped=$((skipped + 1))
      continue
    fi

    if [ -n "$recorded" ] && [ "$recorded" != "$checksum" ]; then
      # Sentinel: a fix-forward migration (e.g. 420_fix_418_drift.sql,
      # 424_v200_rebaseline_420.sql) may rebaseline an earlier row by
      # writing a sentinel like `__rebaselined_by_NNN__`. Recognise any
      # value matching that prefix pattern so future fix-forwards don't
      # require re-touching this script.
      if [[ "$recorded" =~ ^__rebaselined_by_[0-9]+__$ ]]; then
        log "skipping sha check for $filename (rebaselined via $recorded)"
        # Refresh the recorded checksum to the actual file sha so subsequent
        # runs don't keep hitting this branch.
        mysql_q -e "UPDATE schema_migrations SET checksum='$checksum' WHERE filename='$filename';" >/dev/null
        skipped=$((skipped + 1))
        continue
      fi
      log_err "MODIFIED migration: $filename"
      log_err "  applied sha: $recorded"
      log_err "  current sha: $checksum"
      log_err "  Migrations are immutable once applied. Fix forward by writing"
      log_err "  a NEW migration (e.g. 200_fix_${filename%.sql}.sql)."
      modified=$((modified + 1))
      failed=$((failed + 1))
      continue
    fi

    # New migration — apply
    log "applying $filename ..."
    if err=$(mysql_apply "$f" 2>&1); then
      if echo "$err" | grep -qE '^ERROR [0-9]+'; then
        log_err "$filename failed:"
        echo "$err" | grep -E '^ERROR [0-9]+' | head -3 >&2
        failed=$((failed + 1))
        continue
      fi
      mysql_q -e "
        INSERT INTO schema_migrations (filename, checksum, applied_by)
        VALUES ('$filename', '$checksum', 'dev-migrate');
      " >/dev/null
      log_ok "applied $filename"
      applied=$((applied + 1))
    else
      log_err "$filename apply failed"
      echo "$err" | head -5 >&2
      failed=$((failed + 1))
    fi
  done

  echo
  log "summary: applied=$applied skipped=$skipped failed=$failed modified=$modified"
  if [ "$modified" -gt 0 ]; then
    log_err "$modified migration(s) were modified after apply — see above"
    return 1
  fi
  if [ "$failed" -gt 0 ]; then
    log_err "$failed migration(s) failed"
    return 1
  fi
  return 0
}

case "$CMD" in
  up)       cmd_up ;;
  status)   cmd_status ;;
  baseline) cmd_baseline ;;
  *)
    cat <<USAGE
Usage: $0 {up|status|baseline}

  up        — apply all pending migrations, fail on checksum mismatch  (default)
  status    — list applied / pending / modified (read-only)
  baseline  — mark every current migration file as already-applied (use ONCE)

Files: scripts/sql/0{10,20,30,40}_*.sql then src/im/sql/[0-9]*.sql (sorted)
USAGE
    exit 1
    ;;
esac
