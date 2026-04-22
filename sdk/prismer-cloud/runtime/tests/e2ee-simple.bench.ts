/**
 * Simple E2EE test to verify basic functionality
 */

import {
  generateKeyPair,
  createE2EEContext,
  encryptMessage,
  decryptMessage,
} from '../src/e2ee-crypto';

console.log('=== Simple E2EE Test ===\n');

// Generate keypairs
const daemonKeys = generateKeyPair();
const clientKeys = generateKeyPair();

// Create contexts
const daemonContext = createE2EEContext(daemonKeys, clientKeys.publicKey);
const clientContext = createE2EEContext(clientKeys, daemonKeys.publicKey);

console.log('Contexts created:');
console.log(`  daemon.sharedSecret: ${daemonContext.sharedSecret.toString('hex').substring(0, 16)}...`);
console.log(`  daemon.sendKey: ${daemonContext.sendKey.toString('hex').substring(0, 16)}...`);
console.log(`  daemon.recvKey: ${daemonContext.recvKey.toString('hex').substring(0, 16)}...`);
console.log(`  client.sharedSecret: ${clientContext.sharedSecret.toString('hex').substring(0, 16)}...`);
console.log(`  client.sendKey: ${clientContext.sendKey.toString('hex').substring(0, 16)}...`);
console.log(`  client.recvKey: ${clientContext.recvKey.toString('hex').substring(0, 16)}...`);

// Verify shared secrets are the same (this is CORRECT for ECDH)
if (!daemonContext.sharedSecret.equals(clientContext.sharedSecret)) {
  console.log('\n❌ ERROR: Shared secrets should be the same for ECDH!');
  process.exit(1);
}

console.log('✅ Shared secrets are the same (correct for ECDH)');

// Verify send and recv keys are different
if (daemonContext.sendKey.equals(daemonContext.recvKey)) {
  console.log('\n❌ ERROR: Daemon send and recv keys are the same!');
  process.exit(1);
}

if (clientContext.sendKey.equals(clientContext.recvKey)) {
  console.log('\n❌ ERROR: Client send and recv keys are the same!');
  process.exit(1);
}

console.log('✅ Send and recv keys are different (correct)');

// Test message from daemon → client
const plaintext1 = Buffer.from('Hello from daemon!');
console.log('\nTest 1: Daemon → Client');
console.log(`  Plaintext: ${plaintext1.toString()}`);

// Encrypt with daemon context (using daemon.sendKey)
console.log('  Encrypting with daemon.sendKey...');
console.log(`  daemon.sendNonce before: ${daemonContext.sendNonce.toString('hex')}`);
const encrypted1 = encryptMessage(daemonContext, plaintext1);
console.log(`  daemon.sendNonce after: ${daemonContext.sendNonce.toString('hex')}`);
console.log(`  Encrypted length: ${encrypted1.length} bytes`);

// Inspect envelope
import { deserializeEnvelope } from '../src/e2ee-crypto';
const envelope1 = deserializeEnvelope(encrypted1);
console.log(`  Envelope nonce (24 bytes): ${envelope1.nonce.toString('hex')}`);
console.log(`  Envelope nonce (12 bytes): ${envelope1.nonce.slice(0, 12).toString('hex')}`);
console.log(`  Envelope authTag: ${envelope1.authTag.toString('hex')}`);

// Decrypt with client context (using client.recvKey)
console.log('  Decrypting with client.recvKey...');
console.log(`  client.recvNonce before: ${clientContext.recvNonce.toString('hex')}`);
const decrypted1 = decryptMessage(clientContext, encrypted1);
console.log(`  client.recvNonce after: ${clientContext.recvNonce.toString('hex')}`);
console.log(`  Decrypted: ${decrypted1.toString()}`);

// Verify
if (decrypted1.toString() !== plaintext1.toString()) {
  console.log('\n❌ Test 1 failed!');
  process.exit(1);
}

// Test message from client → daemon
const plaintext2 = Buffer.from('Hello from client!');
console.log('\nTest 2: Client → Daemon');
console.log(`  Plaintext: ${plaintext2.toString()}`);

// Encrypt with client context (using client.sendKey)
console.log('  Encrypting with client.sendKey...');
console.log(`  client.sendNonce before: ${clientContext.sendNonce.toString('hex')}`);
const encrypted2 = encryptMessage(clientContext, plaintext2);
console.log(`  client.sendNonce after: ${clientContext.sendNonce.toString('hex')}`);
console.log(`  Encrypted length: ${encrypted2.length} bytes`);

// Decrypt with daemon context (using daemon.recvKey)
console.log('  Decrypting with daemon.recvKey...');
console.log(`  daemon.recvNonce before: ${daemonContext.recvNonce.toString('hex')}`);
const decrypted2 = decryptMessage(daemonContext, encrypted2);
console.log(`  daemon.recvNonce after: ${daemonContext.recvNonce.toString('hex')}`);
console.log(`  Decrypted: ${decrypted2.toString()}`);

// Verify
if (decrypted2.toString() !== plaintext2.toString()) {
  console.log('\n❌ Test 2 failed!');
  process.exit(1);
}

console.log('\n✅ E2EE encryption/decryption working correctly!');

