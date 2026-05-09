import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SAFE_JS_INT,
  classifyMessageType,
  encodeInt64ForWire,
  parseWsEnvelope,
} from "./wsMessage";

test("parseWsEnvelope accepts a valid stateful envelope", () => {
  const envelope = parseWsEnvelope({
    v: 2,
    id: "msg_01HKTEST0000000000000001",
    execution_id: "exe_01HKTEST0000000000000001",
    type: "task.finished",
    message_class: "stateful",
    timestamp_ms: 1735603200000,
    state_version: 7,
    payload_hash: "hash_123",
    ack_type: "required",
    payload: { ok: true },
  });

  assert.equal(envelope.message_class, "stateful");
  assert.equal(envelope.type, "task.finished");
});

test("parseWsEnvelope rejects unknown message type", () => {
  assert.throws(
    () =>
      parseWsEnvelope({
        v: 2,
        id: "msg_01HKTEST0000000000000001",
        execution_id: "exe_01HKTEST0000000000000001",
        type: "task.unknown",
        message_class: "stateful",
        timestamp_ms: 1735603200000,
        state_version: 1,
        payload_hash: "hash_123",
        ack_type: "required",
        payload: {},
      }),
    /unknown message type/,
  );
});

test("parseWsEnvelope rejects message_class mismatch", () => {
  assert.throws(
    () =>
      parseWsEnvelope({
        v: 2,
        id: "msg_01HKTEST0000000000000001",
        execution_id: "exe_01HKTEST0000000000000001",
        type: "task.log_chunk",
        message_class: "stateful",
        timestamp_ms: 1735603200000,
        state_version: 1,
        payload_hash: "hash_123",
        ack_type: "required",
        payload: {},
      }),
    /must use message_class=stream/,
  );
});

test("parseWsEnvelope normalizes empty message_class to legacy", () => {
  const envelope = parseWsEnvelope({
    execution_id: "exe_01HKTEST0000000000000001",
    type: "task.finished",
    payload: { ok: true },
  });

  assert.equal(envelope.message_class, "legacy");
});

test("parseWsEnvelope requires key_id when signature is present", () => {
  assert.throws(
    () =>
      parseWsEnvelope({
        v: 2,
        id: "msg_01HKTEST0000000000000001",
        execution_id: "exe_01HKTEST0000000000000001",
        type: "task.finished",
        message_class: "stateful",
        timestamp_ms: 1735603200000,
        state_version: 7,
        payload_hash: "hash_123",
        ack_type: "required",
        signature: "sig_123",
        payload: {},
      }),
    /key_id/,
  );
});

test("encodeInt64ForWire stringifies values beyond MAX_SAFE_JS_INT", () => {
  assert.equal(encodeInt64ForWire(BigInt(MAX_SAFE_JS_INT) + BigInt(1)), String(BigInt(MAX_SAFE_JS_INT) + BigInt(1)));
});

test("classifyMessageType matches protocol matrix", () => {
  assert.equal(classifyMessageType("task.progress"), "stream");
  assert.equal(classifyMessageType("task.push"), "stateful");
  assert.equal(classifyMessageType("task.unknown"), null);
});
