import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRuntimeSigningKeyCanUpdate,
  assertRuntimeSigningKeyOwner,
  metadataMatchesOwner,
  normalizeRuntimeSigningKeyInput,
} from "./signing-keys";

const publicKey = Buffer.from(Uint8Array.from(Array.from({ length: 32 }, (_, index) => index))).toString("base64url");

test("normalizeRuntimeSigningKeyInput accepts a minimal runtime key", () => {
  const normalized = normalizeRuntimeSigningKeyInput({
    did: "did:key:local-dev-daemon",
    public_key: publicKey,
  });

  assert.equal(normalized.did, "did:key:local-dev-daemon");
  assert.equal(normalized.keyVersion, 1);
  assert.equal(normalized.keyId, "did:key:local-dev-daemon#k1");
  assert.equal(normalized.algorithm, "ed25519");
});

test("normalizeRuntimeSigningKeyInput rejects unsupported keys", () => {
  assert.throws(
    () =>
      normalizeRuntimeSigningKeyInput({
        did: "user_1",
        public_key: publicKey,
      }),
    /did:key or did:web/,
  );

  assert.throws(
    () =>
      normalizeRuntimeSigningKeyInput({
        did: "did:key:local-dev-daemon",
        public_key: Buffer.from("short").toString("base64"),
      }),
    /32-byte Ed25519/,
  );

  assert.throws(
    () =>
      normalizeRuntimeSigningKeyInput({
        did: "did:key:local-dev-daemon",
        public_key: publicKey,
        key_id: "did:key:other#k1",
      }),
    /did as prefix/,
  );
});

test("normalizeRuntimeSigningKeyInput accepts an explicit rotation key version", () => {
  const normalized = normalizeRuntimeSigningKeyInput({
    did: "did:key:local-dev-daemon",
    public_key: publicKey,
    key_version: 2,
  });

  assert.equal(normalized.keyVersion, 2);
  assert.equal(normalized.keyId, "did:key:local-dev-daemon#k2");
});

test("metadataMatchesOwner requires exact phase-a runtime ownership metadata", () => {
  assert.equal(
    metadataMatchesOwner(
      JSON.stringify({
        ownerUserId: "user_1",
        phase: "phase_a",
        purpose: "runtime_admission",
      }),
      "user_1",
    ),
    true,
  );
  assert.equal(
    metadataMatchesOwner(
      JSON.stringify({
        ownerUserId: "user_10",
        phase: "phase_a",
        purpose: "runtime_admission",
      }),
      "user_1",
    ),
    false,
  );
  assert.equal(metadataMatchesOwner("not-json", "user_1"), false);
});

test("assertRuntimeSigningKeyOwner rejects cross-owner key reuse", () => {
  const metadata = JSON.stringify({
    ownerUserId: "user_1",
    phase: "phase_a",
    purpose: "runtime_admission",
  });

  assert.doesNotThrow(() => assertRuntimeSigningKeyOwner(metadata, "user_1"));
  assert.throws(() => assertRuntimeSigningKeyOwner(metadata, "user_2"), /another owner/);
  assert.throws(() => assertRuntimeSigningKeyOwner(null, "user_1"), /another owner/);
});

test("assertRuntimeSigningKeyCanUpdate rejects key material changes for the same key id", () => {
  const metadata = JSON.stringify({
    ownerUserId: "user_1",
    phase: "phase_a",
    purpose: "runtime_admission",
  });
  const otherPublicKey = Buffer.from(Uint8Array.from(Array.from({ length: 32 }, (_, index) => index + 1))).toString(
    "base64url",
  );

  assert.doesNotThrow(() => assertRuntimeSigningKeyCanUpdate({ metadata, publicKey }, "user_1", publicKey));
  assert.throws(
    () => assertRuntimeSigningKeyCanUpdate({ metadata, publicKey }, "user_1", otherPublicKey),
    /different public_key/,
  );
});
