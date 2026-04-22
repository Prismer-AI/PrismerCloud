// T13 — hooks.test.ts: port of EXP-13 six scenarios + file I/O tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  mergeHooks,
  readHookConfig,
  writeHookConfig,
  installHooks,
  rollbackHooks,
  type HookConfig,
  type HookEntry,
} from '../../src/agents/hooks.js';

// ============================================================
// Constants (mirrored from EXP-13)
// ============================================================

const LEGACY_HOOK_MARKER = 'evolution-hook.js';
const PARA_EMIT_MARKER = 'para-emit';
const PARA_ADAPTER_MARKER = '/opt/prismer/runtime/para-adapter.js';

/** Plugin root used in tests (resolvePluginRoot fallback). */
const TEST_PLUGIN_ROOT = '/opt/prismer/test-plugin';

// v1.8 Prismer legacy hooks (EXP-13 LEGACY_PRISMER_HOOKS)
const LEGACY_CONFIG: HookConfig = {
  hooks: {
    PreToolUse: [
      {
        matcher: '.*',
        hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/evolution-hook.js" PreToolUse' }],
      } as unknown as HookEntry,
    ],
    PostToolUse: [
      {
        matcher: '.*',
        hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/evolution-hook.js" PostToolUse' }],
      } as unknown as HookEntry,
    ],
    SessionStart: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs"' }],
      } as unknown as HookEntry,
    ],
  },
};

// ============================================================
// Helpers
// ============================================================

function configStr(cfg: HookConfig): string {
  return JSON.stringify(cfg);
}

// ============================================================
// Scenario 1: Fresh install (no existing config)
// ============================================================

describe('mergeHooks — fresh install', () => {
  it('should add all PARA hooks when config is null', () => {
    const { merged, added, replaced, preserved } = mergeHooks(null, {
      daemonUrl: 'http://127.0.0.1:3210',
      pluginRoot: TEST_PLUGIN_ROOT,
    });

    // All PARA events should be present
    const hooks = merged.hooks;
    expect(Object.keys(hooks)).toContain('PreToolUse');
    expect(Object.keys(hooks)).toContain('PostToolUse');
    expect(Object.keys(hooks)).toContain('SessionStart');
    expect(Object.keys(hooks)).toContain('SessionEnd');
    expect(Object.keys(hooks)).toContain('Stop');
    expect(Object.keys(hooks)).toContain('PostToolUseFailure');
    expect(Object.keys(hooks)).toContain('Elicitation');

    // Everything was added — nothing replaced or preserved
    expect(added.length).toBeGreaterThan(0);
    expect(replaced.length).toBe(0);
    expect(preserved.length).toBe(0);

    // Content has PARA emit marker and uses para-emit.mjs
    expect(configStr(merged)).toContain(PARA_EMIT_MARKER);
    expect(configStr(merged)).toContain(TEST_PLUGIN_ROOT + '/hooks/para-emit.mjs');
  });

  it('should add all 26 PARA hook events when config is empty', () => {
    const { merged, added } = mergeHooks({ hooks: {} }, {
      daemonUrl: 'http://127.0.0.1:3210',
      pluginRoot: TEST_PLUGIN_ROOT,
    });
    expect(added.length).toBe(26); // All PARA_HOOK_EVENTS
    expect(configStr(merged)).toContain(PARA_EMIT_MARKER);
  });

  it('should use Claude Code nested format with matcher and hooks array', () => {
    const { merged } = mergeHooks(null, {
      daemonUrl: 'http://127.0.0.1:3210',
      pluginRoot: TEST_PLUGIN_ROOT,
    });

    // Verify nested format for PreToolUse
    const preToolUse = merged.hooks['PreToolUse'] as HookEntry[];
    expect(preToolUse).toHaveLength(1);
    const entry = preToolUse[0] as any;
    expect(entry.matcher).toBe('.*');
    expect(entry.hooks).toHaveLength(1);
    expect(entry.hooks[0].type).toBe('command');
    expect(entry.hooks[0].command).toContain('para-emit.mjs');
    expect(entry.hooks[0].command).toContain('PreToolUse');
  });
});

// ============================================================
// Scenario 2: v1.8 upgrade
// ============================================================

describe('mergeHooks — v1.8 upgrade', () => {
  it('should remove legacy Prismer hooks and add PARA hooks', () => {
    const { merged, replaced, added } = mergeHooks(LEGACY_CONFIG, {
      daemonUrl: 'http://127.0.0.1:3210',
      pluginRoot: TEST_PLUGIN_ROOT,
    });

    // Legacy marker should be gone
    expect(configStr(merged)).not.toContain(LEGACY_HOOK_MARKER);
    expect(configStr(merged)).not.toContain('session-start.mjs');

    // PARA hooks should be present
    expect(configStr(merged)).toContain(PARA_EMIT_MARKER);

    // SessionEnd should be present (new event not in legacy)
    expect(merged.hooks['SessionEnd']).toBeDefined();

    // replaced has the legacy event names
    expect(replaced.length).toBeGreaterThan(0);
    // added has new events like SessionEnd, Stop
    expect(added.length).toBeGreaterThan(0);
  });
});

// ============================================================
// Scenario 3: User custom hooks preserved
// ============================================================

describe('mergeHooks — user custom preserved', () => {
  it('should keep user hooks and add PARA hooks alongside', () => {
    const userConfig: HookConfig = {
      hooks: {
        PreToolUse: [{
          command: 'echo "Custom safety check for Bash"',
          matcher: 'Bash',
        }],
        PostToolUse: [{
          command: '/usr/local/bin/my-formatter.sh',
          matcher: 'Edit',
        }],
      },
    };

    const { merged, preserved } = mergeHooks(userConfig, {
      daemonUrl: 'http://127.0.0.1:3210',
      pluginRoot: TEST_PLUGIN_ROOT,
    });

    const str = configStr(merged);

    // User hooks still present
    expect(str).toContain('safety check');
    expect(str).toContain('my-formatter.sh');

    // PARA hooks also present
    expect(str).toContain(PARA_EMIT_MARKER);

    // preserved has user hook events
    expect(preserved.length).toBeGreaterThan(0);
  });
});

// ============================================================
// Scenario 4: Mixed (v1.8 Prismer + user custom + third-party)
// ============================================================

describe('mergeHooks — mixed scenario', () => {
  it('should handle user + legacy + third-party correctly', () => {
    const mixedConfig: HookConfig = {
      hooks: {
        PreToolUse: [
          { command: 'echo "user safety"', matcher: 'Bash' },
          {
            command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/evolution-hook.js" PreToolUse',
            matcher: '.*',
          },
          { command: '/opt/other-plugin/hook.sh PreToolUse', matcher: '.*' },
        ],
        SessionStart: [
          { command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs"', matcher: '' },
        ],
      },
    };

    const { merged } = mergeHooks(mixedConfig, { daemonUrl: 'http://127.0.0.1:3210', pluginRoot: TEST_PLUGIN_ROOT });
    const str = configStr(merged);

    // User hook preserved
    expect(str).toContain('user safety');
    // Third-party preserved
    expect(str).toContain('other-plugin');
    // Legacy removed
    expect(str).not.toContain(LEGACY_HOOK_MARKER);
    expect(str).not.toContain('session-start.mjs');
    // PARA added
    expect(str).toContain(PARA_EMIT_MARKER);
  });
});

// ============================================================
// Scenario 5: Rollback
// ============================================================

describe('rollbackHooks — file I/O', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-hooks-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should restore from backup and delete backup after restore', async () => {
    const configPath = path.join(tmpDir, 'hooks.json');
    const originalConfig: HookConfig = {
      hooks: {
        PreToolUse: [{ command: 'echo "keep me"', matcher: 'Bash' }],
      },
    };

    // Write original
    await writeHookConfig(configPath, originalConfig);

    // Install (creates backup)
    await installHooks(configPath, originalConfig, { daemonUrl: 'http://127.0.0.1:3210', pluginRoot: TEST_PLUGIN_ROOT });

    // Verify PARA hooks are in the file
    const after = await readHookConfig(configPath);
    expect(JSON.stringify(after)).toContain(PARA_EMIT_MARKER);

    // Rollback
    const rollback = await rollbackHooks(configPath);
    expect(rollback.restored).toBe(true);
    expect(rollback.fromBackup).not.toBeNull();

    // Verify restored content
    const restored = await readHookConfig(configPath);
    expect(JSON.stringify(restored)).toContain('keep me');
    expect(JSON.stringify(restored)).not.toContain(PARA_EMIT_MARKER);

    // Backup should be deleted
    const backupExists = rollback.fromBackup !== null && fs.existsSync(rollback.fromBackup);
    expect(backupExists).toBe(false);
  });

  it('second rollback after restore returns restored:false', async () => {
    const configPath = path.join(tmpDir, 'hooks.json');
    const originalConfig: HookConfig = { hooks: { PreToolUse: [{ command: 'echo "x"' }] } };

    await writeHookConfig(configPath, originalConfig);
    await installHooks(configPath, originalConfig, { daemonUrl: 'http://127.0.0.1:3210', pluginRoot: TEST_PLUGIN_ROOT });
    await rollbackHooks(configPath); // first rollback — consumes backup

    const second = await rollbackHooks(configPath);
    expect(second.restored).toBe(false);
    expect(second.fromBackup).toBeNull();
  });

  it('rollback with no backup returns restored:false', async () => {
    const configPath = path.join(tmpDir, 'hooks.json');
    const result = await rollbackHooks(configPath);
    expect(result.restored).toBe(false);
    expect(result.fromBackup).toBeNull();
  });
});

// ============================================================
// Scenario 6: Idempotency
// ============================================================

describe('mergeHooks — idempotency', () => {
  it('merging twice produces identical output with zero added/replaced on second pass', () => {
    const opts = { daemonUrl: 'http://127.0.0.1:3210', pluginRoot: TEST_PLUGIN_ROOT };
    const { merged: first, added: firstAdded } = mergeHooks(null, opts);
    const { merged: second, added: secondAdded, replaced: secondReplaced } = mergeHooks(first, opts);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(firstAdded.length).toBeGreaterThan(0);
    expect(secondAdded.length).toBe(0);
    expect(secondReplaced.length).toBe(0);
  });

  it('is idempotent with legacy config — second run adds nothing', () => {
    const opts = { daemonUrl: 'http://127.0.0.1:3210', pluginRoot: TEST_PLUGIN_ROOT };
    const { merged: first } = mergeHooks(LEGACY_CONFIG, opts);
    const { merged: second, added: secondAdded, replaced: secondReplaced } = mergeHooks(first, opts);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(secondAdded.length).toBe(0);
    expect(secondReplaced.length).toBe(0);
  });
});

// ============================================================
// readHookConfig / writeHookConfig
// ============================================================

describe('readHookConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-hooks-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for non-existent file', async () => {
    const result = await readHookConfig(path.join(tmpDir, 'nope.json'));
    expect(result).toBeNull();
  });

  it('returns { hooks: {} } for malformed JSON', async () => {
    const p = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(p, 'not json', 'utf-8');
    const result = await readHookConfig(p);
    expect(result).toEqual({ hooks: {} });
  });

  it('reads a valid config', async () => {
    const cfg: HookConfig = { hooks: { PreToolUse: [{ command: 'echo x' }] } };
    const p = path.join(tmpDir, 'hooks.json');
    await writeHookConfig(p, cfg);
    const result = await readHookConfig(p);
    expect(result?.hooks?.['PreToolUse']).toBeDefined();
  });
});
