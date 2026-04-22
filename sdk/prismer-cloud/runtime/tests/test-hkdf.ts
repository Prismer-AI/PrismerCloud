/**
 * Test HKDF with different info parameters
 */

import { deriveSharedSecret } from '../src/e2ee-crypto';
import * as crypto from 'node:crypto';

const HKDF_INFO_SEND = Buffer.from('prismer-lan-send');
const HKDF_INFO_RECV = Buffer.from('prismer-lan-recv');

console.log('=== HKDF Test ===\n');

// Test data
const sharedSecret = crypto.randomBytes(32);
console.log(`Shared secret: ${sharedSecret.toString('hex')}`);

// Manual HKDF-SHA256 implementation
function hkdfSha256(ikm, salt, info, length) {
  // Extract
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();

  // Expand
  const t = [];
  let outputLength = 0;
  let i = 1;

  while (outputLength < length) {
    const hmac = crypto.createHmac('sha256', prk);

    if (t.length > 0) {
      hmac.update(t[t.length - 1]);
    }

    hmac.update(info);
    hmac.update(Buffer.from([i]));
    const t_i = hmac.digest();

    t.push(t_i);
    outputLength += t_i.length;
    i++;
  }

  return Buffer.concat(t).slice(0, length);
}

const salt = Buffer.alloc(0);
const KEY_SIZE = 32;

console.log('\nHKDF with SEND info:');
console.log(`  Info: ${HKDF_INFO_SEND.toString('hex')}`);
const sendKey = hkdfSha256(sharedSecret, salt, HKDF_INFO_SEND, KEY_SIZE);
console.log(`  Result: ${sendKey.toString('hex')}`);

console.log('\nHKDF with RECV info:');
console.log(`  Info: ${HKDF_INFO_RECV.toString('hex')}`);
const recvKey = hkdfSha256(sharedSecret, salt, HKDF_INFO_RECV, KEY_SIZE);
console.log(`  Result: ${recvKey.toString('hex')}`);

if (sendKey.equals(recvKey)) {
  console.log('\n❌ ERROR: Send and recv keys are the same!');
  process.exit(1);
} else {
  console.log('\n✅ Send and recv keys are different (correct)');
}
