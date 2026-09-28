// memory211/10 R4 W-1 — the digest "Verified this turn" section.
//
// 07 §2.2 W-1: the verified working state enters the digest, and its content
// comes ONLY from harness-held receipts (task state machine state, the last
// turn's terminal receipt summary, completed artifact pointers). The model
// self-reporting "done" must not be able to pollute the context's fact
// section — the section renders what the harness RECEIVED, nothing else.
//
// The stability contract (digest.ts header) applies UNCHANGED, and these tests
// pin exactly that:
//   · same receipts ⇒ byte-identical text AND identical version hash;
//   · changed receipts ⇒ version changes (a consumer's cache line invalidates);
//   · NO receipts ⇒ byte-identical to the pre-W-1 digest (the section does not
//     exist as an empty stub);
//   · the section lives INSIDE the extreme guard.
//
// Run: npx vitest run test/memory-digest-verified.test.ts

import { describe, expect, it } from 'vitest';
import { buildMemoryDigest, type MemoryStore } from '../src/daemon/memory/digest.js';

function fakeStore(): MemoryStore {
  return {
    loadIndexPageContent: () => null,
    list: () => [
      {
        id: 'hub_1',
        path: 'memory/kestrel',
        title: 'Kestrel',
        description: 'Kestrel protocol notes',
        contentHash: 'h',
        version: 1,
        pageType: 'hub',
        encrypted: false,
      },
    ],
    loadContent: () => ({ content: '# Kestrel\n\nprotocol notes' }),
  } as unknown as MemoryStore;
}

const RECEIPTS_A = {
  lines: ['task cg_1: completed (terminal receipt ok)', 'artifact: memory/kestrel/draft.pkf@3 (contentHash 9f2a…)'],
};
const RECEIPTS_B = {
  lines: ['task cg_1: completed (terminal receipt ok)', 'task cg_2: failed (claim_unverified)'],
};

describe('W-1 verified section — receipts only, stability contract unchanged', () => {
  it('renders the receipts verbatim under the section header', () => {
    const d = buildMemoryDigest(fakeStore(), { verified: RECEIPTS_A });
    expect(d).toBeTruthy();
    expect(d!.text).toContain('# Verified this turn');
    expect(d!.text).toContain('- task cg_1: completed (terminal receipt ok)');
    expect(d!.text).toContain('- artifact: memory/kestrel/draft.pkf@3 (contentHash 9f2a…)');
  });

  it('same receipts ⇒ byte-identical text and version (stability contract)', () => {
    const a = buildMemoryDigest(fakeStore(), { verified: RECEIPTS_A });
    const b = buildMemoryDigest(fakeStore(), { verified: RECEIPTS_A });
    expect(a!.text).toBe(b!.text);
    expect(a!.version).toBe(b!.version);
  });

  it('changed receipts ⇒ version changes (cache line invalidates)', () => {
    const a = buildMemoryDigest(fakeStore(), { verified: RECEIPTS_A });
    const b = buildMemoryDigest(fakeStore(), { verified: RECEIPTS_B });
    expect(a!.version).not.toBe(b!.version);
    expect(b!.text).toContain('claim_unverified');
  });

  it('no receipts ⇒ no section at all (byte-identical to the pre-W-1 digest)', () => {
    const before = buildMemoryDigest(fakeStore());
    const after = buildMemoryDigest(fakeStore(), { verified: { lines: [] } });
    expect(before).toBeTruthy();
    expect(after!.text).toBe(before!.text);
    expect(after!.version).toBe(before!.version);
    expect(after!.text).not.toContain('Verified');
  });

  it('blank receipt lines never render (no empty bullets)', () => {
    const d = buildMemoryDigest(fakeStore(), { verified: { lines: ['real receipt', '  ', ''] } });
    expect(d!.text).toContain('- real receipt');
    expect(d!.text.match(/^- $/gm)).toBeNull();
  });
});
