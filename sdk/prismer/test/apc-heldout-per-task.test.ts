// desktop205 W5 — the held-out deny SWITCH is per-dispatch, not per-daemon.
//
// F7 (docs/desktop205/01-evidence §7): `apcHeldOutDenySettings()` was called with
// no argument, so it read the DAEMON's `process.env`. W4 had just stopped the
// rules from being written into the shared hermetic settings.json (where one APC
// run permanently narrowed every other coding agent on the box) — but with a
// daemon-global switch the same blast radius came back through the front door:
// the only way to turn the boundary on was to turn it on for every run on the
// machine. W5 moves the read to the composed SPAWN env, which layers the
// dispatch's per-task env over the daemon env.
//
// ORACLE — the SDK `Options` object the query is actually launched with.
// The test injects a `queryFactory` and lets the REAL ClaudeAgentSession run its
// REAL `buildOptions()`; the assertion reads `options.settings` off the captured
// input. Nothing here re-derives the merge or the overlay order, so a regression
// in either is caught (this is the same discipline as the D5 sentinel: drive the
// production function, never re-implement it in the probe).
//
// 负控 — two sessions from the SAME client (⇒ same daemon, same process.env, in
// which APC_HELDOUT_DENY is UNSET throughout): only the one carrying the per-task
// marker gets deny rules. If the switch were still daemon-global, either both
// would have them or neither would.
//
// ⚠️ SCOPE: the deny rules are a HINT that lowers the chance of an accidental
// touch, NOT a security boundary — `Bash` is outside CC's file-permission check
// entirely (00-INDEX §2.4, 01 §F2). These tests pin plumbing, not containment.

import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ClaudeAgentClient } from '../src/adapters/coding/claude-code/agent.js';
import { APC_HELD_OUT_PATHS } from '../src/adapters/coding/claude-code/config-isolation.js';
import type { ClaudeQueryInput } from '../src/adapters/coding/claude-code/query.js';

/** Minimal pino-shaped logger — `.child()` must return something with the same shape. */
function makeLogger(): any {
  const noop = () => undefined;
  const logger: any = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop };
  logger.child = () => logger;
  return logger;
}

/**
 * A Query stub good enough for `listCommands()` — the cheapest public method
 * that goes through ensureQuery() → buildOptions() → claudeQuery(). Everything
 * beyond `supportedCommands()` is never reached.
 */
function makeQueryStub(): any {
  return {
    supportedCommands: async () => [],
    applyFlagSettings: async () => undefined,
    close: () => undefined,
    return: async () => undefined,
    async *[Symbol.asyncIterator]() {
      /* no messages */
    },
  };
}

interface Captured {
  settings: unknown;
  env: NodeJS.ProcessEnv;
}

/**
 * Build one session and return the SDK options its query was launched with.
 * `taskEnv` is the dispatch's per-task env — the `extra.claude.env` seam that
 * `buildClaudeSpawnEnv` overlays onto the daemon env.
 */
async function launchAndCapture(
  client: ClaudeAgentClient,
  captures: Captured[],
  taskEnv?: Record<string, string>,
): Promise<Captured> {
  const before = captures.length;
  const session = await client.createSession({
    provider: 'claude',
    cwd: process.cwd(),
    ...(taskEnv ? { extra: { claude: { env: taskEnv } } } : {}),
  } as any);
  await session.listCommands();
  expect(captures.length, 'the query factory was never called').toBe(before + 1);
  return captures[before]!;
}

function denyRules(captured: Captured): string[] {
  const settings = captured.settings;
  if (settings === undefined) return [];
  const parsed = typeof settings === 'string' ? JSON.parse(settings) : settings;
  const deny = (parsed as { permissions?: { deny?: unknown } })?.permissions?.deny;
  return Array.isArray(deny) ? (deny as string[]) : [];
}

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let prevSwitch: string | undefined;

let client: ClaudeAgentClient;
let captures: Captured[];

beforeEach(() => {
  // Isolate ~/.prismer/claude-config into a throwaway tree: buildSdkEnv calls
  // ensureClaudeConfigIsolation(), which mkdir's it. The real user's home is
  // never touched.
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'apc-per-task-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  prevSwitch = process.env.APC_HELDOUT_DENY;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  // The daemon-global switch stays UNSET for every test in this file. That is
  // the whole point: any deny rule observed below can only have come from the
  // per-task env.
  delete process.env.APC_HELDOUT_DENY;

  captures = [];
  client = new ClaudeAgentClient({
    logger: makeLogger(),
    resolveBinary: async () => '/nonexistent/claude',
    queryFactory: (input: ClaudeQueryInput) => {
      captures.push({ settings: input.options.settings, env: input.options.env ?? {} });
      return makeQueryStub();
    },
  } as any);
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  if (prevSwitch === undefined) delete process.env.APC_HELDOUT_DENY;
  else process.env.APC_HELDOUT_DENY = prevSwitch;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('W5 — the deny switch is decided per dispatch', () => {
  it('正控: a run whose per-task env carries APC_HELDOUT_DENY=1 gets the deny rules', async () => {
    const captured = await launchAndCapture(client, captures, { APC_HELDOUT_DENY: '1' });

    const deny = denyRules(captured);
    for (const p of APC_HELD_OUT_PATHS) {
      expect(deny).toContain(`Edit(${p})`);
      expect(deny).toContain(`Edit(${p}/**)`);
    }
    // The marker really did reach the spawned process's env, not just the gate.
    expect(captured.env.APC_HELDOUT_DENY).toBe('1');
  });

  it('负控: a concurrent run on the SAME daemon without the marker gets NO deny rules', async () => {
    // Both sessions come from one client ⇒ one daemon, one process.env (with the
    // switch unset). Before W5 the gate read process.env, so this pair could only
    // ever be both-on or both-off — the asymmetry below is the entire fix.
    const apc = await launchAndCapture(client, captures, { APC_HELDOUT_DENY: '1' });
    const normal = await launchAndCapture(client, captures);

    expect(denyRules(apc)).toContain('Edit(scripts/test203/baseline.json)');
    expect(denyRules(normal)).toEqual([]);
    expect(normal.env.APC_HELDOUT_DENY).toBeUndefined();
  });

  it('负控: the daemon-global env alone no longer decides a run that opts out', async () => {
    // A per-task '0' must beat a daemon-wide '1'. This pins the direction of the
    // read: the per-task overlay is layered ON TOP of the daemon env, so the run
    // has the last word.
    process.env.APC_HELDOUT_DENY = '1';

    const optedOut = await launchAndCapture(client, captures, { APC_HELDOUT_DENY: '0' });

    expect(denyRules(optedOut)).toEqual([]);
  });

  it('a normal agent on a clean daemon carries no settings at all', async () => {
    const captured = await launchAndCapture(client, captures);
    // Not merely "no deny list" — buildOptions must not invent a settings payload
    // for an ordinary coding agent.
    expect(captured.settings).toBeUndefined();
  });
});
