/**
 * release 200 P5 — B-tree midpoint position helper for kanban reorder.
 *
 * The board calls `computeKanbanPosition(neighbors, dropIndex)` once per
 * drop, where `neighbors` is the column's existing tasks (sorted by
 * position ASC, excluding the dragged task) and `dropIndex` is the visual
 * slot. The returned number is forwarded to `/tasks/:id/transition` and
 * stored verbatim in `IMTask.position` (DOUBLE).
 */

import { describe, expect, it } from 'vitest';
import { computeKanbanPosition } from '../task-board';
import type { TaskDTO } from '../../lib/types';

function task(id: string, position: number | null): TaskDTO {
  // Minimal stub — `computeKanbanPosition` only reads `position`.
  return { id, position } as unknown as TaskDTO;
}

describe('computeKanbanPosition (release 200 P5)', () => {
  it('returns 0 when dropping into an empty column', () => {
    expect(computeKanbanPosition([], 0)).toBe(0);
  });

  it('places above the first card (first.position - 1) when dropIndex = 0', () => {
    const neighbors = [task('a', 100), task('b', 200), task('c', 300)];
    expect(computeKanbanPosition(neighbors, 0)).toBe(99);
  });

  it('places below the last card (last.position + 1) when dropIndex >= length', () => {
    const neighbors = [task('a', 100), task('b', 200), task('c', 300)];
    expect(computeKanbanPosition(neighbors, 3)).toBe(301);
    expect(computeKanbanPosition(neighbors, 99)).toBe(301);
  });

  it('returns midpoint of adjacent positions for an interior drop', () => {
    const neighbors = [task('a', 100), task('b', 200), task('c', 300)];
    expect(computeKanbanPosition(neighbors, 1)).toBe(150);
    expect(computeKanbanPosition(neighbors, 2)).toBe(250);
  });

  it('treats neighbors with null position as 0 (defensive backfill fallback)', () => {
    // If migration 345's backfill missed a row, `position` may be null on
    // the wire. We don't want the helper to throw — fall back to 0.
    const neighbors = [task('a', null), task('b', 100)];
    expect(computeKanbanPosition(neighbors, 1)).toBe(50);
  });

  it('handles non-integer doubles (typical mid-merge state)', () => {
    const neighbors = [task('a', 100.5), task('b', 100.75)];
    expect(computeKanbanPosition(neighbors, 1)).toBeCloseTo(100.625, 6);
  });
});
