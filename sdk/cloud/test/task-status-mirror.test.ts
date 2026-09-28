/**
 * Nine-state mirror — Cloud SDK side (T-P0-2).
 *
 * Pins three mirror sites against the DOCUMENTED nine-state list (hardcoded
 * here). 跨包契约（服务端 canon 钉住全部五份拷贝）=
 * src/im/tests/acp-nine-state-text-contract.test.ts（评审修复）。
 *  1. `types.TaskStatus` — compile-time pin.
 *  2. `catalog/skills/tasks/SKILL.md` — lifecycle line set equality.
 *  3. `docs/specs/im-tasks.yaml` — status enum set equality, no `claimed`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

import type { TaskStatus } from '../src/types';

/** Canonical nine-state list — mirror of src/im/types/index.ts TaskStatus. */
const CANON_NINE: TaskStatus[] = [
  'pending',
  'assigned',
  'running',
  'review',
  'blocked',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
];

// sdk/cloud/test → repo root
const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('nine-state mirror — SDK (T-P0-2)', () => {
  it('SDK TaskStatus covers all nine canonical states (compile-time pin)', () => {
    expect(CANON_NINE).toHaveLength(9);
  });

  it('tasks SKILL.md lifecycle names exactly the canonical nine', () => {
    const md = fs.readFileSync(path.join(ROOT, 'sdk/cloud/catalog/skills/tasks/SKILL.md'), 'utf8');
    const line = md.match(/Nine-state lifecycle: `([^`]+)`/);
    expect(line, 'SKILL.md must carry the Nine-state lifecycle line').toBeTruthy();
    const named = (line![1].match(/[a-z_]+/g) ?? []).filter((s): s is TaskStatus =>
      (CANON_NINE as string[]).includes(s),
    );
    expect(new Set(named)).toEqual(new Set(CANON_NINE));
  });

  it('im-tasks.yaml status enum equals canonical nine and has no claimed', () => {
    const yaml = fs.readFileSync(path.join(ROOT, 'docs/specs/im-tasks.yaml'), 'utf8');
    const block = yaml.match(/name: status[\s\S]*?enum:([\s\S]*?)- name: keyResultId/);
    expect(block, 'im-tasks.yaml must carry a status enum before the capability param').toBeTruthy();
    const entries = (block![1].match(/-\s+([a-z_]+)/g) ?? []).map((s) => s.replace(/^\s*-\s*/, ''));
    expect(new Set(entries)).toEqual(new Set(CANON_NINE));
    expect(entries).not.toContain('claimed');
  });
});
