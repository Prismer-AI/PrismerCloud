// product209/15 PKF-C2 — memory-curation compatibility acceptance.
//
// The canonical `memory-curation` catalog dir, the runtime TS copy, the
// regenerator script and the Python foreign-runtime copy are all DELETED.
// What remains is the compatibility contract: the canonical `memory` skill
// declares `metadata.aliases: [memory-curation]`, the catalog no longer
// ships a second curation body, and no adapter embeds the old full text.
// (Old slug/skillId/ACK resolution + delivery dedupe is covered by the
// cloud-side compatibility-alias tests.)
//
// This test REPLACES the old drift-detection test — the compatibility
// acceptance itself is preserved, only its oracle changed to the alias
// contract.

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// prismer/test/ → prismer/ → sdk/ → repoRoot
const REPO_ROOT = join(__dirname, '..', '..', '..');

const CANONICAL_MEMORY = join(REPO_ROOT, 'sdk/cloud/catalog/skills/memory/SKILL.md');
const CURATION_CATALOG_DIR = join(REPO_ROOT, 'sdk/cloud/catalog/skills/memory-curation');
const CURATION_TS = join(REPO_ROOT, 'sdk/prismer/src/skills/memory-curation.ts');
const REGEN_CJS = join(REPO_ROOT, 'sdk/prismer/scripts/regenerate-memory-curation-skill.cjs');
const CURATION_PY = join(REPO_ROOT, 'sdk/cloud/python/prismer/_memory_curation_skill.py');

describe('memory-curation compatibility (alias contract)', () => {
  const memory = readFileSync(CANONICAL_MEMORY, 'utf8');

  it('canonical memory skill declares the memory-curation alias', () => {
    expect(memory).toMatch(/aliases:\s*\n\s*-\s*memory-curation/);
  });

  it('no second curation body ships anywhere', () => {
    expect(existsSync(CURATION_CATALOG_DIR)).toBe(false);
    expect(existsSync(CURATION_TS)).toBe(false);
    expect(existsSync(REGEN_CJS)).toBe(false);
    expect(existsSync(CURATION_PY)).toBe(false);
  });

  it('canonical memory SKILL.md is non-empty and well-formed', () => {
    expect(memory.length).toBeGreaterThan(500);
    expect(memory).toMatch(/^---\nname: memory\n/);
  });
});
