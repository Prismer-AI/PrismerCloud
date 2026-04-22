import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/permission-engine.js';
import { FROZEN_DIRS, FROZEN_FILES, FROZEN_GLOBS } from '../src/frozen.js';
import type { PermissionRule } from '../src/types.js';

// Helper: build a structured rule value from tool + optional pattern
function rule(
  source: PermissionRule['source'],
  behavior: PermissionRule['behavior'],
  tool: string,
  pattern?: string,
): PermissionRule {
  return { source, behavior, value: { tool, pattern } };
}

// ============================================================
// EXP-15 scenarios — 11 cases
// ============================================================

describe('permission-engine', () => {
  // EXP-15 test 1
  it('FROZEN files always denied (all modes, all patterns)', () => {
    const frozenFiles = [
      '~/.gitconfig',
      '~/.bashrc',
      '~/.zshrc',
      '~/.npmrc',
      '~/.pypirc',
      '~/.ssh/id_rsa',
      '~/.ssh/config',
      '~/.aws/credentials',
      '~/.env',
      '~/.env.local',
      '~/.env.production',
      '/Users/dev/.ssh/known_hosts',
      '/home/user/.aws/config',
    ];

    const modes = ['default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'auto'] as const;

    // Allow-all rule that must NOT override FROZEN
    const permissiveRules: PermissionRule[] = [rule('policySettings', 'allow', '*')];

    for (const file of frozenFiles) {
      for (const mode of modes) {
        const result = evaluate(permissiveRules, mode, { toolName: 'Edit', filePath: file });
        expect(result.decision, `${file} @ ${mode} should be denied`).toBe('deny');
        expect(result.frozen, `${file} @ ${mode} frozen flag`).toBe(true);
      }
    }

    // bypassPermissions must add a warning
    const bypassResult = evaluate(permissiveRules, 'bypassPermissions', {
      toolName: 'Edit',
      filePath: '~/.ssh/id_rsa',
    });
    expect(bypassResult.warning).toBeTruthy();
  });

  // EXP-15 test 2
  it('Policy rule overrides user rule', () => {
    const rules: PermissionRule[] = [
      rule('userSettings', 'allow', 'Bash'),
      rule('policySettings', 'deny', 'Bash'),
    ];

    const result = evaluate(rules, 'default', { toolName: 'Bash', args: 'rm -rf /' });

    expect(result.decision).toBe('deny');
    expect(result.matchedRule?.source).toBe('policySettings');
  });

  // EXP-15 test 3
  it('Source priority enforced: project > session, local > session', () => {
    // Test A: same specificity — project wins over session
    const rulesA: PermissionRule[] = [
      rule('projectSettings', 'deny', 'Bash', 'npm *'),
      rule('session', 'allow', 'Bash', 'npm *'),
    ];
    const resultA = evaluate(rulesA, 'default', { toolName: 'Bash', args: 'npm install lodash' });
    expect(resultA.decision).toBe('deny');
    expect(resultA.matchedRule?.source).toBe('projectSettings');

    // Test B: localSettings higher priority than session despite session being more specific
    const rulesB: PermissionRule[] = [
      rule('localSettings', 'deny', 'Bash'),
      rule('session', 'allow', 'Bash', 'npm install'),
    ];
    const resultB = evaluate(rulesB, 'default', { toolName: 'Bash', args: 'npm install' });
    expect(resultB.decision).toBe('deny');
    expect(resultB.matchedRule?.source).toBe('localSettings');
  });

  // EXP-15 test 4
  it('acceptEdits mode: Edit/Write auto-allow, Bash asks', () => {
    const noRules: PermissionRule[] = [];

    const editResult  = evaluate(noRules, 'acceptEdits', { toolName: 'Edit',  args: 'src/index.ts' });
    const writeResult = evaluate(noRules, 'acceptEdits', { toolName: 'Write', args: 'new-file.ts' });
    const bashResult  = evaluate(noRules, 'acceptEdits', { toolName: 'Bash',  args: 'npm run build' });
    const readResult  = evaluate(noRules, 'acceptEdits', { toolName: 'Read',  args: 'file.ts' });

    expect(editResult.decision).toBe('allow');
    expect(writeResult.decision).toBe('allow');
    expect(bashResult.decision).toBe('ask');
    expect(readResult.decision).toBe('allow');
  });

  // EXP-15 test 5
  it('plan mode: deny all writes, allow reads', () => {
    const noRules: PermissionRule[] = [];

    const writeTools = ['Bash', 'Edit', 'Write'];
    const readTools  = ['Read', 'Grep', 'Glob'];

    for (const tool of writeTools) {
      const r = evaluate(noRules, 'plan', { toolName: tool, args: 'x' });
      expect(r.decision, `${tool} should be denied in plan mode`).toBe('deny');
    }
    for (const tool of readTools) {
      const r = evaluate(noRules, 'plan', { toolName: tool, args: 'x' });
      expect(r.decision, `${tool} should be allowed in plan mode`).toBe('allow');
    }
  });

  // EXP-15 test 6
  it('Wildcard patterns: Bash(npm *) and Bash(rm *)', () => {
    const rules: PermissionRule[] = [
      rule('session', 'allow', 'Bash', 'npm *'),
      rule('session', 'deny',  'Bash', 'rm *'),
    ];

    const cases: Array<{ args: string; expected: 'allow' | 'deny' | 'ask'; label: string }> = [
      { args: 'npm install lodash', expected: 'allow', label: 'npm install -> allow' },
      { args: 'npm run build',      expected: 'allow', label: 'npm run build -> allow' },
      { args: 'npm test',           expected: 'allow', label: 'npm test -> allow' },
      { args: 'rm -rf /tmp',        expected: 'deny',  label: 'rm -rf -> deny' },
      { args: 'rm file.txt',        expected: 'deny',  label: 'rm file -> deny' },
      { args: 'git status',         expected: 'ask',   label: 'git status -> ask (no match, default mode)' },
    ];

    for (const c of cases) {
      const result = evaluate(rules, 'default', { toolName: 'Bash', args: c.args });
      expect(result.decision, c.label).toBe(c.expected);
    }
  });

  // EXP-15 test 7
  it('Rule specificity: Bash(git push) deny beats Bash(git *) allow', () => {
    const rules: PermissionRule[] = [
      rule('session', 'allow', 'Bash', 'git *'),
      rule('session', 'deny',  'Bash', 'git push'),
    ];

    expect(evaluate(rules, 'default', { toolName: 'Bash', args: 'git push'   }).decision).toBe('deny');
    expect(evaluate(rules, 'default', { toolName: 'Bash', args: 'git pull'   }).decision).toBe('allow');
    expect(evaluate(rules, 'default', { toolName: 'Bash', args: 'git status' }).decision).toBe('allow');
    expect(evaluate(rules, 'default', { toolName: 'Bash', args: 'git commit' }).decision).toBe('allow');
  });

  // EXP-15 test 8
  it('Full 8-level priority chain (each level beats the next)', () => {
    const allSources: PermissionRule['source'][] = [
      'policySettings',
      'userSettings',
      'projectSettings',
      'localSettings',
      'skill',
      'session',
      'cliArg',
      'command',
    ];

    for (let i = 0; i < allSources.length - 1; i++) {
      const highSource = allSources[i];
      const lowSource  = allSources[i + 1];

      const rules: PermissionRule[] = [
        rule(lowSource,  'allow', 'Bash'),
        rule(highSource, 'deny',  'Bash'),
      ];

      const result = evaluate(rules, 'default', { toolName: 'Bash', args: 'echo test' });
      expect(result.decision, `${highSource} should beat ${lowSource}`).toBe('deny');
      expect(result.matchedRule?.source, `matched source should be ${highSource}`).toBe(highSource);
    }
  });

  // G1 — 'skill' source
  it("'skill' source is a valid PermissionRule", () => {
    const skillRule: PermissionRule = rule('skill', 'allow', 'Bash', 'npm *');
    const result = evaluate([skillRule], 'default', { toolName: 'Bash', args: 'npm install' });
    expect(result.decision).toBe('allow');
    expect(result.matchedRule?.source).toBe('skill');
  });

  it("priority: localSettings > skill > session", () => {
    // skill deny beats session allow
    const rulesA: PermissionRule[] = [
      rule('skill',   'deny',  'Edit'),
      rule('session', 'allow', 'Edit'),
    ];
    const resultA = evaluate(rulesA, 'default', { toolName: 'Edit', args: 'file.ts' });
    expect(resultA.decision).toBe('deny');
    expect(resultA.matchedRule?.source).toBe('skill');

    // localSettings deny beats skill allow
    const rulesB: PermissionRule[] = [
      rule('localSettings', 'deny',  'Edit'),
      rule('skill',         'allow', 'Edit'),
    ];
    const resultB = evaluate(rulesB, 'default', { toolName: 'Edit', args: 'file.ts' });
    expect(resultB.decision).toBe('deny');
    expect(resultB.matchedRule?.source).toBe('localSettings');
  });

  // EXP-15 test 9
  it('bypassPermissions: allows non-frozen, FROZEN still denied', () => {
    const denyRules: PermissionRule[] = [rule('policySettings', 'deny', '*')];

    // Explicit deny rule still wins even in bypassPermissions
    const normalResult = evaluate(denyRules, 'bypassPermissions', {
      toolName: 'Bash',
      args: 'rm -rf /',
    });
    expect(normalResult.decision).toBe('deny');

    // No rules + bypassPermissions → allow
    const noRuleResult = evaluate([], 'bypassPermissions', {
      toolName: 'Bash',
      args: 'rm -rf /',
    });
    expect(noRuleResult.decision).toBe('allow');

    // FROZEN file still denied
    const frozenResult = evaluate([], 'bypassPermissions', {
      toolName: 'Edit',
      filePath: '~/.ssh/id_rsa',
    });
    expect(frozenResult.decision).toBe('deny');
  });

  // EXP-15 test 10
  it('Multiple rules same source: specificity tiebreak', () => {
    const rules: PermissionRule[] = [
      rule('session', 'allow', '*'),                   // specificity: 0
      rule('session', 'deny',  'Bash'),                // specificity: 100
      rule('session', 'allow', 'Bash', 'git status'),  // specificity: 150
    ];

    // Most specific "Bash(git status)" allow wins
    const statusResult = evaluate(rules, 'default', { toolName: 'Bash', args: 'git status' });
    expect(statusResult.decision).toBe('allow');

    // "Bash" deny is more specific than "*" allow
    const pushResult = evaluate(rules, 'default', { toolName: 'Bash', args: 'git push' });
    expect(pushResult.decision).toBe('deny');

    // Read only matches "*" allow
    const readResult = evaluate(rules, 'default', { toolName: 'Read', args: 'file.ts' });
    expect(readResult.decision).toBe('allow');
  });

  // EXP-15 test 11
  it('default mode: ask for writes, allow for reads', () => {
    const noRules: PermissionRule[] = [];
    const writeTools = ['Bash', 'Edit', 'Write'];
    const readTools  = ['Read', 'Grep'];

    for (const tool of writeTools) {
      const r = evaluate(noRules, 'default', { toolName: tool, args: 'x' });
      expect(r.decision, `${tool} should ask in default mode`).toBe('ask');
    }
    for (const tool of readTools) {
      const r = evaluate(noRules, 'default', { toolName: tool, args: 'x' });
      expect(r.decision, `${tool} should allow in default mode`).toBe('allow');
    }
  });

  it('dontAsk mode denies unmatched calls but still honors explicit allow rules', () => {
    const unmatched = evaluate([], 'dontAsk', { toolName: 'Read', args: 'src/index.ts' });
    expect(unmatched.decision).toBe('deny');

    const allowed = evaluate(
      [rule('session', 'allow', 'Read', 'src/*')],
      'dontAsk',
      { toolName: 'Read', args: 'src/index.ts' },
    );
    expect(allowed.decision).toBe('allow');
  });

  // ============================================================
  // FROZEN integration regression — covers every entry in frozen.ts
  // If a new entry is added to FROZEN_FILES/DIRS/GLOBS, this test
  // automatically exercises it without any changes here.
  // ============================================================

  describe('FROZEN regression: all frozen.ts entries', () => {
    const bypassMode = 'bypassPermissions' as const;

    it('FROZEN_FILES entries are all denied', () => {
      for (const filename of FROZEN_FILES) {
        // Use a home-relative path as a realistic caller would
        const filePath = `/home/user/${filename}`;
        const result = evaluate([], bypassMode, { toolName: 'Edit', filePath });
        expect(result.decision,  `FROZEN_FILES[${filename}] decision`).toBe('deny');
        expect(result.frozen,    `FROZEN_FILES[${filename}] frozen flag`).toBe(true);
        expect(result.warning,   `FROZEN_FILES[${filename}] bypass warning`).toBeTruthy();
      }
    });

    it('FROZEN_DIRS entries are all denied', () => {
      for (const dir of FROZEN_DIRS) {
        // Construct a realistic path that contains this directory segment
        const filePath = `/home/user/${dir}/somefile.txt`;
        const result = evaluate([], bypassMode, { toolName: 'Write', filePath });
        expect(result.decision,  `FROZEN_DIRS[${dir}] decision`).toBe('deny');
        expect(result.frozen,    `FROZEN_DIRS[${dir}] frozen flag`).toBe(true);
        expect(result.warning,   `FROZEN_DIRS[${dir}] bypass warning`).toBeTruthy();
      }
    });

    it('FROZEN_GLOBS entries are all denied', () => {
      // Map each glob to a realistic matching path for testing
      const globExamples: Record<string, string> = {
        '**/*.pem':         '/workspace/certs/server.pem',
        '**/*.key':         '/workspace/keys/private.key',
        '**/.env*':         '/workspace/src/.env.production',
        '**/credentials.*': '/home/user/.aws/credentials.json',
      };

      for (const glob of FROZEN_GLOBS) {
        const filePath = globExamples[glob] ?? `/workspace/matched-${glob.replace(/\*\*/g, 'x').replace(/\*/g, 'y')}`;
        const result = evaluate([], bypassMode, { toolName: 'Edit', filePath });
        expect(result.decision,  `FROZEN_GLOBS[${glob}] decision for ${filePath}`).toBe('deny');
        expect(result.frozen,    `FROZEN_GLOBS[${glob}] frozen flag`).toBe(true);
        expect(result.warning,   `FROZEN_GLOBS[${glob}] bypass warning`).toBeTruthy();
      }
    });
  });
});
