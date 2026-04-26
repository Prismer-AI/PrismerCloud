/**
 * Prismer IM — v1.8.0 Signing Integration Tests (P5)
 *
 * Tests v1.8.0-specific signing behaviors:
 *   1. Default 'recommended' signing policy on new conversations
 *   2. Hash chain (prevHash) break → rejection
 *   3. Hash chain continuity → acceptance
 *   4. Mixed signed + unsigned in recommended mode
 *   5. SDK auto-sign fields presence (senderDid, signedAt)
 *   6. prevHash null for first message in conversation
 *   7. Correct prevHash for sequential signed messages
 *   8. Concurrent signers maintain separate chains
 *   9. Lite signing mode (senderDid only, no senderKeyId)
 *  10. Timestamp skew >5min → rejection
 *  11. Replay detection (same sequence) → rejection
 *  12. Required signing policy rejects unsigned messages
 *
 * Usage: DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/tests/signing-v180.test.ts
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const BASE = process.env.IM_BASE_URL || 'http://localhost:3200';

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

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function assertEqual(actual: any, expected: any, field: string) {
  if (actual !== expected)
    throw new Error(`${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function api(method: string, path: string, body?: any, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const url = BASE.includes('/api/im') ? `${BASE}${path}` : `${BASE}/api${path}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// ─── Crypto helpers ─────────────────────────────────────────

function generateKeyPair() {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return {
    publicKey: Buffer.from(publicKey).toString('base64'),
    privateKey: Buffer.from(privateKey).toString('base64'),
  };
}

function deriveKeyId(pubBase64: string): string {
  const hash = sha256(Buffer.from(pubBase64, 'base64'));
  return bytesToHex(hash.slice(0, 8));
}

function computeContentHash(content: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(content)));
}

/** Encode a Base64 Ed25519 public key as did:key (inline, matches src/im/crypto/index.ts) */
function publicKeyToDID(publicKeyBase64: string): string {
  const pubBytes = Buffer.from(publicKeyBase64, 'base64');
  // Multicodec prefix for Ed25519: [0xed, 0x01]
  const multicodec = new Uint8Array(34);
  multicodec[0] = 0xed;
  multicodec[1] = 0x01;
  multicodec.set(pubBytes, 2);
  // Base58btc encode
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let zeroCount = 0;
  while (zeroCount < multicodec.length && multicodec[zeroCount] === 0) zeroCount++;
  const digits: number[] = [];
  for (let i = zeroCount; i < multicodec.length; i++) {
    let carry = multicodec[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let str = '1'.repeat(zeroCount);
  for (let i = digits.length - 1; i >= 0; i--) str += ALPHABET[digits[i]];
  return `did:key:z${str}`;
}

function buildPayload(p: {
  secVersion: number;
  senderId: string;
  senderKeyId: string;
  senderDid?: string;
  conversationId: string;
  sequence: number;
  type: string;
  timestamp: number;
  contentHash: string;
  prevHash: string | null;
}): Uint8Array {
  // Must match server's buildSigningPayload format exactly:
  // secVersion|senderId|senderDid|senderKeyId|conversationId|sequence|type|timestamp|contentHash|prevHash
  return new TextEncoder().encode(
    [
      p.secVersion,
      p.senderId,
      p.senderDid ?? '',
      p.senderKeyId,
      p.conversationId,
      p.sequence,
      p.type,
      p.timestamp,
      p.contentHash,
      p.prevHash ?? '',
    ].join('|'),
  );
}

function signMsg(privateKey: string, payload: Uint8Array): string {
  return Buffer.from(ed25519.sign(payload, Buffer.from(privateKey, 'base64'))).toString('base64');
}

function createSignedBody(params: {
  senderId: string;
  senderKeyId: string;
  privateKey: string;
  conversationId: string;
  sequence: number;
  content: string;
  prevHash?: string | null;
  senderDid?: string;
}) {
  const content = params.content;
  const contentHash = computeContentHash(content);
  const timestamp = Date.now();
  const payload = buildPayload({
    secVersion: 1,
    senderId: params.senderId,
    senderDid: params.senderDid,
    senderKeyId: params.senderKeyId,
    conversationId: params.conversationId,
    sequence: params.sequence,
    type: 'text',
    timestamp,
    contentHash,
    prevHash: params.prevHash ?? null,
  });
  const signature = signMsg(params.privateKey, payload);
  return {
    content,
    type: 'text',
    secVersion: 1,
    senderKeyId: params.senderKeyId,
    sequence: params.sequence,
    contentHash,
    prevHash: params.prevHash ?? null,
    signature,
    timestamp,
    ...(params.senderDid ? { senderDid: params.senderDid } : {}),
  };
}

// ─── State ──────────────────────────────────────────────────

const ts = String(Date.now()).slice(-8);
let userAToken = '',
  userAId = '',
  userBToken = '',
  userBId = '';
const userAKeyPair = generateKeyPair();
const userAKeyId = deriveKeyId(userAKeyPair.publicKey);
const userBKeyPair = generateKeyPair();
const userBKeyId = deriveKeyId(userBKeyPair.publicKey);
let conversationId = '';

async function setup() {
  console.log('Setting up test users...');
  const regA = await api('POST', '/register', { username: `sign_a_${ts}`, displayName: 'Sign A', type: 'human' });
  assert(regA.data?.ok, `Register A failed: ${JSON.stringify(regA.data)}`);
  userAToken = regA.data.data.token;
  userAId = regA.data.data.imUserId;

  const regB = await api('POST', '/register', { username: `sign_b_${ts}`, displayName: 'Sign B', type: 'human' });
  assert(regB.data?.ok, `Register B failed: ${JSON.stringify(regB.data)}`);
  userBToken = regB.data.data.token;
  userBId = regB.data.data.imUserId;

  // Register identity keys
  await api('PUT', '/keys/identity', { publicKey: userAKeyPair.publicKey, algorithm: 'Ed25519' }, userAToken);
  await api('PUT', '/keys/identity', { publicKey: userBKeyPair.publicKey, algorithm: 'Ed25519' }, userBToken);

  // Create conversation
  const conv = await api('POST', '/conversations/direct', { otherUserId: userBId }, userAToken);
  assert(conv.data?.ok, `Create conversation failed: ${JSON.stringify(conv.data)}`);
  conversationId = conv.data.data.id;
}

// ─── Tests ──────────────────────────────────────────────────

async function runTests() {
  console.log('\n🔹 v1.8.0 Signing Integration Tests');

  // Test 1: Default signing policy is 'recommended'
  await test('1. New conversation has recommended signing policy', async () => {
    const sec = await api('GET', `/conversations/${conversationId}/security`, undefined, userAToken);
    if (sec.data?.ok && sec.data.data) {
      assertEqual(sec.data.data.signingPolicy, 'recommended', 'signingPolicy');
    }
  });

  // Test 2: prevHash null for first signed message
  let firstContentHash = '';
  await test('2. First signed message accepts prevHash=null', async () => {
    const body = createSignedBody({
      senderId: userAId,
      senderKeyId: userAKeyId,
      privateKey: userAKeyPair.privateKey,
      conversationId,
      sequence: 1,
      content: `First signed msg ${ts}`,
      prevHash: null,
    });
    const res = await api('POST', `/messages/${conversationId}`, body, userAToken);
    assert(res.data?.ok, `Send failed: ${JSON.stringify(res.data)}`);
    firstContentHash = body.contentHash;
  });

  // Test 3: Correct prevHash chain succeeds
  let secondContentHash = '';
  await test('3. Correct prevHash chain is accepted', async () => {
    const body = createSignedBody({
      senderId: userAId,
      senderKeyId: userAKeyId,
      privateKey: userAKeyPair.privateKey,
      conversationId,
      sequence: 2,
      content: `Second signed msg ${ts}`,
      prevHash: firstContentHash,
    });
    const res = await api('POST', `/messages/${conversationId}`, body, userAToken);
    assert(res.data?.ok, `Send failed: ${JSON.stringify(res.data)}`);
    secondContentHash = body.contentHash;
  });

  // Test 4: Hash chain break → rejection
  await test('4. Hash chain break is rejected', async () => {
    const wrongPrevHash = computeContentHash('this-is-not-the-previous-hash');
    const body = createSignedBody({
      senderId: userAId,
      senderKeyId: userAKeyId,
      privateKey: userAKeyPair.privateKey,
      conversationId,
      sequence: 3,
      content: `Broken chain ${ts}`,
      prevHash: wrongPrevHash,
    });
    const res = await api('POST', `/messages/${conversationId}`, body, userAToken);
    assert(
      !res.data?.ok || res.status === 403,
      `Expected rejection for hash chain break, got: ${JSON.stringify(res.data)}`,
    );
    if (res.data?.error) {
      assert(
        res.data.error.includes('hash_chain') || res.data.error.includes('chain') || res.data.error.includes('signing'),
        `Error should mention hash chain, got: ${res.data.error}`,
      );
    }
  });

  // Test 5: Mixed signed + unsigned in recommended mode
  await test('5. Unsigned messages work in recommended mode', async () => {
    const res = await api(
      'POST',
      `/messages/${conversationId}`,
      {
        content: `Unsigned msg in recommended mode ${ts}`,
        type: 'text',
      },
      userAToken,
    );
    assert(res.data?.ok, `Unsigned message should be accepted in recommended mode: ${JSON.stringify(res.data)}`);
  });

  // Test 6: SDK auto-sign fields (senderDid) preserved
  await test('6. senderDid field is accepted in signed message', async () => {
    // Use the real did:key derived from userA's public key (must match what the server registered)
    const userADid = publicKeyToDID(userAKeyPair.publicKey);
    const body = createSignedBody({
      senderId: userAId,
      senderKeyId: userAKeyId,
      privateKey: userAKeyPair.privateKey,
      conversationId,
      sequence: 4,
      content: `DID signed msg ${ts}`,
      prevHash: secondContentHash,
      senderDid: userADid,
    });
    const res = await api('POST', `/messages/${conversationId}`, body, userAToken);
    // Should succeed — senderDid is informational alongside senderKeyId
    assert(res.data?.ok, `Message with senderDid should succeed: ${JSON.stringify(res.data)}`);
  });

  // Test 7: Concurrent signers maintain separate chains
  await test('7. User B signs independently with own prevHash chain', async () => {
    // B's first message: prevHash=null (B has no prior messages in this conversation)
    const bodyB1 = createSignedBody({
      senderId: userBId,
      senderKeyId: userBKeyId,
      privateKey: userBKeyPair.privateKey,
      conversationId,
      sequence: 1,
      content: `B first msg ${ts}`,
      prevHash: null,
    });
    const res1 = await api('POST', `/messages/${conversationId}`, bodyB1, userBToken);
    assert(res1.data?.ok, `B first signed msg failed: ${JSON.stringify(res1.data)}`);

    // B's second message with correct prevHash
    const bodyB2 = createSignedBody({
      senderId: userBId,
      senderKeyId: userBKeyId,
      privateKey: userBKeyPair.privateKey,
      conversationId,
      sequence: 2,
      content: `B second msg ${ts}`,
      prevHash: bodyB1.contentHash,
    });
    const res2 = await api('POST', `/messages/${conversationId}`, bodyB2, userBToken);
    assert(res2.data?.ok, `B second signed msg failed: ${JSON.stringify(res2.data)}`);
  });

  // Test 8: Valid signature but wrong sender key → reject
  await test('8. Signing with wrong key is rejected', async () => {
    const wrongKeyPair = generateKeyPair();
    const body = createSignedBody({
      senderId: userAId,
      senderKeyId: userAKeyId,
      privateKey: wrongKeyPair.privateKey,
      conversationId,
      sequence: 5,
      content: `Wrong key msg ${ts}`,
      prevHash: null,
    });
    const res = await api('POST', `/messages/${conversationId}`, body, userAToken);
    assert(
      !res.data?.ok || res.status === 403,
      `Expected rejection for wrong signing key, got: ${JSON.stringify(res.data)}`,
    );
  });

  // ─── New P5 Tests (lite mode, timestamp skew, replay, required policy) ───

  // Test 9: Lite signing mode — senderDid present, senderKeyId absent
  await test('9. Lite signing mode (senderDid only, no senderKeyId) is accepted', async () => {
    // Create a fresh conversation so hash chain starts clean (no prior signed messages)
    const liteConv = await api('POST', '/conversations/direct', { otherUserId: userBId }, userAToken);
    assert(liteConv.data?.ok, `Create lite-mode conversation failed: ${JSON.stringify(liteConv.data)}`);
    const liteConvId = liteConv.data.data.id;

    // Derive the real did:key from userA's public key
    const didKey = publicKeyToDID(userAKeyPair.publicKey);
    const content = `Lite signed msg ${ts}`;
    const contentHash = computeContentHash(content);
    const timestamp = Date.now();
    // Build lite signing payload: secVersion|senderDid|type|timestamp|contentHash
    const litePayload = new TextEncoder().encode([1, didKey, 'text', timestamp, contentHash].join('|'));
    const signature = signMsg(userAKeyPair.privateKey, litePayload);
    const body = {
      content,
      type: 'text',
      secVersion: 1,
      senderDid: didKey,
      // NO senderKeyId — this triggers lite mode on the server
      sequence: 1,
      contentHash,
      prevHash: null,
      signature,
      signedAt: timestamp,
    };
    const res = await api('POST', `/messages/${liteConvId}`, body, userAToken);
    assert(res.data?.ok, `Lite signed message should succeed: ${JSON.stringify(res.data)}`);
    // Verify senderDid is present in the returned message
    if (res.data?.data?.message) {
      // senderDid may or may not be stored on the message model — just ensure success
      assert(res.data.data.message.id, 'Message should have an id');
    }
  });

  // Test 10: Timestamp skew >5min → rejection
  await test('10. Timestamp skew >5min is rejected', async () => {
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000; // 10 minutes ago
    const content = `Old timestamp msg ${ts}`;
    const contentHash = computeContentHash(content);
    const payload = buildPayload({
      secVersion: 1,
      senderId: userAId,
      senderKeyId: userAKeyId,
      conversationId,
      sequence: 20,
      type: 'text',
      timestamp: tenMinutesAgo,
      contentHash,
      prevHash: null,
    });
    const signature = signMsg(userAKeyPair.privateKey, payload);
    const body = {
      content,
      type: 'text',
      secVersion: 1,
      senderKeyId: userAKeyId,
      sequence: 20,
      contentHash,
      prevHash: null,
      signature,
      signedAt: tenMinutesAgo,
    };
    const res = await api('POST', `/messages/${conversationId}`, body, userAToken);
    assert(
      !res.data?.ok || res.status === 403,
      `Expected rejection for timestamp skew >5min, got: ${JSON.stringify(res.data)}`,
    );
    if (res.data?.error) {
      assert(
        res.data.error.includes('timestamp_skew') || res.data.error.includes('timestamp'),
        `Error should mention timestamp, got: ${res.data.error}`,
      );
    }
  });

  // Test 11: Replay detection — same sequence rejected on second attempt
  await test('11. Replay (same sequence) is rejected', async () => {
    // Create a fresh conversation for clean replay test
    const replayConv = await api('POST', '/conversations/direct', { otherUserId: userBId }, userAToken);
    assert(replayConv.data?.ok, `Create replay test conversation failed: ${JSON.stringify(replayConv.data)}`);
    const replayConvId = replayConv.data.data.id;

    const content = `Replay test msg ${ts}`;
    const contentHash = computeContentHash(content);
    const timestamp1 = Date.now();
    const payload1 = buildPayload({
      secVersion: 1,
      senderId: userAId,
      senderKeyId: userAKeyId,
      conversationId: replayConvId,
      sequence: 1,
      type: 'text',
      timestamp: timestamp1,
      contentHash,
      prevHash: null,
    });
    const signature1 = signMsg(userAKeyPair.privateKey, payload1);
    const body1 = {
      content,
      type: 'text',
      secVersion: 1,
      senderKeyId: userAKeyId,
      sequence: 1,
      contentHash,
      prevHash: null,
      signature: signature1,
      signedAt: timestamp1,
    };

    // First send should succeed
    const res1 = await api('POST', `/messages/${replayConvId}`, body1, userAToken);
    assert(res1.data?.ok, `First send should succeed: ${JSON.stringify(res1.data)}`);

    // Replay the SAME sequence number with fresh timestamp/signature
    const timestamp2 = Date.now();
    const content2 = `Replayed msg ${ts}`;
    const contentHash2 = computeContentHash(content2);
    const payload2 = buildPayload({
      secVersion: 1,
      senderId: userAId,
      senderKeyId: userAKeyId,
      conversationId: replayConvId,
      sequence: 1,
      type: 'text',
      timestamp: timestamp2,
      contentHash: contentHash2,
      prevHash: null,
    });
    const signature2 = signMsg(userAKeyPair.privateKey, payload2);
    const body2 = {
      content: content2,
      type: 'text',
      secVersion: 1,
      senderKeyId: userAKeyId,
      sequence: 1,
      contentHash: contentHash2,
      prevHash: null,
      signature: signature2,
      signedAt: timestamp2,
    };

    const res2 = await api('POST', `/messages/${replayConvId}`, body2, userAToken);
    assert(
      !res2.data?.ok || res2.status === 403,
      `Expected rejection for replayed sequence, got: ${JSON.stringify(res2.data)}`,
    );
    if (res2.data?.error) {
      assert(
        res2.data.error.includes('replay') || res2.data.error.includes('sequence'),
        `Error should mention replay, got: ${res2.data.error}`,
      );
    }
  });

  // Test 12: Required signing policy rejects unsigned messages
  await test('12. Required signing policy rejects unsigned messages', async () => {
    // Create a new conversation and set signingPolicy to 'required'
    const reqConv = await api('POST', '/conversations/direct', { otherUserId: userBId }, userAToken);
    assert(reqConv.data?.ok, `Create required-policy conversation failed: ${JSON.stringify(reqConv.data)}`);
    const reqConvId = reqConv.data.data.id;

    // Update signing policy to 'required'
    const patchRes = await api(
      'PATCH',
      `/conversations/${reqConvId}/security`,
      { signingPolicy: 'required' },
      userAToken,
    );
    assert(patchRes.data?.ok, `Set signing policy failed: ${JSON.stringify(patchRes.data)}`);

    // Verify policy is set
    const secRes = await api('GET', `/conversations/${reqConvId}/security`, undefined, userAToken);
    assertEqual(secRes.data?.data?.signingPolicy, 'required', 'signingPolicy after PATCH');

    // Send an unsigned message — should be rejected
    const res = await api(
      'POST',
      `/messages/${reqConvId}`,
      {
        content: `Unsigned in required mode ${ts}`,
        type: 'text',
      },
      userAToken,
    );
    assert(
      !res.data?.ok || res.status === 403,
      `Expected rejection for unsigned message in required mode, got: ${JSON.stringify(res.data)}`,
    );
    if (res.data?.error) {
      assert(
        res.data.error.includes('required') || res.data.error.includes('signed'),
        `Error should mention signing required, got: ${res.data.error}`,
      );
    }
  });
}

// ─── Runner ─────────────────────────────────────────────────

async function main() {
  console.log(`🔏 v1.8.0 Signing Integration Tests — ${BASE}\n`);
  await setup();
  await runTests();

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`🔏 Signing v1.8.0: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ❌ ${f}`);
  }
  console.log(`${'═'.repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
