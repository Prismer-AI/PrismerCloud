// release203/09 §3.2 / §5(1) — `agent.fs.list` core (listReposDir) unit tests.
//
// Covers: (a) mixed dirs/files + a `.git` dir → isRepo flagging + sort order,
// (b) jail rejection of `../../etc` → path_escape, (c) non-existent dir → ok
// with empty entries (NOT an error, per doc §4.4).

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { listReposDir } from '../src/daemon/fs-list.js';

describe('listReposDir', () => {
  let root: string; // workspace jail root
  let base: string; // per-project repos/ dir

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fs-list-'));
    base = path.join(root, 'projects', '_unscoped', 'repos');
    await mkdir(base, { recursive: true });
  });

  it('(a) flags repos via .git, sorts dirs-first alphabetical', async () => {
    // a repo dir (has .git), a plain dir, and a file
    await mkdir(path.join(base, 'my-repo', '.git'), { recursive: true });
    await mkdir(path.join(base, 'plain-dir'), { recursive: true });
    await writeFile(path.join(base, 'notes.txt'), 'hi');

    const res = await listReposDir(base, root, undefined);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.absPath).toBe(base);
    expect(res.data.parentRel).toBeNull();
    expect(res.data.entries).toEqual([
      { name: 'my-repo', type: 'dir', isRepo: true },
      { name: 'plain-dir', type: 'dir', isRepo: false },
      { name: 'notes.txt', type: 'file', isRepo: false },
    ]);
  });

  it('(a2) computes parentRel for a nested subpath', async () => {
    await mkdir(path.join(base, 'group', 'inner'), { recursive: true });

    const res = await listReposDir(base, root, 'group');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.absPath).toBe(path.join(base, 'group'));
    // parent of base/group is base itself → '' (base root)
    expect(res.data.parentRel).toBe('');
    expect(res.data.entries).toEqual([{ name: 'inner', type: 'dir', isRepo: false }]);
  });

  it('(b) rejects jail escape with path_escape', async () => {
    const res = await listReposDir(base, root, '../../../../etc');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('path_escape');
  });

  it('(c) returns ok with empty entries for a non-existent dir', async () => {
    const missingBase = path.join(root, 'projects', 'never-ran', 'repos');
    const res = await listReposDir(missingBase, root, undefined);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.absPath).toBe(missingBase);
    expect(res.data.entries).toEqual([]);
    expect(res.data.parentRel).toBeNull();
  });
});
