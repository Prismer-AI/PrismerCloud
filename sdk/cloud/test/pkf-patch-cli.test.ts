/**
 * product209/15 PKF-H3 — `cloud pkf patch|diff` local-file lane.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runPkfDiff, runPkfPatchFile } from '../src/commands/pkf';

const cleanups: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'pkf-patch-'));
  cleanups.push(d);
  return d;
}
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SID = 'sec_01k2f6m8v7q4x9a3b5c6d7e8f9';
const SOURCE = `<script type="application/prismer+json">{"type":"note","pkfVersion":"1.1"}</script>
<section><h2 id="a" data-sid="${SID}">A</h2><p>old words here</p></section>`;

describe('pkf patch/diff CLI (local files)', () => {
  it('patch dry-run returns the typed receipt without writing source', () => {
    const dir = tmp();
    const src = join(dir, 'doc.pkf');
    const patch = join(dir, 'patch.json');
    writeFileSync(src, SOURCE);
    writeFileSync(
      patch,
      JSON.stringify({
        operations: [{ op: 'replace-hunk', sectionSid: SID, oldText: 'old words here', newText: 'new words', expectedSectionHash: expectSectionHash() }],
        message: 'cli patch',
      }),
    );
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(runPkfPatchFile(SOURCE, patch, null, true)).toBe(0);
    const receipt = JSON.parse(write.mock.calls[0][0] as string);
    expect(receipt.ok).toBe(true);
    expect(receipt.changedSectionSids).toEqual([SID]);
    write.mockRestore();
  });

  it('diff reports source + semantic receipt', () => {
    const dir = tmp();
    const from = join(dir, 'base.pkf');
    const to = join(dir, 'head.pkf');
    writeFileSync(from, SOURCE);
    writeFileSync(to, SOURCE.replace('old words here', 'new words'));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(runPkfDiff(from, to, true)).toBe(0);
    const payload = JSON.parse(write.mock.calls[0][0] as string);
    expect(payload.baseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.receipt.sectionsChanged).toBeGreaterThanOrEqual(1);
    write.mockRestore();
  });
});

import { parsePkfSource, sha256Hex } from '@prismer/pkf';
function expectSectionHash(): string {
  const doc = parsePkfSource(SOURCE);
  const walk = (n: typeof doc.root): string | null => {
    if (n.tagName === 'h2' && n.parent?.tagName === 'section') {
      return sha256Hex(SOURCE.slice(n.startOffset ?? 0, n.parent.endOffset ?? SOURCE.length));
    }
    for (const c of n.children) {
      const r = walk(c);
      if (r) return r;
    }
    return null;
  };
  return walk(doc.root) ?? '';
}
import { vi } from 'vitest';
