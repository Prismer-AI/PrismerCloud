import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRuntime } from '../src/daemon/memory/runtime.js';
import { MemoryRecallHooks, truncateToBudget } from '../src/daemon/memory/hooks.js';

let dir = '';
let runtime: MemoryRuntime;
let hooks: MemoryRecallHooks;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prismer-hooks-'));
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
  hooks = new MemoryRecallHooks(runtime, 'dev_x');
});

afterEach(() => {
  runtime.closeAll();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function seedIndex(content: string): void {
  const slot = runtime.resolve('ws_test');
  slot.store.write({
    workspaceId: 'ws_test',
    path: 'INDEX.md',
    content,
    pageType: 'hub',
    actorImUserId: 'im_seed',
    actorKind: 'human',
  });
}

function seedPage(path: string, content: string): void {
  const slot = runtime.resolve('ws_test');
  slot.store.write({
    workspaceId: 'ws_test',
    path,
    content,
    pageType: 'leaf',
    actorImUserId: 'im_seed',
    actorKind: 'human',
  });
}

describe('truncateToBudget', () => {
  it('passes content under both limits unchanged', () => {
    const r = truncateToBudget('a\nb\nc', { maxLines: 100, maxBytes: 1000 });
    expect(r.truncated).toBe(false);
    expect(r.output).toBe('a\nb\nc');
  });

  it('truncates by line count', () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line${i}`).join('\n');
    const r = truncateToBudget(lines, { maxLines: 100, maxBytes: 1024 * 1024 });
    expect(r.truncated).toBe(true);
    expect(r.output.split('\n').length).toBe(100);
  });

  it('truncates by byte cap when single line exceeds budget', () => {
    const huge = 'x'.repeat(50_000);
    const r = truncateToBudget(huge, { maxLines: 1000, maxBytes: 1024 });
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.output, 'utf8')).toBeLessThanOrEqual(1024);
  });
});

describe('MemoryRecallHooks.onSessionStart', () => {
  it('returns null when no INDEX.md exists', () => {
    const r = hooks.onSessionStart({
      workspaceId: 'ws_test',
      agentImUserId: 'im_agent',
      actorKind: 'agent',
      sessionId: 'sess_1',
    });
    expect(r).toBeNull();
  });

  it('loads INDEX.md content + emits recall_preload outbox event', () => {
    seedIndex('# index\n\n- a.md\n- b.md\n');
    const slot = runtime.resolve('ws_test');
    const before = slot.outbox.pendingCount();

    const r = hooks.onSessionStart({
      workspaceId: 'ws_test',
      agentImUserId: 'im_agent',
      actorKind: 'agent',
      sessionId: 'sess_1',
    });

    expect(r).not.toBeNull();
    expect(r!.content).toContain('# index');
    expect(r!.truncated).toBe(false);
    expect(r!.pageId).toMatch(/^page_/);
    expect(slot.outbox.pendingCount()).toBe(before + 1);
  });

  it('truncates over-budget INDEX + reports truncated=true', () => {
    const oversized = Array.from({ length: 500 }, (_, i) => `### section ${i}`).join('\n');
    seedIndex(oversized);

    const r = hooks.onSessionStart({
      workspaceId: 'ws_test',
      agentImUserId: 'im_agent',
      actorKind: 'agent',
      sessionId: 'sess_1',
    });

    expect(r).not.toBeNull();
    expect(r!.truncated).toBe(true);
    expect(r!.content.split('\n').length).toBeLessThanOrEqual(200);
  });
});

describe('MemoryRecallHooks.onIdleRecallHint', () => {
  it('returns null on empty query', () => {
    const r = hooks.onIdleRecallHint({
      workspaceId: 'ws_test',
      agentImUserId: 'im_agent',
      actorKind: 'agent',
      sessionId: 'sess_1',
      turnIndex: 0,
      query: '   ',
    });
    expect(r).toBeNull();
  });

  it('returns null when no results meet relevance threshold', () => {
    seedPage('a.md', 'totally different content about plumbing');
    const r = hooks.onIdleRecallHint({
      workspaceId: 'ws_test',
      agentImUserId: 'im_agent',
      actorKind: 'agent',
      sessionId: 'sess_1',
      turnIndex: 0,
      query: 'unicorn rainbow',
    });
    expect(r).toBeNull();
  });

  it('builds <memory-context> fence with top-3 hits + emits one recall_inject per hit', () => {
    seedPage('auth.md', 'OAuth migration decision');
    seedPage('billing.md', 'Stripe billing OAuth scope notes');
    seedPage('arch.md', 'OAuth flow architecture');
    const slot = runtime.resolve('ws_test');
    const before = slot.outbox.pendingCount();

    const r = hooks.onIdleRecallHint({
      workspaceId: 'ws_test',
      agentImUserId: 'im_agent',
      actorKind: 'agent',
      sessionId: 'sess_1',
      turnIndex: 5,
      query: 'OAuth',
      relevanceThreshold: 0,
    });

    expect(r).not.toBeNull();
    expect(r!.fence).toMatch(/^<memory-context>/);
    expect(r!.fence).toMatch(/<\/memory-context>$/);
    expect(r!.results.length).toBeGreaterThan(0);
    expect(r!.results.length).toBeLessThanOrEqual(3);
    expect(slot.outbox.pendingCount() - before).toBe(r!.results.length);
  });

  it('respects custom topK + maxBytes overrides', () => {
    for (let i = 0; i < 10; i++) seedPage(`p${i}.md`, `decision ${i}`);
    const r = hooks.onIdleRecallHint({
      workspaceId: 'ws_test',
      agentImUserId: 'im_agent',
      actorKind: 'agent',
      sessionId: 'sess_1',
      turnIndex: 0,
      query: 'decision',
      topK: 2,
      relevanceThreshold: 0,
    });
    expect(r!.results.length).toBeLessThanOrEqual(2);
  });
});
