import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readBundle } from '../src/internal/bundle/index';

it('includes all supporting resource types and license basenames recursively', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-bundle-resources-'));
  try {
    const resources = ['SKILL.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'NOTICE.md', 'assets/font.ttf', 'scripts/tool.py', 'templates/doc.xml', 'references/LICENSE'];
    for (const file of [...resources, '.DS_Store', '.gitignore']) {
      mkdirSync(join(dir, file, '..'), { recursive: true });
      writeFileSync(join(dir, file), file.endsWith('.ttf') ? Buffer.from([0, 255, 128, 1]) : file);
    }
    const bundle = readBundle(dir);
    expect(bundle.files.map((f) => f.path).sort()).toEqual(resources.sort());
    expect(bundle.files.find((f) => f.path === 'assets/font.ttf')?.bytes).toEqual(Buffer.from([0, 255, 128, 1]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
