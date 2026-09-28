# GitHub Installation and Authentication

Installation, authentication and repository authorization are three separate gates.
The skill stays discoverable when gh is absent. Never ask users to manually install
an ordinary missing tool when the host can install it within its existing permissions.

## 1. Tool readiness

Resolve SKILL_ROOT to this installed skill's absolute directory, not the repository cwd.
Run `python3 "$SKILL_ROOT/scripts/ensure-gh.py"`. It checks an existing gh first,
installs only if missing, verifies `gh --version`, then independently checks
`gh auth status --hostname github.com`. Python 3.10+ is required for these helpers.

Host choices: existing Homebrew on macOS/Linux, winget on Windows, otherwise official
checksummed release binary on Linux/macOS into ~/.local/bin. No sudo, global account
changes, shell startup edits or account login. Use the returned executable path
when ~/.local/bin is not on PATH. Do not reinstall an existing but broken command
silently. Install failures/offline/unsupported architectures are explicit blockers,
not authentication failures. A git/curl fallback remains usable with suitable credentials.

Official installation sources (verified 2026-09-23):
- https://cli.github.com/
- https://github.com/cli/cli/blob/trunk/docs/install_linux.md
- https://github.com/cli/cli/releases

`--check-only` disables installation. It still performs read-only auth checking
when gh exists; this is not an offline-only mode.

## 2. Independent identity and auth

Use already-injected GH_TOKEN/GITHUB_TOKEN for github.com or the host-specific
credential mechanism supplied by Runtime. Do not inspect another user's .env,
auth.json or credential-store automatically. Do not print tokens, put them in
remote URLs, write hosts.yml, change global git helpers or run setup-git.

If authentication is missing, state that installation succeeded but authentication
did not. For an explicitly authorized account-linking task, use the official
`gh auth login --hostname HOST --web` device flow with the intended account.
The user completes the browser step; never type approval blindly. In headless
Runtime tasks request secure credential injection from the owner instead.
Do not implement ad-hoc OAuth polling or plaintext keyring fallbacks.

Prefer repository-scoped fine-grained tokens with the minimum permissions needed
for the requested operation and an expiry. Classic repo/workflow scopes are broad;
do not request them unless the actual API requires them.

## 3. Target repository permission

Verify the exact host and owner/repo. `gh api --hostname HOST user --jq .login`
identifies the account; `gh repo view OWNER/REPO --json viewerPermission` checks
the target repository. READ is not permission to push, merge, manage secrets or
delete. API permission, org SSO and branch rules can further restrict an operation.
Use explicit --repo/--hostname on remote commands when cwd is ambiguous.

`git ls-remote` proves only read transport access, never push permission.
SSH access is independent of REST auth. Reuse existing SSH keys/host aliases only
for the named account. Key generation, key registration and SSH config edits
require an account-management task; do not overwrite keys or disable host checking.

## 4. Git/curl fallback

`source "$SKILL_ROOT/scripts/gh-env.sh"` locates sibling helpers using BASH_SOURCE,
parses origin strictly, and distinguishes gh/none/token-unverified. It does not
install tools, source dotenv files or read shared credentials. Bash is required;
on native Windows use ensure-gh.py and gh directly.

For github.com only, injected GITHUB_TOKEN may be used by curl against
https://api.github.com. Use --fail-with-body, a timeout, structured JSON and full
pagination; do not send the token to origin URLs. For Enterprise, bind credentials
to the explicitly verified host and its API root; do not reuse github.com tokens.
Use stdin/config or a secure client if process arguments are observable by other
tenants; never log Authorization headers.

The retained git-credential-token.py parser supports explicit, user-authorized
migration of a specified credential-store file. It requires an explicit file
argument and writes the token to stdout: capture privately, never run it as a
diagnostic or allow terminal output to be included in conversation evidence.

## Troubleshooting and verification

- Tool unavailable: report install/version result and usable fallback separately.
- Authentication missing/expired: request scoped account linking or injection;
  do not delete cached credentials globally.
- 403: distinguish scope, org SSO, branch protection and repository membership.
- Multiple accounts: select the exact host/account; do not overwrite hosts.yml.
- Read succeeded but write failed: do not elevate scopes or retry mutation blindly.
- Login timed out: stop, keep existing config, report a blocked auth step.
- Delivery uncertain: read back the intended issue/PR/review before retrying.

Never claim installation, login, repository access, a write, or CI success from
another gate's result.
