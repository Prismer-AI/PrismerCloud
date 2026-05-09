import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { MAX_SAFE_JS_INT, type StatefulEnvelope, type StreamEnvelope, type WireInt64 } from "./wsMessage";

export type SignableWsEnvelope = StatefulEnvelope | StreamEnvelope;

export interface VerifyWsEnvelopeOptions {
  nowMs?: number;
  maxSkewMs?: number;
}

export interface VerifyWsEnvelopeResult {
  valid: boolean;
  reason?: "payload_hash_mismatch" | "timestamp_skew" | "invalid_signature" | "invalid_key" | "missing_signature";
}

export function canonicalizeJSON(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

export function computePayloadHash(payload: unknown): string {
  return base64urlEncode(sha256(new TextEncoder().encode(canonicalizeJSON(payload))));
}

export function envelopeSigningInput(envelope: SignableWsEnvelope): Uint8Array {
  const wire: Record<string, unknown> = {
    v: envelope.v,
    id: envelope.id,
    execution_id: envelope.execution_id,
    type: envelope.type,
    message_class: envelope.message_class,
    timestamp_ms: encodeWireInt64ForSigning(envelope.timestamp_ms),
  };

  appendNonEmpty(wire, "trace_id", envelope.trace_id);

  if (envelope.message_class === "stateful") {
    appendNonZeroWireInt64(wire, "state_version", envelope.state_version);
    appendNonEmpty(wire, "payload_hash", envelope.payload_hash);
    appendNonEmpty(wire, "state_crc", envelope.state_crc);
  } else {
    appendNonEmpty(wire, "stream_id", envelope.stream_id);
    appendNonZeroWireInt64(wire, "stream_seq", envelope.stream_seq);
    appendNonEmpty(wire, "idempotency_key", envelope.idempotency_key);
  }

  wire.ack_type = envelope.ack_type;
  appendNonEmpty(wire, "key_id", envelope.key_id);
  wire.payload = canonicalizeValue(envelope.payload);

  return new TextEncoder().encode(JSON.stringify(wire));
}

export function signWsEnvelope<T extends SignableWsEnvelope>(
  envelope: T,
  privateKeyBase64: string,
): T {
  if (!envelope.key_id) {
    throw new Error("key_id required to sign envelope");
  }

  const next = { ...envelope };
  if (next.message_class === "stateful") {
    next.payload_hash = computePayloadHash(next.payload);
  }

  const digest = sha256(envelopeSigningInput(next));
  const signature = ed25519.sign(digest, normalizePrivateKey(privateKeyBase64));
  next.signature = base64urlEncode(signature);
  return next;
}

export function verifyWsEnvelopeSignature(
  envelope: SignableWsEnvelope,
  publicKeyBase64: string,
  options: VerifyWsEnvelopeOptions = {},
): VerifyWsEnvelopeResult {
  if (!envelope.signature) {
    return { valid: false, reason: "missing_signature" };
  }

  if (envelope.message_class === "stateful") {
    const expectedHash = computePayloadHash(envelope.payload);
    if (expectedHash !== envelope.payload_hash) {
      return { valid: false, reason: "payload_hash_mismatch" };
    }
  }

  if (options.maxSkewMs && options.maxSkewMs > 0) {
    const timestampMs = Number(BigInt(envelope.timestamp_ms));
    const nowMs = options.nowMs ?? Date.now();
    if (Math.abs(nowMs - timestampMs) > options.maxSkewMs) {
      return { valid: false, reason: "timestamp_skew" };
    }
  }

  try {
    const publicKey = decodeBase64Any(publicKeyBase64);
    const signature = decodeBase64Any(envelope.signature);
    if (publicKey.length !== 32 || signature.length !== 64) {
      return { valid: false, reason: "invalid_key" };
    }
    const digest = sha256(envelopeSigningInput(envelope));
    return ed25519.verify(signature, digest, publicKey)
      ? { valid: true }
      : { valid: false, reason: "invalid_signature" };
  } catch {
    return { valid: false, reason: "invalid_signature" };
  }
}

function canonicalizeValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonical JSON cannot encode non-finite numbers");
    }
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const child = input[key];
      if (child !== undefined) {
        output[key] = canonicalizeValue(child);
      }
    }
    return output;
  }
  throw new Error(`canonical JSON cannot encode ${typeof value}`);
}

function appendNonEmpty(target: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value) {
    target[key] = value;
  }
}

function appendNonZeroWireInt64(target: Record<string, unknown>, key: string, value: WireInt64 | undefined): void {
  if (value === undefined) {
    return;
  }
  if (BigInt(value) === BigInt(0)) {
    return;
  }
  target[key] = encodeWireInt64ForSigning(value);
}

function encodeWireInt64ForSigning(value: WireInt64): number | string {
  const bigintValue = BigInt(value);
  if (bigintValue > BigInt(MAX_SAFE_JS_INT) || bigintValue < BigInt(-MAX_SAFE_JS_INT)) {
    return bigintValue.toString(10);
  }
  return Number(bigintValue);
}

function normalizePrivateKey(privateKeyBase64: string): Uint8Array {
  const privateKey = decodeBase64Any(privateKeyBase64);
  if (privateKey.length === 32) {
    return privateKey;
  }
  if (privateKey.length === 64) {
    return privateKey.slice(0, 32);
  }
  throw new Error(`expected 32-byte seed or 64-byte Ed25519 private key, got ${privateKey.length}`);
}

function base64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decodeBase64Any(value: string): Uint8Array {
  if (!value) {
    throw new Error("empty base64 value");
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, "base64"));
}
