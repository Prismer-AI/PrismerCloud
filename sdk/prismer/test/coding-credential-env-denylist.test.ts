// apc/03 §1 layer b ("凭据隔离", 标注「MVP 主力」) + apc/05 §3 ("凭据可见性边界")
// — coding agent spawn env must not carry the daemon's own high-risk
// credentials (Nacos / RDS / KMS / admin secrets); the gap was that
// `buildClaudeSpawnEnv` → `createProviderEnv` → `createExternalProcessEnv`
// passed `baseEnv` (== the daemon's own `process.env`) through untouched.
//
// This file drives the REAL SUT:
//   - `isDenylistedCredentialEnvKey` / `CREDENTIAL_ENV_FILTER_ESCAPE_HATCH` —
//     imported from the shared shim, the single source of truth for the
//     denylist. No pattern list is hand-copied here.
//   - `createExternalProcessEnv` — the shared chokepoint used by every coding
//     adapter (claude-code / codex / opencode / acp-agent).
//   - `buildClaudeSpawnEnv` — the actual claude-code production entrypoint
//     (agent.ts `buildSdkEnv` calls this with `baseEnv: process.env`).
//
// Per CLAUDE.md 验收纪律: positive control asserts the credential is absent;
// each negative control is a REAL toggle on the SUT (the escape hatch, or
// moving the same key from overlay to baseEnv) that must flip the assertion
// to failing — not a re-implementation of the rule under test.
//
// ⚠️ apc/17 §8.1 W2.1′ (2026-07-27) — the gate INVERTED to an allowlist
// (`isAllowlistedSpawnEnvKey`). The name-pattern predicate this file was
// originally written against (`isDenylistedCredentialEnvKey`) is now only the
// SECOND gate, so every assertion below still holds verbatim — but they are no
// longer the whole story. The block at the bottom of this file carries the ONE
// assertion a denylist can never pass: an unenumerated future credential is
// blocked by DEFAULT. (File name kept as-is to avoid churn on a shared tree.)

import { describe, expect, test } from 'vitest';
import {
  createExternalProcessEnv,
  isAllowlistedSpawnEnvKey,
  isDenylistedCredentialEnvKey,
  CREDENTIAL_ENV_FILTER_ESCAPE_HATCH,
  type ProcessEnvRecord,
} from '../src/adapters/coding/shared/shims/paseo-env.js';
import { buildClaudeSpawnEnv } from '../src/adapters/coding/claude-code/agent.js';

/** Minimal baseEnv every real spawn needs (PATH/HOME) so we aren't asserting against an empty object. */
function minimalBaseEnv(extra: ProcessEnvRecord): ProcessEnvRecord {
  return {
    PATH: '/usr/bin:/bin',
    HOME: '/home/tester',
    NODE_ENV: 'test',
    ...extra,
  };
}

describe('credential denylist — name-pattern predicate (single source of truth)', () => {
  test('POSITIVE: real-world secret-shaped names from docs/.env.local are denylisted', () => {
    const denylisted = [
      'JWT_SECRET',
      'AUTH_SECRET',
      'STRIPE_SECRET_KEY',
      'REMOTE_MYSQL_PASSWORD',
      'NEWAPI_ADMIN_TOKEN',
      'SMS_PASSWORD',
      'DEEPSEEK_API_KEY',
      'ZHIPU_API_KEY',
      'EXASEARCH_API_KEY',
      'OPENAI_API_KEY',
      'DATABASE_URL',
      'IDENTITY_KMS_KEY',
      'SKILL_CONFIG_ENC_KEY',
      'DISPATCH_DAEMON_SECRET',
      'ADMIN_EMAILS',
      'NACOS_SERVER_ADDR',
      'FAKE_TEST_SECRET', // the test sentinel used below
    ];
    for (const key of denylisted) {
      expect(isDenylistedCredentialEnvKey(key), `expected ${key} to be denylisted`).toBe(true);
    }
  });

  test('non-credential env keys a coding agent needs are NOT denylisted', () => {
    const allowed = [
      'PATH',
      'HOME',
      'USERPROFILE',
      'NODE_ENV',
      'LANG',
      'TERM',
      'SHELL',
      'CLAUDE_CONFIG_DIR',
      'ANTHROPIC_BASE_URL', // routing url, not a credential value
      'PRISMER_DAEMON_ID',
      'APP_ENV',
    ];
    for (const key of allowed) {
      expect(isDenylistedCredentialEnvKey(key), `expected ${key} NOT to be denylisted`).toBe(false);
    }
  });
});

describe('credential denylist — createExternalProcessEnv (shared chokepoint, all coding adapters)', () => {
  test('POSITIVE CONTROL: a seeded fake baseEnv credential is stripped from the spawn env', () => {
    const baseEnv = minimalBaseEnv({
      FAKE_TEST_SECRET: 'sentinel-xxx',
      DATABASE_URL: 'mysql://root:pw@localhost:3307/prismer_cloud',
      STRIPE_SECRET_KEY: 'sk_live_should_not_leak',
    });
    const env = createExternalProcessEnv(baseEnv);
    expect(env.FAKE_TEST_SECRET).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    // sanity: non-credential baseEnv keys survive
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/tester');
  });

  test('NEGATIVE CONTROL (must go red without the escape hatch): escape hatch OFF strips the sentinel; this is the control the next test inverts', () => {
    const baseEnv = minimalBaseEnv({ FAKE_TEST_SECRET: 'sentinel-xxx' });
    const env = createExternalProcessEnv(baseEnv);
    expect(env.FAKE_TEST_SECRET).toBeUndefined();
  });

  test('escape hatch PRISMER_CC_NO_CRED_FILTER=1 disables filtering (real toggle, not a re-implementation)', () => {
    const baseEnv = minimalBaseEnv({
      FAKE_TEST_SECRET: 'sentinel-xxx',
      [CREDENTIAL_ENV_FILTER_ESCAPE_HATCH]: '1',
    });
    const env = createExternalProcessEnv(baseEnv);
    // With the escape hatch on, the same key that test above proved gets
    // stripped is now present — proving the "POSITIVE CONTROL" test is not
    // vacuously green: flipping this real production switch flips the result.
    expect(env.FAKE_TEST_SECRET).toBe('sentinel-xxx');
  });
});

describe('anti-false-positive: overlay-supplied proxy credentials are NEVER filtered', () => {
  test('POSITIVE CONTROL: gateway proxy credentials passed via overlay survive alongside a filtered baseEnv secret', () => {
    const baseEnv = minimalBaseEnv({
      FAKE_TEST_SECRET: 'sentinel-xxx',
      JWT_SECRET: 'daemon-own-jwt-signing-key',
    });
    const overlay = {
      ANTHROPIC_AUTH_TOKEN: 'sk-prismer-live-abc123',
      ANTHROPIC_BASE_URL: 'https://gateway.prismer.internal/api',
      PRISMER_API_KEY: 'sk-prismer-live-def456',
    };
    const env = createExternalProcessEnv(baseEnv, overlay);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-prismer-live-abc123');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway.prismer.internal/api');
    expect(env.PRISMER_API_KEY).toBe('sk-prismer-live-def456');
    // and the baseEnv secrets are still stripped in the same call
    expect(env.FAKE_TEST_SECRET).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();
  });

  test('NEGATIVE CONTROL (must go red — proves the overlay-exemption is load-bearing, not incidental): the SAME key/value moved from overlay into baseEnv IS stripped', () => {
    // ANTHROPIC_AUTH_TOKEN matches the `_TOKEN` fragment rule just like any
    // other denylisted name — the ONLY reason it survives in production is
    // that it arrives via the overlay, merged in AFTER baseEnv is filtered.
    // This proves that claim: put it in baseEnv instead and watch it die.
    expect(isDenylistedCredentialEnvKey('ANTHROPIC_AUTH_TOKEN')).toBe(true);
    const baseEnv = minimalBaseEnv({ ANTHROPIC_AUTH_TOKEN: 'sk-prismer-live-abc123' });
    const env = createExternalProcessEnv(baseEnv); // no overlay this time
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
});

describe('production entrypoint — buildClaudeSpawnEnv (claude-code agent.ts, real code path)', () => {
  test('baseEnv (daemon-inherited) credentials are stripped; launchEnv (gateway proxy injection) credentials survive', () => {
    const baseEnv: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/tester',
      FAKE_TEST_SECRET: 'sentinel-xxx',
      DATABASE_URL: 'mysql://root:pw@localhost:3307/prismer_cloud',
      REMOTE_MYSQL_PASSWORD: 'super-secret-rds-pw',
      NACOS_SERVER_ADDR: 'nacos.internal:8848',
      ADMIN_EMAILS: 'winshare@prismer.ai',
    };
    const launchEnv = {
      ANTHROPIC_AUTH_TOKEN: 'sk-prismer-live-abc123',
      ANTHROPIC_BASE_URL: 'https://gateway.prismer.internal/api',
    };
    const env = buildClaudeSpawnEnv({
      baseEnv,
      launchEnv,
      // isolation overlay is orthogonal to this test; keep it off so the
      // isolated HOME/CLAUDE_CONFIG_DIR overlay doesn't distract from the
      // credential-filtering assertions.
      isolationEnv: { PRISMER_CC_NO_ISOLATION: '1' },
    });

    // daemon-inherited credentials: gone
    expect(env.FAKE_TEST_SECRET).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.REMOTE_MYSQL_PASSWORD).toBeUndefined();
    expect(env.NACOS_SERVER_ADDR).toBeUndefined();
    expect(env.ADMIN_EMAILS).toBeUndefined();

    // gateway proxy injection: the ONLY auth path code agents have — must survive
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-prismer-live-abc123');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway.prismer.internal/api');

    // agent still has what it needs to run at all
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe(baseEnv.HOME);
  });

  test('NEGATIVE CONTROL (must go red): escape hatch on the SAME baseEnv restores the daemon secret into the real production spawn env', () => {
    const baseEnv: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/tester',
      FAKE_TEST_SECRET: 'sentinel-xxx',
      [CREDENTIAL_ENV_FILTER_ESCAPE_HATCH]: '1',
    };
    const env = buildClaudeSpawnEnv({
      baseEnv,
      isolationEnv: { PRISMER_CC_NO_ISOLATION: '1' },
    });
    expect(env.FAKE_TEST_SECRET).toBe('sentinel-xxx');
  });
});

// ---------------------------------------------------------------------------
// apc/17 §8.1 W2.1′ — allowlist inversion.
// ---------------------------------------------------------------------------

/** The six names measured leaking through the denylist against the real `.env.local`. */
const MEASURED_DENYLIST_ESCAPEES = [
  'SMTP_PASS', // a LIVE 16-char SMTP password; `_PASS` is not `_PASSWORD`
  'REDIS_URL', // URL form carries `user:pass@`
  'SMS_ACCOUNT',
  'SMTP_USER',
  'K8S_CLUSTER_URL',
  'AUTH_URL',
];

describe('spawn env allowlist (apc/17 §8.1 W2.1′) — the gate is "known-needed", not "known-bad"', () => {
  test('⭐ DISCRIMINANT: an unenumerated FUTURE credential is blocked by default — and the old denylist provably would NOT have caught it', () => {
    const FUTURE = 'FUTURE_VENDOR_CREDENTIAL';
    // The whole reason for the inversion: the name-pattern gate admits it...
    expect(
      isDenylistedCredentialEnvKey(FUTURE),
      'the name-pattern gate does not recognise this name — that is the premise',
    ).toBe(false);
    // ...and the allowlist gate rejects it anyway, because it was never listed.
    expect(isAllowlistedSpawnEnvKey(FUTURE)).toBe(false);
    const env = createExternalProcessEnv(
      minimalBaseEnv({ [FUTURE]: 'sentinel-future-credential' }),
    );
    expect(env[FUTURE]).toBeUndefined();
  });

  test('NEGATIVE CONTROL (real toggle, must flip): the escape hatch restores that same future credential', () => {
    const FUTURE = 'FUTURE_VENDOR_CREDENTIAL';
    const env = createExternalProcessEnv(
      minimalBaseEnv({
        [FUTURE]: 'sentinel-future-credential',
        [CREDENTIAL_ENV_FILTER_ESCAPE_HATCH]: '1',
      }),
    );
    expect(env[FUTURE]).toBe('sentinel-future-credential');
  });

  test('POSITIVE CONTROL: the six measured denylist escapees are now blocked', () => {
    const baseEnv = minimalBaseEnv(
      Object.fromEntries(MEASURED_DENYLIST_ESCAPEES.map((k) => [k, `sentinel-${k}`])),
    );
    const env = createExternalProcessEnv(baseEnv);
    for (const key of MEASURED_DENYLIST_ESCAPEES) {
      // premise: none of these matched the old gate
      expect(isDenylistedCredentialEnvKey(key), `${key} was a denylist escapee`).toBe(false);
      expect(env[key], `${key} must not reach the spawn env`).toBeUndefined();
    }
  });

  test('POSITIVE CONTROL: cloud-vendor access-key ids (no `_SECRET`/`_TOKEN` in the name) are blocked', () => {
    const vendorKeys = ['ALIBABA_CLOUD_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_ID'];
    const env = createExternalProcessEnv(
      minimalBaseEnv(Object.fromEntries(vendorKeys.map((k) => [k, `sentinel-${k}`]))),
    );
    for (const key of vendorKeys) {
      expect(env[key], `${key} must not reach the spawn env`).toBeUndefined();
    }
  });

  test('the spawn env is a SUBSET of the allowlist — no key survives that the gate would reject', () => {
    const dirtyBaseEnv = minimalBaseEnv({
      SMTP_PASS: 'x',
      REDIS_URL: 'x',
      DATABASE_URL: 'x',
      NACOS_SERVER_ADDR: 'x',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      npm_config_userconfig: '/home/tester/.npmrc',
      JAVA_HOME: '/opt/java',
      SOME_UNRELATED_THING: 'x',
      HTTP_PROXY: 'http://proxy:3128',
      LC_ALL: 'en_US.UTF-8',
    });
    const env = createExternalProcessEnv(dirtyBaseEnv);
    const stray = Object.keys(env).filter((k) => !isAllowlistedSpawnEnvKey(k));
    expect(stray, `these survived without being allowlisted: ${stray.join(', ')}`).toEqual([]);
  });

  test('deliberate denies stay denied (documented in the module, not accidents)', () => {
    // SSH_AUTH_SOCK hands the agent the OPERATOR's ssh identity; npm_config_*
    // carries registry auth whose names dodge every credential pattern; PWD is
    // the daemon's cwd, stale for the child.
    for (const key of ['SSH_AUTH_SOCK', 'npm_config_userconfig', 'npm_config__auth', 'PWD']) {
      expect(isAllowlistedSpawnEnvKey(key), `${key} must stay denied`).toBe(false);
    }
  });

  test('ANTI-FALSE-POSITIVE: every key the runtime actually needs to inherit IS allowlisted', () => {
    const required = [
      // process basics — the child cannot run / shell out / write temp without these
      'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'TZ',
      'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'NO_COLOR',
      // node
      'NODE_ENV', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS',
      // egress
      'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
      // provider routing / config pointers (URLs + dirs, not secrets)
      'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_BASE', 'OPENAI_BASE_URL',
      'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG',
      // apc/14 D6 held-out DENY switch — read from the COMPOSED spawn env and
      // fails OPEN when absent, so it must survive inheritance
      'APC_HELDOUT_DENY',
      // PRISMER_* the CHILD consumes (SDK CLI + built-in skill scripts)
      'PRISMER_HOME', 'PRISMER_BASE_URL', 'PRISMER_CLOUD_BASE',
      'PRISMER_DAEMON_URL', 'PRISMER_DAEMON_PORT',
      // Windows: process creation itself fails without these
      'SystemRoot', 'COMSPEC', 'PATHEXT', 'Path', 'USERPROFILE', 'LOCALAPPDATA',
      'APPDATA', 'ProgramFiles', 'ProgramData', 'windir',
    ];
    for (const key of required) {
      expect(isAllowlistedSpawnEnvKey(key), `${key} must be inheritable`).toBe(true);
    }
  });

  test('the Windows/lowercase casing of a key does not change its verdict', () => {
    // Windows preserves OS casing (`Path`, `ProgramFiles`); the lowercase proxy
    // aliases are the same variable. Both must resolve like their UPPER form.
    expect(isAllowlistedSpawnEnvKey('Path')).toBe(isAllowlistedSpawnEnvKey('PATH'));
    expect(isAllowlistedSpawnEnvKey('no_proxy')).toBe(isAllowlistedSpawnEnvKey('NO_PROXY'));
    expect(isAllowlistedSpawnEnvKey('database_url')).toBe(isAllowlistedSpawnEnvKey('DATABASE_URL'));
    const env = createExternalProcessEnv(
      minimalBaseEnv({ Path: 'C:\\Windows', no_proxy: 'localhost', database_url: 'mysql://x' }),
    );
    expect(env.Path).toBe('C:\\Windows');
    expect(env.no_proxy).toBe('localhost');
    expect(env.database_url).toBeUndefined();
  });

  test('SECOND GATE: a prefix family cannot smuggle a credential in (NODE_* is allowlisted, NODE_AUTH_TOKEN is not)', () => {
    expect(isAllowlistedSpawnEnvKey('NODE_ENV')).toBe(true);
    expect(isAllowlistedSpawnEnvKey('NODE_AUTH_TOKEN')).toBe(false);
    const env = createExternalProcessEnv(
      minimalBaseEnv({ NODE_AUTH_TOKEN: 'npm-registry-token', NODE_OPTIONS: '--max-old-space-size=4096' }),
    );
    expect(env.NODE_AUTH_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096');
  });
});
