// memory211/10 R1 §2.1 — the evolution-artifact metadata gate, daemon side.
//
// 07 §2.1 「谁写」: an evolution artifact (frontier draft / merge / ingest /
// external-import) MUST declare `memoryRole` + `source`; a human or a
// conversational agent writing by hand MAY. The carrier is the controlled
// `extra.memory` frontmatter block (D-1 (a) — zero PKF standard layer change).
//
// This is the daemon mirror of the cloud gate in
// `src/im/services/memory-activation-probe.ts`. The two CANNOT share code: the
// runtime is a separate package with its own tsconfig and its own staged pkf
// copy (prebuild/stage-pkf-core.cjs). The repo's precedent for that boundary is
// a documented mirror (`src/im/services/magic-bytes.ts`). What makes the mirror
// safe rather than a fork is the parity suite:
//   · scripts/__tests__/memory211-evolution-metadata-parity.test.ts asserts the
//     value domain is identical AND that both implementations agree verdict-for
//     -verdict on a shared fixture table.
//
// WHY IT IS NOT WIRED INTO A CALL SITE YET (deliberate, not an oversight): the
// daemon's evolution surface is the PROPOSAL, not the page — SessionExtractRunner
// and CloudDreamRunner enqueue `memory.proposal` outbox events. The daemon's
// actual page-writing leg is the automatic extraction pipeline, and write-gate.ts
// itself documents why a new 422 must never land there (a background leg cannot
// repair, so rejection silently LOSES the memory — the D4 failure mode). Wiring
// the proposal lane is R2's "proposals 扩展" work, once the block is actually
// produced. Until then this is a pure admission function with the tests as its
// only caller, on purpose.
//
// Run: npx vitest run test/memory-evolution-metadata-gate.test.ts

import { describe, expect, it } from 'vitest';
import { checkEvolutionMetadataGate, MEMORY_ROLES } from '../src/daemon/memory/write-gate.js';

/** A strict-valid v1.1 PKF body; `memory` is an unknown frontmatter key → `extra`. */
function body(memory?: unknown): string {
  const fm: Record<string, unknown> = {
    pkfVersion: '1.1',
    type: 'note',
    title: 'Kestrel lease',
    description: 'How the lease renews.',
  };
  if (memory !== undefined) fm.memory = memory;
  return [
    `<script type="application/prismer+json">${JSON.stringify(fm)}</script>`,
    '<section><h2 id="renewal">Renewal</h2>',
    '<p>The lease renews after <strong>300</strong> seconds.</p>',
    '</section>',
  ].join('\n');
}

const VALID_BLOCK = { memoryRole: 'knowledge', source: 'frontier cluster kestrel 2026-09-15' };

describe('§2.1 evolution metadata gate (daemon)', () => {
  it('exposes the shared value domain in the canonical order', () => {
    expect([...MEMORY_ROLES]).toEqual(['knowledge', 'procedure', 'action_result']);
  });

  it('rejects an artifact whose frontmatter carries no `memory` block', () => {
    expect(checkEvolutionMetadataGate(body())?.code).toBe('evolution_metadata_required');
  });

  it('rejects a block that declares no memoryRole', () => {
    expect(checkEvolutionMetadataGate(body({ source: VALID_BLOCK.source }))?.detail).toMatch(/memoryRole/);
  });

  it('rejects a block whose memoryRole is outside the domain', () => {
    expect(checkEvolutionMetadataGate(body({ memoryRole: 'fact', source: VALID_BLOCK.source }))?.detail).toMatch(/memoryRole/);
  });

  it('rejects a block that declares no source', () => {
    expect(checkEvolutionMetadataGate(body({ memoryRole: 'knowledge' }))?.detail).toMatch(/source/);
  });

  it('rejects a blank source — an unstatable provenance is not a provenance', () => {
    expect(checkEvolutionMetadataGate(body({ memoryRole: 'knowledge', source: '   ' }))?.detail).toMatch(/source/);
  });

  it('rejects an unknown key inside the controlled block', () => {
    expect(checkEvolutionMetadataGate(body({ ...VALID_BLOCK, priority: 'high' }))?.detail).toMatch(/priority/);
  });

  it('rejects a malformed trigger', () => {
    expect(checkEvolutionMetadataGate(body({ ...VALID_BLOCK, trigger: { event: 'recall-miss' } }))?.detail).toMatch(/trigger/);
  });

  it('rejects a sections[] entry that omits its own source', () => {
    const v = checkEvolutionMetadataGate(body({ ...VALID_BLOCK, sections: [{ anchor: 'renewal', memoryRole: 'procedure' }] }));
    expect(v?.detail).toMatch(/sections\[0\]/);
  });

  it('rejects a sections[] entry with no anchor — it could not be attributed', () => {
    const v = checkEvolutionMetadataGate(body({ ...VALID_BLOCK, sections: [{ memoryRole: 'procedure', source: 'runbook' }] }));
    expect(v?.detail).toMatch(/anchor/);
  });

  it('accepts a well-formed block, anchor-indexed sections included', () => {
    expect(
      checkEvolutionMetadataGate(
        body({ ...VALID_BLOCK, sections: [{ anchor: 'renewal', memoryRole: 'procedure', source: 'runbook 2026-09' }] }),
      ),
    ).toBeNull();
  });

  it('accepts an optional well-formed trigger', () => {
    expect(
      checkEvolutionMetadataGate(body({ ...VALID_BLOCK, trigger: { event: 'recall-miss', state: 'INDEX.pkf#kestrel' } })),
    ).toBeNull();
  });

  it('treats a non-PKF body as missing the block (markdown cannot carry one)', () => {
    expect(checkEvolutionMetadataGate('# plain markdown\n\nno frontmatter here\n')?.code).toBe('evolution_metadata_required');
  });
});
