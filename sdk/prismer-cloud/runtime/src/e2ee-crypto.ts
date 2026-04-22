/**
 * Prismer Runtime — E2EE Crypto Module (v1.9.0)
 *
 * End-to-end encryption for LAN direct connections.
 * Uses X25519 for key exchange and XSalsa20-Poly1305 for encryption.
 *
 * Security model:
 *   - Daemon and mobile each generate X25519 keypair
 *   - Keys are exchanged via QR code or relay (out-of-band)
 *   - Each session derives unique encryption key via HKDF
 *   - All LAN traffic is encrypted - relay never sees plaintext
 *
 * This implementation uses Node.js built-in crypto module for
 * compatibility and no external dependencies.
 */

import * as crypto from 'node:crypto';

// ============================================================
// Types
// ============================================================

export interface KeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
}

export interface E2EEContext {
  localKeyPair: KeyPair;
  remotePublicKey: Buffer;
  sharedSecret: Buffer;
  sendKey: Buffer;
  recvKey: Buffer;
  sendNonce: Buffer;
  recvNonce: Buffer;
}

export interface EncryptedEnvelope {
  version: number;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

// ============================================================
// Constants
// ============================================================

const KEY_SIZE = 32; // X25519 key size (bytes)
const NONCE_SIZE = 24; // XSalsa20 nonce size (bytes)
const AUTH_TAG_SIZE = 16; // Poly1305 auth tag size (bytes)
// Direction labels for HKDF — peer with smaller public key takes the
// "A" role so both sides agree which side's send key matches which
// side's recv key. The previous SEND/RECV split gave both peers
// identical (sendKey, recvKey) and broke decryption end-to-end.
const HKDF_INFO_A_TO_B = Buffer.from('prismer-lan-a2b');
const HKDF_INFO_B_TO_A = Buffer.from('prismer-lan-b2a');
const PROTOCOL_VERSION = 1;
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

// ============================================================
// Key Generation
// ============================================================

/**
 * Generate X25519 keypair for E2EE
 */
export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pubKeyBuffer = publicKey.export({ type: 'spki', format: 'der' });
  const privKeyBuffer = privateKey.export({ type: 'pkcs8', format: 'der' });

  const pubKeyRaw = extractX25519PublicFromSPKI(pubKeyBuffer);
  const privKeyRaw = extractX25519PrivateFromPKCS8(privKeyBuffer);

  return {
    publicKey: pubKeyRaw,
    privateKey: privKeyRaw,
  };
}

/**
 * Extract raw X25519 public key from SPKI format
 */
function extractX25519PublicFromSPKI(spki: Buffer): Buffer {
  if (
    spki.length !== X25519_SPKI_PREFIX.length + KEY_SIZE ||
    !spki.subarray(0, X25519_SPKI_PREFIX.length).equals(X25519_SPKI_PREFIX)
  ) {
    throw new Error('Invalid X25519 SPKI format');
  }

  const key = spki.subarray(X25519_SPKI_PREFIX.length);

  if (key.length !== KEY_SIZE) {
    throw new Error(`Invalid X25519 public key size: ${key.length}`);
  }

  return key;
}

/**
 * Extract raw X25519 private key from PKCS8 format
 */
function extractX25519PrivateFromPKCS8(pkcs8: Buffer): Buffer {
  if (
    pkcs8.length !== X25519_PKCS8_PREFIX.length + KEY_SIZE ||
    !pkcs8.subarray(0, X25519_PKCS8_PREFIX.length).equals(X25519_PKCS8_PREFIX)
  ) {
    throw new Error('Invalid X25519 PKCS8 format');
  }

  const key = pkcs8.subarray(X25519_PKCS8_PREFIX.length);

  if (key.length !== KEY_SIZE) {
    throw new Error(`Invalid X25519 private key size: ${key.length}`);
  }

  return key;
}

/**
 * Derive shared secret from local private key and remote public key (X25519)
 */
export function deriveSharedSecret(
  localPrivateKey: Buffer,
  remotePublicKey: Buffer
): Buffer {
  if (localPrivateKey.length !== KEY_SIZE) {
    throw new Error(`Invalid local private key size: ${localPrivateKey.length}`);
  }
  if (remotePublicKey.length !== KEY_SIZE) {
    throw new Error(`Invalid remote public key size: ${remotePublicKey.length}`);
  }

  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, localPrivateKey]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, remotePublicKey]),
    format: 'der',
    type: 'spki',
  });
  const sharedSecret = crypto.diffieHellman({ privateKey, publicKey });

  if (sharedSecret.length !== KEY_SIZE) {
    throw new Error(`Invalid shared secret size: ${sharedSecret.length}`);
  }

  return sharedSecret;
}

// ============================================================
// Session Key Derivation
// ============================================================

/**
 * Derive send/recv keys from shared secret using HKDF-SHA256.
 *
 * Role is determined by lexicographic comparison of the two public keys
 * so both peers agree without an explicit role flag. Without the keys
 * (legacy single-context callers), defaults to the "A" role.
 */
export function deriveSessionKeys(
  sharedSecret: Buffer,
  localPublicKey?: Buffer,
  remotePublicKey?: Buffer
): {
  sendKey: Buffer;
  recvKey: Buffer;
} {
  const isA =
    localPublicKey === undefined ||
    remotePublicKey === undefined ||
    Buffer.compare(localPublicKey, remotePublicKey) < 0;

  const sendInfo = isA ? HKDF_INFO_A_TO_B : HKDF_INFO_B_TO_A;
  const recvInfo = isA ? HKDF_INFO_B_TO_A : HKDF_INFO_A_TO_B;

  const sendKey = hkdfSha256(sharedSecret, Buffer.alloc(0), sendInfo, KEY_SIZE);
  const recvKey = hkdfSha256(sharedSecret, Buffer.alloc(0), recvInfo, KEY_SIZE);

  return { sendKey, recvKey };
}

/**
 * HKDF-SHA256 key derivation
 */
function hkdfSha256(
  ikm: Buffer,
  salt: Buffer,
  info: Buffer,
  length: number
): Buffer {
  // Extract
  const prk = crypto
    .createHmac('sha256', salt)
    .update(ikm)
    .digest();

  // Expand
  const t: Buffer[] = [];
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

// ============================================================
// Encryption / Decryption
// ============================================================

/**
 * Encrypt data using ChaCha20-Poly1305 (AEAD)
 * Node.js built-in crypto supports this via crypto.createCipheriv('chacha20-poly1305')
 */
export function encrypt(
  key: Buffer,
  plaintext: Buffer,
  nonce?: Buffer
): EncryptedEnvelope {
  if (key.length !== KEY_SIZE) {
    throw new Error(`Invalid key size: ${key.length}`);
  }

  // Generate random nonce if not provided
  const iv = nonce || crypto.randomBytes(NONCE_SIZE);

  // ChaCha20-Poly1305: 32-byte key, 12-byte nonce
  // We truncate our 24-byte nonce to 12 bytes for ChaCha20-Poly1305
  const chachaNonce = iv.slice(0, 12);

  const cipher = crypto.createCipheriv('chacha20-poly1305', key, chachaNonce);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return {
    version: PROTOCOL_VERSION,
    nonce: iv,
    ciphertext,
    authTag,
  };
}

/**
 * Decrypt data using ChaCha20-Poly1305
 */
export function decrypt(
  key: Buffer,
  envelope: EncryptedEnvelope
): Buffer {
  if (key.length !== KEY_SIZE) {
    throw new Error(`Invalid key size: ${key}`);
  }
  if (envelope.nonce.length !== NONCE_SIZE) {
    throw new Error(`Invalid nonce size: ${envelope.nonce.length}`);
  }
  if (envelope.authTag.length !== AUTH_TAG_SIZE) {
    throw new Error(`Invalid auth tag size: ${envelope.authTag}`);
  }

  // Truncate nonce for ChaCha20-Poly1305
  const chachaNonce = envelope.nonce.slice(0, 12);

  const decipher = crypto.createDecipheriv('chacha20-poly1305', key, chachaNonce);
  decipher.setAuthTag(envelope.authTag);

  try {
    const plaintext = Buffer.concat([
      decipher.update(envelope.ciphertext),
      decipher.final(),
    ]);
    return plaintext;
  } catch (err) {
    throw new Error(`Decryption failed: ${(err as Error).message}`);
  }
}

/**
 * Serialize encrypted envelope to buffer
 */
export function serializeEnvelope(envelope: EncryptedEnvelope): Buffer {
  const version = Buffer.from([envelope.version]);
  const nonceLen = Buffer.from([NONCE_SIZE]);
  const authTagLen = Buffer.from([AUTH_TAG_SIZE]);
  const ciphertextLen = Buffer.alloc(4);
  ciphertextLen.writeUInt32BE(envelope.ciphertext.length, 0);

  return Buffer.concat([
    version,
    nonceLen,
    authTagLen,
    ciphertextLen,
    envelope.nonce,
    envelope.authTag,
    envelope.ciphertext,
  ]);
}

/**
 * Deserialize encrypted envelope from buffer
 */
export function deserializeEnvelope(data: Buffer): EncryptedEnvelope {
  let offset = 0;

  const version = data[offset];
  offset += 1;

  if (version !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version: ${version}`);
  }

  const nonceLen = data[offset];
  offset += 1;

  const authTagLen = data[offset];
  offset += 1;

  const ciphertextLen = data.readUInt32BE(offset);
  offset += 4;

  if (nonceLen !== NONCE_SIZE) {
    throw new Error(`Invalid nonce length in envelope: ${nonceLen}`);
  }
  if (authTagLen !== AUTH_TAG_SIZE) {
    throw new Error(`Invalid auth tag length in envelope: ${authTagLen}`);
  }

  const nonce = data.slice(offset, offset + nonceLen);
  offset += nonceLen;

  const authTag = data.slice(offset, offset + authTagLen);
  offset += authTagLen;

  const ciphertext = data.slice(offset, offset + ciphertextLen);

  return {
    version,
    nonce,
    ciphertext,
    authTag,
  };
}

// ============================================================
// E2EE Context Management
// ============================================================

/**
 * Create E2EE context for a session
 */
export function createE2EEContext(
  localKeyPair: KeyPair,
  remotePublicKey: Buffer
): E2EEContext {
  // Derive shared secret
  const sharedSecret = deriveSharedSecret(
    localKeyPair.privateKey,
    remotePublicKey
  );

  // Derive session keys with role-aware HKDF (peer with smaller public
  // key takes the "A" role) — see deriveSessionKeys for the rationale.
  const { sendKey, recvKey } = deriveSessionKeys(
    sharedSecret,
    localKeyPair.publicKey,
    remotePublicKey
  );

  // Initialize nonces
  const sendNonce = crypto.randomBytes(NONCE_SIZE);
  const recvNonce = crypto.randomBytes(NONCE_SIZE);

  return {
    localKeyPair,
    remotePublicKey,
    sharedSecret,
    sendKey,
    recvKey,
    sendNonce,
    recvNonce,
  };
}

/**
 * Encrypt message using E2EE context
 */
export function encryptMessage(context: E2EEContext, plaintext: Buffer): Buffer {
  // Increment send nonce BEFORE encrypting (so each message uses unique nonce)
  incrementNonce(context.sendNonce);

  const envelope = encrypt(context.sendKey, plaintext, context.sendNonce);

  return serializeEnvelope(envelope);
}

/**
 * Decrypt message using E2EE context
 */
export function decryptMessage(context: E2EEContext, data: Buffer): Buffer {
  const envelope = deserializeEnvelope(data);

  // Decrypt using recvKey and the nonce from envelope
  // Note: We don't use context.recvNonce - the nonce in envelope
  // is what the sender used for encryption
  const decrypted = decrypt(context.recvKey, envelope);

  return decrypted;
}

/**
 * Increment nonce (simple big-endian increment)
 */
function incrementNonce(nonce: Buffer): void {
  let carry = 1;
  for (let i = nonce.length - 1; i >= 0 && carry > 0; i--) {
    const sum = nonce[i] + carry;
    nonce[i] = sum & 0xff;
    carry = sum >> 8;
  }

  // If carry is still set, nonce wrapped around (should not happen with 24-byte nonce)
  if (carry > 0) {
    throw new Error('Nonce overflow - too many messages in session');
  }
}

// ============================================================
// Key Serialization
// ============================================================

/**
 * Serialize public key to base64
 */
export function serializePublicKey(publicKey: Buffer): string {
  return publicKey.toString('base64');
}

/**
 * Deserialize public key from base64
 */
export function deserializePublicKey(data: string): Buffer {
  return Buffer.from(data, 'base64');
}

/**
 * Serialize keypair to JSON
 */
export function serializeKeyPair(keyPair: KeyPair): {
  publicKey: string;
  privateKey: string;
} {
  return {
    publicKey: serializePublicKey(keyPair.publicKey),
    privateKey: keyPair.privateKey.toString('base64'),
  };
}

/**
 * Deserialize keypair from JSON
 */
export function deserializeKeyPair(data: {
  publicKey: string;
  privateKey: string;
}): KeyPair {
  return {
    publicKey: deserializePublicKey(data.publicKey),
    privateKey: Buffer.from(data.privateKey, 'base64'),
  };
}
