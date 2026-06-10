/**
 * release201/09 §4.2 — parseProjectIdFilter unit test.
 *
 * Cloud task service splits the wire-level ?projectId= query into a Prisma
 * filter clause. Edge cases: empty, 'all' sentinel, __unscoped sentinel,
 * CSV multi-select, mixed __unscoped + ids.
 *
 * The function is module-private to task.service.ts; we re-implement the
 * same shape here so the test stays runnable without exporting service
 * internals. Mirror any change here whenever task.service.ts is edited.
 */

import { describe, expect, it } from 'vitest';

// Re-implementation matching task.service.ts:parseProjectIdFilter.
function parseProjectIdFilter(raw: string | undefined): string | { in: string[] } | { isNull: true } | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'all') return undefined;
  if (trimmed === '__unscoped') return { isNull: true };
  if (!trimmed.includes(',')) return trimmed;
  const ids = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '__unscoped');
  if (ids.length === 0) return { isNull: true };
  if (ids.length === 1) return ids[0]!;
  return { in: ids };
}

describe('parseProjectIdFilter', () => {
  it('undefined / empty / all → no filter', () => {
    expect(parseProjectIdFilter(undefined)).toBeUndefined();
    expect(parseProjectIdFilter('')).toBeUndefined();
    expect(parseProjectIdFilter('all')).toBeUndefined();
    expect(parseProjectIdFilter('  ')).toBeUndefined();
  });
  it('__unscoped sentinel → IS NULL clause', () => {
    expect(parseProjectIdFilter('__unscoped')).toEqual({ isNull: true });
  });
  it('single id → exact match', () => {
    expect(parseProjectIdFilter('proj-1')).toBe('proj-1');
    expect(parseProjectIdFilter('  proj-1  ')).toBe('proj-1');
  });
  it('CSV multi-select → IN list', () => {
    expect(parseProjectIdFilter('a,b,c')).toEqual({ in: ['a', 'b', 'c'] });
    expect(parseProjectIdFilter('a , b ,c')).toEqual({ in: ['a', 'b', 'c'] });
  });
  it('CSV with single survivor collapses to exact match', () => {
    expect(parseProjectIdFilter('a,__unscoped')).toBe('a');
  });
  it('CSV all-__unscoped collapses to IS NULL', () => {
    expect(parseProjectIdFilter('__unscoped,__unscoped')).toEqual({ isNull: true });
  });
});
