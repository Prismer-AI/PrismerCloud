export const PROTOCOL_VERSION_V2 = 2;
export const MAX_SAFE_JS_INT = Number.MAX_SAFE_INTEGER;

export const ENVELOPE_FIELD_NAMES = [
  "v",
  "id",
  "execution_id",
  "type",
  "message_class",
  "timestamp_ms",
  "trace_id",
  "state_version",
  "payload_hash",
  "state_crc",
  "stream_id",
  "stream_seq",
  "idempotency_key",
  "ack_type",
  "signature",
  "key_id",
  "payload",
] as const;

export type EnvelopeFieldName = (typeof ENVELOPE_FIELD_NAMES)[number];

export const MESSAGE_CLASSES = ["stateful", "stream", "legacy"] as const;
export type MessageClass = (typeof MESSAGE_CLASSES)[number];

export const ACK_TYPES = ["required", "best_effort", "none"] as const;
export type AckType = (typeof ACK_TYPES)[number];

export const STATEFUL_MESSAGE_TYPES = [
  "runtime.hello",
  "runtime.capability_report",
  "stream.resume_request",
  "stream.resume_ack",
  "task.push",
  "task.accepted",
  "task.rejected",
  "task.finished",
  "task.cancel",
  "approval.request",
  "approval.decision",
] as const;

export const STREAM_MESSAGE_TYPES = [
  "runtime.heartbeat",
  "runtime.heartbeat_ack",
  "task.log_chunk",
  "task.progress",
] as const;

export const KNOWN_MESSAGE_TYPES = [
  ...STATEFUL_MESSAGE_TYPES,
  ...STREAM_MESSAGE_TYPES,
] as const;

export type StatefulMessageType = (typeof STATEFUL_MESSAGE_TYPES)[number];
export type StreamMessageType = (typeof STREAM_MESSAGE_TYPES)[number];
export type KnownMessageType = (typeof KNOWN_MESSAGE_TYPES)[number];
export type WireInt64 = number | string;

export interface EnvelopeBase {
  v: typeof PROTOCOL_VERSION_V2;
  id: string;
  execution_id: string;
  type: KnownMessageType;
  message_class: MessageClass;
  timestamp_ms: WireInt64;
  trace_id?: string;
  ack_type: AckType;
  signature?: string;
  key_id?: string;
  payload: unknown;
}

export interface StatefulEnvelope extends EnvelopeBase {
  type: StatefulMessageType;
  message_class: "stateful";
  state_version: WireInt64;
  payload_hash: string;
  state_crc?: string;
  stream_id?: never;
  stream_seq?: never;
  idempotency_key?: never;
}

export interface StreamEnvelope extends EnvelopeBase {
  type: StreamMessageType;
  message_class: "stream";
  stream_id: string;
  stream_seq: WireInt64;
  idempotency_key?: string;
  state_version?: never;
  payload_hash?: never;
  state_crc?: never;
}

export interface LegacyEnvelope {
  id?: string;
  execution_id: string;
  type: string;
  message_class: "legacy";
  timestamp_ms?: WireInt64;
  trace_id?: string;
  ack_type?: AckType;
  signature?: string;
  key_id?: string;
  payload: unknown;
  [key: string]: unknown;
}

export type WsEnvelope = StatefulEnvelope | StreamEnvelope | LegacyEnvelope;

const STATEFUL_MESSAGE_TYPE_SET = new Set<string>(STATEFUL_MESSAGE_TYPES);
const STREAM_MESSAGE_TYPE_SET = new Set<string>(STREAM_MESSAGE_TYPES);
const KNOWN_MESSAGE_TYPE_SET = new Set<string>(KNOWN_MESSAGE_TYPES);
const ACK_TYPE_SET = new Set<string>(ACK_TYPES);

export function isKnownMessageType(value: string): value is KnownMessageType {
  return KNOWN_MESSAGE_TYPE_SET.has(value);
}

export function classifyMessageType(type: KnownMessageType): "stateful" | "stream";
export function classifyMessageType(type: string): "stateful" | "stream" | null;
export function classifyMessageType(type: string): "stateful" | "stream" | null {
  if (STREAM_MESSAGE_TYPE_SET.has(type)) return "stream";
  if (STATEFUL_MESSAGE_TYPE_SET.has(type)) return "stateful";
  return null;
}

export function encodeInt64ForWire(value: number | bigint): WireInt64 {
  const bigintValue = typeof value === "bigint" ? value : BigInt(value);
  if (bigintValue > BigInt(MAX_SAFE_JS_INT) || bigintValue < BigInt(-MAX_SAFE_JS_INT)) {
    return bigintValue.toString(10);
  }
  return Number(bigintValue);
}

export function parseWsEnvelope(input: unknown): WsEnvelope {
  if (!isRecord(input)) {
    throw new Error("envelope must be an object");
  }

  const executionId = requireNonEmptyString(input.execution_id, "execution_id");
  const type = requireNonEmptyString(input.type, "type");
  const payload = requirePresent(input.payload, "payload");
  const normalizedClass = normalizeMessageClass(input.message_class);

  if (normalizedClass === "legacy") {
    const ackType =
      input.ack_type === undefined ? undefined : assertAckType(input.ack_type);
    return {
      ...input,
      execution_id: executionId,
      type,
      message_class: "legacy",
      payload,
      ack_type: ackType,
      timestamp_ms: input.timestamp_ms === undefined ? undefined : assertWireInt64(input.timestamp_ms, "timestamp_ms"),
    };
  }

  if (!isKnownMessageType(type)) {
    throw new Error(`unknown message type: ${type}`);
  }

  const classified = classifyMessageType(type);
  if (classified !== normalizedClass) {
    throw new Error(`message type ${type} must use message_class=${classified}`);
  }

  const version = requireProtocolVersion(input.v);
  const id = requireNonEmptyString(input.id, "id");
  const timestampMs = assertWireInt64(input.timestamp_ms, "timestamp_ms");
  const ackType = assertAckType(input.ack_type);
  const signature = optionalString(input.signature, "signature");
  const keyId = optionalString(input.key_id, "key_id");

  if (signature && !keyId) {
    throw new Error("signature present requires key_id");
  }

  if (normalizedClass === "stateful") {
    const statefulType = type as StatefulMessageType;
    const stateVersion = assertWireInt64(input.state_version, "state_version");
    if (toBigInt(stateVersion, "state_version") <= BigInt(0)) {
      throw new Error("stateful message requires state_version > 0");
    }
    const payloadHash = requireNonEmptyString(input.payload_hash, "payload_hash");

    return {
      v: version,
      id,
      execution_id: executionId,
      type: statefulType,
      message_class: "stateful",
      timestamp_ms: timestampMs,
      trace_id: optionalString(input.trace_id, "trace_id"),
      state_version: stateVersion,
      payload_hash: payloadHash,
      state_crc: optionalString(input.state_crc, "state_crc"),
      ack_type: ackType,
      signature: signature ?? undefined,
      key_id: keyId ?? undefined,
      payload,
    };
  }

  const streamType = type as StreamMessageType;
  const streamId = requireNonEmptyString(input.stream_id, "stream_id");
  const streamSeq = assertWireInt64(input.stream_seq, "stream_seq");
  if (toBigInt(streamSeq, "stream_seq") < BigInt(0)) {
    throw new Error("stream_seq must be >= 0");
  }

  return {
    v: version,
    id,
    execution_id: executionId,
    type: streamType,
    message_class: "stream",
    timestamp_ms: timestampMs,
    trace_id: optionalString(input.trace_id, "trace_id"),
    stream_id: streamId,
    stream_seq: streamSeq,
    idempotency_key: optionalString(input.idempotency_key, "idempotency_key"),
    ack_type: ackType,
    signature: signature ?? undefined,
    key_id: keyId ?? undefined,
    payload,
  };
}

function normalizeMessageClass(value: unknown): MessageClass {
  if (value === undefined || value === "") {
    return "legacy";
  }
  if (value === "stateful" || value === "stream" || value === "legacy") {
    return value;
  }
  throw new Error(`unknown message_class: ${String(value)}`);
}

function requireProtocolVersion(value: unknown): typeof PROTOCOL_VERSION_V2 {
  if (value !== PROTOCOL_VERSION_V2) {
    throw new Error(`message requires v=${PROTOCOL_VERSION_V2}`);
  }
  return PROTOCOL_VERSION_V2;
}

function assertAckType(value: unknown): AckType {
  if (typeof value !== "string" || !ACK_TYPE_SET.has(value)) {
    throw new Error(`invalid ack_type: ${String(value)}`);
  }
  return value as AckType;
}

function assertWireInt64(value: unknown, fieldName: string): WireInt64 {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`${fieldName} must be an integer`);
    }
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return value;
  }
  throw new Error(`${fieldName} must be an int64 encoded as number or string`);
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} required`);
  }
  return value;
}

function optionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  return value;
}

function requirePresent<T>(value: T | undefined, fieldName: string): T {
  if (value === undefined) {
    throw new Error(`${fieldName} required`);
  }
  return value;
}

function toBigInt(value: WireInt64, fieldName: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new Error(`${fieldName} must be a valid int64`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
