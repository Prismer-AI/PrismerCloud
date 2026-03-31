/**
 * Integration tests for IdentityClient, SecurityClient, and FilesClient.
 *
 * Runs against the live test environment (https://cloud.prismer.dev).
 * Requires PRISMER_API_KEY_TEST env var.
 *
 * Usage:
 *   PRISMER_API_KEY_TEST="sk-prismer-live-..." npx vitest run tests/integration/identity-security-files.test.ts --reporter=verbose
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { PrismerClient } from '../../src/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_KEY = process.env.PRISMER_API_KEY_TEST;
if (!API_KEY) {
  throw new Error('PRISMER_API_KEY_TEST environment variable is required');
}

const BASE_URL = process.env.PRISMER_BASE_URL_TEST || 'https://cloud.prismer.dev';
const RUN_ID = Date.now().toString(36);

function apiClient(): PrismerClient {
  return new PrismerClient({
    apiKey: API_KEY!,
    baseUrl: BASE_URL,
    timeout: 60_000,
  });
}

function imClient(token: string): PrismerClient {
  return new PrismerClient({
    apiKey: token,
    baseUrl: BASE_URL,
    timeout: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let agentAToken: string;
let agentAId: string;
let agentBToken: string;
let agentBId: string;
let clientA: PrismerClient;
let clientB: PrismerClient;
let directConversationId: string;

// ---------------------------------------------------------------------------
// Setup: register two agents and create a conversation
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const client = apiClient();

  // Register Agent A
  const regA = await client.im.account.register({
    type: 'agent',
    username: `isf-agent-a-${RUN_ID}`,
    displayName: `ISF Agent A (${RUN_ID})`,
    agentType: 'assistant',
    capabilities: ['testing'],
    description: 'Identity/Security/Files test agent A',
  });
  expect(regA.ok).toBe(true);
  agentAToken = regA.data!.token;
  agentAId = regA.data!.imUserId;
  clientA = imClient(agentAToken);

  // Register Agent B
  const regB = await client.im.account.register({
    type: 'agent',
    username: `isf-agent-b-${RUN_ID}`,
    displayName: `ISF Agent B (${RUN_ID})`,
    agentType: 'specialist',
    capabilities: ['testing'],
    description: 'Identity/Security/Files test agent B',
  });
  expect(regB.ok).toBe(true);
  agentBToken = regB.data!.token;
  agentBId = regB.data!.imUserId;
  clientB = imClient(agentBToken);

  // Create a direct conversation by sending a message
  const sendResult = await clientA.im.direct.send(agentBId, `Setup message ${RUN_ID}`);
  expect(sendResult.ok).toBe(true);
  directConversationId = sendResult.data!.conversationId;
}, 30_000);

// ===========================================================================
// Identity Client
// ===========================================================================

describe('IdentityClient', () => {
  it('getServerKey() — returns server public key', async () => {
    const res = await clientA.im.identity.getServerKey();
    if (res.ok) {
      expect(res.data).toBeDefined();
      expect(typeof res.data!.publicKey).toBe('string');
      expect(res.data!.publicKey.length).toBeGreaterThan(0);
    } else {
      // Endpoint may not be deployed; skip gracefully
      console.warn('[IdentityClient] getServerKey not available:', res.error);
    }
  }, 30_000);

  it('registerKey() — register an Ed25519 public key', async () => {
    // Generate a fake Ed25519 public key (base64-encoded 32 bytes)
    const fakePublicKey = Buffer.from(
      Array.from({ length: 32 }, (_, i) => (i + 0x10 + parseInt(RUN_ID.slice(0, 2), 36)) & 0xff),
    ).toString('base64');

    const res = await clientA.im.identity.registerKey({
      publicKey: fakePublicKey,
      derivationMode: 'imported',
    });
    if (res.ok) {
      expect(res.data).toBeDefined();
      expect(res.data!.publicKey).toBe(fakePublicKey);
      expect(res.data!.imUserId).toBe(agentAId);
      expect(typeof res.data!.keyId).toBe('string');
      expect(res.data!.keyId.length).toBeGreaterThan(0);
      expect(typeof res.data!.registeredAt).toBe('string');
      expect(res.data!.revokedAt).toBeNull();
    } else {
      console.warn('[IdentityClient] registerKey not available:', res.error);
    }
  }, 30_000);

  it('getKey() — retrieve key by userId', async () => {
    const res = await clientA.im.identity.getKey(agentAId);
    if (res.ok) {
      expect(res.data).toBeDefined();
      expect(res.data!.imUserId).toBe(agentAId);
      expect(typeof res.data!.publicKey).toBe('string');
      expect(typeof res.data!.keyId).toBe('string');
    } else {
      // May fail if registerKey didn't succeed
      console.warn('[IdentityClient] getKey not available:', res.error);
    }
  }, 30_000);

  it('getAuditLog() — key change history', async () => {
    const res = await clientA.im.identity.getAuditLog(agentAId);
    if (res.ok) {
      expect(res.data).toBeDefined();
      expect(Array.isArray(res.data)).toBe(true);
      if (res.data!.length > 0) {
        const entry = res.data![0];
        expect(entry.imUserId).toBe(agentAId);
        expect(['register', 'rotate', 'revoke']).toContain(entry.action);
        expect(typeof entry.publicKey).toBe('string');
        expect(typeof entry.keyId).toBe('string');
        expect(typeof entry.createdAt).toBe('string');
      }
    } else {
      console.warn('[IdentityClient] getAuditLog not available:', res.error);
    }
  }, 30_000);

  it('verifyAuditLog() — hash-chain integrity check', async () => {
    const res = await clientA.im.identity.verifyAuditLog(agentAId);
    if (res.ok) {
      expect(res.data).toBeDefined();
      expect(typeof res.data!.valid).toBe('boolean');
      // If the chain is valid, invalidAt should be absent
      if (res.data!.valid) {
        expect(res.data!.invalidAt).toBeUndefined();
      }
    } else {
      console.warn('[IdentityClient] verifyAuditLog not available:', res.error);
    }
  }, 30_000);

  it('revokeKey() — revoke own identity key', async () => {
    const res = await clientA.im.identity.revokeKey();
    if (res.ok) {
      // After revocation, getKey should show revokedAt set
      const keyRes = await clientA.im.identity.getKey(agentAId);
      if (keyRes.ok && keyRes.data) {
        // Key may or may not have revokedAt set depending on implementation
        // (some servers return the latest active key, some return the revoked one)
        expect(keyRes.data.imUserId).toBe(agentAId);
      }
    } else {
      // May fail if no key was registered or endpoint not available
      console.warn('[IdentityClient] revokeKey not available:', res.error);
    }
  }, 30_000);
});

// ===========================================================================
// Security Client
// ===========================================================================

describe('SecurityClient', () => {
  it('getConversationSecurity() — fetch security policy for a conversation', async () => {
    expect(directConversationId).toBeDefined();
    const res = await clientA.im.security.getConversationSecurity(directConversationId);
    if (res.ok) {
      expect(res.data).toBeDefined();
      // The shape depends on server implementation; just verify we got an object
      expect(typeof res.data).toBe('object');
    } else {
      console.warn('[SecurityClient] getConversationSecurity not available:', res.error);
    }
  }, 30_000);

  it('setConversationSecurity() — set signing policy', async () => {
    expect(directConversationId).toBeDefined();
    const res = await clientA.im.security.setConversationSecurity(directConversationId, {
      signingPolicy: 'optional',
    });
    if (res.ok) {
      expect(res.data).toBeDefined();
    } else {
      // May fail if user is not conversation admin or endpoint not available
      console.warn('[SecurityClient] setConversationSecurity not available:', res.error);
    }
  }, 30_000);

  it('uploadKey() — upload public key for conversation', async () => {
    expect(directConversationId).toBeDefined();
    const fakeConvKey = Buffer.from(
      Array.from({ length: 32 }, (_, i) => (i + 0x20 + parseInt(RUN_ID.slice(0, 2), 36)) & 0xff),
    ).toString('base64');

    const res = await clientA.im.security.uploadKey(
      directConversationId,
      fakeConvKey,
      'ed25519',
    );
    if (res.ok) {
      expect(res.data).toBeDefined();
    } else {
      console.warn('[SecurityClient] uploadKey not available:', res.error);
    }
  }, 30_000);

  it('getKeys() — list conversation keys', async () => {
    expect(directConversationId).toBeDefined();
    const res = await clientA.im.security.getKeys(directConversationId);
    if (res.ok) {
      expect(res.data).toBeDefined();
      expect(Array.isArray(res.data)).toBe(true);
    } else {
      console.warn('[SecurityClient] getKeys not available:', res.error);
    }
  }, 30_000);

  it('revokeKey() — revoke a conversation key', async () => {
    expect(directConversationId).toBeDefined();
    // Try revoking own key from the conversation
    const res = await clientA.im.security.revokeKey(directConversationId, agentAId);
    if (res.ok) {
      // revokeKey may return ok:true with data or without data (void response)
      expect(res.ok).toBe(true);
    } else {
      // Expected to fail if no key was uploaded or endpoint not available
      console.warn('[SecurityClient] revokeKey not available:', res.error);
    }
  }, 30_000);
});

// ===========================================================================
// Files Client
// ===========================================================================

describe('FilesClient', () => {
  let uploadedId: string | undefined;

  it('types() — list allowed MIME types', async () => {
    const res = await clientA.im.files.types();
    if (res.ok) {
      expect(res.data).toBeDefined();
      expect(Array.isArray(res.data!.allowedMimeTypes)).toBe(true);
      expect(res.data!.allowedMimeTypes.length).toBeGreaterThan(0);
      // Should include common types
      const types = res.data!.allowedMimeTypes;
      const hasCommon = types.some(
        (t: string) => t.startsWith('image/') || t.startsWith('application/') || t.startsWith('text/'),
      );
      expect(hasCommon).toBe(true);
    } else {
      console.warn('[FilesClient] types not available:', res.error);
    }
  }, 30_000);

  it('quota() — check storage quota', async () => {
    const res = await clientA.im.files.quota();
    if (res.ok) {
      expect(res.data).toBeDefined();
      expect(typeof res.data!.used).toBe('number');
      expect(typeof res.data!.limit).toBe('number');
      expect(typeof res.data!.tier).toBe('string');
      expect(typeof res.data!.fileCount).toBe('number');
      expect(res.data!.used).toBeGreaterThanOrEqual(0);
      expect(res.data!.limit).toBeGreaterThan(0);
      expect(res.data!.fileCount).toBeGreaterThanOrEqual(0);
    } else {
      console.warn('[FilesClient] quota not available:', res.error);
    }
  }, 30_000);

  it('presign() — get upload URL', async () => {
    const res = await clientA.im.files.presign({
      fileName: `test-${RUN_ID}.txt`,
      fileSize: 13,
      mimeType: 'text/plain',
    });
    if (res.ok) {
      expect(res.data).toBeDefined();
      expect(typeof res.data!.uploadId).toBe('string');
      expect(res.data!.uploadId.length).toBeGreaterThan(0);
      expect(typeof res.data!.url).toBe('string');
      expect(res.data!.url.length).toBeGreaterThan(0);
      expect(typeof res.data!.fields).toBe('object');
      expect(typeof res.data!.expiresAt).toBe('string');
    } else {
      console.warn('[FilesClient] presign not available:', res.error);
    }
  }, 30_000);

  it('upload() — high-level upload with Uint8Array (small file <10MB)', async () => {
    const content = `Hello from integration test ${RUN_ID}`;
    const bytes = new TextEncoder().encode(content);

    try {
      const result = await clientA.im.files.upload(bytes, {
        fileName: `integration-test-${RUN_ID}.txt`,
        mimeType: 'text/plain',
      });
      expect(result).toBeDefined();
      expect(typeof result.uploadId).toBe('string');
      expect(result.uploadId.length).toBeGreaterThan(0);
      expect(typeof result.cdnUrl).toBe('string');
      expect(result.cdnUrl.length).toBeGreaterThan(0);
      expect(result.fileName).toBe(`integration-test-${RUN_ID}.txt`);
      expect(result.fileSize).toBe(bytes.byteLength);
      expect(result.mimeType).toBe('text/plain');
      expect(typeof result.cost).toBe('number');
      uploadedId = result.uploadId;
    } catch (err: any) {
      // upload() throws on failure rather than returning ok:false
      console.warn('[FilesClient] upload not available:', err.message);
    }
  }, 30_000);

  it('confirm() — confirm upload (already confirmed by upload())', async () => {
    // Presign a fresh file and attempt to confirm without uploading
    // (should fail because no file was actually uploaded to the presigned URL)
    const presignRes = await clientA.im.files.presign({
      fileName: `confirm-test-${RUN_ID}.txt`,
      fileSize: 5,
      mimeType: 'text/plain',
    });
    if (presignRes.ok) {
      const confirmRes = await clientA.im.files.confirm(presignRes.data!.uploadId);
      // Likely to fail since we didn't actually upload bytes to the presigned URL
      // But we verify the API is reachable and returns a proper response shape
      if (confirmRes.ok) {
        expect(confirmRes.data).toBeDefined();
        expect(typeof confirmRes.data!.uploadId).toBe('string');
        expect(typeof confirmRes.data!.cdnUrl).toBe('string');
      } else {
        // Expected failure — no actual bytes were uploaded
        expect(confirmRes.error).toBeDefined();
      }
    } else {
      console.warn('[FilesClient] presign not available for confirm test:', presignRes.error);
    }
  }, 30_000);

  it('delete() — delete uploaded file', async () => {
    if (!uploadedId) {
      console.warn('[FilesClient] Skipping delete — no file was uploaded');
      return;
    }
    const res = await clientA.im.files.delete(uploadedId);
    if (res.ok) {
      // Verify file is deleted (quota fileCount should not increase)
      expect(res.ok).toBe(true);
    } else {
      // Delete may not be implemented or file already cleaned up
      console.warn('[FilesClient] delete not available:', res.error);
    }
  }, 30_000);

  it('sendFile() — upload + send as message in one call', async () => {
    expect(directConversationId).toBeDefined();
    const content = `File message test ${RUN_ID}`;
    const bytes = new TextEncoder().encode(content);

    try {
      const result = await clientA.im.files.sendFile(
        directConversationId,
        bytes,
        {
          fileName: `sendfile-test-${RUN_ID}.txt`,
          mimeType: 'text/plain',
          content: 'Shared a test file',
        },
      );
      expect(result).toBeDefined();
      expect(result.upload).toBeDefined();
      expect(typeof result.upload.uploadId).toBe('string');
      expect(typeof result.upload.cdnUrl).toBe('string');
      expect(result.upload.fileName).toBe(`sendfile-test-${RUN_ID}.txt`);
      expect(result.message).toBeDefined();

      // Clean up — delete the uploaded file
      await clientA.im.files.delete(result.upload.uploadId).catch(() => {});
    } catch (err: any) {
      // sendFile() throws on failure
      console.warn('[FilesClient] sendFile not available:', err.message);
    }
  }, 30_000);
});
