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
import bs58 from 'bs58';

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
 * Convert a Base64 Ed25519 public key to its `did:key:z...` form (W3C DID-Key).
 *
 * Format: `did:key:z` + base58btc(multicodec(0xed 0x01) || rawPublicKey)
 * `0xed 0x01` is the multicodec varint for Ed25519 public key.
 */
export function publicKeyToDIDKey(publicKeyBase64: string): string {
  const pubBytes = Buffer.from(publicKeyBase64, 'base64');
  if (pubBytes.length !== 32) {
    throw new Error('publicKeyToDIDKey: expected 32-byte Ed25519 public key');
  }
  const prefixed = Buffer.concat([Buffer.from([0xed, 0x01]), pubBytes]);
  return 'did:key:z' + bs58.encode(prefixed);
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
export function signMessage(
  privateKeyBase64: string,
  payload: Uint8Array,
): string {
  const privBytes = Buffer.from(privateKeyBase64, 'base64');
  const sig = ed25519.sign(payload, privBytes);
  return Buffer.from(sig).toString('base64');
}

/**
 * Verify an Ed25519 message signature (STRICT RFC 8032 mode).
 * Returns true if signature is valid.
 */
export function verifySignature(
  publicKeyBase64: string,
  signatureBase64: string,
  payload: Uint8Array,
): boolean {
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
export function checkReplay(
  window: ReplayWindowState,
  seq: number,
): 'accept' | 'reject' {
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
