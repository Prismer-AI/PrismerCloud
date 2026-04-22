/**
 * Debug HKDF key derivation
 */

import { generateKeyPair, deriveSharedSecret, deriveSessionKeys } from '../src/e2ee-crypto';

console.log('=== HKDF Debug ===\n');

// Generate keypairs
const daemonKeys = generateKeyPair();
const clientKeys = generateKeyPair();

// Derive shared secret
const sharedSecret = deriveSharedSecret(daemonKeys.privateKey, clientKeys.publicKey);
console.log(`Shared secret: ${sharedSecret.toString('hex')}`);

// Derive session keys
const { sendKey, recvKey } = deriveSessionKeys(sharedSecret);

console.log(`Send key: ${sendKey.toString('hex')}`);
console.log(`Recv key: ${recvKey.toString('hex')}`);

// Check if they're different
if (sendKey.equals(recvKey)) {
  console.log('\n❌ Send and recv keys are the same (should be different)');
} else {
  console.log('\n✅ Send and recv keys are different (correct)');
}
