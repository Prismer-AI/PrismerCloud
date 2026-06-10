// M-B — fork-recall runner integration tests.
//
// Exercises the in-process orchestration helper end-to-end against a real
// SQLite-backed memory store. The LLM call is mocked so we can assert
// selector-prompt shape and abort handling without burning live tokens.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRuntime } from '../src/daemon/memory/runtime.js';
import {
  buildManifest,
  parseSelectorOutput,
  runForkedRecallInProcess,
  finalizeSelected,
  SELECT_MEMORIES_SYSTEM_PROMPT,
} from '../src/daemon/memory/fork/index.js';
import { MAX_MANIFEST_ENTRIES, MAX_SELECTED } from '../src/daemon/memory/fork/select-memories.js';

let dir = '';
let runtime: MemoryRuntime;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prismer-fork-'));
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
});

afterEach(() => {
  runtime.closeAll();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function seedPage(workspaceId: string, path: string, content: string, description: string | null = null): void {
  const slot = runtime.resolve(workspaceId);
  slot.store.write({
    workspaceId,
    path,
    content,
    pageType: 'leaf',
    actorImUserId: 'im_seed',
    actorKind: 'human',
    description,
  });
}

describe('buildManifest', () => {
  it('returns empty for an unopened workspace (peek miss)', () => {
    const m = buildManifest(runtime, 'ws_unknown', 'anything');
    expect(m.entries.length).toBe(0);
    expect(m.truncated).toBe(false);
  });

  it('returns FTS-ranked entries when query is non-empty', () => {
    seedPage('ws', 'memory/auth.md', 'OAuth migration decision', 'OAuth migration plan');
    seedPage('ws', 'memory/billing.md', 'Stripe billing setup', 'Billing config notes');
    seedPage('ws', 'memory/random.md', 'Plumbing notes about pipes', 'Random plumbing ref');
    const m = buildManifest(runtime, 'ws', 'OAuth');
    const paths = m.entries.map((e) => e.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.includes('memory/auth.md')).toBe(true);
    // Plumbing page must NOT match OAuth.
    expect(paths.includes('memory/random.md')).toBe(false);
  });

  it('falls back to updatedAt DESC when query is empty', () => {
    seedPage('ws', 'memory/p1.md', 'first', 'first page');
    seedPage('ws', 'memory/p2.md', 'second', 'second page');
    seedPage('ws', 'memory/p3.md', 'third', 'third page');
    // Force a deterministic updatedAt ordering — same-millisecond writes
    // are common in tests and would make the ordering check flaky.
    const slot = runtime.resolve('ws');
    const db = slot.store.rawDb();
    db.prepare(`UPDATE memory_pages SET updatedAt = ? WHERE workspaceId = 'ws' AND path = ?`).run(1000, 'memory/p1.md');
    db.prepare(`UPDATE memory_pages SET updatedAt = ? WHERE workspaceId = 'ws' AND path = ?`).run(2000, 'memory/p2.md');
    db.prepare(`UPDATE memory_pages SET updatedAt = ? WHERE workspaceId = 'ws' AND path = ?`).run(3000, 'memory/p3.md');
    const m = buildManifest(runtime, 'ws', '');
    expect(m.entries.length).toBe(3);
    // Most-recent first — p3 was bumped to the highest updatedAt.
    expect(m.entries[0]!.path).toBe('memory/p3.md');
  });

  it('honors the limit option (truncated = true when corpus exceeds it)', () => {
    for (let i = 0; i < 12; i++) seedPage('ws', `memory/p${i}.md`, `body ${i}`, `desc ${i}`);
    const m = buildManifest(runtime, 'ws', '', { limit: 5 });
    expect(m.entries.length).toBe(5);
    expect(m.truncated).toBe(true);
  });

  it('skips stale + archived pages from manifest', () => {
    seedPage('ws', 'memory/active.md', 'active body', 'active desc');
    seedPage('ws', 'memory/stale.md', 'stale body', 'stale desc');
    seedPage('ws', 'memory/archived.md', 'archived body', 'archived desc');
    const slot = runtime.resolve('ws');
    const db = slot.store.rawDb();
    // Stale and archived flags aren't exposed via store methods (they
    // arrive via cloud-mirror sync, not local writes), so flip them
    // directly. Emulates the post-sync state buildManifest must filter.
    db.prepare(`UPDATE memory_pages SET stale = 1 WHERE workspaceId='ws' AND path = 'memory/stale.md'`).run();
    db.prepare(`UPDATE memory_pages SET archivedAt = 12345 WHERE workspaceId='ws' AND path = 'memory/archived.md'`).run();
    const m = buildManifest(runtime, 'ws', '');
    const paths = m.entries.map((e) => e.path);
    expect(paths.includes('memory/active.md')).toBe(true);
    expect(paths.includes('memory/stale.md')).toBe(false);
    expect(paths.includes('memory/archived.md')).toBe(false);
  });
});

describe('parseSelectorOutput', () => {
  const manifest = [
    { path: 'memory/a.md', title: null, pageType: 'leaf', description: null, mtimeMs: 0 },
    { path: 'memory/b.md', title: null, pageType: 'leaf', description: null, mtimeMs: 0 },
  ];

  it('parses a clean JSON response', () => {
    const r = parseSelectorOutput('{"selected_memories": ["memory/a.md"]}', manifest);
    expect(r.selected).toEqual(['memory/a.md']);
  });

  it('strips ```json fences', () => {
    const r = parseSelectorOutput('```json\n{"selected_memories":["memory/b.md"]}\n```', manifest);
    expect(r.selected).toEqual(['memory/b.md']);
  });

  it('returns empty on malformed JSON without throwing', () => {
    const r = parseSelectorOutput('not json at all', manifest);
    expect(r.selected).toEqual([]);
  });

  it('drops hallucinated paths not in the manifest', () => {
    const r = parseSelectorOutput('{"selected_memories":["memory/nope.md","memory/a.md"]}', manifest);
    expect(r.selected).toEqual(['memory/a.md']);
  });

  it('caps at MAX_SELECTED entries even if the LLM returned more', () => {
    const longManifest = Array.from({ length: 10 }, (_, i) => ({
      path: `memory/p${i}.md`,
      title: null,
      pageType: 'leaf',
      description: null,
      mtimeMs: 0,
    }));
    const allPaths = JSON.stringify({
      selected_memories: longManifest.map((e) => e.path),
    });
    const r = parseSelectorOutput(allPaths, longManifest);
    expect(r.selected.length).toBe(MAX_SELECTED);
  });

  it('deduplicates repeated filenames in selector output', () => {
    const r = parseSelectorOutput('{"selected_memories":["memory/a.md","memory/a.md","memory/b.md"]}', manifest);
    expect(r.selected).toEqual(['memory/a.md', 'memory/b.md']);
  });
});

describe('finalizeSelected', () => {
  it('resolves selected paths to RelevantMemory[] with snippets + URI', () => {
    seedPage('ws', 'memory/x.md', 'x body content here', 'x desc');
    const r = finalizeSelected(runtime, 'ws', ['memory/x.md'], 100);
    expect(r.length).toBe(1);
    expect(r[0]!.path).toBe('memory/x.md');
    expect(r[0]!.uri).toBe('prismer://workspace/ws/memory/memory/x.md');
    expect(r[0]!.snippet).toContain('x body');
  });

  it('drops paths that do not exist (defensive)', () => {
    seedPage('ws', 'memory/exists.md', 'body', null);
    const r = finalizeSelected(runtime, 'ws', ['memory/exists.md', 'memory/nope.md'], 100);
    expect(r.length).toBe(1);
  });

  it('truncates oversized content to fit the snippet byte cap', () => {
    seedPage('ws', 'memory/big.md', 'x'.repeat(10_000), null);
    const r = finalizeSelected(runtime, 'ws', ['memory/big.md'], 200);
    expect(Buffer.byteLength(r[0]!.snippet, 'utf8')).toBeLessThanOrEqual(200);
  });
});

describe('runForkedRecallInProcess', () => {
  it('skips the LLM call when manifest is empty', async () => {
    let llmCalls = 0;
    const r = await runForkedRecallInProcess({
      runtime,
      workspaceId: 'ws_empty',
      query: 'does anything exist',
      forkLLM: async () => {
        llmCalls++;
        return { text: '{"selected_memories":[]}' };
      },
      trace: { deviceId: 'dev_x', actorImUserId: 'im_a', actorKind: 'agent' },
    });
    expect(llmCalls).toBe(0);
    expect(r.results).toEqual([]);
    expect(r.manifestSize).toBe(0);
  });

  it('end-to-end: builds manifest, calls LLM, returns finalized memories', async () => {
    seedPage('ws', 'memory/hit.md', 'body for hit', 'this is what the agent wanted');
    seedPage('ws', 'memory/miss.md', 'unrelated body', 'unrelated desc');

    const captured: { system: string; user: string }[] = [];
    const r = await runForkedRecallInProcess({
      runtime,
      workspaceId: 'ws',
      query: 'agent wanted',
      forkLLM: async (input) => {
        captured.push(input);
        return { text: '{"selected_memories":["memory/hit.md"]}' };
      },
      trace: { deviceId: 'dev_x', actorImUserId: 'im_a', actorKind: 'agent' },
    });

    expect(captured.length).toBe(1);
    expect(captured[0]!.system).toBe(SELECT_MEMORIES_SYSTEM_PROMPT);
    expect(captured[0]!.user).toContain('Query: agent wanted');
    expect(captured[0]!.user).toContain('memory/hit.md');
    expect(r.selectedPaths).toEqual(['memory/hit.md']);
    expect(r.results.length).toBe(1);
    expect(r.results[0]!.path).toBe('memory/hit.md');
  });

  it('emits a recall_fork outbox event after a non-empty fork', async () => {
    seedPage('ws', 'memory/hit.md', 'body', 'desc');
    const slot = runtime.resolve('ws');
    const before = slot.outbox.pendingCount();

    await runForkedRecallInProcess({
      runtime,
      workspaceId: 'ws',
      query: 'desc',
      forkLLM: async () => ({ text: '{"selected_memories":["memory/hit.md"]}' }),
      trace: { deviceId: 'dev_x', actorImUserId: 'im_a', actorKind: 'agent', forkLabel: 'memory_recall' },
    });

    expect(slot.outbox.pendingCount() - before).toBe(1);
  });

  it('returns empty without crashing when forkLLM throws', async () => {
    seedPage('ws', 'memory/hit.md', 'body', 'desc');
    const r = await runForkedRecallInProcess({
      runtime,
      workspaceId: 'ws',
      query: 'desc',
      forkLLM: async () => {
        throw new Error('host LLM unreachable');
      },
      trace: { deviceId: 'dev_x', actorImUserId: 'im_a', actorKind: 'agent' },
    });
    expect(r.results).toEqual([]);
    expect(r.selectedPaths).toEqual([]);
  });

  it('respects abort signal — empty result, no fork trace emit', async () => {
    seedPage('ws', 'memory/hit.md', 'body', 'desc');
    const slot = runtime.resolve('ws');
    const before = slot.outbox.pendingCount();
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await runForkedRecallInProcess({
      runtime,
      workspaceId: 'ws',
      query: 'desc',
      forkLLM: async () => {
        throw new Error('aborted');
      },
      trace: { deviceId: 'dev_x', actorImUserId: 'im_a', actorKind: 'agent' },
      signal: ctrl.signal,
    });
    expect(r.results).toEqual([]);
    expect(slot.outbox.pendingCount() - before).toBe(0);
  });
});

describe('SELECT_MEMORIES_SYSTEM_PROMPT', () => {
  it('contains the "be selective" load-bearing instruction', () => {
    expect(/be selective|do NOT include/i.test(SELECT_MEMORIES_SYSTEM_PROMPT)).toBe(true);
  });

  it('matches MAX_MANIFEST_ENTRIES expectation', () => {
    expect(MAX_MANIFEST_ENTRIES).toBeGreaterThanOrEqual(50);
    expect(MAX_MANIFEST_ENTRIES).toBeLessThanOrEqual(500);
  });
});
