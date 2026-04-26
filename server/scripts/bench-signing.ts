/**
 * Prismer IM — E2E Signing Benchmark (bench-signing.ts)
 *
 * Pure cryptographic correctness verification — ZERO external dependencies.
 * Tests: Ed25519 signing, content hash, replay window, clock skew, throughput, hash chain.
 *
 * Usage: npx tsx scripts/bench-signing.ts
 *
 * Metrics measured:
 * - Verification Correctness (valid→ACCEPT rate)
 * - Forgery Rejection Rate (tampered→REJECT rate)
 * - Replay Detection Rate (within window)
 * - Clock Skew Tolerance (boundary behavior)
 * - Verification Throughput (msgs/sec)
 * - Hash Chain Integrity (append-only verification)
 * - Key ID Collision Probability (empirical)
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  SEC_VERSION,
  generateKeyPair,
  deriveKeyId,
  computeContentHash,
  buildSigningPayload,
  signMessage,
  verifySignature,
  computeAuditLogHash,
  checkReplay,
  serializeReplayWindow,
  deserializeReplayWindow,
  REPLAY_WINDOW_SIZE,
  type ReplayWindowState,
} from '../src/im/crypto/index.js';

// ─── Test Infrastructure ──────────────────────────────────────

interface BenchResult {
  name: string;
  metric: string;
  value: number;
  target: string;
  pass: boolean;
  details?: string;
}

const results: BenchResult[] = [];
let totalTests = 0;
let passedTests = 0;

function record(name: string, metric: string, value: number, target: string, pass: boolean, details?: string) {
  totalTests++;
  if (pass) passedTests++;
  results.push({ name, metric, value, target, pass, details });
  const icon = pass ? '✅' : '❌';
  console.log(`  ${icon} ${name}: ${metric} = ${value.toFixed(4)} (target: ${target})${details ? ` — ${details}` : ''}`);
}

// ─── Helpers ──────────────────────────────────────────────────

function makeSignedMessage(
  privateKey: string,
  publicKey: string,
  opts: {
    senderId?: string;
    conversationId?: string;
    sequence?: number;
    type?: string;
    content?: string;
    timestamp?: number;
    prevHash?: string | null;
  } = {},
) {
  const senderId = opts.senderId ?? 'user_test';
  const conversationId = opts.conversationId ?? 'conv_test';
  const sequence = opts.sequence ?? 1;
  const type = opts.type ?? 'text';
  const content = opts.content ?? `Hello, world! Message #${sequence}`;
  const timestamp = opts.timestamp ?? Date.now();
  const contentHash = computeContentHash(content);
  const prevHash = opts.prevHash ?? null;
  const senderKeyId = deriveKeyId(publicKey);

  const payload = buildSigningPayload({
    secVersion: SEC_VERSION,
    senderId,
    senderKeyId,
    conversationId,
    sequence,
    type,
    timestamp,
    contentHash,
    prevHash,
  });

  const signature = signMessage(privateKey, payload);

  return {
    senderId,
    conversationId,
    type,
    content,
    createdAt: timestamp,
    secVersion: SEC_VERSION,
    senderKeyId,
    sequence,
    contentHash,
    prevHash,
    signature,
    publicKey,
    payload,
  };
}

function verifyLocally(msg: ReturnType<typeof makeSignedMessage>): boolean {
  // Content hash check
  const expectedHash = computeContentHash(msg.content);
  if (msg.contentHash !== expectedHash) return false;

  // Signature check
  return verifySignature(msg.publicKey, msg.signature, msg.payload);
}

// ─── Test 1: Correctness Matrix ──────────────────────────────

function benchCorrectnessMatrix() {
  console.log('\n=== 1. Correctness Matrix (100 messages) ===');

  const { publicKey, privateKey } = generateKeyPair();
  let validAccepted = 0;
  const totalValid = 100;

  for (let i = 0; i < totalValid; i++) {
    const msg = makeSignedMessage(privateKey, publicKey, {
      sequence: i + 1,
      content: `Test message ${i}: ${crypto.randomUUID()}`,
    });
    if (verifyLocally(msg)) validAccepted++;
  }

  record(
    'Valid Messages',
    'Acceptance Rate',
    validAccepted / totalValid,
    '= 1.0',
    validAccepted === totalValid,
    `${validAccepted}/${totalValid}`,
  );

  // Tampered content: modify 1 byte
  let contentTamperRejected = 0;
  const totalContentTamper = 100;
  for (let i = 0; i < totalContentTamper; i++) {
    const msg = makeSignedMessage(privateKey, publicKey, {
      sequence: i + 1,
      content: `Tamper test ${i}`,
    });
    // Modify content but keep old hash
    msg.content = msg.content + '!';
    const ok = verifyLocally(msg);
    if (!ok) contentTamperRejected++;
  }

  record(
    'Content Tampering',
    'Rejection Rate',
    contentTamperRejected / totalContentTamper,
    '= 1.0',
    contentTamperRejected === totalContentTamper,
    `${contentTamperRejected}/${totalContentTamper}`,
  );

  // Tampered signature: flip 1 bit
  let sigTamperRejected = 0;
  const totalSigTamper = 100;
  for (let i = 0; i < totalSigTamper; i++) {
    const msg = makeSignedMessage(privateKey, publicKey, {
      sequence: i + 1,
      content: `Sig tamper ${i}`,
    });
    // Flip first bit of signature
    const sigBytes = Buffer.from(msg.signature, 'base64');
    sigBytes[0] ^= 0x01;
    msg.signature = sigBytes.toString('base64');
    const ok = verifyLocally(msg);
    if (!ok) sigTamperRejected++;
  }

  record(
    'Signature Tampering',
    'Rejection Rate',
    sigTamperRejected / totalSigTamper,
    '= 1.0',
    sigTamperRejected === totalSigTamper,
    `${sigTamperRejected}/${totalSigTamper}`,
  );

  // Wrong key: sign with one key, verify with another
  let wrongKeyRejected = 0;
  const totalWrongKey = 100;
  const { publicKey: otherPub } = generateKeyPair();
  for (let i = 0; i < totalWrongKey; i++) {
    const msg = makeSignedMessage(privateKey, publicKey, {
      sequence: i + 1,
      content: `Wrong key test ${i}`,
    });
    // Use different public key for verification
    msg.publicKey = otherPub;
    const ok = verifyLocally(msg);
    if (!ok) wrongKeyRejected++;
  }

  record(
    'Wrong Key Verification',
    'Rejection Rate',
    wrongKeyRejected / totalWrongKey,
    '= 1.0',
    wrongKeyRejected === totalWrongKey,
    `${wrongKeyRejected}/${totalWrongKey}`,
  );
}

// ─── Test 2: Replay Window ───────────────────────────────────

function benchReplayWindow() {
  console.log('\n=== 2. Replay Window (sliding window anti-replay) ===');

  const window: ReplayWindowState = { highestSeq: 0, windowBitmap: BigInt(0) };

  // Phase 1: Sequential send seq=1..100
  let sequentialAccepted = 0;
  for (let seq = 1; seq <= 100; seq++) {
    if (checkReplay(window, seq) === 'accept') sequentialAccepted++;
  }
  record(
    'Sequential Accept',
    'Rate',
    sequentialAccepted / 100,
    '= 1.0',
    sequentialAccepted === 100,
    `${sequentialAccepted}/100`,
  );

  // Phase 2: Replay within window — seq=50 (diff=100-50=50 < 64, should be seen)
  const replayInWindow = checkReplay(window, 50);
  record(
    'Replay seq=50 (within window)',
    'Detected',
    replayInWindow === 'reject' ? 1 : 0,
    '= 1',
    replayInWindow === 'reject',
  );

  // Phase 3: Replay latest — seq=99
  const replayLatest = checkReplay(window, 99);
  record(
    'Replay seq=99 (recent)',
    'Detected',
    replayLatest === 'reject' ? 1 : 0,
    '= 1',
    replayLatest === 'reject',
  );

  // Phase 4: Too old — seq=30 (diff=100-30=70 >= 64)
  const tooOld = checkReplay(window, 30);
  record(
    'Too-old seq=30 (diff=70>64)',
    'Rejected',
    tooOld === 'reject' ? 1 : 0,
    '= 1',
    tooOld === 'reject',
  );

  // Phase 5: Out-of-order new messages
  let outOfOrderAccepted = 0;
  const outOfOrder = [102, 101, 105, 103];
  for (const seq of outOfOrder) {
    if (checkReplay(window, seq) === 'accept') outOfOrderAccepted++;
  }
  record(
    'Out-of-order Accept',
    'Rate',
    outOfOrderAccepted / outOfOrder.length,
    '= 1.0',
    outOfOrderAccepted === outOfOrder.length,
    `seqs: [${outOfOrder.join(',')}]`,
  );

  // Phase 6: Systematic replay test — replay all 1..100 again
  let replayAllRejected = 0;
  for (let seq = 1; seq <= 100; seq++) {
    if (checkReplay(window, seq) === 'reject') replayAllRejected++;
  }
  // Some old ones (seq 1..36) are outside window, also rejected
  record(
    'Full Replay Rejection (1..100)',
    'Rate',
    replayAllRejected / 100,
    '= 1.0',
    replayAllRejected === 100,
    `${replayAllRejected}/100`,
  );

  // Phase 7: Serialization roundtrip
  const serialized = serializeReplayWindow(window);
  const deserialized = deserializeReplayWindow(serialized);
  const roundtripOk = deserialized.highestSeq === window.highestSeq &&
    deserialized.windowBitmap === window.windowBitmap;
  record(
    'Serialization Roundtrip',
    'Correct',
    roundtripOk ? 1 : 0,
    '= 1',
    roundtripOk,
  );

  // Phase 8: Edge case — seq=0 and negative
  const seqZero = checkReplay({ highestSeq: 0, windowBitmap: BigInt(0) }, 0);
  const seqNeg = checkReplay({ highestSeq: 0, windowBitmap: BigInt(0) }, -1);
  const edgeCasesRejected = (seqZero === 'reject' ? 1 : 0) + (seqNeg === 'reject' ? 1 : 0);
  record(
    'Edge Cases (seq=0, seq=-1)',
    'Rejection Rate',
    edgeCasesRejected / 2,
    '= 1.0',
    edgeCasesRejected === 2,
  );
}

// ─── Test 3: Clock Skew Boundary ─────────────────────────────

function benchClockSkew() {
  console.log('\n=== 3. Clock Skew Boundary Test ===');

  const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

  // Simulate server-side check: |now - createdAt| > 5min → reject
  function checkSkew(skewMs: number): boolean {
    const now = Date.now();
    const createdAt = now - skewMs;
    return Math.abs(now - createdAt) <= MAX_CLOCK_SKEW_MS;
  }

  const cases: { label: string; skewMs: number; shouldAccept: boolean }[] = [
    { label: 'skew=0s', skewMs: 0, shouldAccept: true },
    { label: 'skew=+60s', skewMs: 60_000, shouldAccept: true },
    { label: 'skew=+4m59s', skewMs: 4 * 60_000 + 59_000, shouldAccept: true },
    { label: 'skew=+5m0s', skewMs: 5 * 60_000, shouldAccept: true },
    { label: 'skew=+5m1s', skewMs: 5 * 60_000 + 1000, shouldAccept: false },
    { label: 'skew=+10m', skewMs: 10 * 60_000, shouldAccept: false },
    { label: 'skew=-60s (future)', skewMs: -60_000, shouldAccept: true },
    { label: 'skew=-4m59s (future)', skewMs: -(4 * 60_000 + 59_000), shouldAccept: true },
    { label: 'skew=-5m1s (future)', skewMs: -(5 * 60_000 + 1000), shouldAccept: false },
  ];

  let correctCount = 0;
  for (const c of cases) {
    const result = checkSkew(c.skewMs);
    if (result === c.shouldAccept) correctCount++;
  }

  record(
    'Clock Skew Boundary',
    'Accuracy',
    correctCount / cases.length,
    '= 1.0',
    correctCount === cases.length,
    `${correctCount}/${cases.length} boundary cases correct`,
  );
}

// ─── Test 4: Verification Throughput ─────────────────────────

function benchThroughput() {
  console.log('\n=== 4. Verification Throughput ===');

  const { publicKey, privateKey } = generateKeyPair();
  const COUNT = 10_000;

  // Pre-generate signed messages
  const messages: ReturnType<typeof makeSignedMessage>[] = [];
  const genStart = performance.now();
  for (let i = 0; i < COUNT; i++) {
    messages.push(
      makeSignedMessage(privateKey, publicKey, {
        sequence: i + 1,
        content: `Throughput test message #${i}`,
      }),
    );
  }
  const genElapsed = performance.now() - genStart;
  const genRate = COUNT / (genElapsed / 1000);

  record(
    'Signing Throughput',
    'msgs/sec',
    genRate,
    '≥ 1000',
    genRate >= 1000,
    `${COUNT} messages in ${genElapsed.toFixed(0)}ms`,
  );

  // Verify all
  const verStart = performance.now();
  let verified = 0;
  for (const msg of messages) {
    if (verifyLocally(msg)) verified++;
  }
  const verElapsed = performance.now() - verStart;
  const verRate = COUNT / (verElapsed / 1000);

  record(
    'Verification Throughput',
    'msgs/sec',
    verRate,
    '≥ 500',
    verRate >= 500,
    `${verified}/${COUNT} verified in ${verElapsed.toFixed(0)}ms`,
  );

  // Content hash throughput
  const hashStart = performance.now();
  for (let i = 0; i < COUNT; i++) {
    computeContentHash(`Hash throughput test message #${i}`);
  }
  const hashElapsed = performance.now() - hashStart;
  const hashRate = COUNT / (hashElapsed / 1000);

  record(
    'Content Hash Throughput',
    'hashes/sec',
    hashRate,
    '≥ 50000',
    hashRate >= 50_000,
    `${COUNT} hashes in ${hashElapsed.toFixed(0)}ms`,
  );
}

// ─── Test 5: Hash Chain Integrity ────────────────────────────

function benchHashChain() {
  console.log('\n=== 5. Hash Chain Integrity ===');

  // Build a chain of 10 audit entries
  const entries: Array<{
    imUserId: string;
    action: string;
    publicKey: string;
    keyId: string;
    createdAt: string;
    prevLogHash: string | null;
    logHash: string;
  }> = [];

  const userId = 'user_chain_test';
  const { publicKey } = generateKeyPair();
  const keyId = deriveKeyId(publicKey);

  let prevHash: string | null = null;
  for (let i = 0; i < 10; i++) {
    const entry = {
      imUserId: userId,
      action: i === 0 ? 'register' : 'sign',
      publicKey,
      keyId,
      createdAt: new Date(Date.now() + i * 1000).toISOString(),
      prevLogHash: prevHash,
    };
    const logHash = computeAuditLogHash(entry);
    entries.push({ ...entry, logHash });
    prevHash = logHash;
  }

  // Verify complete chain
  function verifyChain(chain: typeof entries): boolean {
    for (let i = 0; i < chain.length; i++) {
      const expectedHash = computeAuditLogHash({
        imUserId: chain[i].imUserId,
        action: chain[i].action,
        publicKey: chain[i].publicKey,
        keyId: chain[i].keyId,
        createdAt: chain[i].createdAt,
        prevLogHash: chain[i].prevLogHash,
      });
      if (expectedHash !== chain[i].logHash) return false;
      if (i > 0 && chain[i].prevLogHash !== chain[i - 1].logHash) return false;
    }
    return true;
  }

  // Normal chain
  const normalOk = verifyChain(entries);
  record('Normal Chain', 'Integrity', normalOk ? 1 : 0, '= 1', normalOk);

  // Tampered entry: modify content of entry 5
  const tampered1 = entries.map((e, i) =>
    i === 5 ? { ...e, action: 'revoke' } : { ...e },
  );
  const tamper1Detected = !verifyChain(tampered1);
  record('Tampered Entry', 'Detected', tamper1Detected ? 1 : 0, '= 1', tamper1Detected);

  // Deleted entry: remove entry 5
  const deleted = [...entries.slice(0, 5), ...entries.slice(6)];
  const deleteDetected = !verifyChain(deleted);
  record('Deleted Entry', 'Detected', deleteDetected ? 1 : 0, '= 1', deleteDetected);

  // Appended forged entry
  const forged = [...entries, {
    imUserId: userId,
    action: 'register',
    publicKey,
    keyId,
    createdAt: new Date().toISOString(),
    prevLogHash: 'fake_hash_000',
    logHash: 'fake_hash_001',
  }];
  const forgedDetected = !verifyChain(forged);
  record('Forged Append', 'Detected', forgedDetected ? 1 : 0, '= 1', forgedDetected);

  // Reordered entries: swap entries 3 and 4
  const reordered = [...entries];
  [reordered[3], reordered[4]] = [reordered[4], reordered[3]];
  const reorderDetected = !verifyChain(reordered);
  record('Reordered Entries', 'Detected', reorderDetected ? 1 : 0, '= 1', reorderDetected);
}

// ─── Test 6: Key ID Collision ────────────────────────────────

function benchKeyIdCollision() {
  console.log('\n=== 6. Key ID Collision Test (empirical) ===');

  const NUM_KEYS = 10_000;
  const keyIds = new Set<string>();
  let collisions = 0;

  for (let i = 0; i < NUM_KEYS; i++) {
    const { publicKey } = generateKeyPair();
    const keyId = deriveKeyId(publicKey);
    if (keyIds.has(keyId)) {
      collisions++;
    }
    keyIds.add(keyId);
  }

  const collisionRate = collisions / NUM_KEYS;
  // Birthday paradox: P(collision) ≈ n²/(2×2^64) ≈ 10^8/(2×1.8×10^19) ≈ 2.7×10^-12
  // With 10K keys: ~0 expected collisions
  record(
    'Key ID Collision',
    'Collision Rate',
    collisionRate,
    '< 1e-5',
    collisionRate < 1e-5,
    `${collisions} collisions in ${NUM_KEYS} keys (2^64 space)`,
  );

  // Verify key ID length
  const { publicKey: testPub } = generateKeyPair();
  const testKeyId = deriveKeyId(testPub);
  const lengthOk = testKeyId.length === 16;
  record(
    'Key ID Length',
    'Correct (16 hex)',
    lengthOk ? 1 : 0,
    '= 1',
    lengthOk,
    `got: ${testKeyId.length} chars`,
  );
}

// ─── Report ──────────────────────────────────────────────────

function printReport() {
  console.log('\n' + '='.repeat(60));
  console.log('  E2E Signing Benchmark Report');
  console.log('='.repeat(60));

  console.log('\n┌────────────────────────────────┬────────────────┬──────────┬────────┐');
  console.log('│ Test                           │ Metric         │ Value    │ Status │');
  console.log('├────────────────────────────────┼────────────────┼──────────┼────────┤');

  for (const r of results) {
    const name = r.name.padEnd(30).substring(0, 30);
    const metric = r.metric.padEnd(14).substring(0, 14);
    const value = r.value.toFixed(4).padStart(8);
    const status = r.pass ? ' PASS ' : ' FAIL ';
    console.log(`│ ${name} │ ${metric} │ ${value} │ ${status} │`);
  }

  console.log('└────────────────────────────────┴────────────────┴──────────┴────────┘');
  console.log(`\nTotal: ${passedTests}/${totalTests} passed`);

  if (passedTests < totalTests) {
    console.log('\nFailed tests:');
    for (const r of results) {
      if (!r.pass) {
        console.log(`  - ${r.name}: ${r.metric} = ${r.value.toFixed(4)} (expected ${r.target})`);
      }
    }
  }
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log('=' .repeat(60));
  console.log('  Prismer IM — E2E Signing Benchmark');
  console.log('  Pure cryptographic correctness (no external deps)');
  console.log('=' .repeat(60));

  benchCorrectnessMatrix();
  benchReplayWindow();
  benchClockSkew();
  benchThroughput();
  benchHashChain();
  benchKeyIdCollision();

  printReport();
  process.exit(passedTests < totalTests ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
