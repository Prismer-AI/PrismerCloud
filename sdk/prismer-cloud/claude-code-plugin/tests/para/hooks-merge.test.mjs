/**
 * hooks-merge.test.mjs — Unit tests for scripts/lib/hooks-merge.mjs
 *
 * Covers the 5 scenarios from EXP-13 + idempotency:
 *   1. Empty → add PARA hooks
 *   2. Legacy Evolution hooks → replace with PARA
 *   3. User custom hooks → preserve + add PARA
 *   4. Mixed (user + legacy + third-party) → preserve all non-legacy + add PARA
 *   5. Rollback: remove only PARA entries, restore user hooks
 *   6. Idempotency: migrate twice = same result
 */

import { describe, it, expect } from 'vitest';
import { mergePara, removePara, PARA_HOOK_MARKER, LEGACY_HOOK_MARKERS } from '../../scripts/lib/hooks-merge.mjs';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Minimal set of PARA hooks (mirrors what setup.mjs would inject). */
const PARA_HOOKS = {
  PreToolUse: [
    {
      matcher: '.*',
      hooks: [{ type: 'command', command: `node /opt/plugin/hooks/${PARA_HOOK_MARKER} PreToolUse` }],
    },
  ],
  PostToolUse: [
    {
      matcher: '.*',
      hooks: [{ type: 'command', command: `node /opt/plugin/hooks/${PARA_HOOK_MARKER} PostToolUse` }],
    },
  ],
  SessionStart: [
    {
      matcher: '.*',
      hooks: [{ type: 'command', command: `node /opt/plugin/hooks/${PARA_HOOK_MARKER} SessionStart` }],
    },
  ],
  SessionEnd: [
    {
      matcher: '.*',
      hooks: [{ type: 'command', command: `node /opt/plugin/hooks/${PARA_HOOK_MARKER} SessionEnd` }],
    },
  ],
  Stop: [
    {
      matcher: '.*',
      hooks: [{ type: 'command', command: `node /opt/plugin/hooks/${PARA_HOOK_MARKER} Stop` }],
    },
  ],
};

/** Legacy Prismer Evolution hook config (uses session-start.mjs etc). */
const LEGACY_HOOKS = {
  PreToolUse: [
    {
      matcher: '.*',
      hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/evolution-hook.js" PreToolUse' }],
    },
  ],
  PostToolUse: [
    {
      matcher: '.*',
      hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/evolution-hook.js" PostToolUse' }],
    },
  ],
  SessionStart: [
    {
      matcher: 'startup|resume|clear|compact',
      hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs"' }],
    },
  ],
};

// ─── Scenario 1: Empty → PARA ─────────────────────────────────────────────────

describe('Scenario 1: Empty hooks.json → add PARA entries', () => {
  it('should add all PARA event types', () => {
    const { result } = mergePara({}, PARA_HOOKS);
    expect(Object.keys(result)).toEqual(expect.arrayContaining(Object.keys(PARA_HOOKS)));
  });

  it('should mark all added entries as PARA (contain marker)', () => {
    const { result } = mergePara({}, PARA_HOOKS);
    for (const [event, rules] of Object.entries(result)) {
      const hasPara = rules.some((r) => r.hooks.some((h) => h.command.includes(PARA_HOOK_MARKER)));
      expect(hasPara).toBe(true);
    }
  });

  it('should report ADD actions for each event', () => {
    const { actions } = mergePara({}, PARA_HOOKS);
    const adds = actions.filter((a) => a.startsWith('ADD PARA'));
    expect(adds.length).toBe(Object.keys(PARA_HOOKS).length);
  });
});

// ─── Scenario 2: Legacy Prismer hooks → replace with PARA ────────────────────

describe('Scenario 2: Legacy Prismer Evolution hooks → PARA upgrade', () => {
  it('removes legacy hooks from result', () => {
    const { result } = mergePara(LEGACY_HOOKS, PARA_HOOKS);
    const allCmds = JSON.stringify(result);
    expect(allCmds).not.toContain('evolution-hook.js');
    expect(allCmds).not.toContain('session-start.mjs');
  });

  it('adds PARA hooks in their place', () => {
    const { result } = mergePara(LEGACY_HOOKS, PARA_HOOKS);
    const allCmds = JSON.stringify(result);
    expect(allCmds).toContain(PARA_HOOK_MARKER);
  });

  it('adds new PARA-only events (SessionEnd, Stop) that did not exist before', () => {
    const { result } = mergePara(LEGACY_HOOKS, PARA_HOOKS);
    expect('SessionEnd' in result).toBe(true);
    expect('Stop' in result).toBe(true);
  });

  it('logs REMOVE actions for legacy entries', () => {
    const { actions } = mergePara(LEGACY_HOOKS, PARA_HOOKS);
    const removes = actions.filter((a) => a.startsWith('REMOVE legacy'));
    expect(removes.length).toBeGreaterThan(0);
  });
});

// ─── Scenario 3: User custom hooks preserved ─────────────────────────────────

describe('Scenario 3: User custom hooks preserved after merge', () => {
  const userHooks = {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'echo "Custom safety check for Bash"' }],
      },
    ],
    PostToolUse: [
      {
        matcher: 'Edit',
        hooks: [{ type: 'command', command: '/usr/local/bin/my-formatter.sh' }],
      },
    ],
  };

  it('keeps user hooks in result', () => {
    const { result } = mergePara(userHooks, PARA_HOOKS);
    const userBashKept = result.PreToolUse?.some(
      (r) => r.matcher === 'Bash' && r.hooks.some((h) => h.command.includes('safety check')),
    );
    const userEditKept = result.PostToolUse?.some(
      (r) => r.matcher === 'Edit' && r.hooks.some((h) => h.command.includes('formatter')),
    );
    expect(userBashKept).toBe(true);
    expect(userEditKept).toBe(true);
  });

  it('adds PARA hooks alongside user hooks', () => {
    const { result } = mergePara(userHooks, PARA_HOOKS);
    const paraCoexist = result.PreToolUse?.some(
      (r) => r.hooks.some((h) => h.command.includes(PARA_HOOK_MARKER)),
    );
    expect(paraCoexist).toBe(true);
  });
});

// ─── Scenario 4: Mixed (user + legacy + third-party) ─────────────────────────

describe('Scenario 4: Mixed hooks — user + legacy + third-party preserved', () => {
  const mixedHooks = {
    PreToolUse: [
      // User hook
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo "user safety"' }] },
      // Legacy Prismer hook
      { matcher: '.*', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/evolution-hook.js" PreToolUse' }] },
      // Third-party hook
      { matcher: '.*', hooks: [{ type: 'command', command: '/opt/other-plugin/hook.sh PreToolUse' }] },
    ],
    SessionStart: [
      { matcher: '', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs"' }] },
    ],
  };

  it('preserves user hooks', () => {
    const { result } = mergePara(mixedHooks, PARA_HOOKS);
    const userKept = result.PreToolUse?.some((r) => r.hooks.some((h) => h.command.includes('user safety')));
    expect(userKept).toBe(true);
  });

  it('preserves third-party hooks', () => {
    const { result } = mergePara(mixedHooks, PARA_HOOKS);
    const thirdPartyKept = result.PreToolUse?.some((r) => r.hooks.some((h) => h.command.includes('other-plugin')));
    expect(thirdPartyKept).toBe(true);
  });

  it('removes legacy Prismer hooks', () => {
    const { result } = mergePara(mixedHooks, PARA_HOOKS);
    const allCmds = JSON.stringify(result);
    expect(allCmds).not.toContain('evolution-hook.js');
  });

  it('adds PARA hooks', () => {
    const { result } = mergePara(mixedHooks, PARA_HOOKS);
    const paraAdded = JSON.stringify(result).includes(PARA_HOOK_MARKER);
    expect(paraAdded).toBe(true);
  });
});

// ─── Scenario 5: Rollback ─────────────────────────────────────────────────────

describe('Scenario 5: Rollback removes only PARA, restores user hooks', () => {
  const userHooks = {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo "keep me"' }] },
    ],
  };

  it('user hooks survive migrate → rollback', () => {
    const { result: migrated } = mergePara(userHooks, PARA_HOOKS);
    const { result: rolledBack } = removePara(migrated);
    const userKept = rolledBack.PreToolUse?.some((r) => r.hooks.some((h) => h.command.includes('keep me')));
    expect(userKept).toBe(true);
  });

  it('PARA hooks are gone after rollback', () => {
    const { result: migrated } = mergePara(userHooks, PARA_HOOKS);
    const { result: rolledBack } = removePara(migrated);
    expect(JSON.stringify(rolledBack)).not.toContain(PARA_HOOK_MARKER);
  });

  it('PARA-only events are fully removed after rollback', () => {
    const { result: migrated } = mergePara(userHooks, PARA_HOOKS);
    const { result: rolledBack } = removePara(migrated);
    // SessionEnd, Stop were PARA-only
    expect('SessionEnd' in rolledBack).toBe(false);
    expect('Stop' in rolledBack).toBe(false);
  });

  it('rollback actions describe what was removed', () => {
    const { result: migrated } = mergePara(userHooks, PARA_HOOKS);
    const { actions } = removePara(migrated);
    expect(actions.length).toBeGreaterThan(0);
    const removals = actions.filter((a) => a.startsWith('REMOVE all'));
    expect(removals.length).toBeGreaterThan(0);
  });
});

// ─── Idempotency ──────────────────────────────────────────────────────────────

describe('Idempotency: merging twice produces the same result', () => {
  it('double-merge equals single merge', () => {
    const { result: first } = mergePara({}, PARA_HOOKS);
    const { result: second } = mergePara(first, PARA_HOOKS);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('skips already-present PARA entries on second merge', () => {
    const { result: first, actions: firstActions } = mergePara({}, PARA_HOOKS);
    const { actions: secondActions } = mergePara(first, PARA_HOOKS);
    const firstAdds = firstActions.filter((a) => a.startsWith('ADD PARA')).length;
    const secondAdds = secondActions.filter((a) => a.startsWith('ADD PARA')).length;
    const secondSkips = secondActions.filter((a) => a.startsWith('SKIP PARA')).length;
    expect(firstAdds).toBeGreaterThan(0);
    expect(secondAdds).toBe(0);
    expect(secondSkips).toBe(firstAdds);
  });
});
