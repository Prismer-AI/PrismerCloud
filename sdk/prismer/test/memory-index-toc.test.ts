// memory202 doc 05 §4.2a — INDEX dynamic core-inject tests.
//
//   buildIndexToc (pure):
//     - within budget → full TOC (with header)
//     - over budget → skeleton of headings, cut at a section boundary (never
//       mid-section / mid-heading)
//     - skeleton greedily bounded → only whole heading lines, dropped at a
//       boundary
//     - empty / whitespace / budget<=0 → '' (no throw)
//   injectIndexTocForTarget (wiring):
//     - flag ON + seeded INDEX page → coreInject ran (MEMORY.md managed section
//       carries the TOC)
//     - flag OFF (default) → coreInject NEVER ran (dormant, zero behaviour change)
//     - no INDEX page → no-op
//   MemoryStore.loadIndexPageContent → returns the pageType='index' content.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndexToc, MEMORY_MAP_HEADER } from '../src/daemon/memory/index-toc.js';
import { injectIndexTocForTarget } from '../src/daemon/memory/index-toc-inject.js';
import { MemoryStore } from '../src/daemon/memory/store.js';
import { MANAGED_START, MANAGED_END } from '../src/daemon/memory/hermes-memory-bridge.js';

// ───────────────────────── buildIndexToc (pure) ─────────────────────────

describe('buildIndexToc — bounding', () => {
  it('returns the full map (with header) when within budget', () => {
    const map = '## Decisions\nauth, deploy\n\n## SDK\nclient libs';
    const out = buildIndexToc(map, 1800);
    expect(out.startsWith(`${MEMORY_MAP_HEADER}\n`)).toBe(true);
    expect(out).toContain('## Decisions');
    expect(out).toContain('client libs');
    expect(out.length).toBeLessThanOrEqual(1800);
  });

  it('empty / whitespace INDEX → empty string (no throw)', () => {
    expect(buildIndexToc('', 1800)).toBe('');
    expect(buildIndexToc('   \n\t\n', 1800)).toBe('');
  });

  it('budget <= 0 → empty string', () => {
    expect(buildIndexToc('## A\nbody', 0)).toBe('');
    expect(buildIndexToc('## A\nbody', -5)).toBe('');
  });

  it('over budget → skeleton of headings, never cuts mid-section', () => {
    // Each section has a long body that would blow the budget if included.
    const body = 'x'.repeat(200);
    const map = [
      '## Alpha',
      body,
      '## Bravo',
      body,
      '## Charlie',
      body,
    ].join('\n');
    // Budget large enough for the heading skeleton but far too small for bodies.
    const out = buildIndexToc(map, 80);
    expect(out.length).toBeLessThanOrEqual(80);
    // Skeleton must NOT contain any section body text (no mid-section cut).
    expect(out).not.toContain('xx');
    // Skeleton carries heading TITLES (the map shape).
    expect(out).toContain('Alpha');
  });

  it('skeleton is greedily bounded at whole-heading boundaries', () => {
    const body = 'y'.repeat(50);
    const heads = Array.from({ length: 40 }, (_, i) => `## Section-${i}\n${body}`);
    const map = heads.join('\n');
    const out = buildIndexToc(map, 120);
    expect(out.length).toBeLessThanOrEqual(120);
    // Every line that is a heading entry must be a COMPLETE '- Section-N' line —
    // no truncated trailing token.
    for (const line of out.split('\n')) {
      if (line.startsWith('- ')) {
        expect(/^- Section-\d+$/.test(line)).toBe(true);
      }
    }
  });

  it('nested headings render as an indented tree skeleton when over budget', () => {
    const body = 'z'.repeat(300);
    const map = [
      '# Root',
      body,
      '## Child',
      body,
      '### Grandchild',
      body,
    ].join('\n');
    const out = buildIndexToc(map, 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out).toContain('- Root');
    // Child is indented two spaces below Root (level 2 vs level 1).
    expect(out).toContain('  - Child');
  });

  it('fence-aware: # inside a code fence is NOT treated as a heading', () => {
    const body = 'q'.repeat(300);
    const map = [
      '## Real',
      '```',
      '# not-a-heading',
      '```',
      body,
      '## AlsoReal',
      body,
    ].join('\n');
    const out = buildIndexToc(map, 80);
    expect(out).toContain('Real');
    expect(out).not.toContain('not-a-heading');
  });
});

// ───────── structure-preserving truncation (hierarchical top-index) ─────────

const TRUNC_MARKER_RE = /load the index page for the full map/;

describe('buildIndexToc — structure-preserving truncation', () => {
  it('small index under budget → returned verbatim (unchanged)', () => {
    const map = '## Decisions\nauth, deploy\n\n## SDK\nclient libs';
    const out = buildIndexToc(map, 1800);
    expect(out).toBe(`${MEMORY_MAP_HEADER}\n${map}`);
    // No marker on the verbatim (fully-fitting) path.
    expect(out).not.toMatch(TRUNC_MARKER_RE);
  });

  it('LARGE hierarchical index over budget → ALL hub headings survive, marked, bounded', () => {
    // 10 hubs (## level), each with 8 leaves (### level) + prose. The whole map
    // far exceeds a realistic carrier budget; the hub spine must survive whole.
    const HUBS = 10;
    const LEAVES = 8;
    const prose = 'detail '.repeat(20); // ~140 chars of body per node
    const hubNames: string[] = [];
    const parts: string[] = [];
    for (let h = 0; h < HUBS; h++) {
      const hub = `Hub-${h}`;
      hubNames.push(hub);
      parts.push(`## ${hub}`, prose);
      for (let l = 0; l < LEAVES; l++) {
        parts.push(`### ${hub}-Leaf-${l}`, prose);
      }
    }
    const map = parts.join('\n');
    // A budget that comfortably holds all 10 hub lines + header + marker, but NOT
    // all 80 leaf lines — so the depth-first drop must shed leaves while keeping
    // the spine. (At the full 1,800 carrier budget this small synthetic map fits
    // whole as a skeleton; we tighten it to actually exercise truncation.)
    const budget = 400;
    const out = buildIndexToc(map, budget);

    // (a) bounded
    expect(out.length).toBeLessThanOrEqual(budget);
    // (b) every TOP-LEVEL hub heading survives — the navigational spine is whole
    for (const hub of hubNames) {
      expect(out).toContain(`- ${hub}`);
    }
    // (c) truncation is OBSERVABLE — the marker is present and tells the agent to drill in
    expect(out).toMatch(TRUNC_MARKER_RE);
    // (d) leaf detail was trimmed (deepest-first): not every leaf can be present
    //     given the budget, proving depth-first drop actually shed leaves.
    const leafCount = (out.match(/-Leaf-/g) ?? []).length;
    expect(leafCount).toBeLessThan(HUBS * LEAVES);
  });

  it('NEGATIVE CONTROL: flat index, only leaves, over budget → still bounded + marked', () => {
    // No hubs at all — a flat list of ## sections each with a big body. Proves
    // the bound + marker hold even with no spine to preserve.
    const body = 'z'.repeat(120);
    const flat = Array.from({ length: 60 }, (_, i) => `## Flat-${i}\n${body}`).join('\n');
    // Tight budget so the flat skeleton genuinely overflows and entries drop.
    const budget = 300;
    const out = buildIndexToc(flat, budget);

    expect(out.length).toBeLessThanOrEqual(budget);
    expect(out).toMatch(TRUNC_MARKER_RE);
    // Something survived (not the silent-empty failure mode).
    expect(out).toContain('Flat-0');
    // And it dropped some entries (60 sections cannot all fit at 300 chars).
    expect(out).not.toContain('Flat-59');
  });
});

// ─────────────────────── injectIndexTocForTarget (wiring) ───────────────────

const WS = 'cmpworkspaceindextoc01';

function seedStore(dir: string, withIndex: boolean): MemoryStore {
  const store = new MemoryStore({
    dbPath: join(dir, 'memory.db'),
    workspaceId: WS,
    deviceId: 'test-device',
  });
  store.open();
  if (withIndex) {
    store.write({
      workspaceId: WS,
      path: 'INDEX.md',
      title: 'Workspace Map',
      content: '## Decisions\nauth\n\n## SDK\nclient',
      // 'index' is a cloud-side pageType the daemon stores verbatim; cast to
      // bypass the daemon's narrower enum (matches cloud-sync materialisePage).
      pageType: 'index' as unknown as 'hub',
      actorImUserId: 'cloud-sync',
      actorKind: 'agent',
    });
  }
  return store;
}

let dir: string;
let memPath: string;
let prevFlag: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'index-toc-'));
  memPath = join(dir, 'MEMORY.md');
  prevFlag = process.env.FF_MEMORY_INDEX_INJECT_ENABLED;
});

afterEach(() => {
  if (prevFlag === undefined) delete process.env.FF_MEMORY_INDEX_INJECT_ENABLED;
  else process.env.FF_MEMORY_INDEX_INJECT_ENABLED = prevFlag;
  rmSync(dir, { recursive: true, force: true });
});

describe('MemoryStore.loadIndexPageContent', () => {
  it('returns the index page content', () => {
    const store = seedStore(dir, true);
    expect(store.loadIndexPageContent()).toContain('## Decisions');
    store.close();
  });

  it('returns null when no index page exists', () => {
    const store = seedStore(dir, false);
    expect(store.loadIndexPageContent()).toBeNull();
    store.close();
  });
});

describe('injectIndexTocForTarget — flag gating', () => {
  it('flag ON + seeded INDEX → coreInject ran, MEMORY.md carries the TOC', () => {
    process.env.FF_MEMORY_INDEX_INJECT_ENABLED = 'true';
    const store = seedStore(dir, true);
    const res = injectIndexTocForTarget({ store, memoryFilePath: memPath, workspaceId: WS });
    store.close();

    expect(res.injected).toBe(true);
    expect(res.bytes).toBeGreaterThan(0);
    expect(existsSync(memPath)).toBe(true);
    const file = readFileSync(memPath, 'utf-8');
    expect(file).toContain(MANAGED_START);
    expect(file).toContain(MANAGED_END);
    expect(file).toContain(MEMORY_MAP_HEADER);
    expect(file).toContain('## Decisions');
  });

  it('flag explicitly OFF → coreInject NEVER ran, no MEMORY.md written', () => {
    // memory211/01 W3 轴E flipped the DEFAULT to ON; the kill-switch is now an
    // explicit `false|0|off`, so this control pins the OFF path by declaring it.
    process.env.FF_MEMORY_INDEX_INJECT_ENABLED = 'false';
    const store = seedStore(dir, true);
    const res = injectIndexTocForTarget({ store, memoryFilePath: memPath, workspaceId: WS });
    store.close();

    expect(res.injected).toBe(false);
    expect(res.reason).toBe('flag-off');
    expect(existsSync(memPath)).toBe(false);
  });

  it('flag ON but no INDEX page → no-op', () => {
    process.env.FF_MEMORY_INDEX_INJECT_ENABLED = 'true';
    const store = seedStore(dir, false);
    const res = injectIndexTocForTarget({ store, memoryFilePath: memPath, workspaceId: WS });
    store.close();

    expect(res.injected).toBe(false);
    expect(res.reason).toBe('no-index');
    expect(existsSync(memPath)).toBe(false);
  });
});
