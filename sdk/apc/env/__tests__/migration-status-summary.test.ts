import { beforeEach, describe, expect, it, vi } from 'vitest';

const runBash = vi.hoisted(() => vi.fn());

vi.mock('../probes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../probes')>()),
  runBash,
}));

import { findItem } from '../manifest';

const migrationGuard = () => findItem('project.mysql-migrations-pending')!;

describe('migration status summary compatibility', () => {
  beforeEach(() => {
    runBash.mockReset();
  });

  it('accepts the rename-aware db-migrate summary when no work or drift remains', async () => {
    runBash.mockResolvedValue({
      ok: true,
      stdout: '[db-migrate] applied=553  pending=0  renamed=2  modified=0  conflicts=0',
      stderr: '',
    });

    await expect(migrationGuard().check()).resolves.toEqual({
      status: 'pass',
      detail: 'applied=553 pending=0 modified=0 conflicts=0',
    });
  });

  it('fails closed when the migration runner reports a numeric-prefix conflict', async () => {
    runBash.mockResolvedValue({
      ok: false,
      stdout: '[db-migrate] applied=552  pending=0  renamed=0  modified=0  conflicts=1',
      stderr: '',
      error: 'exit 1',
    });

    const result = await migrationGuard().check();

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('1 条 migration number conflict');
  });
});
