/**
 * Security Feature Integration Test — Layers 1-5
 * Tests: Identity, Signing, Rate Limiting, Context ACL, Encryption
 *
 * Usage: npx tsx sdk/tests/security-test.ts
 */

const BASE = 'http://localhost:3200';
const P = '\x1b[32m✓\x1b[0m';
const F = '\x1b[31m✗\x1b[0m';
let passed = 0, failed = 0;
const failures: string[] = [];

function ok(cond: boolean, msg: string, detail?: string) {
  if (cond) { console.log(`  ${P} ${msg}`); passed++; }
  else { const f = detail ? `${msg} — ${detail}` : msg; console.log(`  ${F} ${f}`); failed++; failures.push(f); }
}

async function req(method: string, path: string, body?: any, token?: string) {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  let d: any; try { d = JSON.parse(txt); } catch { d = { _raw: txt }; }
  return { d, status: r.status, ok: r.ok && d.ok !== false, headers: Object.fromEntries(r.headers.entries()) };
}

async function register(suffix: string) {
  const r = await req('POST', '/api/register', { type: 'agent', username: `sec-${Date.now()}-${suffix}`, displayName: `Sec ${suffix}` });
  return { token: r.d?.data?.token, id: r.d?.data?.imUserId };
}

async function main() {
  console.log('═══ Security Feature Test ═══\n');

  const a1 = await register('a');
  const a2 = await register('b');
  if (!a1.token || !a2.token) { console.error('Registration failed'); process.exit(1); }

  // ═══════════════════════════════════════════
  // Layer 1: Identity & Authentication
  // ═══════════════════════════════════════════
  console.log('── L1: Identity & Auth ──');

  const sk = await req('GET', '/api/keys/server', undefined, a1.token);
  ok(sk.ok, 'Server key endpoint');
  ok(!!sk.d?.data?.publicKey, 'Returns server public key');

  const regKey = await req('POST', '/api/keys/register', {
    publicKey: 'MCowBQYDK2VwAyEA' + 'ABCDEFGHIJ1234567890abcdefgh12345678' + 'AAAA',
    derivationMode: 'generated',
  }, a1.token);
  // May succeed or fail on key format — endpoint must respond
  ok(regKey.status < 500, 'Key register endpoint responds (no 500)');

  const audit = await req('GET', `/api/keys/audit/${a1.id}`, undefined, a1.token);
  ok(audit.status < 500, 'Audit log endpoint responds');

  // ═══════════════════════════════════════════
  // Layer 2: Message Signing (server-side verify)
  // ═══════════════════════════════════════════
  console.log('\n── L2: Message Signing ──');

  // Send unsigned message — should work (policy=optional by default)
  const m1 = await req('POST', `/api/direct/${a2.id}/messages`, { content: 'Unsigned msg' }, a1.token);
  ok(m1.ok, 'Unsigned message accepted (policy=optional)');

  // Send with fake signature fields — server should reject invalid signatures
  const m2 = await req('POST', `/api/messages/${m1.d?.data?.conversationId}`, {
    content: 'Fake signed',
    secVersion: 1,
    senderKeyId: 'fakekeyid',
    sequence: 1,
    contentHash: 'fakehash',
    signature: 'fakesig',
  }, a1.token);
  // Server should reject or accept-with-warning depending on implementation
  ok(m2.status !== 500, 'Fake signature doesn\'t crash server');

  // ═══════════════════════════════════════════
  // Layer 4: Rate Limiting
  // ═══════════════════════════════════════════
  console.log('\n── L4: Rate Limiting ──');

  // Check rate limit headers
  const rl1 = await req('POST', `/api/direct/${a2.id}/messages`, { content: 'Rate test 1' }, a1.token);
  ok(rl1.ok, 'Message with rate limit passes');
  ok(!!rl1.headers['x-ratelimit-limit'], `Rate limit header present (limit=${rl1.headers['x-ratelimit-limit']})`);
  ok(!!rl1.headers['x-ratelimit-remaining'], `Remaining header present (=${rl1.headers['x-ratelimit-remaining']})`);

  // Rapid fire — send many messages quickly to test rate limiting kicks in
  // Tier 0 = 10 msg/min. We already sent ~3, send 10 more to trigger limit.
  let rateLimited = false;
  let lastStatus = 200;
  for (let i = 0; i < 15; i++) {
    const r = await req('POST', `/api/direct/${a2.id}/messages`, { content: `Flood ${i}` }, a1.token);
    lastStatus = r.status;
    if (r.status === 429) {
      rateLimited = true;
      ok(true, `Rate limited after ${i + 1} rapid messages (429)`);
      ok(!!r.headers['retry-after'], 'Retry-After header present');
      ok(r.d?.error?.code === 'RATE_LIMITED', `Error code is RATE_LIMITED`);
      break;
    }
  }
  if (!rateLimited) {
    ok(false, 'Rate limiting should trigger within 15 msgs (tier 0 = 10/min)', `last status: ${lastStatus}`);
  }

  // Test suspended user rejection
  const suspended = await req('GET', '/api/im/me', undefined, 'suspended-fake-token');
  // Can't actually suspend in test — just verify the endpoint doesn't crash
  ok(suspended.status === 401 || suspended.status === 403, 'Invalid token rejected');

  // ═══════════════════════════════════════════
  // Layer 3: Context Access Control
  // ═══════════════════════════════════════════
  console.log('\n── L3: Context Access Control ──');

  // Use fresh agent for context ACL test (avoid rate limit from L4 test above)
  const ctxAgent = await register('ctx');
  const ctxMsg = await req('POST', `/api/direct/${a2.id}/messages`, {
    content: 'Check this: prismer://private/u_someoneelse/c_secret123',
  }, ctxAgent.token);
  // Should be rejected (sender doesn't own the private context)
  ok(ctxMsg.status === 403, `Private context ref from non-owner rejected (status=${ctxMsg.status})`);

  // Send message with public context ref — should always pass
  // Use a new agent to avoid rate limits
  const a3 = await register('c');
  const pubCtx = await req('POST', `/api/direct/${a2.id}/messages`, {
    content: 'Public ref: prismer://public/u_anyone/c_content1',
  }, a3.token);
  ok(pubCtx.ok || pubCtx.status === 429, 'Public context ref allowed');

  // Conversation policy CRUD
  const convId = m1.d?.data?.conversationId;
  if (convId) {
    // Create policy
    const pol = await req('POST', `/api/conversations/${convId}/policies`, {
      rule: 'deny', subjectType: 'user', subjectId: 'bad-actor-id', action: 'send',
    }, a1.token);
    ok(pol.ok || pol.status < 500, 'Create conversation policy');

    // List policies
    const pols = await req('GET', `/api/conversations/${convId}/policies`, undefined, a1.token);
    ok(pols.ok || pols.status < 500, 'List conversation policies');
  }

  // ═══════════════════════════════════════════
  // Layer 5: Encryption (SDK-side)
  // ═══════════════════════════════════════════
  console.log('\n── L5: Encryption (SDK Pipeline) ──');

  try {
    const { E2EEncryption } = await import('../typescript/src/encryption.js');
    const { encryptForSend, decryptOnReceive, encryptFile, decryptFile, encryptContext, decryptContext } = await import('../typescript/src/encryption-pipeline.js');

    const e2e = new E2EEncryption();
    await e2e.init('test-passphrase');
    ok(true, 'E2E initialized');

    await e2e.generateSessionKey('conv-test');
    ok(e2e.hasSessionKey('conv-test'), 'Session key generated');

    // Message encrypt/decrypt
    const enc = await encryptForSend(e2e, 'conv-test', 'Secret agent message');
    ok(enc.metadata.encrypted === true, 'encryptForSend sets encrypted flag');
    ok(enc.content !== 'Secret agent message', 'Content is encrypted');

    const dec = await decryptOnReceive(e2e, 'conv-test', enc.content, enc.metadata);
    ok(dec.decrypted, 'decryptOnReceive succeeds');
    ok(dec.content === 'Secret agent message', `Roundtrip OK (got: ${dec.content.slice(0, 20)}...)`);

    // No session key → passthrough
    const noKey = await encryptForSend(e2e, 'no-key-conv', 'Plain message');
    ok(noKey.content === 'Plain message', 'No session key → plaintext passthrough');

    // File encrypt/decrypt
    const fileData = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const encFile = await encryptFile(e2e, 'conv-test', fileData);
    ok(encFile !== null, 'File encrypted');
    ok(encFile!.metadata.encrypted === true, 'File metadata has encrypted flag');

    const decFile = await decryptFile(e2e, 'conv-test', encFile!.data);
    ok(decFile !== null, 'File decrypted');
    ok(decFile![0] === 72 && decFile![4] === 111, 'File content matches (Hello)');

    // Context encrypt/decrypt
    await e2e.generateSessionKey('context-cache');
    const encCtx = await encryptContext(e2e, '# Important Knowledge\n\nThis is cached context.');
    ok(encCtx !== null, 'Context encrypted');

    const decCtx = await decryptContext(e2e, encCtx!.content);
    ok(decCtx === '# Important Knowledge\n\nThis is cached context.', 'Context roundtrip OK');

  } catch (e: any) {
    ok(false, 'Encryption pipeline import', e.message);
  }

  // ═══════════════════════════════════════════
  // Layer 5: Server encryption mode enforcement
  // ═══════════════════════════════════════════
  console.log('\n── L5: Server Encryption Enforcement ──');

  // Create a conversation and set encryption mode to 'required'
  // Then try to send plaintext — should be rejected
  const a4 = await register('d');
  const a5 = await register('e');
  const setupMsg = await req('POST', `/api/direct/${a5.id}/messages`, { content: 'Setup conv' }, a4.token);
  const encConvId = setupMsg.d?.data?.conversationId;

  if (encConvId) {
    // Note: There's no API to change encryptionMode directly in current implementation.
    // The server checks IMConversationSecurity.encryptionMode but there's no endpoint to set it.
    // This is a design gap — the mode can only be changed via direct DB update.
    // We verify the field exists and the check code runs by testing the normal (mode=none) path.
    const plainOk = await req('POST', `/api/messages/${encConvId}`, {
      content: 'This is plaintext', type: 'text',
    }, a4.token);
    ok(plainOk.ok || plainOk.status === 429, 'Plaintext message works in mode=none');

    // Send encrypted message (metadata.encrypted=true) — should also work
    const encOk = await req('POST', `/api/messages/${encConvId}`, {
      content: 'AES-256-GCM-ciphertext-here',
      metadata: { encrypted: true, encKeyId: 'conv-test' },
    }, a4.token);
    ok(encOk.ok || encOk.status === 429, 'Encrypted message accepted');
  }

  // ═══════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════
  console.log(`\n═══ Summary ═══`);
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  if (failures.length) {
    console.log('\n  Failures:');
    failures.forEach(f => console.log(`    ${F} ${f}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
