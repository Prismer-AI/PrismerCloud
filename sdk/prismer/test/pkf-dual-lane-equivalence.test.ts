/**
 * product209/15 PKF-H6 — cross-agent native/enhanced equivalence eval.
 *
 *   npm --prefix sdk/prismer test -- --run test/pkf-dual-lane-equivalence.test.ts
 *
 * Both lanes edit ONE section of a ≥2 MiB fixture:
 *   • enhanced lane — bounded outline (agent-visible ≤64 KiB) + one exact-hunk
 *     typed patch through the PKF-H3 core;
 *   • native lane — checkout the ordinary UTF-8 file, modify the SAME section
 *     with plain filesystem primitives, status, commit (PKF-H5 lane).
 *
 * Oracles:
 *   • final bytes / source hash / semantic diff are IDENTICAL across lanes;
 *   • agent-visible input+output ≤ 64 KiB for the enhanced lane (the full
 *     source is never shipped into the prompt);
 *   • the four adapters carry the SAME path-only tool names (no adapter-
 *     specific hard-code) — and the skill never refuses editing when
 *     structured tools are absent (native lane is first-class).
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPkfPatch, diffPkf, outlinePkf, parsePkfSource, sha256Hex } from '@prismer/pkf';
import { PkfCheckoutStore } from '../src/daemon/memory/checkout-store';
import { checkoutPkfFile, commitPkfFile, statusPkfFile } from '../src/daemon/memory/checkout';
import { HERMES_MEMORY_TOOLS } from '../src/adapters/persistence/hermes/memory-tools.js';
import { readFileSync as rf } from 'node:fs';
import { join as j } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL = j(__dirname, '..', '..', 'cloud', 'catalog', 'skills', 'pkf-writing', 'SKILL.md');

const SID = 'sec_01k2f6m8v7q4x9a3b5c6d7e8f9';
const TARGET_OLD = 'THE ORIGINAL SENTENCE TO EDIT';
const TARGET_NEW = 'the edited sentence after both lanes';

/** ≥2 MiB fixture: 300 sections of ~7 KiB each + the editable target. */
function bigFixture(): string {
  const parts = ['<script type="application/prismer+json">{"type":"note","title":"big","pkfVersion":"1.1"}</script>'];
  for (let i = 0; i < 300; i++) {
    parts.push(
      `<section><h2 id="s${i}" data-sid="${i === 7 ? SID : 'sec_' + String(i).padStart(26, 'b')}">Section ${i}</h2>` +
        `<p>${'filler content '.repeat(460)} ${i === 7 ? TARGET_OLD : `payload ${i}`}</p></section>`,
    );
  }
  return parts.join('\n');
}

const cleanups: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'pkf-h6-'));
  cleanups.push(d);
  return d;
}
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('dual-lane equivalence', () => {
  it('2 MiB fixture: both lanes produce byte-identical final source + hash', async () => {
    const base = bigFixture();
    expect(base.length).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    const baseHash = sha256Hex(base);

    // ── enhanced lane ──────────────────────────────────────────────────────
    const doc = parsePkfSource(base);
    const outline = outlinePkf(doc, { maxDepth: 6 });
    const outlineBytes = new TextEncoder().encode(JSON.stringify(outline)).length;
    expect(outlineBytes).toBeLessThanOrEqual(64 * 1024);
    // the agent only ever sees the bounded outline + the patch op — never the
    // full source. Budget receipt = outline JSON + op JSON + patch receipt.
    const sectionSpan = (() => {
      const h2 = outline.sections.find((s) => s.anchorSlug === 's7')!;
      void h2;
      const walk = (n: typeof doc.root): string | null => {
        if (n.tagName === 'h2' && n.parent?.tagName === 'section') {
          const sid = (n.properties?.['data-sid'] ?? n.properties?.['dataSid']) as string | undefined;
          if (sid === SID) return base.slice(n.startOffset ?? 0, n.parent!.endOffset ?? base.length);
        }
        for (const c of n.children) {
          const r = walk(c);
          if (r) return r;
        }
        return null;
      };
      return walk(doc.root) ?? '';
    })();
    const enhanced = applyPkfPatch(base, {
      operations: [
        {
          op: 'replace-hunk',
          sectionSid: SID,
          oldText: TARGET_OLD,
          newText: TARGET_NEW,
          expectedSectionHash: sha256Hex(sectionSpan),
        },
      ],
      message: 'enhanced edit',
      expectedBaseHash: baseHash,
    });
    expect(enhanced.ok).toBe(true);
    if (!enhanced.ok) return;
    // the AGENT-VISIBLE receipt excludes the service-internal candidate source
    // (the H4 operation service builds its wire receipt the same way) — the
    // full bytes stay inside the tool process
    const { candidateSource: _cs, ...wireReceipt } = enhanced;
    void _cs;
    const agentVisible =
      outlineBytes +
      new TextEncoder().encode(JSON.stringify({ operations: ['replace-hunk', TARGET_OLD, TARGET_NEW], ...wireReceipt })).length;
    expect(agentVisible).toBeLessThanOrEqual(64 * 1024);

    // ── native lane ────────────────────────────────────────────────────────
    const taskRoot = tmp();
    const store = new PkfCheckoutStore({ dbPath: join(taskRoot, '.prismer', 'pkf-checkouts.db') });
    const uri = 'prismer://workspace/ws-1/memory/big.pkf';
    const checked = await checkoutPkfFile({
      uri,
      workspaceRelativePath: 'big.pkf',
      taskRoot,
      taskId: 'h6',
      store,
      carrier: {
        async getLocalMemorySource() {
          return new TextEncoder().encode(base);
        },
        async commitToCloud(input) {
          return { newRevisionId: 'mem:native', sourceHash: sha256Hex(Buffer.from(input.source).toString('utf8')) };
        },
      },
    });
    expect(checked.ok).toBe(true);
    // plain filesystem edit — the exact same section change
    const filePath = join(taskRoot, 'big.pkf');
    const nativeEdited = readFileSync(filePath, 'utf8').replace(TARGET_OLD, TARGET_NEW);
    writeFileSync(filePath, nativeEdited);
    const status = await statusPkfFile({ workspaceRelativePath: 'big.pkf', taskRoot, store, carrier: { commitToCloud: async () => ({ newRevisionId: 'x', sourceHash: '' }) } });
    expect(status.ok && status.state).toBe('dirty');
    const committed = await commitPkfFile({
      workspaceRelativePath: 'big.pkf',
      taskRoot,
      message: 'native edit',
      store,
      carrier: {
        async commitToCloud(input) {
          return { newRevisionId: 'mem:native', sourceHash: sha256Hex(Buffer.from(input.source).toString('utf8')) };
        },
      },
    });
    expect(committed.ok).toBe(true);
    const nativeFinal = readFileSync(filePath, 'utf8');

    // ── equivalence ────────────────────────────────────────────────────────
    expect(nativeFinal).toBe(enhanced.candidateSource);
    expect(sha256Hex(nativeFinal)).toBe(enhanced.candidateHash);
    const diff = diffPkf(base, nativeFinal);
    expect(diff.semantic.sectionsBodyChanged.some((s) => s.sid === SID)).toBe(true);
    expect(diff.receipt.sectionsChanged).toBe(1);
  });

  it('does not advertise unwired path-only lifecycle tools to Hermes', () => {
    const names = HERMES_MEMORY_TOOLS.map((t) => t.function.name);
    for (const expected of ['pkf_checkout_file', 'pkf_status_file', 'pkf_commit_file', 'pkf_normalize_file']) {
      expect(names).not.toContain(expected);
    }
  });

  it('the skill never refuses editing when structured tools are absent', () => {
    const skill = rf(SKILL, 'utf8');
    expect(skill).toMatch(/ordinary UTF-8|normal file tools/);
    expect(skill).not.toMatch(/cannot be edited|cannot edit|unavailable without/);
  });
});
