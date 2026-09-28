import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachDeliver } from '../src/daemon/asset/deliver.js';
import { ArtifactsWatcher } from '../src/daemon/artifacts-watcher.js';

function mockCloud() {
  const baseUrl = 'http://cloud.test';
  return {
    apiKey: 'sk-test',
    baseUrl,
    opts: { apiKey: 'sk-test', baseUrl },
    // Minimal CloudClient.request used by the send-mode message POST. Routes
    // through the global fetch stub so tests can observe the X-IM-Agent header
    // + body. Returns the same { ok, status, data } envelope the real client
    // produces.
    async request(method: string, path: string, init?: { body?: unknown; headers?: Record<string, string> }) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        data = undefined;
      }
      if (!res.ok) {
        return { ok: false, status: res.status, error: { code: 'http', message: `HTTP ${res.status}` } };
      }
      return { ok: true, status: res.status, data };
    },
  };
}

function mkResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('attachDeliver (release202/09 P2 explicit delivery sink)', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const dir of cleanup.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function tmpFileWith(name: string, contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'prismer-deliver-'));
    cleanup.push(dir);
    const full = join(dir, name);
    writeFileSync(full, contents);
    return full;
  }

  it('mode:attach uploads + records the assetId so flushPending rides it on the reply', async () => {
    const filePath = tmpFileWith('report.pdf', '%PDF-1.4\n%minimal\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/im/assets/direct-upload/init')) return mkResponse({ ok: false }, 503);
        return mkResponse({ ok: true, data: { id: 'asset-pdf-1', contentHash: 'sha256-x' } }, 201);
      }) as unknown as typeof fetch,
    );

    const watcher = new ArtifactsWatcher({
      cloud: mockCloud() as any,
      containerId: 'c-1',
      workspaceId: () => 'ws-1',
      autoScan: false,
      log: { info: () => {}, warn: () => {} },
    });
    const handler = attachDeliver({ watcher, cloud: mockCloud() as any });

    const result = await handler({ taskId: 'task-A', path: filePath, mode: 'attach' });
    expect(result.status).toBe(200);
    expect((result.body as any).ok).toBe(true);
    expect((result.body as any).assetId).toBe('asset-pdf-1');
    // The assetId is now in pendingByTask — the dispatch-end channel.
    expect(watcher.flushPending('task-A')).toEqual(['asset-pdf-1']);
  });

  it('mode:send posts a standalone message with the asset attachment (X-IM-Agent stamped)', async () => {
    const filePath = tmpFileWith('deck.pdf', '%PDF-1.4\n');
    const sends: Array<{ url: string; agentHeader?: string; body: any }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/im/assets/direct-upload/init')) return mkResponse({ ok: false }, 503);
        if (url.includes('/api/im/messages/')) {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          sends.push({ url, agentHeader: headers['X-IM-Agent'], body: JSON.parse(String(init?.body)) });
          return mkResponse({ ok: true, data: { id: 'msg-1', conversationId: 'conv-9' } }, 200);
        }
        return mkResponse({ ok: true, data: { id: 'asset-send-1', contentHash: 'sha256-y' } }, 201);
      }) as unknown as typeof fetch,
    );

    const watcher = new ArtifactsWatcher({
      cloud: mockCloud() as any,
      containerId: 'c-1',
      workspaceId: () => 'ws-1',
      autoScan: false,
      log: { info: () => {}, warn: () => {} },
    });
    const handler = attachDeliver({ watcher, cloud: mockCloud() as any });

    const result = await handler({
      taskId: 'task-A',
      path: filePath,
      mode: 'send',
      conversationId: 'conv-9',
      agentUsername: 'ceo',
    });
    expect(result.status).toBe(200);
    expect((result.body as any).assetId).toBe('asset-send-1');
    expect(sends.length).toBe(1);
    expect(sends[0]!.url).toContain('/api/im/messages/conv-9');
    expect(sends[0]!.agentHeader).toBe('ceo');
    expect(sends[0]!.body.attachments[0]).toMatchObject({ kind: 'asset', assetId: 'asset-send-1' });
    // send-mode does NOT ride the reply.
    expect(watcher.flushPending('task-A')).toEqual([]);
  });

  it('mode:task-attach uploads as a task-bound asset (sourceTaskId) without riding the reply or sending a message', async () => {
    const filePath = tmpFileWith('deliverable.pdf', '%PDF-1.4\n%task\n');
    const uploads: Array<{ url: string; sourceTaskId?: string }> = [];
    let messagePosts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/im/assets/direct-upload/init')) return mkResponse({ ok: false }, 503);
        if (url.includes('/api/im/messages/')) {
          messagePosts += 1;
          return mkResponse({ ok: true, data: { id: 'msg-x' } }, 200);
        }
        // multipart POST /assets — the daemon stamps sourceTaskId in the form;
        // capture the URL so we can assert the asset upload happened.
        if (url.includes('/api/im/assets')) {
          let sourceTaskId: string | undefined;
          try {
            const form = init?.body as FormData | undefined;
            const v = form?.get?.('sourceTaskId');
            if (typeof v === 'string') sourceTaskId = v;
          } catch {
            /* body not a FormData in this stub path */
          }
          uploads.push({ url, ...(sourceTaskId ? { sourceTaskId } : {}) });
        }
        return mkResponse({ ok: true, data: { id: 'asset-task-1', contentHash: 'sha256-t' } }, 201);
      }) as unknown as typeof fetch,
    );

    const watcher = new ArtifactsWatcher({
      cloud: mockCloud() as any,
      containerId: 'c-1',
      workspaceId: () => 'ws-1',
      autoScan: false,
      log: { info: () => {}, warn: () => {} },
    });
    const handler = attachDeliver({ watcher, cloud: mockCloud() as any });

    const result = await handler({ taskId: 'task_KANBAN1', path: filePath, mode: 'task-attach' });
    expect(result.status).toBe(200);
    expect((result.body as any).ok).toBe(true);
    expect((result.body as any).mode).toBe('task-attach');
    expect((result.body as any).assetId).toBe('asset-task-1');
    expect((result.body as any).taskId).toBe('task_KANBAN1');
    // task-attach does NOT ride the chat reply (kanban card binding is via the
    // cloud's sourceTaskId rollup, not reply.assetIds).
    expect(watcher.flushPending('task_KANBAN1')).toEqual([]);
    // and it never posts a standalone message.
    expect(messagePosts).toBe(0);
    // the daemon stamped sourceTaskId on the upload so the cloud binds it to
    // the task card.
    expect(uploads.some((u) => u.sourceTaskId === 'task_KANBAN1')).toBe(true);
  });

  it('mode:message-attach uploads + appends to an already-sent message via the cloud attach route (X-IM-Agent stamped)', async () => {
    const filePath = tmpFileWith('addendum.pdf', '%PDF-1.4\n%a2\n');
    const attaches: Array<{ url: string; agentHeader?: string; body: any }> = [];
    let standaloneMessagePosts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/im/assets/direct-upload/init')) return mkResponse({ ok: false }, 503);
        // The A2 attach route ends in `/attach`. A standalone `send`-mode POST
        // would hit `/api/im/messages/<conv>` with NO `/attach` suffix.
        if (url.includes('/api/im/messages/') && url.endsWith('/attach')) {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          attaches.push({ url, agentHeader: headers['X-IM-Agent'], body: JSON.parse(String(init?.body)) });
          return mkResponse({ ok: true, data: { messageId: 'msg-existing', assetId: 'asset-a2-1', added: true } }, 200);
        }
        if (url.includes('/api/im/messages/')) {
          standaloneMessagePosts += 1;
          return mkResponse({ ok: true, data: { id: 'msg-x' } }, 200);
        }
        return mkResponse({ ok: true, data: { id: 'asset-a2-1', contentHash: 'sha256-a2' } }, 201);
      }) as unknown as typeof fetch,
    );

    const watcher = new ArtifactsWatcher({
      cloud: mockCloud() as any,
      containerId: 'c-1',
      workspaceId: () => 'ws-1',
      autoScan: false,
      log: { info: () => {}, warn: () => {} },
    });
    const handler = attachDeliver({ watcher, cloud: mockCloud() as any });

    const result = await handler({
      taskId: 'run_CHAT1',
      path: filePath,
      mode: 'message-attach',
      conversationId: 'conv-9',
      messageId: 'msg-existing',
      agentUsername: 'ceo',
    });
    expect(result.status).toBe(200);
    expect((result.body as any).ok).toBe(true);
    expect((result.body as any).mode).toBe('message-attach');
    expect((result.body as any).assetId).toBe('asset-a2-1');
    expect((result.body as any).messageId).toBe('msg-existing');
    // It hits the conversation-scoped attach route with the messageId, stamped
    // as the agent so the cloud sender-check passes.
    expect(attaches.length).toBe(1);
    expect(attaches[0]!.url).toContain('/api/im/messages/conv-9/msg-existing/attach');
    expect(attaches[0]!.agentHeader).toBe('ceo');
    expect(attaches[0]!.body).toMatchObject({ assetId: 'asset-a2-1' });
    // It does NOT post a standalone message and does NOT ride the chat reply.
    expect(standaloneMessagePosts).toBe(0);
    expect(watcher.flushPending('run_CHAT1')).toEqual([]);
  });

  it('rejects message-attach missing conversationId/messageId with 400', async () => {
    const filePath = tmpFileWith('x.pdf', '%PDF-1.4\n');
    const watcher = new ArtifactsWatcher({
      cloud: mockCloud() as any,
      containerId: 'c-1',
      workspaceId: () => 'ws-1',
      autoScan: false,
      log: { info: () => {}, warn: () => {} },
    });
    const handler = attachDeliver({ watcher, cloud: mockCloud() as any });
    // no conversationId
    expect((await handler({ taskId: 't', path: filePath, mode: 'message-attach', messageId: 'm' })).status).toBe(400);
    // no messageId
    expect(
      (await handler({ taskId: 't', path: filePath, mode: 'message-attach', conversationId: 'c' })).status,
    ).toBe(400);
  });

  it('rejects missing taskId/path with 400', async () => {
    const watcher = new ArtifactsWatcher({
      cloud: mockCloud() as any,
      containerId: 'c-1',
      workspaceId: () => 'ws-1',
      autoScan: false,
      log: { info: () => {}, warn: () => {} },
    });
    const handler = attachDeliver({ watcher, cloud: mockCloud() as any });
    expect((await handler({ path: '/tmp/x', mode: 'attach' })).status).toBe(400);
    expect((await handler({ taskId: 't', mode: 'attach' })).status).toBe(400);
    expect((await handler({ taskId: 't', path: '/tmp/x', mode: 'send' })).status).toBe(400); // no conversationId
  });

  it('returns 404 when the file does not exist', async () => {
    const watcher = new ArtifactsWatcher({
      cloud: mockCloud() as any,
      containerId: 'c-1',
      workspaceId: () => 'ws-1',
      autoScan: false,
      log: { info: () => {}, warn: () => {} },
    });
    const handler = attachDeliver({ watcher, cloud: mockCloud() as any });
    const result = await handler({ taskId: 'task-A', path: '/tmp/does-not-exist-xyz.pdf', mode: 'attach' });
    expect(result.status).toBe(404);
  });

  it('returns 422 on magic-bytes mismatch (markdown renamed to .pdf)', async () => {
    const filePath = tmpFileWith('fake.pdf', '# This is markdown, not a PDF\n');
    vi.stubGlobal('fetch', vi.fn(async () => mkResponse({ ok: true, data: { id: 'x', contentHash: 'h' } }, 201)) as unknown as typeof fetch);

    const watcher = new ArtifactsWatcher({
      cloud: mockCloud() as any,
      containerId: 'c-1',
      workspaceId: () => 'ws-1',
      autoScan: false,
      log: { info: () => {}, warn: () => {} },
    });
    const handler = attachDeliver({ watcher, cloud: mockCloud() as any });
    const result = await handler({ taskId: 'task-A', path: filePath, mode: 'attach' });
    expect(result.status).toBe(422);
    expect(String((result.body as any).error)).toMatch(/MIME_MISMATCH|rejected/i);
  });
});
