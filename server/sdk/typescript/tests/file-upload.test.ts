/**
 * Prismer TypeScript SDK — File Upload Integration Tests
 *
 * Runs against the local IM server (http://localhost:3200).
 * Start the server first: npm run im:start
 *
 * Usage:
 *   npx vitest run tests/file-upload.test.ts --reporter=verbose
 *
 * The standalone IM server serves routes at /api/*, but the SDK uses /api/im/*.
 * A custom fetch wrapper rewrites paths automatically.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { PrismerClient } from '../src/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = process.env.IM_BASE_URL || 'http://localhost:3200';
const RUN_ID = Date.now().toString(36);

/**
 * Custom fetch that rewrites /api/im/* → /api/* for standalone IM server.
 * In production (Next.js proxy) this rewrite is not needed, but it's harmless
 * since the test targets the standalone server directly.
 */
const standaloneRewriteFetch: typeof fetch = (input, init?) => {
  let url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  url = url.replace('/api/im/', '/api/');
  return fetch(url, init);
};

/** Create a client pointing at the standalone IM server */
function localClient(token?: string): PrismerClient {
  return new PrismerClient({
    apiKey: token,
    baseUrl: BASE_URL,
    timeout: 15_000,
    fetch: standaloneRewriteFetch,
  });
}

/** Register a fresh agent and return an authenticated client */
async function createAgent(suffix: string): Promise<{ client: PrismerClient; token: string; userId: string }> {
  const anonClient = localClient();
  const res = await anonClient.im.account.register({
    type: 'agent',
    username: `file-test-${suffix}-${RUN_ID}`,
    displayName: `File Test ${suffix}`,
  });
  if (!res.ok || !res.data) throw new Error(`Register failed: ${res.error?.message}`);

  const client = localClient(res.data.token);
  return { client, token: res.data.token, userId: res.data.imUserId };
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let agentA: { client: PrismerClient; token: string; userId: string };
let agentB: { client: PrismerClient; token: string; userId: string };
let conversationId: string;
let uploadedId: string; // for cleanup test

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('File Upload (SDK high-level)', () => {
  beforeAll(async () => {
    // Register two agents and set up a direct conversation
    [agentA, agentB] = await Promise.all([createAgent('a'), createAgent('b')]);

    // Create a direct conversation by sending a message
    const msgRes = await agentA.client.im.direct.send(agentB.userId, 'hello for file test');
    if (!msgRes.ok || !msgRes.data) throw new Error(`Direct send failed: ${msgRes.error?.message}`);
    conversationId = msgRes.data.conversationId;
  }, 30_000);

  // ── upload() with Buffer ──────────────────────────────────────────────

  it('upload() with Buffer — simple upload happy path', async () => {
    const content = Buffer.from('Hello from SDK upload test');
    const result = await agentA.client.im.files.upload(content, {
      fileName: 'test-upload.txt',
      mimeType: 'text/plain',
    });

    expect(result).toBeDefined();
    expect(result.uploadId).toBeTruthy();
    expect(result.cdnUrl).toBeTruthy();
    expect(result.fileName).toBe('test-upload.txt');
    expect(result.fileSize).toBe(content.byteLength);
    expect(result.mimeType).toBe('text/plain');
    expect(typeof result.cost).toBe('number');

    // Save for cleanup
    uploadedId = result.uploadId;
  });

  // ── upload() auto-detects MIME ─────────────────────────────────────────

  it('upload() auto-detects mimeType from fileName extension', async () => {
    const content = Buffer.from('# Markdown file\n\nHello!');
    const result = await agentA.client.im.files.upload(content, {
      fileName: 'readme.md',
    });

    expect(result.mimeType).toBe('text/markdown');
    expect(result.fileName).toBe('readme.md');
  });

  // ── upload() with Uint8Array ──────────────────────────────────────────

  it('upload() with Uint8Array works', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('Uint8Array upload test content');
    const result = await agentA.client.im.files.upload(bytes, {
      fileName: 'uint8-test.txt',
    });

    expect(result.uploadId).toBeTruthy();
    expect(result.fileName).toBe('uint8-test.txt');
  });

  // ── sendFile() ────────────────────────────────────────────────────────

  it('sendFile() — upload + file message in one call', async () => {
    const content = Buffer.from('{ "key": "value" }');
    const result = await agentA.client.im.files.sendFile(conversationId, content, {
      fileName: 'data.json',
      content: 'Here is the data file',
    });

    expect(result.upload).toBeDefined();
    expect(result.upload.uploadId).toBeTruthy();
    expect(result.upload.cdnUrl).toBeTruthy();
    expect(result.upload.mimeType).toBe('application/json');
    expect(result.message).toBeDefined();
  });

  // ── quota() ───────────────────────────────────────────────────────────

  it('quota() reflects uploaded files', async () => {
    const res = await agentA.client.im.files.quota();
    expect(res.ok).toBe(true);
    expect(res.data).toBeDefined();
    expect(res.data!.used).toBeGreaterThan(0);
    expect(res.data!.fileCount).toBeGreaterThan(0);
    expect(typeof res.data!.limit).toBe('number');
    expect(typeof res.data!.tier).toBe('string');
  });

  // ── Error: missing fileName ───────────────────────────────────────────

  it('upload() error — missing fileName for Buffer', async () => {
    const content = Buffer.from('no name');
    await expect(
      agentA.client.im.files.upload(content),
    ).rejects.toThrow('fileName is required');
  });

  // ── Error: file too large ─────────────────────────────────────────────

  it('upload() error — file exceeds 50 MB (client-side)', async () => {
    // Create a buffer that reports > 50 MB without actually allocating it
    const fakeBytes = new Uint8Array(1);
    Object.defineProperty(fakeBytes, 'byteLength', { value: 51 * 1024 * 1024 });

    await expect(
      agentA.client.im.files.upload(fakeBytes, { fileName: 'huge.bin' }),
    ).rejects.toThrow('50 MB');
  });

  // ── Low-level: types ──────────────────────────────────────────────────

  it('types() returns allowed MIME types', async () => {
    const res = await agentA.client.im.files.types();
    expect(res.ok).toBe(true);
    expect(res.data?.allowedMimeTypes).toBeDefined();
    expect(Array.isArray(res.data!.allowedMimeTypes)).toBe(true);
    expect(res.data!.allowedMimeTypes.length).toBeGreaterThan(0);
  });

  // ── delete() — cleanup ────────────────────────────────────────────────

  it('delete() — cleanup uploaded file', async () => {
    expect(uploadedId).toBeTruthy();
    const res = await agentA.client.im.files.delete(uploadedId);
    expect(res.ok).toBe(true);
  });
});
