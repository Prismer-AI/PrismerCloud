/**
 * product209/15 PKF-F1 — `cloud pkf pack-harness` CLI integration.
 *
 * The core packer is tested in packages/pkf (src/core); this suite covers the CLI
 * layer: directory walk, symlink rejection, manifest write, and the real
 * product-tour harness fixture. Negative controls each turn the same pack
 * journey red.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { packHarness } from '@prismer/pkf';
import { walkBundle } from '../src/commands/pkf';

const cleanups: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'pkf-cli-'));
  cleanups.push(d);
  return d;
}

afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeBundle(): { dir: string; manifestPath: string } {
  const dir = tmpDir();
  writeFileSync(join(dir, 'app.js'), '(function(){"use strict";console.log(1);})();\n');
  writeFileSync(join(dir, 'app.css'), ':root{--x:1}\n');
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({ scripts: [{ path: 'app.js' }], styles: [{ path: 'app.css' }], actions: [] }),
  );
  return { dir, manifestPath };
}

describe('pkf pack-harness CLI layer', () => {
  it('walks a bundle dir into path→bytes and packs it deterministically', () => {
    const { dir } = makeBundle();
    const { files } = walkBundle(dir);
    expect(Object.keys(files).sort()).toEqual(['app.css', 'app.js', 'manifest.json']);
    const authored = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    const result = packHarness({
      files,
      manifest: {
        scripts: authored.scripts,
        styles: authored.styles,
        actions: authored.actions,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.scripts[0].path).toBe('app.js');
    expect(result.manifest.scripts[0].integrity).toMatch(/^sha256-/);
    // repeated pack byte-identical
    const again = packHarness({
      files: walkBundle(dir).files,
      manifest: { scripts: authored.scripts, styles: authored.styles, actions: authored.actions },
    });
    if (again.ok) expect(JSON.stringify(again.manifest)).toBe(JSON.stringify(result.manifest));
  });

  it('rejects a symlinked bundle entry (traversal / link attack)', () => {
    const { dir } = makeBundle();
    const outside = tmpDir();
    writeFileSync(join(outside, 'evil.js'), 'alert(1);');
    symlinkSync(join(outside, 'evil.js'), join(dir, 'linked.js'));
    expect(() => walkBundle(dir)).toThrow(/symlink/);
  });

  it('rejects a symlinked bundle ROOT', () => {
    const { dir } = makeBundle();
    const link = join(tmpDir(), 'root-link');
    symlinkSync(dir, link);
    expect(() => walkBundle(link)).toThrow(/symlink|traverse/);
  });

  it('rejects a forbidden nested directory', () => {
    const { dir } = makeBundle();
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules/x.js'), 'x');
    expect(() => walkBundle(dir)).toThrow(/forbidden directory/);
  });

  it('packs the REAL product-tour harness fixture (repo bytes)', () => {
    const fixture = join(__dirname, '..', '..', '..', 'src/im/data/workspace-starter/resources/harness');
    const { files } = walkBundle(fixture);
    expect(Object.keys(files).sort()).toEqual(['app.css', 'app.js', 'manifest.json']);
    const authored = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    const result = packHarness({
      files,
      manifest: {
        scripts: authored.scripts,
        styles: authored.styles,
        actions: authored.actions,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.actions).toEqual([]);
    expect(result.manifest.version).toBe('prismer-harness@1');
  });
});
