import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CloudClient } from '../src/auth.js';
import { PKF_BUNDLE_COMMIT_TOOL } from '../src/adapters/memory-tools.js';
import { attachPkfRpc } from '../src/daemon/pkf/rpc.js';

const hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const sri = (data: string | Buffer) => `sha256-${createHash('sha256').update(data).digest('base64')}`;

const ROOT_SOURCE =
  '<script type="application/prismer+json">{"type":"note","title":"Bundle","pkfVersion":"1.1"}</script><section><h2 id="bundle">Bundle</h2></section>';
// pkf209/07 §4a: the runtime normalizer verifies self-supplied hashes, so the
// legacy fixtures carry REAL hashes (computed, not hand-typed).
const ROOT = {
  filename: 'interactive-report.pkf',
  source: ROOT_SOURCE,
  sourceHash: hex(ROOT_SOURCE),
};
const CSV_BYTES = Buffer.from('YSxiCjEsMgo=', 'base64');
const RESOURCES = [
  {
    path: 'data.csv',
    bytesBase64: 'YSxiCjEsMgo=',
    contentHash: hex(CSV_BYTES),
    integrity: sri(CSV_BYTES),
    mime: 'text/csv',
    usage: 'data',
  },
];
const VIEW = {
  replayed: false,
  receipt: { id: 'pkfbr_1', state: 'committed', requestHash: 'd'.repeat(64) },
  root: {
    id: 'pkfb_1',
    revision: 1,
    contentHash: ROOT.sourceHash,
    filename: ROOT.filename,
    workspacePath: 'PKF/interactive-report.pkf',
  },
  resources: [
    {
      id: 'pkfr_1',
      path: 'data.csv',
      contentHash: RESOURCES[0]!.contentHash,
      integrity: RESOURCES[0]!.integrity,
      mime: 'text/csv',
      usage: 'data',
      fromContentHash: ROOT.sourceHash,
      fromNodeKey: `asset:pkfb_1:1:${ROOT.sourceHash}`,
      boundKind: 'pkf-resource',
    },
  ],
};

async function start(handler: ReturnType<typeof attachPkfRpc>): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res))) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server unavailable');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function post(
  baseUrl: string,
  body: unknown,
  agentImUserId = 'agent-runtime',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/local/pkf/bundle-commit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(agentImUserId ? { 'X-Prismer-Agent': agentImUserId } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('pkf_bundle_commit tool schema (pkf209/07 §4a relaxed model surface)', () => {
  it('keeps every legacy field while making hashes optional and adding text/harnessDecl', () => {
    const schema = PKF_BUNDLE_COMMIT_TOOL.inputSchema as {
      properties: Record<string, { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }>;
      required: string[];
      additionalProperties: boolean;
    };
    // wire keeps additionalProperties:false everywhere (no unknown bleed)
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['idempotencyKey', 'root', 'resources']);
    // root: sourceHash optional, old fields still declared
    expect(schema.properties.root!.required).toEqual(['filename', 'source']);
    expect(schema.properties.root!.properties).toHaveProperty('sourceHash');
    const item = (schema.properties.resources as unknown as {
      items: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
    }).items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(['path', 'mime', 'usage']);
    for (const legacy of ['fromPath', 'bytesBase64', 'contentHash', 'integrity', 'mime', 'usage']) {
      expect(item.properties).toHaveProperty(legacy);
    }
    expect(item.properties).toHaveProperty('text');
    expect(schema.properties).toHaveProperty('harnessDecl');
  });
});

describe('pkf_bundle_commit Runtime RPC', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it('commits one logical bundle and verifies the canonical Cloud readback', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 201, data: { success: true, data: VIEW, requestId: 'req-post' } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { success: true, data: VIEW, requestId: 'req-get' } });
    const local = await start(
      attachPkfRpc({ cloud: { request } as unknown as CloudClient, workspaceId: () => 'ws-runtime' }),
    );
    servers.push(local.server);

    const response = await post(local.baseUrl, {
      idempotencyKey: 'bundle-turn-1',
      root: ROOT,
      resources: RESOURCES,
      workspaceId: 'ws-forged-by-model',
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      receipt: VIEW.receipt,
      root: VIEW.root,
      resources: VIEW.resources,
    });
    expect(request).toHaveBeenNthCalledWith(1, 'POST', '/api/pkf/bundles/commit', {
      body: { workspaceId: 'ws-runtime', idempotencyKey: 'bundle-turn-1', root: ROOT, resources: RESOURCES },
      headers: { 'X-Prismer-Agent': 'agent-runtime' },
      timeoutMs: 120_000,
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      'GET',
      '/api/pkf/bundles/commit?workspaceId=ws-runtime&idempotencyKey=bundle-turn-1',
      { headers: { 'X-Prismer-Agent': 'agent-runtime' }, timeoutMs: 120_000 },
    );
  });

  it('fails closed before Cloud when the trusted provider identity header is absent', async () => {
    const request = vi.fn();
    const local = await start(
      attachPkfRpc({ cloud: { request } as unknown as CloudClient, workspaceId: () => 'ws-runtime' }),
    );
    servers.push(local.server);
    const response = await post(
      local.baseUrl,
      { idempotencyKey: 'no-agent', root: ROOT, resources: RESOURCES, actor: 'forged-model-actor' },
      '',
    );
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('pkf_bundle_agent_unbound');
    expect(request).not.toHaveBeenCalled();
  });

  it('reuses the same idempotency key after a Runtime restart and rejects receipt drift', async () => {
    let canonical = VIEW;
    let createCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'POST') {
        const replayed = createCount > 0;
        if (!replayed) createCount += 1;
        return {
          ok: true,
          status: replayed ? 200 : 201,
          data: { success: true, data: { ...VIEW, replayed }, requestId: 'req-post' },
        };
      }
      return { ok: true, status: 200, data: { success: true, data: canonical, requestId: 'req-get' } };
    });
    const body = { idempotencyKey: 'restart-stable-key', root: ROOT, resources: RESOURCES };

    const first = await start(
      attachPkfRpc({ cloud: { request } as unknown as CloudClient, workspaceId: () => 'ws-runtime' }),
    );
    servers.push(first.server);
    expect((await post(first.baseUrl, body)).status).toBe(200);
    await new Promise<void>((resolve) => first.server.close(() => resolve()));
    servers.splice(servers.indexOf(first.server), 1);

    const restarted = await start(
      attachPkfRpc({ cloud: { request } as unknown as CloudClient, workspaceId: () => 'ws-runtime' }),
    );
    servers.push(restarted.server);
    expect((await post(restarted.baseUrl, body)).status).toBe(200);
    expect(createCount).toBe(1);

    canonical = { ...VIEW, root: { ...VIEW.root, id: 'pkfb_tampered' } };
    const drift = await post(restarted.baseUrl, body);
    expect(drift.status).toBe(502);
    expect(drift.body.error).toBe('pkf_bundle_readback_mismatch');
  });

  it('fails closed before Cloud when no workspace is bound', async () => {
    const request = vi.fn();
    const local = await start(
      attachPkfRpc({ cloud: { request } as unknown as CloudClient, workspaceId: () => null }),
    );
    servers.push(local.server);
    const response = await post(local.baseUrl, { idempotencyKey: 'no-workspace', root: ROOT, resources: RESOURCES });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('pkf_bundle_workspace_unbound');
    expect(request).not.toHaveBeenCalled();
  });

  // ── pkf209/07 §4a: relaxed model surface → runtime-computed wire ──────────

  it('accepts bare text resources + harnessDecl and forwards the runtime-normalized wire', async () => {
    const js = 'console.log(1);\n';
    const relaxedRoot = `<script type="application/prismer+json">{"type":"note","title":"Relaxed","pkfVersion":"1.1"}</script><section><h2 id="r">R</h2><prismer-interactive manifest="manifest.json">fallback</prismer-interactive><prismer-data src="data.csv" format="csv" view="table"></prismer-data></section>`;
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 201, data: { success: true, data: VIEW, requestId: 'r1' } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { success: true, data: VIEW, requestId: 'r2' } });
    const local = await start(
      attachPkfRpc({ cloud: { request } as unknown as CloudClient, workspaceId: () => 'ws-runtime' }),
    );
    servers.push(local.server);

    const response = await post(local.baseUrl, {
      idempotencyKey: 'relaxed-1',
      root: { filename: 'relaxed.pkf', source: relaxedRoot },
      resources: [
        { path: 'main.js', text: js, mime: 'text/javascript', usage: 'harness-script' },
        { path: 'data.csv', text: 'a,b\n1,2\n', mime: 'text/csv', usage: 'data' },
      ],
      harnessDecl: { scripts: ['main.js'] },
    });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    const forwarded = request.mock.calls[0]![2] as { body: Record<string, unknown> };
    const body = forwarded.body as {
      workspaceId: string;
      root: { source: string; sourceHash: string };
      resources: Array<{
        path: string;
        usage: string;
        fromPath?: string;
        bytesBase64: string;
        contentHash: string;
        integrity: string;
        mime: string;
      }>;
    };
    expect(body.workspaceId).toBe('ws-runtime');
    const manifest = body.resources.find((r) => r.usage === 'harness-manifest')!;
    expect(manifest.path).toBe('manifest.json');
    expect(manifest.mime).toBe('application/json');
    const script = body.resources.find((r) => r.path === 'main.js')!;
    expect(script.fromPath).toBe('manifest.json');
    expect(script.contentHash).toBe(hex(js));
    expect(script.integrity).toBe(sri(js));
    const csv = body.resources.find((r) => r.path === 'data.csv')!;
    expect(csv.contentHash).toBe(hex('a,b\n1,2\n'));
    expect(body.root.sourceHash).toBe(hex(body.root.source));
    expect(body.root.source).toContain(`manifest="prismer://workspace/ws-runtime/asset/${manifest.contentHash}"`);
    expect(body.root.source).toContain(`src="prismer://workspace/ws-runtime/asset/${csv.contentHash}"`);
    const manifestJson = JSON.parse(Buffer.from(manifest.bytesBase64, 'base64').toString('utf8')) as {
      scripts: Array<{ path: string; src: string; integrity: string }>;
    };
    expect(manifestJson.scripts).toEqual([
      {
        path: 'main.js',
        src: `prismer://workspace/ws-runtime/asset/${hex(js)}`,
        integrity: sri(js),
      },
    ]);
  });

  it('locally rejects a wrong self-supplied hash with a 400 before Cloud', async () => {
    const request = vi.fn();
    const local = await start(
      attachPkfRpc({ cloud: { request } as unknown as CloudClient, workspaceId: () => 'ws-runtime' }),
    );
    servers.push(local.server);
    const response = await post(local.baseUrl, {
      idempotencyKey: 'bad-hash',
      root: { filename: 'bad.pkf', source: '<p>x</p>', sourceHash: hex('<p>x</p>') },
      resources: [
        {
          path: 'data.csv',
          bytesBase64: 'YSxiCjEsMgo=',
          contentHash: 'b'.repeat(64),
          integrity: sri(CSV_BYTES),
          mime: 'text/csv',
          usage: 'data',
        },
      ],
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('pkf_bundle_resource_hash_mismatch');
    expect(response.body.message).toContain('data.csv');
    expect(request).not.toHaveBeenCalled();
  });
});
