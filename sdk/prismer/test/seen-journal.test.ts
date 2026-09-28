// runtime210/01 experiment — SeenJournal: deposit-dedup journal so an
// agent's headless reads never overwrite each other's cache entries
// (ContextCacheService.deposit is a blind upsert).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SeenJournal } from '../src/daemon/web/seen-journal.js';

describe('SeenJournal', () => {
  let tmp: string;
  let file: string;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'seen-journal-'));
    file = path.join(tmp, 'headless-deposited.json');
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('missing file → has false (treated as empty)', () => {
    const j = new SeenJournal(file);
    expect(j.has('https://a.com/1')).toBe(false);
  });

  it('add → has true; re-add idempotent', () => {
    const j = new SeenJournal(file);
    j.add(['https://a.com/1', 'https://a.com/2']);
    expect(j.has('https://a.com/1')).toBe(true);
    expect(j.has('https://a.com/2')).toBe(true);
    j.add(['https://a.com/1']);
    expect(j.has('https://a.com/1')).toBe(true);
  });

  it('new instance re-reads from disk', () => {
    const j2 = new SeenJournal(file);
    expect(j2.has('https://a.com/1')).toBe(true);
    expect(j2.has('https://a.com/2')).toBe(true);
  });

  it('corrupted file → treated as empty, still writable', async () => {
    const corrupt = path.join(tmp, 'corrupt.json');
    await writeFile(corrupt, '{not json', 'utf8');
    const j = new SeenJournal(corrupt);
    expect(j.has('https://x.com')).toBe(false);
    j.add(['https://x.com']);
    expect(j.has('https://x.com')).toBe(true);
  });

  it('static open: explicit cacheDir + PRISMER_HOME override', () => {
    const j1 = SeenJournal.open(tmp);
    expect(j1.filePath).toContain(tmp);
    const prev = process.env.PRISMER_HOME;
    process.env.PRISMER_HOME = tmp;
    try {
      const j2 = SeenJournal.open();
      expect(j2.filePath).toBe(path.join(tmp, 'cache', 'headless-deposited.json'));
    } finally {
      if (prev === undefined) delete process.env.PRISMER_HOME;
      else process.env.PRISMER_HOME = prev;
    }
  });
});
