import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  runPkfBundleCommitCli,
  runPkfBundleReadCli,
  runPkfMaterializationReadCli,
  runPkfMaterializeCli,
  type PkfMaterializationCliClient,
} from '../src/commands/pkf';
import { PrismerClient } from '../src';

afterEach(() => {
  vi.restoreAllMocks();
});

function client(response: unknown = { success: true, data: { receiptId: 'receipt_1' } }) {
  const request = vi.fn().mockResolvedValue(response);
  return { request } as unknown as PkfMaterializationCliClient & { request: typeof request };
}

const SOURCE = {
  messageId: 'message_1',
  blockId: 'pkfib_1',
  blockRevision: 1,
  sourceHash: 'a'.repeat(64),
};

describe('cloud pkf materialize', () => {
  it('cloud pkf bundle-commit reads real descriptor files and sends exact bytes/hash/SRI', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const dir = mkdtempSync(join(tmpdir(), 'pkf-bundle-cli-'));
    try {
      const root = '<section>real descriptor root</section>';
      const resource = Buffer.from('real dependency bytes');
      writeFileSync(join(dir, 'root.pkf'), root);
      writeFileSync(join(dir, 'proof.bin'), resource);
      const descriptor = {
        workspaceId: 'workspace_1',
        idempotencyKey: 'bundle-cli-1',
        root: { filename: 'bundle.pkf', sourceFile: 'root.pkf' },
        resources: [{ path: 'proof.bin', file: 'proof.bin', mime: 'application/octet-stream', usage: 'file' }],
      };
      const descriptorFile = join(dir, 'bundle.json');
      writeFileSync(descriptorFile, JSON.stringify(descriptor));
      const api = client({ success: true, data: { receipt: { id: 'receipt_bundle' } } });

      expect(await runPkfBundleCommitCli(descriptorFile, api)).toBe(0);
      expect(api.request).toHaveBeenCalledWith('POST', '/api/pkf/bundles/commit', {
        workspaceId: descriptor.workspaceId,
        idempotencyKey: descriptor.idempotencyKey,
        root: {
          filename: descriptor.root.filename,
          source: root,
          sourceHash: createHash('sha256').update(root).digest('hex'),
        },
        resources: [
          {
            path: 'proof.bin',
            bytesBase64: resource.toString('base64'),
            contentHash: createHash('sha256').update(resource).digest('hex'),
            integrity: `sha256-${createHash('sha256').update(resource).digest('base64')}`,
            mime: 'application/octet-stream',
            usage: 'file',
          },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('TAMPER rejects a descriptor path escape before any bundle request', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const dir = mkdtempSync(join(tmpdir(), 'pkf-bundle-cli-tamper-'));
    try {
      const descriptorFile = join(dir, 'bundle.json');
      writeFileSync(
        descriptorFile,
        JSON.stringify({
          workspaceId: 'workspace_1',
          idempotencyKey: 'bundle-cli-tamper',
          root: { filename: 'bundle.pkf', sourceFile: '../outside.pkf' },
          resources: [{ path: 'proof.bin', file: 'proof.bin', mime: 'application/octet-stream', usage: 'file' }],
        }),
      );
      const api = client();
      expect(await runPkfBundleCommitCli(descriptorFile, api)).toBe(1);
      expect(api.request).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cloud pkf bundle-read performs explicit actor-scoped restart readback', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const api = client({ success: true, data: { receipt: { id: 'receipt_bundle' } } });
    expect(await runPkfBundleReadCli('workspace_1', 'bundle-cli-1', api)).toBe(0);
    expect(api.request).toHaveBeenCalledWith('GET', '/api/pkf/bundles/commit', undefined, {
      workspaceId: 'workspace_1',
      idempotencyKey: 'bundle-cli-1',
    });
  });

  it('exposes atomic bundle commit and restart readback on the canonical PKF client', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, data: null, requestId: 'request_bundle' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const sdk = new PrismerClient({
      apiKey: 'sk-prismer-pkf-bundle-test',
      imAgent: 'agent-canonical-1',
      baseUrl: 'https://api.test',
      fetch: fetchFn as typeof fetch,
    });
    const bundle = {
      workspaceId: 'workspace_1',
      idempotencyKey: 'bundle_1',
      root: { filename: 'bundle.pkf', source: '<section>bundle</section>', sourceHash: 'a'.repeat(64) },
      resources: [
        {
          path: 'proof.txt',
          bytesBase64: 'cHJvb2Y=',
          contentHash: 'b'.repeat(64),
          integrity: 'sha256-cHJvb2Y=',
          mime: 'text/plain',
          usage: 'file' as const,
        },
      ],
    };

    await sdk.pkf.commitBundle(bundle);
    await sdk.pkf.getBundle({ workspaceId: bundle.workspaceId, idempotencyKey: bundle.idempotencyKey });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe('https://api.test/api/pkf/bundles/commit');
    expect((fetchFn.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
    expect((fetchFn.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      'X-Prismer-Agent': 'agent-canonical-1',
    });
    expect((fetchFn.mock.calls[0]?.[1] as RequestInit).headers).not.toHaveProperty('X-IM-Agent');
    expect(JSON.parse(String((fetchFn.mock.calls[0]?.[1] as RequestInit).body))).toEqual(bundle);
    expect(String(fetchFn.mock.calls[1]?.[0])).toBe(
      'https://api.test/api/pkf/bundles/commit?workspaceId=workspace_1&idempotencyKey=bundle_1',
    );
    expect((fetchFn.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({
      'X-Prismer-Agent': 'agent-canonical-1',
    });
    expect((fetchFn.mock.calls[1]?.[1] as RequestInit).headers).not.toHaveProperty('X-IM-Agent');
  });

  it('exposes the canonical no-IM PKF SDK surface at client.pkf', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/resources/bytes?')) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream', 'X-Asset-Hash': 'b'.repeat(64) },
        });
      }
      return new Response(JSON.stringify({ success: true, data: null, requestId: 'request_1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const sdk = new PrismerClient({
      apiKey: 'sk-prismer-pkf-test',
      baseUrl: 'https://api.test',
      fetch: fetchFn as typeof fetch,
    });

    await sdk.pkf.getMaterialization({
      workspaceId: 'workspace_1',
      idempotencyKey: 'save-memory-1',
      targetKind: 'memory-page',
    });
    await sdk.pkf.getArtifactRelations({
      workspaceId: 'workspace_1',
      rootKind: 'asset',
      rootId: 'asset/root 1',
      revision: 2,
    });
    const resource = {
      workspaceId: 'workspace_1',
      rootKind: 'asset' as const,
      rootId: 'asset/root 1',
      rootRevision: 2,
      rootHash: 'a'.repeat(64),
      targetAssetId: 'dependency_1',
    };
    await sdk.pkf.getResourceDetail(resource);
    const bytes = await sdk.pkf.getResourceBytes(resource);

    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
      'https://api.test/api/pkf/materializations?workspaceId=workspace_1&idempotencyKey=save-memory-1&targetKind=memory-page',
    );
    expect(String(fetchFn.mock.calls[1]?.[0])).toBe(
      'https://api.test/api/pkf/artifacts/asset/asset%2Froot%201/relations?workspaceId=workspace_1&revision=2',
    );
    expect(String(fetchFn.mock.calls[2]?.[0])).toContain('https://api.test/api/pkf/resources/detail?');
    expect(String(fetchFn.mock.calls[2]?.[0])).toContain('targetAssetId=dependency_1');
    expect(String(fetchFn.mock.calls[3]?.[0])).toContain('https://api.test/api/pkf/resources/bytes?');
    expect((await bytes.arrayBuffer()).byteLength).toBe(3);
    expect((sdk.im as unknown as { pkf?: unknown }).pkf).toBeUndefined();
  });

  it('discovers a committed materialization through the complete source locator', async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ success: true, data: null, requestId: 'request_discovery' }),
    );
    const sdk = new PrismerClient({
      apiKey: 'sk-prismer-pkf-discovery-test',
      baseUrl: 'https://api.test',
      fetch: fetchFn as typeof fetch,
    });

    await sdk.pkf.discoverMaterialization({
      workspaceId: 'workspace_1',
      source: { kind: 'message-pkf', ...SOURCE },
      targetKind: 'memory-page',
    });

    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
      'https://api.test/api/pkf/materializations' +
        `?workspaceId=workspace_1&messageId=${SOURCE.messageId}&blockId=${SOURCE.blockId}` +
        `&blockRevision=${SOURCE.blockRevision}&sourceHash=${SOURCE.sourceHash}&targetKind=memory-page`,
    );
  });

  it('sends a confirmed Memory Page path and authoritative source locator', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const api = client();
    const code = await runPkfMaterializeCli(
      {
        workspaceId: 'workspace_1',
        idempotencyKey: 'save-memory-1',
        source: SOURCE,
        targetKind: 'memory-page',
        path: 'notes/redis.pkf',
        confirmPath: true,
        visibility: 'workspace',
        json: true,
      },
      api,
    );

    expect(code).toBe(0);
    expect(api.request).toHaveBeenCalledWith('POST', '/api/pkf/materializations', {
      workspaceId: 'workspace_1',
      idempotencyKey: 'save-memory-1',
      source: { kind: 'message-pkf', ...SOURCE },
      target: {
        kind: 'memory-page',
        path: 'notes/redis.pkf',
        pathConfirmed: true,
        visibility: 'workspace',
      },
    });
  });

  it('refuses an unconfirmed Memory path without sending a request', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const api = client();
    const code = await runPkfMaterializeCli(
      {
        workspaceId: 'workspace_1',
        idempotencyKey: 'save-memory-2',
        source: SOURCE,
        targetKind: 'memory-page',
        path: 'notes/redis.pkf',
        confirmPath: false,
        json: true,
      },
      api,
    );

    expect(code).toBe(1);
    expect(api.request).not.toHaveBeenCalled();
  });

  it('reads the correct receipt namespace instead of defaulting Memory to Asset', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const api = client();
    expect(
      await runPkfMaterializationReadCli(
        {
          workspaceId: 'workspace_1',
          idempotencyKey: 'save-memory-1',
          targetKind: 'memory-page',
          json: true,
        },
        api,
      ),
    ).toBe(0);
    expect(api.request).toHaveBeenCalledWith('GET', '/api/pkf/materializations', undefined, {
      workspaceId: 'workspace_1',
      idempotencyKey: 'save-memory-1',
      targetKind: 'memory-page',
    });
  });
});
