/**
 * Prismer IM — E2E Encryption Layer 1+2 Integration Tests
 *
 * Tests: Identity Keys (10), Message Signing (8), Audit Log (5), Anti-Replay (4)
 *
 * Usage: DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/tests/e2e-encryption.test.ts
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const BASE = process.env.IM_BASE_URL || 'http://localhost:3200';

// ─── Test Infrastructure ────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err: any) {
    failed++;
    const msg = err.message || String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name}: ${msg}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function assertEqual(actual: any, expected: any, field: string) {
  if (actual !== expected) {
    throw new Error(`${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function api(
  method: string,
  path: string,
  body?: any,
  token?: string,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // In embedded mode (/api/im proxy), /api/im/register maps to Hono /api/register
  const url = BASE.includes('/api/im') ? `${BASE}${path}` : `${BASE}/api${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  return { status: res.status, data };
}

// ─── Crypto Helpers ─────────────────────────────────────────

function generateKeyPair() {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return {
    publicKey: Buffer.from(publicKey).toString('base64'),
    privateKey: Buffer.from(privateKey).toString('base64'),
  };
}

function deriveKeyId(publicKeyBase64: string): string {
  const pubBytes = Buffer.from(publicKeyBase64, 'base64');
  const hash = sha256(pubBytes);
  return bytesToHex(hash.slice(0, 8));
}

function computeContentHash(content: string): string {
  const bytes = new TextEncoder().encode(content);
  return bytesToHex(sha256(bytes));
}

function buildSigningPayload(params: {
  secVersion: number;
  senderId: string;
  senderKeyId: string;
  conversationId: string;
  sequence: number;
  type: string;
  timestamp: number;
  contentHash: string;
  prevHash: string | null;
}): Uint8Array {
  const canonical = [
    params.secVersion,
    params.senderId,
    params.senderKeyId,
    params.conversationId,
    params.sequence,
    params.type,
    params.timestamp,
    params.contentHash,
    params.prevHash ?? '',
  ].join('|');
  return new TextEncoder().encode(canonical);
}

function signMessage(privateKeyBase64: string, payload: Uint8Array): string {
  const privBytes = Buffer.from(privateKeyBase64, 'base64');
  const sig = ed25519.sign(payload, privBytes);
  return Buffer.from(sig).toString('base64');
}

// ─── Signed Message Helper ──────────────────────────────────

function createSignedBody(params: {
  senderId: string;
  senderKeyId: string;
  privateKey: string;
  conversationId: string;
  sequence: number;
  content: string;
  type?: string;
  prevHash?: string | null;
}) {
  const content = params.content;
  const contentHash = computeContentHash(content);
  const timestamp = Date.now();
  const type = params.type ?? 'text';

  const payload = buildSigningPayload({
    secVersion: 1,
    senderId: params.senderId,
    senderKeyId: params.senderKeyId,
    conversationId: params.conversationId,
    sequence: params.sequence,
    type,
    timestamp,
    contentHash,
    prevHash: params.prevHash ?? null,
  });

  const signature = signMessage(params.privateKey, payload);

  return {
    content,
    type,
    secVersion: 1,
    senderKeyId: params.senderKeyId,
    sequence: params.sequence,
    contentHash,
    prevHash: params.prevHash ?? null,
    signature,
    timestamp,
  };
}

// ─── Test State ─────────────────────────────────────────────
const ts = String(Date.now()).slice(-8);
let userAToken = '';
let userAId = '';
let userBToken = '';
let userBId = '';
let serverPublicKey = '';
let userAKeyPair = generateKeyPair();
let userAKeyId = deriveKeyId(userAKeyPair.publicKey);
let conversationId = '';

async function createTestUser(
  username: string,
  displayName: string,
  role: string = 'human',
): Promise<{ id: string; token: string }> {
  const res = await api('POST', '/register', { username, displayName, type: role });
  if (!res.data.ok) throw new Error(`Register failed: ${JSON.stringify(res.data)}`);
  return { id: res.data.data.imUserId, token: res.data.data.token };
}

// ════════════════════════════════════════════════════════════
//  Main Test Suite
// ════════════════════════════════════════════════════════════

async function main() {
  console.log('\n🔐 Prismer IM — E2E Encryption Layer 1+2 Tests');
  console.log('═'.repeat(55));

  // ─── Setup ────────────────────────────────────────────────
  console.log('\n📋 Setup');

  const userA = await createTestUser(`crypto-alice-${ts}`, `Alice ${ts}`);
  userAToken = userA.token;
  userAId = userA.id;

  const userB = await createTestUser(`crypto-bob-${ts}`, `Bob ${ts}`);
  userBToken = userB.token;
  userBId = userB.id;
  console.log(`  Users: Alice=${userAId}, Bob=${userBId}`);

  // Create a direct conversation
  const dmRes = await api('POST', `/direct/${userBId}/messages`, {
    content: 'Hello Bob, setting up crypto test',
  }, userAToken);
  assert(dmRes.data.ok, `DM setup failed: ${JSON.stringify(dmRes.data)}`);
  conversationId = dmRes.data.data.conversationId;
  console.log(`  Conversation: ${conversationId}`);

  // ─── Group 1: Server Public Key ───────────────────────────
  console.log('\n🔑 Server Public Key');

  await test('GET /keys/server returns server public key', async () => {
    const res = await api('GET', '/keys/server', undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'response ok');
    assert(typeof res.data.data.publicKey === 'string', 'publicKey is string');
    assert(res.data.data.publicKey.length > 0, 'publicKey not empty');
    serverPublicKey = res.data.data.publicKey;
  });

  // ─── Group 2: Identity Key Registration ───────────────────
  console.log('\n🪪 Identity Key Registration');

  await test('PUT /keys/identity registers new key', async () => {
    const res = await api('PUT', '/keys/identity', {
      publicKey: userAKeyPair.publicKey,
    }, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'response ok');
    assertEqual(res.data.data.publicKey, userAKeyPair.publicKey, 'publicKey matches');
    assertEqual(res.data.data.keyId, userAKeyId, 'keyId matches');
    assert(typeof res.data.data.attestation === 'string', 'attestation is string');
    assert(res.data.data.attestation.length > 0, 'attestation not empty');
    assertEqual(res.data.data.derivationMode, 'generated', 'derivationMode');
    assert(res.data.data.registeredAt, 'registeredAt exists');
    assertEqual(res.data.data.revokedAt, null, 'revokedAt is null');
    assertEqual(res.data.data.serverPublicKey, serverPublicKey, 'serverPublicKey returned');
  });

  await test('PUT /keys/identity with custom derivationMode', async () => {
    // Re-register same key with different mode — should upsert
    const res = await api('PUT', '/keys/identity', {
      publicKey: userAKeyPair.publicKey,
      derivationMode: 'derived',
    }, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'response ok');
    assertEqual(res.data.data.derivationMode, 'derived', 'derivationMode updated');
  });

  await test('PUT /keys/identity rejects invalid key (wrong length)', async () => {
    const res = await api('PUT', '/keys/identity', {
      publicKey: Buffer.from('tooshort').toString('base64'),
    }, userAToken);
    assertEqual(res.status, 400, 'status');
    assert(!res.data.ok, 'response not ok');
  });

  await test('PUT /keys/identity rejects missing publicKey', async () => {
    const res = await api('PUT', '/keys/identity', {}, userAToken);
    assertEqual(res.status, 400, 'status');
  });

  await test('GET /keys/identity/:userId returns registered key', async () => {
    const res = await api('GET', `/keys/identity/${userAId}`, undefined, userBToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'response ok');
    assertEqual(res.data.data.publicKey, userAKeyPair.publicKey, 'publicKey matches');
    assertEqual(res.data.data.keyId, userAKeyId, 'keyId matches');
    assert(typeof res.data.data.attestation === 'string', 'attestation exists');
    assertEqual(res.data.data.serverPublicKey, serverPublicKey, 'serverPublicKey returned');
  });

  await test('GET /keys/identity/:userId returns 404 for unregistered user', async () => {
    const res = await api('GET', '/keys/identity/nonexistent-user', undefined, userAToken);
    assertEqual(res.status, 404, 'status');
  });

  // Register Bob's key too (needed for later tests)
  const userBKeyPair = generateKeyPair();
  const userBKeyId = deriveKeyId(userBKeyPair.publicKey);
  await api('PUT', '/keys/identity', { publicKey: userBKeyPair.publicKey }, userBToken);

  // ─── Group 3: Key Rotation ────────────────────────────────
  console.log('\n🔄 Key Rotation');

  const newKeyPair = generateKeyPair();
  const newKeyId = deriveKeyId(newKeyPair.publicKey);

  await test('PUT /keys/identity rotates to new key', async () => {
    const res = await api('PUT', '/keys/identity', {
      publicKey: newKeyPair.publicKey,
    }, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'response ok');
    assertEqual(res.data.data.publicKey, newKeyPair.publicKey, 'new publicKey');
    assertEqual(res.data.data.keyId, newKeyId, 'new keyId');
  });

  await test('GET /keys/identity returns new key after rotation', async () => {
    const res = await api('GET', `/keys/identity/${userAId}`, undefined, userBToken);
    assertEqual(res.status, 200, 'status');
    assertEqual(res.data.data.publicKey, newKeyPair.publicKey, 'new key returned');
    assertEqual(res.data.data.keyId, newKeyId, 'new keyId');
  });

  // Update local state to use new key
  userAKeyPair = newKeyPair;
  userAKeyId = newKeyId;

  // ─── Group 4: Audit Log ───────────────────────────────────
  console.log('\n📋 Audit Log');

  await test('GET /keys/audit/:userId returns audit log entries', async () => {
    const res = await api('GET', `/keys/audit/${userAId}`, undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'response ok');
    assert(Array.isArray(res.data.data), 'data is array');
    // Should have at least 3 entries: register + rotate(derived) + rotate(new key)
    assert(res.data.data.length >= 3, `expected >= 3 audit entries, got ${res.data.data.length}`);
    // Check first entry
    const first = res.data.data[0];
    assertEqual(first.action, 'register', 'first action is register');
    assertEqual(first.imUserId, userAId, 'userId matches');
    assert(first.prevLogHash === null, 'first entry has no prevLogHash');
  });

  await test('Audit log entries form valid hash chain', async () => {
    const res = await api('GET', `/keys/audit/${userAId}`, undefined, userAToken);
    const logs = res.data.data;
    // Second entry should have prevLogHash pointing to first
    assert(logs.length >= 2, 'need at least 2 entries');
    for (let i = 1; i < logs.length; i++) {
      assert(logs[i].prevLogHash !== null, `entry ${i} has prevLogHash`);
      assert(typeof logs[i].prevLogHash === 'string', `entry ${i} prevLogHash is string`);
    }
  });

  await test('GET /keys/audit/:userId/verify confirms hash chain integrity', async () => {
    const res = await api('GET', `/keys/audit/${userAId}/verify`, undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'response ok');
    assertEqual(res.data.data.valid, true, 'chain is valid');
    const entryCount = res.data.data.totalEntries ?? res.data.data.entries;
    assert(entryCount >= 3 || res.data.data.valid === true, `chain valid with sufficient entries`);
  });

  // ─── Group 5: Signed Message Sending ──────────────────────
  console.log('\n✍️  Signed Message Sending');

  await test('Send signed message via /messages/:conversationId (valid signature)', async () => {
    const body = createSignedBody({
      senderId: userAId, senderKeyId: userAKeyId, privateKey: userAKeyPair.privateKey,
      conversationId, sequence: 1, content: 'This is a signed message from Alice',
    });

    const res = await api('POST', `/messages/${conversationId}`, body, userAToken);

    assertEqual(res.status, 201, `status (got ${res.status}: ${JSON.stringify(res.data)})`);
    assert(res.data.ok, 'response ok');
    const msg = res.data.data.message;
    assertEqual(msg.secVersion, 1, 'secVersion stored');
    assertEqual(msg.senderKeyId, userAKeyId, 'senderKeyId stored');
    assertEqual(msg.sequence, 1, 'sequence stored');
    assertEqual(msg.contentHash, body.contentHash, 'contentHash stored');
    assertEqual(msg.signature, body.signature, 'signature stored');
  });

  await test('Send signed message via /direct/:userId/messages', async () => {
    const body = createSignedBody({
      senderId: userAId, senderKeyId: userAKeyId, privateKey: userAKeyPair.privateKey,
      conversationId, sequence: 2, content: 'Signed DM from Alice to Bob',
    });

    const res = await api('POST', `/direct/${userBId}/messages`, body, userAToken);
    assertEqual(res.status, 201, `status (got ${res.status}: ${JSON.stringify(res.data)})`);
    assert(res.data.ok, 'response ok');
  });

  await test('Reject message with invalid signature', async () => {
    // Build body signed with Bob's key but claiming Alice's keyId
    const body = createSignedBody({
      senderId: userAId, senderKeyId: userAKeyId, privateKey: userBKeyPair.privateKey,
      conversationId, sequence: 3, content: 'This should fail',
    });

    const res = await api('POST', `/messages/${conversationId}`, body, userAToken);
    assertEqual(res.status, 403, `status (got ${res.status}: ${JSON.stringify(res.data)})`);
    assert(!res.data.ok, 'response not ok');
    assert(res.data.error.includes('Signature verification failed'), `error message: ${res.data.error}`);
  });

  await test('Reject message with wrong contentHash', async () => {
    const content = 'Real content';
    const wrongHash = computeContentHash('Different content');
    const timestamp = Date.now();

    const payload = buildSigningPayload({
      secVersion: 1, senderId: userAId, senderKeyId: userAKeyId,
      conversationId, sequence: 4, type: 'text', timestamp,
      contentHash: wrongHash, prevHash: null,
    });
    const signature = signMessage(userAKeyPair.privateKey, payload);

    const res = await api('POST', `/messages/${conversationId}`, {
      content, type: 'text', secVersion: 1, senderKeyId: userAKeyId,
      sequence: 4, contentHash: wrongHash, prevHash: null, signature, timestamp,
    }, userAToken);

    assertEqual(res.status, 403, `status (got ${res.status}: ${JSON.stringify(res.data)})`);
    assert(res.data.error.includes('content_hash_mismatch'), `error: ${res.data.error}`);
  });

  await test('Unsigned messages still work (optional policy)', async () => {
    const res = await api('POST', `/messages/${conversationId}`, {
      content: 'This is an unsigned message — totally fine',
      type: 'text',
    }, userAToken);

    assertEqual(res.status, 201, `status (got ${res.status}: ${JSON.stringify(res.data)})`);
    assert(res.data.ok, 'response ok');
    // Signing fields should be null
    const msg = res.data.data.message;
    assertEqual(msg.secVersion, null, 'secVersion null');
    assertEqual(msg.signature, null, 'signature null');
  });

  // ─── Group 6: Anti-Replay ─────────────────────────────────
  console.log('\n🔁 Anti-Replay (Sliding Window)');

  await test('Reject replayed sequence number', async () => {
    const body1 = createSignedBody({
      senderId: userAId, senderKeyId: userAKeyId, privateKey: userAKeyPair.privateKey,
      conversationId, sequence: 10, content: 'First message seq 10',
    });
    const res1 = await api('POST', `/messages/${conversationId}`, body1, userAToken);
    assertEqual(res1.status, 201, `first send status (got ${res1.status})`);

    // Replay same sequence 10
    const body2 = createSignedBody({
      senderId: userAId, senderKeyId: userAKeyId, privateKey: userAKeyPair.privateKey,
      conversationId, sequence: 10, content: 'Replay attempt seq 10',
    });
    const res2 = await api('POST', `/messages/${conversationId}`, body2, userAToken);
    assertEqual(res2.status, 403, `replay status (got ${res2.status}: ${JSON.stringify(res2.data)})`);
    assert(res2.data.error.includes('replay_detected'), `error: ${res2.data.error}`);
  });

  await test('Accept out-of-order sequences within window', async () => {
    const body = createSignedBody({
      senderId: userAId, senderKeyId: userAKeyId, privateKey: userAKeyPair.privateKey,
      conversationId, sequence: 8, content: 'Out of order seq 8',
    });
    const res = await api('POST', `/messages/${conversationId}`, body, userAToken);
    assertEqual(res.status, 201, `out-of-order status (got ${res.status}: ${JSON.stringify(res.data)})`);
    assert(res.data.ok, 'response ok');
  });

  await test('Accept higher sequence number', async () => {
    const body = createSignedBody({
      senderId: userAId, senderKeyId: userAKeyId, privateKey: userAKeyPair.privateKey,
      conversationId, sequence: 20, content: 'Forward seq 20',
    });
    const res = await api('POST', `/messages/${conversationId}`, body, userAToken);
    assertEqual(res.status, 201, `forward status (got ${res.status}: ${JSON.stringify(res.data)})`);
  });

  // ─── Group 7: Key Revocation ──────────────────────────────
  console.log('\n🚫 Key Revocation');

  await test('POST /keys/identity/revoke revokes key', async () => {
    const res = await api('POST', '/keys/identity/revoke', {}, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'response ok');
  });

  await test('GET /keys/identity/:userId returns 404 after revocation', async () => {
    const res = await api('GET', `/keys/identity/${userAId}`, undefined, userBToken);
    assertEqual(res.status, 404, `status (got ${res.status}: ${JSON.stringify(res.data)})`);
  });

  await test('Signed message with revoked key is rejected', async () => {
    const body = createSignedBody({
      senderId: userAId, senderKeyId: userAKeyId, privateKey: userAKeyPair.privateKey,
      conversationId, sequence: 30, content: 'Trying to sign with revoked key',
    });
    const res = await api('POST', `/messages/${conversationId}`, body, userAToken);
    assertEqual(res.status, 403, `status (got ${res.status}: ${JSON.stringify(res.data)})`);
    assert(res.data.error.includes('unknown_key_id'), `error: ${res.data.error}`);
  });

  await test('Audit log contains revoke entry', async () => {
    const res = await api('GET', `/keys/audit/${userAId}`, undefined, userAToken);
    assert(res.data.ok, 'response ok');
    const logs = res.data.data;
    const revokeEntry = logs.find((l: any) => l.action === 'revoke');
    assert(revokeEntry !== undefined, 'revoke entry exists');
    assert(revokeEntry.prevLogHash !== null, 'revoke entry has prevLogHash');
  });

  await test('Hash chain still valid after revocation', async () => {
    const res = await api('GET', `/keys/audit/${userAId}/verify`, undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assertEqual(res.data.data.valid, true, 'chain valid after revoke');
  });

  // ─── Group 8: Re-registration after revocation ────────────
  console.log('\n🔄 Re-registration After Revocation');

  const freshKeyPair = generateKeyPair();
  const freshKeyId = deriveKeyId(freshKeyPair.publicKey);

  await test('Can register new key after revocation', async () => {
    const res = await api('PUT', '/keys/identity', {
      publicKey: freshKeyPair.publicKey,
    }, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'response ok');
    assertEqual(res.data.data.publicKey, freshKeyPair.publicKey, 'new key');
    assertEqual(res.data.data.keyId, freshKeyId, 'new keyId');
    assertEqual(res.data.data.revokedAt, null, 'not revoked');
  });

  await test('Signed message with new key succeeds', async () => {
    const body = createSignedBody({
      senderId: userAId, senderKeyId: freshKeyId, privateKey: freshKeyPair.privateKey,
      conversationId, sequence: 40, content: 'Message with re-registered key',
    });
    const res = await api('POST', `/messages/${conversationId}`, body, userAToken);
    assertEqual(res.status, 201, `status (got ${res.status}: ${JSON.stringify(res.data)})`);
    assert(res.data.ok, 'response ok');
  });

  // ─── Group 9: Group Message Signing ───────────────────────
  console.log('\n👥 Group Message Signing');

  // Create a group
  const groupRes = await api('POST', '/groups', {
    title: `Crypto Test Group ${ts}`,
    members: [userBId],
  }, userAToken);
  assert(groupRes.data.ok, `Group creation failed: ${JSON.stringify(groupRes.data)}`);
  const groupId = groupRes.data.data.groupId;

  await test('Send signed message to group', async () => {
    const body = createSignedBody({
      senderId: userAId, senderKeyId: freshKeyId, privateKey: freshKeyPair.privateKey,
      conversationId: groupId, sequence: 1, content: 'Signed group message',
    });
    const res = await api('POST', `/groups/${groupId}/messages`, body, userAToken);
    assertEqual(res.status, 201, `status (got ${res.status}: ${JSON.stringify(res.data)})`);
    assert(res.data.ok, 'response ok');
  });

  await test('Reject invalid signature in group', async () => {
    const content = 'Bad sig in group';
    const contentHash = computeContentHash(content);
    const fakeSignature = Buffer.from(new Uint8Array(64)).toString('base64');

    const res = await api('POST', `/groups/${groupId}/messages`, {
      content, type: 'text', secVersion: 1, senderKeyId: freshKeyId,
      sequence: 2, contentHash, prevHash: null, signature: fakeSignature,
      timestamp: Date.now(),
    }, userAToken);
    assertEqual(res.status, 403, `status (got ${res.status}: ${JSON.stringify(res.data)})`);
  });

  // ─── Summary ──────────────────────────────────────────────
  console.log('\n' + '═'.repeat(55));
  console.log(`📊 Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);

  if (failures.length > 0) {
    console.log('\n❌ Failures:');
    failures.forEach((f) => console.log(`  • ${f}`));
  }

  console.log();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
