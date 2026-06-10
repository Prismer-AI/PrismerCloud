// Unit tests for the hermes MEMORY.md file bridge — release201/26 §14.7 #A3.
//
// Tests cover:
//   - Round-trip: write managed section → read it back, curated preserved
//   - Curated content is never clobbered when we rewrite the managed section
//   - Char-budget truncation with a clear marker
//   - Idempotent rewrite (same body twice → byte-identical file)
//   - File-absent: writeManagedSection creates the file (+ parent dir)
//   - readHermesMemory / extractCurated on an absent file → empty strings

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readHermesMemory,
  writeManagedSection,
  extractCurated,
  MANAGED_START,
  MANAGED_END,
  DEFAULT_CHAR_BUDGET,
} from '../src/daemon/memory/hermes-memory-bridge.js';

let dir: string;
let memPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-mem-'));
  memPath = join(dir, 'MEMORY.md');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('hermes-memory-bridge', () => {
  it('creates the file (and nested parent dir) when absent', () => {
    const nested = join(dir, 'profiles', 'alice', 'MEMORY.md');
    expect(existsSync(nested)).toBe(false);

    writeManagedSection(nested, 'recalled fact A');

    expect(existsSync(nested)).toBe(true);
    const { managed } = readHermesMemory(nested);
    expect(managed).toBe('recalled fact A');
  });

  it('returns empty strings for an absent file', () => {
    const { curated, managed, raw } = readHermesMemory(memPath);
    expect(curated).toBe('');
    expect(managed).toBe('');
    expect(raw).toBe('');
    expect(extractCurated(memPath)).toBe('');
  });

  it('round-trips a managed body and reads it back', () => {
    writeManagedSection(memPath, 'fact one\nfact two');
    const { managed, raw } = readHermesMemory(memPath);

    expect(managed).toBe('fact one\nfact two');
    expect(raw).toContain(MANAGED_START);
    expect(raw).toContain(MANAGED_END);
  });

  it('never clobbers agent-curated content when rewriting the managed section', () => {
    // Simulate an agent-curated file (no managed section yet).
    const curatedDoc = '- agent kept this\n§\n- and this entry too';
    require('node:fs').writeFileSync(memPath, curatedDoc, 'utf-8');

    // First write inserts our managed section, preserving curated content.
    writeManagedSection(memPath, 'prismer recall v1');
    let snap = readHermesMemory(memPath);
    expect(snap.curated).toContain('- agent kept this');
    expect(snap.curated).toContain('- and this entry too');
    expect(snap.managed).toBe('prismer recall v1');

    // Rewriting the managed section must leave curated bytes intact.
    writeManagedSection(memPath, 'prismer recall v2 — totally different');
    snap = readHermesMemory(memPath);
    expect(snap.curated).toContain('- agent kept this');
    expect(snap.curated).toContain('- and this entry too');
    expect(snap.managed).toBe('prismer recall v2 — totally different');
  });

  it('extractCurated returns only the agent content, not our managed body', () => {
    require('node:fs').writeFileSync(memPath, 'agent curated line', 'utf-8');
    writeManagedSection(memPath, 'SECRET-RECALL-TOKEN');

    const curated = extractCurated(memPath);
    expect(curated).toContain('agent curated line');
    expect(curated).not.toContain('SECRET-RECALL-TOKEN');
    expect(curated).not.toContain(MANAGED_START);
    expect(curated).not.toContain(MANAGED_END);
  });

  it('truncates an over-budget body with a clear marker', () => {
    const huge = 'x'.repeat(DEFAULT_CHAR_BUDGET + 500);
    writeManagedSection(memPath, huge);

    const { managed } = readHermesMemory(memPath);
    expect(managed.length).toBeLessThanOrEqual(DEFAULT_CHAR_BUDGET);
    expect(managed).toContain('…(truncated)');
    expect(managed).not.toBe(huge);
  });

  it('respects a custom char budget', () => {
    const body = 'y'.repeat(200);
    writeManagedSection(memPath, body, { charBudget: 50 });

    const { managed } = readHermesMemory(memPath);
    expect(managed.length).toBeLessThanOrEqual(50);
    expect(managed).toContain('…(truncated)');
  });

  it('is idempotent: writing the same body twice yields a byte-identical file', () => {
    writeManagedSection(memPath, 'stable recall body');
    const first = readFileSync(memPath, 'utf-8');

    writeManagedSection(memPath, 'stable recall body');
    const second = readFileSync(memPath, 'utf-8');

    expect(second).toBe(first);
  });

  it('is idempotent with curated content present', () => {
    require('node:fs').writeFileSync(memPath, '- curated entry', 'utf-8');
    writeManagedSection(memPath, 'recall body');
    const first = readFileSync(memPath, 'utf-8');

    writeManagedSection(memPath, 'recall body');
    const second = readFileSync(memPath, 'utf-8');

    expect(second).toBe(first);
    // And curated still intact after the double write.
    expect(extractCurated(memPath)).toContain('- curated entry');
  });
});
