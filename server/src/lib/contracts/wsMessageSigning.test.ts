import assert from "node:assert/strict";
import test from "node:test";

import { ed25519 } from "@noble/curves/ed25519.js";

import type { StatefulEnvelope } from "./wsMessage";
import {
  canonicalizeJSON,
  computePayloadHash,
  envelopeSigningInput,
  signWsEnvelope,
  verifyWsEnvelopeSignature,
} from "./wsMessageSigning";

const seed = Uint8Array.from(Array.from({ length: 32 }, (_, index) => index + 1));
const privateKeyBase64 = Buffer.from(seed).toString("base64");
const publicKeyBase64 = Buffer.from(ed25519.getPublicKey(seed)).toString("base64");

function baseEnvelope(): StatefulEnvelope {
  return {
    v: 2,
    id: "msg_01HKTEST0000000000000001",
    execution_id: "exe_01HKTEST0000000000000001",
    type: "runtime.hello",
    message_class: "stateful",
    timestamp_ms: 1735603200000,
    state_version: 1,
    payload_hash: "placeholder",
    ack_type: "required",
    key_id: "did:key:local-dev-daemon#k1",
    payload: {
      z: true,
      a: {
        c: 3,
        b: 2,
      },
    },
  };
}

test("canonicalizeJSON sorts object keys recursively", () => {
  assert.equal(canonicalizeJSON({ z: 1, a: { d: 4, b: 2 }, list: [{ y: 2, x: 1 }] }), '{"a":{"b":2,"d":4},"list":[{"x":1,"y":2}],"z":1}');
});

test("computePayloadHash is independent from object insertion order", () => {
  assert.equal(
    computePayloadHash({ b: 2, a: 1 }),
    computePayloadHash({ a: 1, b: 2 }),
  );
});

test("envelopeSigningInput uses protocol field order and canonical payload", () => {
  const envelope = {
    ...baseEnvelope(),
    payload_hash: computePayloadHash(baseEnvelope().payload),
  };
  assert.equal(
    Buffer.from(envelopeSigningInput(envelope)).toString("utf8"),
    '{"v":2,"id":"msg_01HKTEST0000000000000001","execution_id":"exe_01HKTEST0000000000000001","type":"runtime.hello","message_class":"stateful","timestamp_ms":1735603200000,"state_version":1,"payload_hash":"WHFkmAwKFwnvknCwbEDSvLwNCZ8TrbUndQAQLHsq3dM","ack_type":"required","key_id":"did:key:local-dev-daemon#k1","payload":{"a":{"b":2,"c":3},"z":true}}',
  );
});

test("signWsEnvelope populates payload_hash and verifies the signature", () => {
  const signed = signWsEnvelope(baseEnvelope(), privateKeyBase64);

  assert.equal(signed.payload_hash, computePayloadHash(signed.payload));
  assert.ok(signed.signature);
  assert.deepEqual(
    verifyWsEnvelopeSignature(signed, publicKeyBase64, {
      nowMs: 1735603200000,
      maxSkewMs: 300000,
    }),
    { valid: true },
  );
});

test("verifyWsEnvelopeSignature rejects payload tampering and clock skew", () => {
  const signed = signWsEnvelope(baseEnvelope(), privateKeyBase64);

  assert.deepEqual(
    verifyWsEnvelopeSignature({ ...signed, payload: { a: 1 } }, publicKeyBase64),
    { valid: false, reason: "payload_hash_mismatch" },
  );

  assert.deepEqual(
    verifyWsEnvelopeSignature(signed, publicKeyBase64, {
      nowMs: 1735603800001,
      maxSkewMs: 300000,
    }),
    { valid: false, reason: "timestamp_skew" },
  );
});
