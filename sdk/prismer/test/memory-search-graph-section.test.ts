// memory202/09 P1b — graph neighbor SECTION pull (daemon). 测试闸 ③.
//
// Contract: docs/memory202/09-section-level-granularity.md §11 P1 ②.
// Modules under test:
//   - store.ts#linkNeighbors  — section source = link URI `#anchor`; JOINs
//     memory_page_content to carry the neighbor's plaintext content. Only
//     payloadKind='inline' yields sliceable content (sealed → '').
//   - search.ts#expandViaGraph — when a neighbor carries `section` + content,
//     sliceSection() out the addressed sub-section into `sectionBody`.
//
// Covers:
//   ⑤ link URI with `#anchor` → graph hit sectionBody = that section only;
//      a page-level link (no `#anchor`) → whole page (section/sectionBody unset).
//   ⑥ payloadKind non-inline (sealed) → no sliceable content → whole-page
//      degrade (hit survives, never dropped).
//
// Real MemoryStore (better-sqlite3, on-disk temp db); production code unchanged.
// The sealed-payload case (⑥) flips memory_page_content.payloadKind via a side
// connection on the SAME db file (store.write rejects non-inline at the API).

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/daemon/memory/store.js';
import { MemorySearch } from '../src/daemon/memory/search.js';
import type { MemoryWriteInput } from '../src/daemon/memory/types.js';

const WS = 'ws_graph_section';

// Neighbor page with 3 sections; the SEED carries the keyword, the neighbor
// does NOT (so it only surfaces via the link graph).
const NEIGHBOR_CONTENT = [
  '# Neighbor Page',
  'intro prose',
  '',
  '## Deploy',
  'deploy body line one',
  'deploy body line two',
  '',
  '## Rollback',
  'rollback body only',
  '',
  '## Cleanup',
  'cleanup body only',
].join('\n');

function dbFile(dir: string): string {
  return join(dir, 'memory.db');
}

function buildStore(dir: string): MemoryStore {
  const store = new MemoryStore({ dbPath: dbFile(dir), workspaceId: WS, deviceId: 'dev_x' });
  store.open();
  return store;
}

function input(overrides: Partial<MemoryWriteInput> = {}): MemoryWriteInput {
  return {
    workspaceId: WS,
    path: 'note.md',
    content: 'placeholder',
    pageType: 'leaf',
    actorImUserId: 'im_alice',
    actorKind: 'human',
    ...overrides,
  };
}

function seedTwoPages(store: MemoryStore): void {
  // seed.md is FTS-hittable on "rootkeyword"; neighbor.md is a keyword-miss.
  store.write(input({ path: 'seed.md', title: 'Seed', content: 'rootkeyword anchor decision content' }));
  store.write(input({ path: 'neighbor.md', title: 'Neighbor Page', content: NEIGHBOR_CONTENT }));
}

/** Link seed.md → neighbor.md, optionally addressing the neighbor at #anchor. */
function link(store: MemoryStore, anchor: string | null): void {
  store.upsertLink({
    sourceUri: 'pkm://seed.md',
    targetUri: anchor ? `pkm://neighbor.md#${anchor}` : 'pkm://neighbor.md',
    relation: 'related',
    weight: 2,
    extractedFromPageId: null,
  });
}

describe('M-LOCAL-GRAPH-SECTION — daemon graph neighbor section pull', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const d of cleanup.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function withStore(fn: (store: MemoryStore, dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'prismer-memory-graph-section-'));
    cleanup.push(dir);
    const store = buildStore(dir);
    try {
      fn(store, dir);
    } finally {
      store.close();
    }
  }

  // ⑤a link URI with #anchor → sectionBody is the addressed section only.
  it('⑤ link #anchor → graph hit sectionBody = that section only', () => {
    withStore((store) => {
      seedTwoPages(store);
      link(store, 'rollback');

      const results = new MemorySearch(store).hybrid('rootkeyword');
      const hit = results.find((r) => r.path === 'neighbor.md');
      expect(hit).toBeDefined();
      expect(hit?.via).toBe('graph');
      expect(hit?.section).toBe('rollback');
      expect(hit?.sectionBody).toBeDefined();
      expect(hit?.sectionBody?.startsWith('## Rollback')).toBe(true);
      expect(hit?.sectionBody).toContain('rollback body only');
      // No sibling sections leak in.
      expect(hit?.sectionBody).not.toContain('## Deploy');
      expect(hit?.sectionBody).not.toContain('deploy body');
      expect(hit?.sectionBody).not.toContain('## Cleanup');
    });
  });

  // ⑤b page-level link (no #anchor) → whole page, section/sectionBody unset.
  it('⑤ page-level link (no #anchor) → whole page, section/sectionBody undefined', () => {
    withStore((store) => {
      seedTwoPages(store);
      link(store, null);

      const results = new MemorySearch(store).hybrid('rootkeyword');
      const hit = results.find((r) => r.path === 'neighbor.md');
      expect(hit).toBeDefined();
      expect(hit?.via).toBe('graph');
      expect(hit?.section).toBeUndefined();
      expect(hit?.sectionBody).toBeUndefined();
    });
  });

  // ⑤c #anchor pointing at a missing heading (rename) → sliceSection null →
  //    whole-page degrade (hit survives). Tightens the "never drop" guarantee.
  it('⑤ #anchor missing (rename) → degrade to whole page, hit survives', () => {
    withStore((store) => {
      seedTwoPages(store);
      link(store, 'was-renamed-away');

      const results = new MemorySearch(store).hybrid('rootkeyword');
      const hit = results.find((r) => r.path === 'neighbor.md');
      expect(hit).toBeDefined();
      expect(hit?.via).toBe('graph');
      expect(hit?.section).toBeUndefined();
      expect(hit?.sectionBody).toBeUndefined();
    });
  });

  // ⑥ payloadKind non-inline (sealed) → linkNeighbors yields no content →
  //    no slice possible → whole-page degrade (NOT dropped). store.write
  //    rejects non-inline, so we flip payloadKind via a side connection.
  it('⑥ sealed (non-inline) neighbor payload → whole-page degrade, not dropped', () => {
    withStore((store, dir) => {
      seedTwoPages(store);
      link(store, 'rollback'); // anchor present, but content will be unreadable

      // Flip the neighbor's current-version payload to a non-inline kind.
      const side = new Database(dbFile(dir));
      try {
        const updated = side
          .prepare(
            `UPDATE memory_page_content
               SET payloadKind = 'sealed'
             WHERE pageId = (SELECT id FROM memory_pages WHERE workspaceId = ? AND path = 'neighbor.md')`,
          )
          .run(WS);
        expect(updated.changes).toBeGreaterThan(0);
      } finally {
        side.close();
      }

      const results = new MemorySearch(store).hybrid('rootkeyword');
      const hit = results.find((r) => r.path === 'neighbor.md');
      // The neighbor still surfaces via the graph (page-level), just no section.
      expect(hit).toBeDefined();
      expect(hit?.via).toBe('graph');
      expect(hit?.section).toBeUndefined();
      expect(hit?.sectionBody).toBeUndefined();
    });
  });
});
