/**
 * Test X25519 ECDH directly
 */

import * as crypto from 'node:crypto';
import { generateKeyPair } from '../src/e2ee-crypto';

console.log('=== X25519 ECDH Test ===\n');

// Generate different keypairs
const keypair1 = generateKeyPair();
const keypair2 = generateKeyPair();

console.log('Keypair 1:');
console.log(`  publicKey: ${keypair1.publicKey.toString('hex')}`);
console.log(`  privateKey: ${keypair1.privateKey.toString('hex')}`);

console.log('\nKeypair 2:');
console.log(`  publicKey: ${keypair2.publicKey.toString('hex')}`);
console.log(`  privateKey: ${keypair2.privateKey.toString('hex')}`);

// Derive shared secret 1: keypair1.private * keypair2.public
const shared1 = crypto.diffieHellman({
  privateKey: crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b656e04220420', 'hex'),
      keypair1.privateKey
    ]),
    format: 'der',
    type: 'pkcs8',
  }),
  publicKey: crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b656e032100', 'hex'),
      keypair2.publicKey
    ]),
    format: 'der',
    type: 'spki',
  })
});

console.log('\nShared secret 1 (keypair1.private * keypair2.public):');
console.log(`  ${shared1.toString('hex')}`);

// Derive shared secret 2: keypair2.private * keypair1.public
const shared2 = crypto.diffieHellman({
  privateKey: crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b656e04220420', 'hex'),
      keypair2.privateKey
    ]),
    format: 'der',
    type: 'pkcs8',
  }),
  publicKey: crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b656e032100', 'hex'),
      keypair1.publicKey
    ]),
    format: 'der',
    type: 'spki',
  })
});

console.log('\nShared secret 2 (keypair2.private * keypair1.public):');
console.log(`  ${shared2.toString('hex')}`);

// Verify they're different
if (shared1.equals(shared2)) {
  console.log('\n❌ ERROR: Shared secrets are the same!');
  console.log('This indicates ECDH is not working correctly.');
  process.exit(1);
} else {
  console.log('\n✅ Shared secrets are different (correct)');
}
