// Unit tests for initialSyncFromCloud (cloud-to-local memory sync pull).
//
// Tests cover:
//   - Happy path: cloud returns pages, they land in the local store
//   - No store: skips silently when runtime has no store for the workspace
//   - Already populated: skips when the store already has pages
//   - Cloud error: graceful handling (log + return {0,0})
//   - Empty cloud response: graceful handling
//   - Minimal pages: pages with no title/content still sync cleanly
//
// We test initialSyncFromCloud directly (not via syncMemoryFromCloud) to
// keep the tests focused on the sync logic rather than the wiring. The
// syncMemoryFromCloud wrapper adds only resolve() + error wrapping — the
// interesting behavior lives here.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudClient } from '../src/auth.js';
import { MemoryRuntime } from '../src/daemon/memory/runtime.js';
import { initialSyncFromCloud } from '../src/daemon/memory/cloud-sync.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'prismer-cloud-sync-'));
}

/** Build a mock Response shape that CloudClient.request() digests. */
function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface MockPage {
  id: string;
  path: string;
  pageType?: string;
  visibility?: string;
  title?: string | null;
  content?: string | null;
}

/**
 * Build a CloudClient whose fetchImpl returns the given pages for any
 * request URL containing `/api/im/memory/pages`.
 */
function cloudWithPages(pages: MockPage[]): CloudClient {
  return new CloudClient({
    apiKey: 'sk-test',
    baseUrl: 'http://cloud.test',
    fetchImpl: ((url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : '';
      // List endpoint
      return Promise.resolve(
        mockResponse(200, { ok: true, data: pages }),
      );
    }) as unknown as typeof fetch,
  });
}

/**
 * Build a CloudClient whose fetchImpl returns an error response.
 */
function cloudWithError(status: number): CloudClient {
  return new CloudClient({
    apiKey: 'sk-test',
    baseUrl: 'http://cloud.test',
    fetchImpl: (() =>
      Promise.resolve(mockResponse(status, { ok: false, error: { code: 'test_error', message: 'mock error' } }))) as unknown as typeof fetch,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('initialSyncFromCloud', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it('pulls cloud pages and writes them to the local store', async () => {
    const dir = tmpDir();
    cleanup.push(dir);

    const runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_test' });
    // Resolve a workspace to create the store
    runtime.resolve('ws_test');

    const cloud = cloudWithPages([
      {
        id: 'page_001',
        path: 'INDEX.md',
        pageType: 'hub',
        visibility: 'workspace',
        title: 'Workspace Index',
        content: '# Index\n\nDecisions and glossary.',
      },
      {
        id: 'page_002',
        path: 'decisions/auth.md',
        pageType: 'decision',
        visibility: 'workspace',
        title: 'Auth Decision',
        content: '# Auth\n\nUse OAuth2.',
      },
    ]);

    const result = await initialSyncFromCloud(runtime, cloud, 'ws_test');

    expect(result.pulled).toBe(2);
    expect(result.skipped).toBe(0);

    // Verify pages are in the local store
    const slot = runtime.peek('ws_test')!;
    const pages = slot.store.list();
    expect(pages).toHaveLength(2);

    const index = slot.store.loadByPath('INDEX.md');
    expect(index).not.toBeNull();
    expect(index!.title).toBe('Workspace Index');
    expect(index!.pageType).toBe('hub');

    const auth = slot.store.loadByPath('decisions/auth.md');
    expect(auth).not.toBeNull();
    expect(auth!.title).toBe('Auth Decision');

    // Content should be loadable
    const content = slot.store.loadContent(index!.id);
    expect(content?.content).toContain('# Index');
  });

  it('projects the cloud owner-prefixed visibility string into structured visibility (ACL boundary)', async () => {
    const dir = tmpDir();
    cleanup.push(dir);

    const runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_test' });
    runtime.resolve('ws_test');

    // The cloud stores visibility as an owner-PREFIXED string. The sync must
    // preserve both the kind AND the owner id, else an agent-private page lands
    // as workspace-visible and leaks to every in-workspace agent (the live MVP3
    // ACL leak this regression-guards). Cover workspace + agent:<id> + a
    // fail-closed owner kind (human:<id> → private<owner>).
    const cloud = cloudWithPages([
      { id: 'pw', path: 'pub.md', visibility: 'workspace', content: '# pub' },
      { id: 'pa', path: 'secret.md', visibility: 'agent:im_owner_42', content: '# secret' },
      { id: 'ph', path: 'human.md', visibility: 'human:im_human_7', content: '# human' },
    ]);

    const result = await initialSyncFromCloud(runtime, cloud, 'ws_test');
    expect(result.pulled).toBe(3);

    const slot = runtime.peek('ws_test')!;
    const pub = slot.store.loadByPath('pub.md');
    expect(pub!.visibility).toEqual({ kind: 'workspace' });
    // The subset mirrors the cloud's canonical id (so memory_curate / load-by-id
    // address the right cloud page — the MVP4 curate-404 this guards).
    expect(pub!.id).toBe('pw');

    const secret = slot.store.loadByPath('secret.md');
    expect(secret!.visibility).toEqual({ kind: 'agent', imUserId: 'im_owner_42' });
    expect(secret!.id).toBe('pa');

    // Fail-closed: an owner kind the daemon doesn't model as `agent` collapses
    // to `private` with the parsed subject (only that subject can read it).
    const human = slot.store.loadByPath('human.md');
    expect(human!.visibility).toEqual({ kind: 'private', imUserId: 'im_human_7' });
  });

  it('returns {0,0} when no store exists for the workspace', async () => {
    const dir = tmpDir();
    cleanup.push(dir);

    const runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_test' });
    // Never resolve ws_other — no store created
    runtime.resolve('ws_somewhere');

    const cloud = cloudWithPages([
      { id: 'p1', path: 'a.md', content: 'x' },
    ]);

    const result = await initialSyncFromCloud(runtime, cloud, 'ws_other');

    expect(result).toEqual({ pulled: 0, skipped: 0, upToDate: true });
  });

  it('pulls cloud pages even when local-only pages already exist but no sync cursor is recorded', async () => {
    const dir = tmpDir();
    cleanup.push(dir);

    const runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_test' });
    const slot = runtime.resolve('ws_test');

    // Seed a page
    slot.store.write({
      workspaceId: 'ws_test',
      path: 'existing.md',
      content: 'i was here first',
      actorImUserId: 'im_seed',
      actorKind: 'human',
    });

    const cloud = cloudWithPages([
      { id: 'p_new', path: 'new.md', content: 'pulled from cloud' },
    ]);

    const result = await initialSyncFromCloud(runtime, cloud, 'ws_test');

    expect(result).toEqual({ pulled: 1, skipped: 0, upToDate: false });

    // Local-only page remains, and the initial cloud sync merges the cloud page.
    expect(slot.store.loadByPath('existing.md')).not.toBeNull();
    expect(slot.store.loadByPath('new.md')).not.toBeNull();
  });

  it('gracefully handles cloud API errors', async () => {
    const dir = tmpDir();
    cleanup.push(dir);

    const runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_test' });
    runtime.resolve('ws_test');

    const cloud = cloudWithError(500);

    // Must not throw — logs and returns a no-op result.
    const result = await initialSyncFromCloud(runtime, cloud, 'ws_test');
    expect(result).toEqual({ pulled: 0, skipped: 0, upToDate: true });
  });

  it('gracefully handles empty cloud response', async () => {
    const dir = tmpDir();
    cleanup.push(dir);

    const runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_test' });
    runtime.resolve('ws_test');

    const cloud = cloudWithPages([]);

    const result = await initialSyncFromCloud(runtime, cloud, 'ws_test');
    expect(result).toEqual({ pulled: 0, skipped: 0, upToDate: true });
  });

  it('handles pages without title or content in list response', async () => {
    const dir = tmpDir();
    cleanup.push(dir);

    const runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_test' });
    runtime.resolve('ws_test');

    // Page with no title and no content in list — should still succeed
    // (empty content is written, title is omitted)
    const cloud = cloudWithPages([
      {
        id: 'p_minimal',
        path: 'minimal.md',
        pageType: 'leaf',
        visibility: 'workspace',
        // no title, no content
      },
    ]);

    const result = await initialSyncFromCloud(runtime, cloud, 'ws_test');

    expect(result.pulled).toBe(1);
    expect(result.skipped).toBe(0);

    const slot = runtime.peek('ws_test')!;
    const page = slot.store.loadByPath('minimal.md');
    expect(page).not.toBeNull();
    expect(page!.title).toBeNull();
    // Content is empty string (should still be stored)
    const content = slot.store.loadContent(page!.id);
    expect(content?.content).toBe('');
  });
});
