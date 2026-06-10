#!/usr/bin/env bash
# sync-server.sh — closed-source prismercloud → server/ sync (3-way, scrub-gated)
#
# Model: for every path, compare blob SHAs of
#   ours   = server/<path> in this repo        (self-host adaptations)
#   base   = <path> at the last-synced ref      (recorded in LAST-SYNC.md)
#   theirs = <path> at the requested source ref
# and classify:
#   ours==base            → take theirs verbatim
#   base==theirs          → keep ours (self-host adaptation preserved)
#   all three differ      → git merge-file 3-way; conflicts go to state/conflicts/
#   gone upstream         → delete (conflict if ours was self-host-modified)
#   new upstream          → import iff whitelist.txt matches and blacklist.txt doesn't
# blacklist.txt paths are never touched in either direction.
# Staged results matching content-scrub.txt block apply until fixed.
#
# Usage:
#   sync-server.sh plan  --source-ref <ref> [--base-ref <ref>] [--source-repo <path>]
#   sync-server.sh apply [--force-scrub]
#   sync-server.sh status
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPEN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVER_DIR="$OPEN_ROOT/server"
STATE_DIR="$SCRIPT_DIR/state"
STAGE_DIR="$STATE_DIR/stage"
CONFLICT_DIR="$STATE_DIR/conflicts"
PLAN_FILE="$STATE_DIR/plan.tsv"
META_FILE="$STATE_DIR/meta.env"
SCRUB_REPORT="$STATE_DIR/scrub-report.txt"
SCRUB_PATTERNS="$STATE_DIR/scrub-patterns.txt"
SKIPPED_FILE="$STATE_DIR/skipped-new-files.txt"
LAST_SYNC_FILE="$SCRIPT_DIR/LAST-SYNC.md"
PATCH_DIR="$SCRIPT_DIR/patches"

log()  { printf '\033[1;34m[sync-server]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[sync-server][warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[sync-server][error]\033[0m %s\n' "$*" >&2; exit 1; }

# ── list matching (whitelist/blacklist) ─────────────────────────────
# trailing '/' = recursive dir prefix; '*' anywhere = shell glob; else exact
declare -a WHITELIST_RULES BLACKLIST_RULES
load_rules() { # $1=listfile $2=array-name
  local -n out="$2"
  out=()
  local line
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    out+=("$line")
  done < "$1"
}

matches_rules() { # $1=path $2=array-name
  local path="$1"
  local -n rules="$2"
  local line
  for line in "${rules[@]}"; do
    if [[ "$line" == */ ]]; then
      [[ "$path" == "$line"* ]] && return 0
    elif [[ "$line" == *\** ]]; then
      # glob: '*' must not cross '/' — require equal directory depth
      local pdepth="${path//[^\/]/}" rdepth="${line//[^\/]/}"
      if [[ "${#pdepth}" -eq "${#rdepth}" ]]; then
        # shellcheck disable=SC2254
        case "$path" in $line) return 0;; esac
      fi
    else
      [[ "$path" == "$line" ]] && return 0
    fi
  done
  return 1
}

build_scrub_patterns() {
  grep -vE '^\s*(#|$)' "$SCRIPT_DIR/content-scrub.txt" > "$SCRUB_PATTERNS"
}

scrub_scan() { # $1=dir → matches on stdout
  [[ -d "$1" ]] || return 0
  ( cd "$1" && grep -rnIE -f "$SCRUB_PATTERNS" . 2>/dev/null ) || true
}

blob_is_binary() { # $1=repo $2=sha
  # NUL byte in the first 8000 bytes ⇒ binary. NUL can't be passed as a grep
  # pattern argument, so inspect a hex dump instead; pipefail is suspended so
  # an early-exiting grep (SIGPIPE upstream) can't poison the result.
  local rc=0
  set +o pipefail
  git -C "$1" cat-file blob "$2" 2>/dev/null | head -c 8000 | od -An -tx1 | grep -q ' 00' || rc=$?
  set -o pipefail
  return $rc
}

stage_blob() { # $1=sha $2=path $3=mode
  local out="$STAGE_DIR/$2"
  mkdir -p "$(dirname "$out")"
  git -C "$SOURCE_REPO" cat-file blob "$1" > "$out"
  if [[ "$3" == "100755" ]]; then chmod +x "$out"; fi
}

commit_type() { # $1=path
  case "$1" in
    docs/*|*.md) echo docs;;
    .github/*|.devcontainer/*|.husky/*|Dockerfile|docker*|.gitlab-ci.yml) echo ci;;
    *) echo feat;;
  esac
}

# ── plan ────────────────────────────────────────────────────────────
cmd_plan() {
  local SOURCE_REF="" BASE_REF="" SOURCE_REPO_ARG=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --source-ref)  SOURCE_REF="$2"; shift 2;;
      --base-ref)    BASE_REF="$2"; shift 2;;
      --source-repo) SOURCE_REPO_ARG="$2"; shift 2;;
      *) die "unknown plan flag: $1";;
    esac
  done
  SOURCE_REPO="${SOURCE_REPO_ARG:-$SOURCE_REPO}"
  [[ -d "$SOURCE_REPO/.git" ]] || die "source repo not found: $SOURCE_REPO"
  [[ -n "$SOURCE_REF" ]] || die "--source-ref is required"
  if [[ -z "$BASE_REF" ]]; then
    BASE_REF="$(sed -n 's/^- upstream-sha: //p' "$LAST_SYNC_FILE" 2>/dev/null | head -1 || true)"
    [[ -n "$BASE_REF" ]] || die "--base-ref not given and no LAST-SYNC.md record found"
    log "base ref from LAST-SYNC.md: $BASE_REF"
  fi

  local SRC_SHA BASE_SHA VERSION
  SRC_SHA="$(git -C "$SOURCE_REPO" rev-parse --verify "$SOURCE_REF^{commit}")"
  BASE_SHA="$(git -C "$SOURCE_REPO" rev-parse --verify "$BASE_REF^{commit}")"
  VERSION="$(git -C "$SOURCE_REPO" show "$SRC_SHA:VERSION" 2>/dev/null | tr -d '[:space:]' || true)"
  [[ -n "$VERSION" ]] || VERSION="unknown"

  rm -rf "$STAGE_DIR" "$CONFLICT_DIR"
  mkdir -p "$STAGE_DIR" "$CONFLICT_DIR" "$STATE_DIR"
  : > "$PLAN_FILE"; : > "$SKIPPED_FILE"; : > "$SCRUB_REPORT"
  load_rules "$SCRIPT_DIR/whitelist.txt" WHITELIST_RULES
  load_rules "$SCRIPT_DIR/blacklist.txt" BLACKLIST_RULES
  build_scrub_patterns

  log "source: $SOURCE_REPO @ $SOURCE_REF ($SRC_SHA, VERSION=$VERSION)"
  log "base:   $BASE_REF ($BASE_SHA)"

  # load sha maps (NUL-safe)
  declare -A OURS BASE THEIRS TMODE
  local rec rest mode type sha path
  while IFS= read -r -d '' rec; do
    # "<mode> <sha> <stage>\t<path>"
    path="${rec#*$'\t'}"; rest="${rec%%$'\t'*}"
    read -r mode sha _ <<< "$rest"
    [[ "$path" == server/* ]] || continue
    OURS["${path#server/}"]="$sha"
  done < <(git -C "$OPEN_ROOT" ls-files -s -z -- server)

  while IFS= read -r -d '' rec; do
    # "<mode> <type> <sha>\t<path>"
    path="${rec#*$'\t'}"; rest="${rec%%$'\t'*}"
    read -r mode type sha <<< "$rest"
    [[ "$type" == blob ]] || continue
    BASE["$path"]="$sha"
  done < <(git -C "$SOURCE_REPO" ls-tree -r -z "$BASE_SHA")

  while IFS= read -r -d '' rec; do
    path="${rec#*$'\t'}"; rest="${rec%%$'\t'*}"
    read -r mode type sha <<< "$rest"
    [[ "$type" == blob ]] || continue
    THEIRS["$path"]="$sha"; TMODE["$path"]="$mode"
  done < <(git -C "$SOURCE_REPO" ls-tree -r -z "$SRC_SHA")

  local union
  union="$(printf '%s\n' "${!OURS[@]}" "${!BASE[@]}" "${!THEIRS[@]}" | sort -u)"

  local n_add=0 n_take=0 n_merge=0 n_conflict=0 n_del=0 n_delc=0 n_keep=0 n_skip=0
  local o b t tmp_base tmp_theirs tmp_merged rc
  tmp_base="$(mktemp)"; tmp_theirs="$(mktemp)"; tmp_merged="$(mktemp)"
  trap 'rm -f "$tmp_base" "$tmp_theirs" "$tmp_merged"' RETURN

  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    o="${OURS[$path]:-}"; b="${BASE[$path]:-}"; t="${THEIRS[$path]:-}"

    # never touch blacklisted paths
    if matches_rules "$path" BLACKLIST_RULES; then continue; fi

    if [[ -n "$o" && -n "$t" ]]; then
      [[ "$o" == "$t" ]] && continue                       # already identical
      if [[ -n "$b" && "$b" == "$t" ]]; then               # upstream unchanged → keep ours
        n_keep=$((n_keep+1)); continue
      fi
      if [[ -z "$b" ]]; then                               # add-add: both sides created it
        mkdir -p "$(dirname "$CONFLICT_DIR/$path")"
        git -C "$SOURCE_REPO" cat-file blob "$t" > "$CONFLICT_DIR/$path.theirs"
        printf 'conflict\t%s\n' "$path" >> "$PLAN_FILE"; n_conflict=$((n_conflict+1)); continue
      fi
      if [[ "$o" == "$b" ]]; then                          # we never adapted it
        stage_blob "$t" "$path" "${TMODE[$path]:-100644}"
        printf 'take-theirs\t%s\n' "$path" >> "$PLAN_FILE"; n_take=$((n_take+1)); continue
      fi
      # all three differ → 3-way
      if blob_is_binary "$SOURCE_REPO" "$t" || blob_is_binary "$SOURCE_REPO" "$b"; then
        mkdir -p "$(dirname "$CONFLICT_DIR/$path")"
        git -C "$SOURCE_REPO" cat-file blob "$t" > "$CONFLICT_DIR/$path.theirs"
        printf 'conflict\t%s\n' "$path" >> "$PLAN_FILE"; n_conflict=$((n_conflict+1)); continue
      fi
      git -C "$SOURCE_REPO" cat-file blob "$b" > "$tmp_base"
      git -C "$SOURCE_REPO" cat-file blob "$t" > "$tmp_theirs"
      rc=0
      git merge-file -p \
        -L "self-host (server/$path)" -L "base $BASE_REF" -L "upstream $SOURCE_REF" \
        "$SERVER_DIR/$path" "$tmp_base" "$tmp_theirs" > "$tmp_merged" || rc=$?
      if [[ $rc -eq 0 ]]; then
        mkdir -p "$(dirname "$STAGE_DIR/$path")"
        cp "$tmp_merged" "$STAGE_DIR/$path"
        if [[ "${TMODE[$path]:-}" == "100755" ]]; then chmod +x "$STAGE_DIR/$path"; fi
        printf 'merge\t%s\n' "$path" >> "$PLAN_FILE"; n_merge=$((n_merge+1))
      else
        mkdir -p "$(dirname "$CONFLICT_DIR/$path")"
        cp "$tmp_merged" "$CONFLICT_DIR/$path"
        printf 'conflict\t%s\n' "$path" >> "$PLAN_FILE"; n_conflict=$((n_conflict+1))
      fi
      continue
    fi

    if [[ -n "$o" && -z "$t" ]]; then
      [[ -z "$b" ]] && continue                            # self-host-only file → keep
      if [[ "$o" == "$b" ]]; then
        printf 'delete\t%s\n' "$path" >> "$PLAN_FILE"; n_del=$((n_del+1))
      else
        printf 'delete-conflict\t%s\n' "$path" >> "$PLAN_FILE"; n_delc=$((n_delc+1))
      fi
      continue
    fi

    if [[ -z "$o" && -n "$t" ]]; then
      [[ -n "$b" ]] && continue                            # previously excluded → stays excluded
      if matches_rules "$path" WHITELIST_RULES; then
        stage_blob "$t" "$path" "${TMODE[$path]:-100644}"
        printf 'add\t%s\n' "$path" >> "$PLAN_FILE"; n_add=$((n_add+1))
      else
        printf '%s\n' "$path" >> "$SKIPPED_FILE"; n_skip=$((n_skip+1))
      fi
      continue
    fi
  done <<< "$union"

  scrub_scan "$STAGE_DIR"    >  "$SCRUB_REPORT"
  scrub_scan "$CONFLICT_DIR" >> "$SCRUB_REPORT"

  cat > "$META_FILE" <<EOF
SOURCE_REPO=$SOURCE_REPO
SOURCE_REF=$SOURCE_REF
SRC_SHA=$SRC_SHA
BASE_REF=$BASE_REF
BASE_SHA=$BASE_SHA
VERSION=$VERSION
EOF

  log "plan complete:"
  log "  take-theirs : $n_take"
  log "  3-way merge : $n_merge clean, $n_conflict conflicts (state/conflicts/)"
  log "  new files   : $n_add added, $n_skip skipped by whitelist (state/skipped-new-files.txt)"
  log "  deletes     : $n_del clean, $n_delc need manual decision (delete-conflict)"
  log "  keep-ours   : $n_keep (upstream unchanged vs base)"
  if [[ -s "$SCRUB_REPORT" ]]; then
    warn "SCRUB HITS: $(wc -l < "$SCRUB_REPORT") line(s) — see state/scrub-report.txt; apply will refuse"
  else
    log "scrub scan clean"
  fi
}

# ── apply ───────────────────────────────────────────────────────────
cmd_apply() {
  local FORCE_SCRUB=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force-scrub) FORCE_SCRUB=1; shift;;
      *) die "unknown apply flag: $1";;
    esac
  done
  [[ -f "$PLAN_FILE" && -f "$META_FILE" ]] || die "no plan found — run 'sync-server.sh plan' first"
  # shellcheck disable=SC1090
  source "$META_FILE"
  build_scrub_patterns

  # every conflict must have a resolved copy in stage/
  local action path missing=0
  while IFS=$'\t' read -r action path; do
    case "$action" in
      conflict)
        if [[ ! -f "$STAGE_DIR/$path" ]]; then
          warn "unresolved conflict: $path (resolve into state/stage/$path)"; missing=1
        fi;;
      delete-conflict)
        if [[ ! -f "$STAGE_DIR/$path" ]]; then
          warn "delete-conflict pending: $path — resolve into state/stage/$path (modify) or edit action to 'delete' in plan.tsv"
          missing=1
        fi;;
    esac
  done < "$PLAN_FILE"
  [[ $missing -eq 0 ]] || die "unresolved conflicts remain"

  if grep -rn '^<<<<<<< ' "$STAGE_DIR" >/dev/null 2>&1; then
    die "conflict markers found in state/stage/ — finish resolving first"
  fi

  # authoritative scrub re-scan of staged content
  scrub_scan "$STAGE_DIR" > "$SCRUB_REPORT"
  if [[ -s "$SCRUB_REPORT" ]]; then
    if [[ $FORCE_SCRUB -eq 1 ]]; then
      warn "scrub hits present but --force-scrub given ($(wc -l < "$SCRUB_REPORT") lines)"
    else
      die "scrub hits in staged content — fix them or re-run with --force-scrub (see state/scrub-report.txt)"
    fi
  fi

  if [[ -n "$(git -C "$OPEN_ROOT" status --porcelain -- server)" ]]; then
    die "server/ has uncommitted changes — commit or stash first"
  fi
  local branch
  branch="$(git -C "$OPEN_ROOT" rev-parse --abbrev-ref HEAD)"
  [[ "$branch" == "main" ]] && die "refusing to apply directly on main — create a sync branch first"

  # ordered patch list: adds, then modifies, then deletes (each sorted by path)
  local -a adds=() mods=() dels=()
  while IFS=$'\t' read -r action path; do
    case "$action" in
      add) adds+=("$path");;
      take-theirs|merge|conflict) mods+=("$path");;
      delete) dels+=("$path");;
      delete-conflict) if [[ -f "$STAGE_DIR/$path" ]]; then mods+=("$path"); else dels+=("$path"); fi;;
    esac
  done < <(sort -t$'\t' -k2 "$PLAN_FILE")

  local total=$(( ${#adds[@]} + ${#mods[@]} + ${#dels[@]} ))
  [[ $total -gt 0 ]] || die "plan is empty — nothing to apply"
  log "applying $total patches on branch $branch (adds=${#adds[@]} modifies=${#mods[@]} deletes=${#dels[@]})"

  local start_sha n=0 author subject ctype
  start_sha="$(git -C "$OPEN_ROOT" rev-parse HEAD)"

  emit_patch() { # $1=verb $2=path
    local verb="$1" path="$2"
    n=$((n+1))
    ctype="$(commit_type "$path")"
    author="$(git -C "$SOURCE_REPO" log -1 --format='%an <%ae>' "$SRC_SHA" -- "$path" 2>/dev/null || true)"
    if [[ -z "$author" || "$author" == " <>" ]]; then
      author="$(git -C "$OPEN_ROOT" config user.name) <$(git -C "$OPEN_ROOT" config user.email)>"
    fi
    subject="$(printf '[PATCH %03d/%03d] %s(self-host): %s %s' "$n" "$total" "$ctype" "$verb" "$path")"
    if [[ "$verb" == delete ]]; then
      git -C "$OPEN_ROOT" rm --quiet -- "server/$path"
    else
      mkdir -p "$(dirname "$SERVER_DIR/$path")"
      cp "$STAGE_DIR/$path" "$SERVER_DIR/$path"
      if [[ -x "$STAGE_DIR/$path" ]]; then chmod +x "$SERVER_DIR/$path"; fi
      git -C "$OPEN_ROOT" add -- "server/$path"
    fi
    git -C "$OPEN_ROOT" commit --quiet --no-verify --author="$author" \
      -m "$subject" \
      -m "Upstream: prismer/prismercloud@${SRC_SHA:0:9} ($SOURCE_REF, v$VERSION)"
    if [[ $((n % 100)) -eq 0 ]]; then log "  ...$n/$total"; fi
  }

  for path in "${adds[@]}"; do emit_patch add "$path"; done
  for path in "${mods[@]}"; do emit_patch modify "$path"; done
  for path in "${dels[@]}"; do emit_patch delete "$path"; done

  # prune empty dirs left behind by deletes
  find "$SERVER_DIR" -type d -empty -delete 2>/dev/null || true

  # record sync state (tracked) so the next run knows its base
  cat > "$LAST_SYNC_FILE" <<EOF
# LAST-SYNC — server/ upstream sync state

- upstream-repo: gitlab.app:prismer/prismercloud
- upstream-ref: $SOURCE_REF
- upstream-sha: $SRC_SHA
- upstream-version: $VERSION
- previous-base: $BASE_SHA
- patches: $total
- date: $(date +%Y-%m-%d)

Next sync: \`sync-server.sh plan --source-ref <ref>\` (base defaults to upstream-sha above).
EOF
  git -C "$OPEN_ROOT" add -- "$LAST_SYNC_FILE"
  git -C "$OPEN_ROOT" commit --quiet --no-verify \
    -m "chore(sync-server): record server sync state — v$VERSION @ ${SRC_SHA:0:9}" \
    -m "$total patches from $SOURCE_REF"

  mkdir -p "$PATCH_DIR"
  git -C "$OPEN_ROOT" format-patch -o "$PATCH_DIR" "$start_sha..HEAD" >/dev/null
  log "done: $total patches + 1 state commit on $branch; series exported to build/sync-server/patches/"
}

# ── status ──────────────────────────────────────────────────────────
cmd_status() {
  [[ -f "$PLAN_FILE" ]] || { log "no plan"; exit 0; }
  log "plan summary:"
  cut -f1 "$PLAN_FILE" | sort | uniq -c
  if [[ -s "$SCRUB_REPORT" ]]; then warn "scrub hits: $(wc -l < "$SCRUB_REPORT")"; fi
  log "files in state/conflicts/: $(find "$CONFLICT_DIR" -type f 2>/dev/null | wc -l)"
}

SOURCE_REPO="${SYNC_SOURCE_REPO:-$HOME/codes/prismer/prismercloud}"
CMD="${1:-}"; shift || true
case "$CMD" in
  plan)   cmd_plan "$@";;
  apply)  cmd_apply "$@";;
  status) cmd_status "$@";;
  *) die "usage: sync-server.sh plan|apply|status (see header comment)";;
esac
