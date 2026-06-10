# sync-server — closed-source → `server/` sync tool

Syncs the closed-source `gitlab.app:prismer/prismercloud` repo into this repo's
`server/` tree while **preserving self-host adaptations** (scrubbed secrets,
self-host fallbacks, curated docs, `docker/`, `.github/`, `server/sdk/`, …).

This is the *server* pipeline described in the top-level `CLAUDE.md`. The SDK
pipeline (`sdk/build/sync.sh`, whole-directory rsync) is separate.

## How it works

Three-way classification per path, using blob SHAs (no checkout needed in the
source repo — refs are read with `git show`/`git cat-file`):

| ours (`server/`) | base (last sync) | theirs (source ref) | action |
|---|---|---|---|
| == base | * | changed | take theirs verbatim |
| changed | * | == base | keep ours (self-host adaptation) |
| changed | exists | changed | `git merge-file` 3-way; conflicts → `state/conflicts/` |
| exists | exists | gone | delete (`delete-conflict` if ours was adapted) |
| absent | absent | new | import iff `whitelist.txt` matches and `blacklist.txt` doesn't |

- `blacklist.txt` — paths never touched in either direction.
- `whitelist.txt` — only governs *new* upstream files.
- `content-scrub.txt` — forbidden regexes (keys, internal hosts/namespaces).
  Any staged hit blocks `apply`.

## Workflow

```bash
# 1. plan: classify + stage everything under state/ (no repo mutation)
build/sync-server/sync-server.sh plan --source-ref main
#    first run ever needs an explicit base: --base-ref <last-synced sha>

# 2. resolve conflicts: edit files under state/conflicts/, remove markers,
#    then move each resolved file to state/stage/<path>

# 3. review state/scrub-report.txt and state/skipped-new-files.txt

# 4. apply: per-file commits "[PATCH NNN/TOTAL] <type>(self-host): <verb> <path>"
#    authored by the upstream author; requires a non-main branch
git checkout -b sync/server-vX.Y.Z
build/sync-server/sync-server.sh apply
```

`apply` finishes by writing `LAST-SYNC.md` (the next run's default base) and
exporting the series to `patches/` (gitignored, like `state/`).

## Post-sync checklist

1. `cd server && npm install && npx tsc --noEmit` — type bridge check.
2. Secret scan the diff (GitGuardian blocks PRs on leaks).
3. `docker compose up` self-host smoke (see `server/CLAUDE.md`).
