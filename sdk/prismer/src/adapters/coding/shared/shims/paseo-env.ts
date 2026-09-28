const PASEO_NODE_ENV = "PASEO_NODE_ENV";
const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";

const RUNTIME_CONTROL_ENV_KEYS = [
  PASEO_NODE_ENV,
  "PASEO_DESKTOP_MANAGED",
  "PASEO_SUPERVISED",
  ELECTRON_RUN_AS_NODE,
  "ELECTRON_NO_ATTACH_CONSOLE",
] as const;

// doc 08 §7.6 ② — Claude parent-session env scrub. When the daemon process is
// itself a Claude Code session (agent-rt pod), the CLAUDECODE / CLAUDE_CODE_*
// vars leak into spawned provider subprocesses and corrupt their session
// resolution. Strip them from every external (spawned) process env.
// Prefix match for CLAUDE_CODE_* is applied below in buildExternalProcessEnv.
export const PARENT_SESSION_ENV_VARS = ["CLAUDECODE"] as const;
const PARENT_SESSION_ENV_PREFIXES = ["CLAUDE_CODE_"] as const;

// apc/03 §1 layer b ("凭据隔离") + apc/05 §3 ("凭据可见性边界") — high-risk
// credentials the daemon process inherits (Nacos config, RDS/DB passwords,
// KMS/encryption keys, admin allow-lists, the daemon's own auth secrets to
// cloud) must NOT be visible to a spawned coding agent's bash. A coding agent
// with a shell can `env | grep` and exfiltrate anything present, so the fix is
// exclusion at spawn time, not "the skill won't ask for it".
//
// Scope: this filter is applied ONLY to `baseEnv` — the slice the spawned
// process would otherwise inherit verbatim from the daemon's own
// `process.env`. It is applied BEFORE overlays are merged in
// `buildExternalProcessEnv`, so anything a caller passes explicitly via an
// overlay (`launchEnv` / `taskEnv` / `runtimeSettings.env`) always wins and is
// NEVER stripped — that overlay path is the sanctioned way gateway-proxy
// credentials (`ANTHROPIC_AUTH_TOKEN`, `PRISMER_API_KEY`, etc, see
// provider-proxy-env.ts) reach the agent; there is no official/interactive
// login for code agents (project memory:
// code_agents_proxy_injection_not_official_auth), so that overlay path is the
// ONLY path and must never be touched here.
//
// ⚠️ apc/17 §8.1 W2.1′ (2026-07-27) — THE GATE IS AN ALLOWLIST, NOT A DENYLIST.
// The name-pattern rules below were the ORIGINAL gate and are now only a
// SECOND gate (defence in depth) applied on top of
// `SPAWN_ENV_ALLOWLIST_*`. Rationale, measured: fed the 57 real variable names
// from the repo's `.env.local` through the name-pattern predicate → 21 caught,
// 36 passed through, and the pass-through set included a LIVE SMTP password
// (`SMTP_PASS` — `_PASS` is not `_PASSWORD`), `REDIS_URL` (URL form carries
// `user:pass@`), `SMS_ACCOUNT`, `SMTP_USER`, `K8S_CLUSTER_URL`, `AUTH_URL`.
// A denylist asks "is this name a KNOWN-BAD one"; every new vendor credential
// added to the daemon's env leaks silently until someone remembers to extend
// the list. The allowlist asks "is this name KNOWN-NEEDED", so the failure
// mode of forgetting is a loud break at spawn time, not a silent exfiltration
// channel.
//
// Matched as a `_`-delimited fragment ANYWHERE in the key (not just a strict
// suffix) — real-world names like `STRIPE_SECRET_KEY` embed the pattern in the
// middle, not at the end, and must still be caught.
const CREDENTIAL_DENYLIST_NAME_FRAGMENTS = [
  "_SECRET",
  "_PASSWORD",
  "_TOKEN",
  "_PRIVATE_KEY",
  "_API_KEY",
] as const;

const CREDENTIAL_DENYLIST_PREFIXES = ["REMOTE_MYSQL_", "NACOS_"] as const;

// Explicit point-names not already covered by a fragment/prefix rule above
// (JWT_SECRET / AUTH_SECRET / DISPATCH_DAEMON_SECRET are also caught by the
// `_SECRET` fragment rule; listed here anyway so the denylist is legible
// without cross-referencing the fragment set. ADMIN_EMAILS / DATABASE_URL /
// IDENTITY_KMS_KEY / SKILL_CONFIG_ENC_KEY match no fragment/prefix rule and
// rely on this exact list).
const CREDENTIAL_DENYLIST_EXACT = [
  "DATABASE_URL",
  "IDENTITY_KMS_KEY",
  "SKILL_CONFIG_ENC_KEY",
  "DISPATCH_DAEMON_SECRET",
  "ADMIN_EMAILS",
  "JWT_SECRET",
  "AUTH_SECRET",
] as const;

// apc/17 §8.1 W2.1′ — THE gate. A daemon-inherited (`baseEnv`) key reaches a
// spawned coding agent ONLY if it appears here. Everything else is dropped,
// including keys nobody has thought of yet — that is the entire point.
//
// Not on this list, and NOT an oversight (each is a deliberate deny):
//   · SSH_AUTH_SOCK   — a live handle to the OPERATOR's ssh identity. Passing
//                       it hands the agent the human's git push / server login
//                       rights; exactly the boundary apc/05 §3 draws.
//   · npm_* / npm_config_* — carry registry auth (`npm_config__auth`,
//                       `npm_config_//registry…:_authToken`) whose names dodge
//                       every credential name-pattern, and `npm_config_prefix`
//                       / `npm_lifecycle_*` actively mis-steer an `npm` the
//                       agent runs itself.
//   · PWD / OLDPWD    — the DAEMON's cwd, stale for the child (spawn sets cwd
//                       and bash re-derives PWD on start).
//   · PRISMER_API_KEY — a credential. Reaches the agent via the launch overlay
//                       (provider-proxy-env), never by inheritance; already
//                       blocked before this change by the `_API_KEY` rule.
//   · GIT_ASKPASS / GIT_SSH_COMMAND — credential-adjacent hooks.
//
// Compared UPPER-CASED, which buys two things at once: Windows' own casing
// (`Path`, `ProgramFiles`, `SystemRoot`, `windir`) matches, and the lowercase
// proxy aliases (`http_proxy`, `no_proxy`) need no duplicate entries.
const SPAWN_ENV_ALLOWLIST_EXACT: ReadonlySet<string> = new Set([
  // ── POSIX process basics. Without these the child does not run at all
  //    (PATH), cannot resolve its config/cache (HOME), cannot run a Bash tool
  //    (SHELL), or writes temp files into the wrong place (TMPDIR/TMP/TEMP).
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  // Timestamps the agent emits, and UTF-8 correctness for non-ASCII content
  // (a missing LANG makes python/ripgrep mangle CJK output).
  "TZ",
  "LANG",
  "LANGUAGE",
  // Provider CLIs probe TERM before touching termios; our own CLI honours
  // NO_COLOR (src/cli/util.ts, src/cli/ui.ts).
  "TERM",
  "NO_COLOR",

  // ── Windows process basics. Dropping SYSTEMROOT/COMSPEC/PATHEXT breaks
  //    process creation itself on win32; the profile/app-data trio is where
  //    every provider CLI keeps its config.
  "USERPROFILE",
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  "NUMBER_OF_PROCESSORS",
  "OS",

  // ── Egress. Corporate / dev machines route ALL outbound HTTP through these;
  //    without them the agent's LLM + tool calls simply cannot leave the box.
  //    (Residual: a proxy URL may embed `user:pass@` — see the module note.)
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",

  // ── Provider routing/config pointers. URLs and directory paths, not secrets
  //    (the matching *token* vars are supplied by the launch overlay). Needed
  //    when an operator configures a daemon-wide endpoint / config home
  //    instead of a per-agent proxyProvider.
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_BASE",
  "OPENAI_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "OPENCODE_CONFIG",

  // ── apc/14 D6 held-out write DENY switch, read from the COMPOSED spawn env
  //    (config-isolation.ts:159). Its absence fails OPEN — dropping it would
  //    silently disarm the boundary, so it must be inheritable.
  "APC_HELDOUT_DENY",

  // ── PRISMER_* the CHILD consumes. All non-credential; the scope ids
  //    (WORKSPACE/TASK/AGENT/ARTIFACTS/…) deliberately are NOT here because
  //    they arrive per-dispatch on the overlay (prismer-env.ts).
  //    PRISMER_HOME → SDK CLI config root (src/config.ts:118)
  //    PRISMER_BASE_URL → CLI cloud_api_base (src/config.ts:297)
  //    PRISMER_CLOUD_BASE → built-in skill scripts (skill-builder/ingest.mjs,
  //      claim-agent-ownership) curl the cloud with it
  //    PRISMER_DAEMON_URL / PRISMER_DAEMON_PORT → `cloud memory` reaches the
  //      local daemon (src/cli/commands/memory.ts:73-74)
  "PRISMER_HOME",
  "PRISMER_BASE_URL",
  "PRISMER_CLOUD_BASE",
  "PRISMER_DAEMON_URL",
  "PRISMER_DAEMON_PORT",
]);

// Prefix families. Kept deliberately short — each one is a hole the second
// (name-pattern) gate has to cover, so a family only earns its place when
// enumerating its members is impossible.
//   LC_*   — POSIX locale categories (LC_ALL, LC_CTYPE, …), open-ended set.
//   NODE_* — NODE_ENV / NODE_OPTIONS / NODE_PATH / NODE_EXTRA_CA_CERTS; the
//            last one is how corporate TLS interception is trusted at all.
//            NODE_AUTH_TOKEN is still caught by the `_TOKEN` second gate.
//   XDG_*  — Linux config/cache/data/runtime dirs the provider CLIs resolve.
const SPAWN_ENV_ALLOWLIST_PREFIXES = ["LC_", "NODE_", "XDG_"] as const;

/**
 * True if `key` may be inherited by a spawned coding agent from the daemon's
 * own environment. Allowlist first, then the credential name-pattern predicate
 * as a second gate so a prefix family (`NODE_AUTH_TOKEN`, `XDG_…_SECRET`)
 * cannot smuggle a credential in. Exported as the single source of truth —
 * tests must drive the real SUT through this, not hand-copy the list.
 */
export function isAllowlistedSpawnEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (isDenylistedCredentialEnvKey(upper)) {
    return false;
  }
  if (SPAWN_ENV_ALLOWLIST_EXACT.has(upper)) {
    return true;
  }
  return SPAWN_ENV_ALLOWLIST_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * Escape hatch for troubleshooting only — default OFF (i.e. filtering is ON
 * by default). Must be read from `baseEnv` (the daemon-inherited slice this
 * filter acts on), never from an overlay, so a task/launch overlay can't
 * silently disable the filter.
 */
export const CREDENTIAL_ENV_FILTER_ESCAPE_HATCH = "PRISMER_CC_NO_CRED_FILTER";

/**
 * True if `key` matches the credential name-pattern rules. Since apc/17 §8.1
 * W2.1′ this is the SECOND gate only — {@link isAllowlistedSpawnEnvKey} is the
 * gate that decides inheritance. Exported as the single source of truth —
 * tests must drive the real SUT through this, not hand-copy the pattern list.
 */
export function isDenylistedCredentialEnvKey(key: string): boolean {
  if ((CREDENTIAL_DENYLIST_EXACT as readonly string[]).includes(key)) {
    return true;
  }
  if (CREDENTIAL_DENYLIST_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return true;
  }
  if (CREDENTIAL_DENYLIST_NAME_FRAGMENTS.some((fragment) => key.includes(fragment))) {
    return true;
  }
  return false;
}

function isCredentialEnvFilterDisabled(baseEnv: ProcessEnvRecord): boolean {
  return baseEnv[CREDENTIAL_ENV_FILTER_ESCAPE_HATCH] === "1";
}

/**
 * Reduce `baseEnv` to the allowlisted slice. Called BEFORE overlays are merged
 * in `buildExternalProcessEnv` — see the module-level comment above
 * `CREDENTIAL_DENYLIST_NAME_FRAGMENTS` for why overlays must stay untouched.
 */
function filterCredentialBaseEnv(baseEnv: ProcessEnvRecord): ProcessEnvRecord {
  if (isCredentialEnvFilterDisabled(baseEnv)) {
    return baseEnv;
  }
  const filtered: ProcessEnvRecord = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!isAllowlistedSpawnEnvKey(key)) {
      continue;
    }
    filtered[key] = value;
  }
  return filtered;
}

export type PaseoNodeEnv = "development" | "production" | "test";
export type ProcessEnvRecord = Record<string, string | undefined>;
export type ExternalProcessEnv = NodeJS.ProcessEnv & Record<string, string>;

function buildInternalProcessEnv<T extends ProcessEnvRecord>(baseEnv: T): T {
  return { ...baseEnv };
}

function buildExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  overlays: ProcessEnvRecord[],
): ExternalProcessEnv {
  // Credential denylist runs FIRST and ONLY over baseEnv — overlays are
  // Object.assign'd in afterward and always win, so anything a caller passed
  // explicitly (gateway proxy injection) survives untouched.
  const filteredBaseEnv = filterCredentialBaseEnv(baseEnv);
  const sanitized = Object.assign({}, filteredBaseEnv, ...overlays);
  for (const key of RUNTIME_CONTROL_ENV_KEYS) {
    delete sanitized[key];
  }
  for (const key of PARENT_SESSION_ENV_VARS) {
    delete sanitized[key];
  }
  for (const [key, value] of Object.entries(sanitized)) {
    if (
      value === undefined ||
      PARENT_SESSION_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      delete sanitized[key];
    }
  }
  return sanitized as ExternalProcessEnv;
}

export function createPaseoInternalEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return buildInternalProcessEnv(baseEnv);
}

export function createExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  return buildExternalProcessEnv(baseEnv, overlays);
}

export function createExternalCommandProcessEnv(
  _command: string,
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  // Deprecated command parameter: retained while callers migrate to createExternalProcessEnv.
  return buildExternalProcessEnv(baseEnv, overlays);
}

export function buildSelfNodeCommand(
  args: string[],
  envOverlay?: ProcessEnvRecord,
): {
  command: string;
  args: string[];
  env: ExternalProcessEnv;
} {
  const env = buildExternalProcessEnv(process.env, []);
  Object.assign(env, { [ELECTRON_RUN_AS_NODE]: "1" }, envOverlay);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }
  return {
    command: process.execPath,
    args,
    env,
  };
}

export function resolvePaseoNodeEnv(env: NodeJS.ProcessEnv): PaseoNodeEnv | undefined {
  const value = env[PASEO_NODE_ENV];
  return value === "development" || value === "production" || value === "test" ? value : undefined;
}
