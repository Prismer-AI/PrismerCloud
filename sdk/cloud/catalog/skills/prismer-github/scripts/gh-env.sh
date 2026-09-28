#!/usr/bin/env bash
# Source using the installed absolute path. No installs or account writes.
_gh_skill_scripts="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GH_AUTH_METHOD=none
GH_USER=''
GH_OWNER=''
GH_REPO=''
GH_OWNER_REPO=''
GH_HOST="${GH_HOST:-github.com}"
if command -v gh >/dev/null 2>&1 && gh auth status --hostname "$GH_HOST" >/dev/null 2>&1; then
    GH_AUTH_METHOD=gh
    GH_USER=$(gh api --hostname "$GH_HOST" user --jq '.login' 2>/dev/null) || GH_AUTH_METHOD=none
elif [ "$GH_HOST" = github.com ] && [ -n "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ]; then
    GITHUB_TOKEN="${GITHUB_TOKEN:-$GH_TOKEN}"
    GH_AUTH_METHOD=token-unverified
fi
_gh_remote=$(git remote get-url origin 2>/dev/null) || _gh_remote=''
GH_OWNER_REPO=$(python3 "$_gh_skill_scripts/github-context.py" "$_gh_remote" "$GH_HOST") || GH_OWNER_REPO=''
if [ -n "$GH_OWNER_REPO" ]; then
    GH_OWNER="${GH_OWNER_REPO%%/*}"
    GH_REPO="${GH_OWNER_REPO#*/}"
fi
printf 'GitHub auth: %s; host: %s; repo: %s\n' "$GH_AUTH_METHOD" "$GH_HOST" "$GH_OWNER_REPO"
unset _gh_skill_scripts _gh_remote
export GH_AUTH_METHOD GH_USER GH_OWNER GH_REPO GH_OWNER_REPO GH_HOST
