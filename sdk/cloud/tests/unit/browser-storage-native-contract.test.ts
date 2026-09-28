import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');

describe('browser bundle native-storage contract', () => {
  it('keeps SQLite native dependency invisible to browser static analyzers', () => {
    const storageSource = readFileSync(resolve(ROOT, 'src/storage.ts'), 'utf8');
    const indexSource = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8');

    expect(indexSource).toContain("export { MemoryStorage, IndexedDBStorage, SQLiteStorage } from './storage'");
    expect(storageSource).not.toMatch(/require\(\s*['"]better-sqlite3['"]\s*\)/);
    expect(storageSource).not.toMatch(/import\(\s*['"]better-sqlite3['"]\s*\)/);
  });
});
