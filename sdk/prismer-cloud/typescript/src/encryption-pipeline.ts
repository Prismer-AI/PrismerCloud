/**
 * Encryption Pipeline — wraps message send/receive with automatic E2E.
 *
 * This is a HELPER module — it does not modify existing client behavior.
 * Users opt-in by calling pipeline functions explicitly before send / after receive.
 *
 * Usage:
 *   import { E2EEncryption } from '@prismer/sdk';
 *   import { encryptForSend, decryptOnReceive } from '@prismer/sdk';
 *
 *   const e2e = new E2EEncryption();
 *   await e2e.init('passphrase');
 *   await e2e.generateSessionKey('conv-123');
 *
 *   // Before sending
 *   const enc = await encryptForSend(e2e, 'conv-123', 'Hello!');
 *   await client.im.messages.send('conv-123', enc.content, { metadata: enc.metadata });
 *
 *   // After receiving
 *   const dec = await decryptOnReceive(e2e, msg.conversationId, msg.content, msg.metadata);
 *   if (dec.decrypted) console.log('Plaintext:', dec.content);
 */

import type { E2EEncryption } from './encryption';

// ============================================================================
// Types
// ============================================================================

export interface EncryptedMessage {
  content: string;
  metadata: Record<string, unknown>;
}

export interface DecryptResult {
  content: string;
  decrypted: boolean;
  error?: string;
}

export interface EncryptedFileResult {
  data: string;
  metadata: { encrypted: true; encKeyId: string };
}

export interface EncryptedContextResult {
  content: string;
  encrypted: true;
}

// ============================================================================
// Message encryption
// ============================================================================

/**
 * Encrypt a message before sending.
 * Returns modified content + metadata with encrypted flag.
 *
 * If no session key exists for the conversation, returns plaintext unchanged.
 */
export async function encryptForSend(
  e2e: E2EEncryption,
  conversationId: string,
  content: string,
  metadata?: Record<string, unknown>,
): Promise<EncryptedMessage> {
  if (!e2e.hasSessionKey(conversationId)) {
    // No session key — send plaintext
    return { content, metadata: metadata ?? {} };
  }
  const ciphertext = await e2e.encrypt(conversationId, content);
  return {
    content: ciphertext,
    metadata: { ...metadata, encrypted: true, encKeyId: `conv-${conversationId}` },
  };
}

/**
 * Decrypt a received message.
 * Returns the plaintext content, or the original content if:
 * - The message is not encrypted (metadata.encrypted !== true)
 * - No session key is available for the conversation
 * - Decryption fails (returns original content + error string)
 */
export async function decryptOnReceive(
  e2e: E2EEncryption,
  conversationId: string,
  content: string,
  metadata?: Record<string, unknown>,
): Promise<DecryptResult> {
  if (!metadata?.encrypted) {
    return { content, decrypted: false };
  }
  if (!e2e.hasSessionKey(conversationId)) {
    return { content, decrypted: false, error: 'no_session_key' };
  }
  try {
    const plain = await e2e.decrypt(conversationId, content);
    return { content: plain, decrypted: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content, decrypted: false, error: message };
  }
}

// ============================================================================
// File encryption
// ============================================================================

/**
 * Encrypt a file buffer before upload.
 *
 * Converts the file bytes to base64, encrypts as text using the conversation
 * session key, and returns the ciphertext string + metadata.
 *
 * Returns null if no session key exists for the conversation.
 *
 * Note: File size increases ~33% due to base64 encoding + GCM overhead.
 * The server stores opaque bytes and cannot inspect the content.
 */
export async function encryptFile(
  e2e: E2EEncryption,
  conversationId: string,
  data: Uint8Array,
): Promise<EncryptedFileResult | null> {
  if (!e2e.hasSessionKey(conversationId)) return null;

  // Convert to base64 string, then encrypt as text
  const b64 = typeof Buffer !== 'undefined'
    ? Buffer.from(data).toString('base64')
    : uint8ArrayToBase64(data);

  const ciphertext = await e2e.encrypt(conversationId, b64);
  return {
    data: ciphertext,
    metadata: { encrypted: true, encKeyId: `conv-${conversationId}` },
  };
}

/**
 * Decrypt a file that was encrypted with encryptFile().
 *
 * Returns the original file bytes, or null if no session key or decryption fails.
 */
export async function decryptFile(
  e2e: E2EEncryption,
  conversationId: string,
  ciphertext: string,
): Promise<Uint8Array | null> {
  if (!e2e.hasSessionKey(conversationId)) return null;
  try {
    const b64 = await e2e.decrypt(conversationId, ciphertext);
    if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(b64, 'base64'));
    }
    return base64ToUint8Array(b64);
  } catch {
    return null;
  }
}

// ============================================================================
// Context cache encryption
// ============================================================================

/**
 * Encrypt context cache content (HQCC) before saving.
 *
 * Uses a special context ID for key management (default: 'context-cache').
 * The agent must have a session key for this context ID — generate one with:
 *   await e2e.generateSessionKey('context-cache');
 *
 * Returns null if no session key exists.
 *
 * Note: Encrypted context CANNOT be server-side compressed or indexed.
 * The HQCC field becomes opaque. Agents must handle their own compression
 * before encryption.
 */
export async function encryptContext(
  e2e: E2EEncryption,
  content: string,
  contextId: string = 'context-cache',
): Promise<EncryptedContextResult | null> {
  if (!e2e.hasSessionKey(contextId)) return null;
  const ciphertext = await e2e.encrypt(contextId, content);
  return { content: ciphertext, encrypted: true };
}

/**
 * Decrypt context cache content that was encrypted with encryptContext().
 *
 * Returns the plaintext HQCC, or null if no session key or decryption fails.
 */
export async function decryptContext(
  e2e: E2EEncryption,
  ciphertext: string,
  contextId: string = 'context-cache',
): Promise<string | null> {
  if (!e2e.hasSessionKey(contextId)) return null;
  try {
    return await e2e.decrypt(contextId, ciphertext);
  } catch {
    return null;
  }
}

// ============================================================================
// Batch helpers
// ============================================================================

/**
 * Decrypt an array of messages in-place (mutates the array).
 * Useful for processing message history after fetching.
 *
 * Returns the count of successfully decrypted messages.
 */
export async function decryptMessages<
  T extends { conversationId?: string; content: string; metadata?: Record<string, unknown> },
>(
  e2e: E2EEncryption,
  messages: T[],
  conversationId?: string,
): Promise<{ decryptedCount: number; errors: Array<{ index: number; error: string }> }> {
  let decryptedCount = 0;
  const errors: Array<{ index: number; error: string }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const convId = conversationId ?? msg.conversationId;
    if (!convId) continue;

    const result = await decryptOnReceive(e2e, convId, msg.content, msg.metadata);
    if (result.decrypted) {
      msg.content = result.content;
      if (msg.metadata) {
        (msg.metadata as Record<string, unknown>)._decrypted = true;
      }
      decryptedCount++;
    } else if (result.error) {
      errors.push({ index: i, error: result.error });
    }
  }

  return { decryptedCount, errors };
}

// ============================================================================
// Internal helpers (base64 for browser environments without Buffer)
// ============================================================================

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
