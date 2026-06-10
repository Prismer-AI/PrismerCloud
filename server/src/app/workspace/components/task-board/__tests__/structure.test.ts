/**
 * Structure smoke for the post-split task-board package (v2.0.8 H2).
 *
 * Validates:
 *  - The `./task-board` (index) re-exports keep TaskBoard + computeKanbanPosition
 *    importable at the historic path so `page.tsx` / unit tests didn't move.
 *  - Each sibling file in `task-board/` stays under a 600-line ceiling
 *    (split goal was ≤ 500; we cap at 600 to leave breathing room for
 *    future helper additions without forcing another split). Catches
 *    accidental dump-back-into-index regressions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';

import * as taskBoardModule from '../index';
import { computeKanbanPosition as computeFromHelpers } from '../helpers';
import { computeKanbanPosition as computeFromIndex } from '../index';

const DIR = path.resolve(__dirname, '..');

describe('task-board package structure (v2.0.8 H2)', () => {
  test('re-export surface: TaskBoard + computeKanbanPosition resolve via index', () => {
    expect(typeof taskBoardModule.TaskBoard).toBe('function');
    expect(typeof taskBoardModule.computeKanbanPosition).toBe('function');
    // index re-exports the helpers binding directly — same reference,
    // not a thin wrapper. Guards against accidental re-implementation
    // that drifts from helpers/test contract.
    expect(computeFromIndex).toBe(computeFromHelpers);
  });

  test('each sibling file stays under 500 lines', () => {
    const ceiling = 500;
    const files = fs
      .readdirSync(DIR)
      .filter((f) => /\.(tsx?|ts)$/.test(f))
      .filter((f) => !f.includes('.test.'));
    expect(files.length).toBeGreaterThanOrEqual(5); // 5 split files minimum
    const oversized: Array<{ file: string; lines: number }> = [];
    for (const f of files) {
      const content = fs.readFileSync(path.join(DIR, f), 'utf-8');
      const lines = content.split('\n').length;
      if (lines > ceiling) oversized.push({ file: f, lines });
    }
    expect(oversized).toEqual([]);
  });

  test('expected split files exist', () => {
    const expected = [
      'index.tsx',
      'helpers.ts',
      'types.ts',
      'kanban-column.tsx',
      'board-metrics-strip.tsx',
      'dialogs.tsx',
      'column-config.ts',
      'use-kanban-dnd.ts',
    ];
    for (const f of expected) {
      const p = path.join(DIR, f);
      expect(fs.existsSync(p), `expected ${f} to exist`).toBe(true);
    }
  });
});
