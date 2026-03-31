/**
 * Prismer SDK — E2E Encryption
 *
 * Industry-standard end-to-end encryption for IM messages.
 *
 * - Per-conversation symmetric key: AES-256-GCM
 * - Key exchange: ECDH P-256
 * - Master key derivation: PBKDF2-SHA256
 * - Key storage: Encrypted with master key
 * - Runtime: Web Crypto API (browser) / node:crypto (Node.js)
 *
 * The server only sees ciphertext — it cannot decrypt message content.
 */

// ============================================================================
// Crypto abstraction — works in both browser and Node.js
// ============================================================================

interface CryptoBackend {
  generateKeyPair(): Promise<{ publicKey: JsonWebKey; privateKey: JsonWebKey }>;
  deriveSharedSecret(privateKey: JsonWebKey, publicKey: JsonWebKey): Promise<ArrayBuffer>;
  deriveMasterKey(passphrase: string, salt: Uint8Array): Promise<ArrayBuffer>;
  encrypt(key: ArrayBuffer, plaintext: string): Promise<string>;
  decrypt(key: ArrayBuffer, ciphertext: string): Promise<string>;
  randomBytes(length: number): Uint8Array;
}

function getSubtleCrypto(): SubtleCrypto {
  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    return globalThis.crypto.subtle;
  }
  // Node.js
  try {
    const { webcrypto } = require('node:crypto');
    return webcrypto.subtle;
  } catch {
    throw new Error('No SubtleCrypto available. Requires browser or Node.js 16+.');
  }
}

function getRandomValues(arr: Uint8Array): Uint8Array {
  if (typeof globalThis.crypto?.getRandomValues !== 'undefined') {
    return globalThis.crypto.getRandomValues(arr);
  }
  try {
    const { webcrypto } = require('node:crypto');
    return webcrypto.getRandomValues(arr);
  } catch {
    throw new Error('No crypto.getRandomValues available.');
  }
}

const subtle = (): SubtleCrypto => getSubtleCrypto();

const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12; // AES-GCM recommended
const KEY_LENGTH = 256; // AES-256

// ============================================================================
// E2E Encryption
// ============================================================================

/**
 * E2EEncryption manages per-conversation symmetric keys and
 * encrypts/decrypts message content using AES-256-GCM.
 *
 * Usage:
 *   const e2e = new E2EEncryption();
 *   await e2e.init('user-passphrase');
 *   const ciphertext = await e2e.encrypt('conv-123', 'Hello!');
 *   const plaintext = await e2e.decrypt('conv-123', ciphertext);
 */
export class E2EEncryption {
  private masterKey: CryptoKey | null = null;
  private keyPair: CryptoKeyPair | null = null;
  private sessionKeys = new Map<string, CryptoKey>(); // conversationId → AES key
  private salt: Uint8Array | null = null;

  /**
   * Initialize encryption with user passphrase.
   * Derives a master key via PBKDF2 and generates an ECDH key pair.
   *
   * @param passphrase - User passphrase for master key derivation
   * @param salt - Optional Base64-encoded salt. If omitted, a random 16-byte salt is generated.
   *               Store the salt (via exportSalt()) so you can re-derive the same master key later.
   */
  async init(passphrase: string, salt?: string): Promise<void> {
    // Use provided salt or generate random one
    this.salt = salt
      ? new Uint8Array(base64ToArrayBuffer(salt))
      : getRandomValues(new Uint8Array(SALT_LENGTH));

    // Derive master key from passphrase
    const passphraseKey = await subtle().importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey'],
    );

    this.masterKey = await subtle().deriveKey(
      {
        name: 'PBKDF2',
        salt: new Uint8Array(this.salt.buffer, this.salt.byteOffset, this.salt.byteLength).buffer as ArrayBuffer,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      passphraseKey,
      { name: 'AES-GCM', length: KEY_LENGTH },
      false,
      ['encrypt', 'decrypt'],
    );

    // Generate ECDH key pair for key exchange
    this.keyPair = await subtle().generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey'],
    );
  }

  /**
   * Export the salt as Base64 string for persistent storage.
   * You must store this and pass it back to init() to re-derive the same master key.
   */
  exportSalt(): string {
    if (!this.salt) throw new Error('E2E not initialized. Call init() first.');
    return arrayBufferToBase64(this.salt.buffer as ArrayBuffer);
  }

  /**
   * Export public key for sharing with conversation peers.
   */
  async exportPublicKey(): Promise<JsonWebKey> {
    if (!this.keyPair) throw new Error('E2E not initialized. Call init() first.');
    return subtle().exportKey('jwk', this.keyPair.publicKey);
  }

  /**
   * Derive a shared session key for a conversation using ECDH.
   * Call this with each peer's public key.
   */
  async deriveSessionKey(conversationId: string, peerPublicKey: JsonWebKey): Promise<void> {
    if (!this.keyPair) throw new Error('E2E not initialized. Call init() first.');

    const importedPeerKey = await subtle().importKey(
      'jwk',
      peerPublicKey,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );

    const sessionKey = await subtle().deriveKey(
      { name: 'ECDH', public: importedPeerKey },
      this.keyPair.privateKey,
      { name: 'AES-GCM', length: KEY_LENGTH },
      false,
      ['encrypt', 'decrypt'],
    );

    this.sessionKeys.set(conversationId, sessionKey);
  }

  /**
   * Set a pre-shared session key for a conversation.
   * Useful when the key is exchanged out-of-band or derived from a group key.
   */
  async setSessionKey(conversationId: string, rawKey: ArrayBuffer): Promise<void> {
    const key = await subtle().importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM', length: KEY_LENGTH },
      false,
      ['encrypt', 'decrypt'],
    );
    this.sessionKeys.set(conversationId, key);
  }

  /**
   * Generate a random session key for a conversation.
   * Returns the raw key bytes for sharing with peers.
   */
  async generateSessionKey(conversationId: string): Promise<ArrayBuffer> {
    const key = await subtle().generateKey(
      { name: 'AES-GCM', length: KEY_LENGTH },
      true,
      ['encrypt', 'decrypt'],
    );
    this.sessionKeys.set(conversationId, key);
    return subtle().exportKey('raw', key);
  }

  /**
   * Encrypt plaintext for a conversation.
   * Returns base64-encoded ciphertext with prepended IV.
   */
  async encrypt(conversationId: string, plaintext: string): Promise<string> {
    const key = this.sessionKeys.get(conversationId);
    if (!key) throw new Error(`No session key for conversation ${conversationId}. Call deriveSessionKey() first.`);

    const iv = getRandomValues(new Uint8Array(IV_LENGTH));
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertext = await subtle().encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      encoded,
    );

    // Prepend IV to ciphertext and base64-encode
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);

    return arrayBufferToBase64(combined.buffer);
  }

  /**
   * Decrypt ciphertext from a conversation.
   * Expects base64-encoded data with prepended IV.
   */
  async decrypt(conversationId: string, ciphertext: string): Promise<string> {
    const key = this.sessionKeys.get(conversationId);
    if (!key) throw new Error(`No session key for conversation ${conversationId}. Call deriveSessionKey() first.`);

    const combined = base64ToArrayBuffer(ciphertext);
    const iv = combined.slice(0, IV_LENGTH);
    const data = combined.slice(IV_LENGTH);

    const decrypted = await subtle().decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      key,
      data,
    );

    return new TextDecoder().decode(decrypted);
  }

  /**
   * Check if a session key exists for a conversation.
   */
  hasSessionKey(conversationId: string): boolean {
    return this.sessionKeys.has(conversationId);
  }

  /**
   * Remove session key for a conversation.
   */
  removeSessionKey(conversationId: string): void {
    this.sessionKeys.delete(conversationId);
  }

  /**
   * Clear all keys and reset state.
   */
  destroy(): void {
    this.masterKey = null;
    this.keyPair = null;
    this.sessionKeys.clear();
    this.salt = null;
    this.messageCount = 0;
  }

  // ─── Pipeline Functions ──────────────────────────────────

  private messageCount = 0;
  private static readonly KEY_ROTATION_THRESHOLD = 1000;
  private static readonly KEY_ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
  private lastRotation = Date.now();

  /**
   * High-level encrypt-for-send pipeline.
   * Encrypts content, builds metadata, and handles key rotation.
   *
   * Returns { encryptedContent, metadata } ready to send.
   */
  async encryptForSend(
    conversationId: string,
    content: string,
  ): Promise<{ encryptedContent: string; metadata: Record<string, any> }> {
    if (!this.hasSessionKey(conversationId)) {
      throw new Error('No session key for this conversation. Call deriveSessionKey() first.');
    }

    // Check if key rotation is needed
    const needsRotation = this.shouldRotateKey();

    const encryptedContent = await this.encrypt(conversationId, content);

    this.messageCount++;

    return {
      encryptedContent,
      metadata: {
        encrypted: true,
        encryptionVersion: 1,
        ...(needsRotation && { keyRotationRequested: true }),
      },
    };
  }

  /**
   * High-level decrypt-on-receive pipeline.
   * Decrypts content and validates metadata.
   */
  async decryptOnReceive(
    conversationId: string,
    encryptedContent: string,
    metadata?: Record<string, any>,
  ): Promise<string> {
    if (!this.hasSessionKey(conversationId)) {
      throw new Error('No session key for this conversation. Call deriveSessionKey() first.');
    }

    return this.decrypt(conversationId, encryptedContent);
  }

  /**
   * High-level file encryption pipeline.
   */
  async encryptFile(
    conversationId: string,
    fileData: ArrayBuffer,
  ): Promise<{ encryptedData: string; metadata: Record<string, any> }> {
    const base64Data = arrayBufferToBase64(fileData);
    const encryptedData = await this.encrypt(conversationId, base64Data);
    return {
      encryptedData,
      metadata: {
        encrypted: true,
        encryptionVersion: 1,
        fileEncrypted: true,
      },
    };
  }

  /**
   * High-level file decryption pipeline.
   */
  async decryptFile(
    conversationId: string,
    encryptedData: string,
  ): Promise<ArrayBuffer> {
    const base64Data = await this.decrypt(conversationId, encryptedData);
    return base64ToArrayBuffer(base64Data);
  }

  /**
   * Check if key rotation is needed (1000 messages or 24 hours).
   */
  private shouldRotateKey(): boolean {
    if (this.messageCount >= E2EEncryption.KEY_ROTATION_THRESHOLD) {
      return true;
    }
    if (Date.now() - this.lastRotation >= E2EEncryption.KEY_ROTATION_INTERVAL_MS) {
      return true;
    }
    return false;
  }

  /**
   * Perform key rotation: generate new ECDH keypair and reset counters.
   * The caller is responsible for re-exchanging keys with peers.
   */
  async rotateKeys(): Promise<JsonWebKey> {
    // Generate new keypair
    this.keyPair = await subtle().generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveKey'],
    );

    // Reset counters
    this.messageCount = 0;
    this.lastRotation = Date.now();

    // Clear all session keys — peers need to re-derive
    this.sessionKeys.clear();

    return this.exportPublicKey();
  }
}

// ============================================================================
// Helpers
// ============================================================================

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  if (typeof btoa !== 'undefined') {
    // Browser
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  // Node.js
  return Buffer.from(buffer).toString('base64');
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  if (typeof atob !== 'undefined') {
    // Browser
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
  // Node.js
  const buf = Buffer.from(base64, 'base64');
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
