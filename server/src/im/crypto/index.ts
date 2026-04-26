/**
 * Prismer IM — Cryptographic utilities for E2E Encryption
 *
 * Layer 1: Ed25519 identity keys, server attestation, key ID derivation
 * Layer 2: Message signing, verification, content hashing
 *
 * Uses @noble/curves (audited by Trail of Bits) for Ed25519 in STRICT RFC 8032 mode.
 * Uses @noble/hashes for SHA-256 and HKDF.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
// ─── Base58btc (inline, avoids ESM-only bs58 dep) ──────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Uint8Array(128).fill(255);
for (let i = 0; i < BASE58_ALPHABET.length; i++) BASE58_MAP[BASE58_ALPHABET.charCodeAt(i)] = i;

const bs58 = {
  encode(bytes: Uint8Array): string {
    if (bytes.length === 0) return '';
    // Count leading zeros
    let zeroCount = 0;
    while (zeroCount < bytes.length && bytes[zeroCount] === 0) zeroCount++;
    // Convert to base58 digits (big-endian → little-endian accumulator)
    const digits: number[] = [];
    for (let i = zeroCount; i < bytes.length; i++) {
      let carry = bytes[i];
      for (let j = 0; j < digits.length; j++) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }
    // Leading '1's for zero bytes + reversed digits
    let str = '1'.repeat(zeroCount);
    for (let i = digits.length - 1; i >= 0; i--) str += BASE58_ALPHABET[digits[i]];
    return str;
  },
  decode(str: string): Uint8Array {
    if (str.length === 0) return new Uint8Array(0);
    // Count leading '1's (each = a 0x00 byte)
    let zeroCount = 0;
    while (zeroCount < str.length && str[zeroCount] === '1') zeroCount++;
    // Convert base58 digits to bytes (big-endian → little-endian accumulator)
    const bytes: number[] = [];
    for (let i = zeroCount; i < str.length; i++) {
      const val = BASE58_MAP[str.charCodeAt(i)];
      if (val === 255) throw new Error(`Invalid base58 character: ${str[i]}`);
      let carry = val;
      for (let j = 0; j < bytes.length; j++) {
        carry += bytes[j] * 58;
        bytes[j] = carry & 0xff;
        carry >>= 8;
      }
      while (carry > 0) {
        bytes.push(carry & 0xff);
        carry >>= 8;
      }
    }
    // Prepend zero bytes + reversed value bytes
    const result = new Uint8Array(zeroCount + bytes.length);
    // result[0..zeroCount-1] already 0 from Uint8Array init
    for (let i = 0; i < bytes.length; i++) result[zeroCount + i] = bytes[bytes.length - 1 - i];
    return result;
  },
};

// ─── Constants ──────────────────────────────────────────────

/** Security protocol version for signed messages */
export const SEC_VERSION = 1;

/** Sliding window size for anti-replay (IPsec-inspired) */
export const REPLAY_WINDOW_SIZE = 64;

// ─── Key Operations ─────────────────────────────────────────

/**
 * Generate a new Ed25519 key pair.
 * Returns Base64-encoded public and private keys.
 */
export function generateKeyPair(): { publicKey: string; privateKey: string } {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return {
    publicKey: Buffer.from(publicKey).toString('base64'),
    privateKey: Buffer.from(privateKey).toString('base64'),
  };
}

/**
 * Derive the key ID from a public key.
 * keyId = hex(SHA-256(publicKeyBytes)[0:8]) → 16 hex chars
 */
export function deriveKeyId(publicKeyBase64: string): string {
  const pubBytes = Buffer.from(publicKeyBase64, 'base64');
  const hash = sha256(pubBytes);
  return bytesToHex(hash.slice(0, 8));
}

/**
 * Validate that a Base64-encoded public key is a valid 32-byte Ed25519 key.
 * Does NOT check if it's a small-order point (signature verification handles that).
 */
export function validatePublicKey(publicKeyBase64: string): boolean {
  try {
    const bytes = Buffer.from(publicKeyBase64, 'base64');
    return bytes.length === 32;
  } catch {
    return false;
  }
}

// ─── Server Attestation ─────────────────────────────────────

/**
 * Create a server attestation: Ed25519.sign(serverKey, userId ‖ publicKey ‖ action ‖ timestamp)
 * This proves the server witnessed and approved the key registration.
 */
export function createAttestation(
  serverPrivateKeyBase64: string,
  userId: string,
  publicKeyBase64: string,
  action: string,
  timestamp: string,
): string {
  const message = `${userId}|${publicKeyBase64}|${action}|${timestamp}`;
  const msgBytes = new TextEncoder().encode(message);
  const privBytes = Buffer.from(serverPrivateKeyBase64, 'base64');
  const sig = ed25519.sign(msgBytes, privBytes);
  return Buffer.from(sig).toString('base64');
}

/**
 * Verify a server attestation.
 */
export function verifyAttestation(
  serverPublicKeyBase64: string,
  attestation: string,
  userId: string,
  publicKeyBase64: string,
  action: string,
  timestamp: string,
): boolean {
  try {
    const message = `${userId}|${publicKeyBase64}|${action}|${timestamp}`;
    const msgBytes = new TextEncoder().encode(message);
    const sigBytes = Buffer.from(attestation, 'base64');
    const pubBytes = Buffer.from(serverPublicKeyBase64, 'base64');
    // STRICT RFC 8032 mode (default in @noble/curves)
    return ed25519.verify(sigBytes, msgBytes, pubBytes);
  } catch {
    return false;
  }
}

// ─── Message Signing ────────────────────────────────────────

/**
 * Compute SHA-256 hash of message content.
 * Returns hex-encoded hash string.
 */
export function computeContentHash(content: string): string {
  const bytes = new TextEncoder().encode(content);
  return bytesToHex(sha256(bytes));
}

/**
 * Build the canonical signing payload for a message.
 * Format: version|senderId|senderKeyId|conversationId|sequence|type|timestamp|contentHash|prevHash
 *
 * This is what gets signed, ensuring all critical header fields are bound.
 */
export function buildSigningPayload(params: {
  secVersion: number;
  senderId: string;
  senderKeyId: string;
  senderDid?: string; // AIP: included in canonical payload when present
  conversationId: string;
  sequence: number;
  type: string;
  timestamp: number;
  contentHash: string;
  prevHash: string | null;
}): Uint8Array {
  const canonical = [
    params.secVersion,
    params.senderId,
    params.senderDid ?? '', // AIP: DID binding (empty string for legacy keyId-only messages)
    params.senderKeyId,
    params.conversationId,
    params.sequence,
    params.type,
    params.timestamp,
    params.contentHash,
    params.prevHash ?? '',
  ].join('|');

  return new TextEncoder().encode(canonical);
}

/**
 * Build a "lite" signing payload for SDK auto-signing (v1.8.0 S1).
 *
 * SDK auto-sign mode cannot include senderId/conversationId/sequence
 * (not available at the SDK request layer). The lite format covers
 * content integrity + sender identity:
 *   secVersion|senderDid|type|timestamp|contentHash
 *
 * Server detects lite mode when senderKeyId is empty and senderDid is set.
 */
export function buildLiteSigningPayload(params: {
  secVersion: number;
  senderDid: string;
  type: string;
  timestamp: number;
  contentHash: string;
}): Uint8Array {
  const canonical = [
    params.secVersion,
    params.senderDid,
    params.type,
    params.timestamp,
    params.contentHash,
  ].join('|');
  return new TextEncoder().encode(canonical);
}

/**
 * Sign a message with Ed25519.
 * Returns Base64-encoded signature (64 bytes).
 */
export function signMessage(privateKeyBase64: string, payload: Uint8Array): string {
  const privBytes = Buffer.from(privateKeyBase64, 'base64');
  const sig = ed25519.sign(payload, privBytes);
  return Buffer.from(sig).toString('base64');
}

/**
 * Verify an Ed25519 message signature (STRICT RFC 8032 mode).
 * Returns true if signature is valid.
 */
export function verifySignature(publicKeyBase64: string, signatureBase64: string, payload: Uint8Array): boolean {
  try {
    const sigBytes = Buffer.from(signatureBase64, 'base64');
    const pubBytes = Buffer.from(publicKeyBase64, 'base64');

    if (sigBytes.length !== 64 || pubBytes.length !== 32) return false;

    // STRICT RFC 8032: rejects non-canonical S, small-order points
    return ed25519.verify(sigBytes, payload, pubBytes);
  } catch {
    return false;
  }
}

// ─── Hash Chain ─────────────────────────────────────────────

/**
 * Compute hash for a key audit log entry (for hash chain).
 * hash = SHA-256(userId|action|publicKey|keyId|timestamp|prevLogHash)
 */
export function computeAuditLogHash(entry: {
  imUserId: string;
  action: string;
  publicKey: string;
  keyId: string;
  createdAt: string;
  prevLogHash: string | null;
}): string {
  const data = [
    entry.imUserId,
    entry.action,
    entry.publicKey,
    entry.keyId,
    entry.createdAt,
    entry.prevLogHash ?? '',
  ].join('|');
  return bytesToHex(sha256(new TextEncoder().encode(data)));
}

// ─── Sliding Window Anti-Replay ─────────────────────────────

export interface ReplayWindowState {
  highestSeq: number;
  windowBitmap: bigint;
}

/**
 * Check if a sequence number should be accepted or rejected.
 * Implements IPsec ESP-style sliding window (RFC 4303).
 *
 * Mutates the window state if accepted.
 * Returns 'accept' or 'reject'.
 */
export function checkReplay(window: ReplayWindowState, seq: number): 'accept' | 'reject' {
  if (seq <= 0) return 'reject';

  if (seq > window.highestSeq) {
    // New highest — shift window
    const shift = seq - window.highestSeq;
    if (shift >= REPLAY_WINDOW_SIZE) {
      window.windowBitmap = BigInt(0);
    } else {
      window.windowBitmap = window.windowBitmap << BigInt(shift);
    }
    window.highestSeq = seq;
    window.windowBitmap |= BigInt(1); // Mark current as seen
    return 'accept';
  }

  const diff = window.highestSeq - seq;
  if (diff >= REPLAY_WINDOW_SIZE) return 'reject'; // Too old

  const bit = BigInt(1) << BigInt(diff);
  if (window.windowBitmap & bit) return 'reject'; // Already seen (replay)

  window.windowBitmap |= bit; // Mark as seen
  return 'accept';
}

/**
 * Serialize ReplayWindowState for JSON storage.
 */
export function serializeReplayWindow(window: ReplayWindowState): { highestSeq: number; windowBitmap: string } {
  return {
    highestSeq: window.highestSeq,
    windowBitmap: window.windowBitmap.toString(),
  };
}

/**
 * Deserialize ReplayWindowState from JSON storage.
 */
export function deserializeReplayWindow(data: { highestSeq?: number; windowBitmap?: string }): ReplayWindowState {
  return {
    highestSeq: data.highestSeq ?? 0,
    windowBitmap: data.windowBitmap ? BigInt(data.windowBitmap) : BigInt(0),
  };
}

// ─── AIP: DID:KEY Encoding ─────────────────────────────────

/** Multicodec prefix for Ed25519 public key (0xed, 0x01) */
const ED25519_MULTICODEC_PREFIX = new Uint8Array([0xed, 0x01]);

/**
 * Encode a Base64 Ed25519 public key as a did:key identifier.
 *
 * did:key encoding (W3C did:key Method v1.0):
 *   1. Take 32-byte Ed25519 public key
 *   2. Prepend Multicodec prefix [0xed, 0x01] → 34 bytes
 *   3. Base58btc encode with Multibase prefix 'z'
 *   4. Prepend "did:key:"
 *
 * Result: did:key:z6Mk<base58-encoded-34-bytes>
 */
export function publicKeyToDIDKey(publicKeyBase64: string): string {
  const pubBytes = Buffer.from(publicKeyBase64, 'base64');
  if (pubBytes.length !== 32) {
    throw new Error(`Invalid Ed25519 public key: expected 32 bytes, got ${pubBytes.length}`);
  }

  // Prepend multicodec prefix
  const multicodecBytes = new Uint8Array(34);
  multicodecBytes.set(ED25519_MULTICODEC_PREFIX, 0);
  multicodecBytes.set(pubBytes, 2);

  // Base58btc encode with 'z' multibase prefix
  const encoded = bs58.encode(multicodecBytes);
  return `did:key:z${encoded}`;
}

/**
 * Decode a did:key identifier back to a Base64 Ed25519 public key.
 *
 * Reverse of publicKeyToDIDKey.
 */
export function didKeyToPublicKey(didKey: string): string {
  if (!didKey.startsWith('did:key:z')) {
    throw new Error(`Invalid did:key format: must start with "did:key:z", got "${didKey.slice(0, 20)}"`);
  }

  // Strip "did:key:z" prefix and decode base58btc
  const encoded = didKey.slice(9); // "did:key:z".length = 9
  const decoded = bs58.decode(encoded);

  if (decoded.length !== 34) {
    throw new Error(`Invalid did:key: decoded to ${decoded.length} bytes, expected 34`);
  }

  // Verify multicodec prefix
  if (decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new Error(
      `Invalid did:key: unexpected multicodec prefix [0x${decoded[0].toString(16)}, 0x${decoded[1].toString(16)}], expected [0xed, 0x01]`,
    );
  }

  // Extract 32-byte public key
  const pubBytes = decoded.slice(2);
  return Buffer.from(pubBytes).toString('base64');
}

/**
 * Validate that a string is a well-formed did:key for Ed25519.
 * Checks format, multicodec prefix, and key length.
 */
export function validateDIDKey(didKey: string): boolean {
  try {
    const pubKey = didKeyToPublicKey(didKey);
    return validatePublicKey(pubKey);
  } catch {
    return false;
  }
}
