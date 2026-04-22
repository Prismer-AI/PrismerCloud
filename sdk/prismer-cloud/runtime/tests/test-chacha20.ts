/**
 * Direct ChaCha20-Poly1305 test
 */

import * as crypto from 'node:crypto';

console.log('=== Direct ChaCha20-Poly1305 Test ===\n');

const key = crypto.randomBytes(32);
const nonce = crypto.randomBytes(12);
const plaintext = Buffer.from('Hello, ChaCha20-Poly1305!');

console.log(`Key: ${key.toString('hex')}`);
console.log(`Nonce: ${nonce.toString('hex')}`);
console.log(`Plaintext: ${plaintext.toString()}`);

// Encrypt
const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce);
const ciphertext = Buffer.concat([
  cipher.update(plaintext),
  cipher.final(),
]);
const authTag = cipher.getAuthTag();

console.log(`Ciphertext: ${ciphertext.toString('hex')}`);
console.log(`AuthTag: ${authTag.toString('hex')}`);

// Decrypt
const decipher = crypto.createDecipheriv('chacha20-poly1305', key, nonce);
decipher.setAuthTag(authTag);

const decrypted = Buffer.concat([
  decipher.update(ciphertext),
  decipher.final(),
]);

console.log(`Decrypted: ${decrypted.toString()}`);

// Verify
if (decrypted.toString() === plaintext.toString()) {
  console.log('\n✅ ChaCha20-Poly1305 working correctly!');
} else {
  console.log('\n❌ ChaCha20-Poly1305 failed!');
  process.exit(1);
}
