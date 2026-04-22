/**
 * D12 canonical-type guard — verifies that PermissionMode, PermissionRule, and
 * PermissionRuleSource are declared ONLY in sandbox-runtime/src/types.ts.
 *
 * Per docs/version190/04-sandbox-permissions.md §5.1.1:
 *   "唯一实现在 @prismer/sandbox-runtime. CI 阻止重复定义"
 *   ("Single implementation in @prismer/sandbox-runtime. CI blocks re-declarations.")
 *
 * Design notes:
 *   - Uses Node.js spawnSync + grep to scan the sdk/ tree at the repo root.
 *   - Excludes: dist/ (compiled output), node_modules/, test/ files.
 *   - Pattern targets TYPE/INTERFACE DECLARATIONS (^export type / ^export interface),
 *     not import re-exports (export type { ... } from ...) which are allowed.
 *   - grep -E is available on macOS + Linux (POSIX). spawnSync avoids shell injection.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

describe('D12 canonical types guard', () => {
  it('PermissionMode / PermissionRule / PermissionRuleSource declared only in sandbox-runtime/src/types.ts', () => {
    const repoRoot = path.resolve(__dirname, '../../../..');

    // Spawn grep directly — no shell, no injection risk. Input is all literals.
    const result = spawnSync(
      'grep',
      [
        '-rn',
        '-E',
        '^export (type|interface) (PermissionMode|PermissionRule|PermissionRuleSource)[^a-zA-Z_]',
        'sdk/',
        '--include=*.ts',
      ],
      { cwd: repoRoot, encoding: 'utf-8' },
    );

    // grep exits 0 on match, 1 on no match, 2 on error.
    // Exit 2 means grep itself failed (bad pattern, missing dir) — surface as test failure.
    if (result.status === 2) {
      throw new Error(`grep failed: ${result.stderr}`);
    }

    const lines = (result.stdout ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(
        (l) =>
          l.length > 0 &&
          !l.includes('/dist/') &&
          !l.includes('/node_modules/') &&
          !l.includes('/test/'),
      );

    const violations = lines.filter(
      (l) => !l.includes('sandbox-runtime/src/types.ts'),
    );

    expect(
      violations,
      `D12 violation — canonical types re-declared outside sandbox-runtime/src/types.ts:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
