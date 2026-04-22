// Ed25519 pack signature verification.
// Verifies that downloaded adapter packs are signed by the Prismer release key.
// Uses the same public key as public/install.sh (Step 3.5).

import * as crypto from 'node:crypto';

// Prismer Release Public Key (Ed25519, SPKI DER, base64)
// Source: public/install.sh line 312 — PRISMER_RELEASE_PUBKEY
const PRISMER_RELEASE_PUBLIC_KEY_B64 =
  'MCowBQYDK2VwAyEAZBXpiCEDH3c6fgsxFbscVrf0wx1pLX7jtWJfBDGnWK4=';

const KEY_ID = 'prismer-release-ed25519-v1';

export interface VerifyResult {
  verified: boolean;
  keyId: string;
  error?: string;
}

/**
 * Verify an Ed25519 signature over pack data.
 *
 * @param packData      - The raw pack bytes (tarball / manifest payload)
 * @param signatureB64  - Base64-encoded Ed25519 signature
 * @param publicKeyB64  - Optional override for the public key (SPKI DER, base64).
 *                        Defaults to the hardcoded Prismer release key.
 * @returns VerifyResult — never throws.
 */
export function verifyPackSignature(
  packData: Buffer,
  signatureB64: string,
  publicKeyB64?: string,
): VerifyResult {
  try {
    const keyB64 = publicKeyB64 ?? PRISMER_RELEASE_PUBLIC_KEY_B64;

    const pubKey = crypto.createPublicKey({
      key: Buffer.from(keyB64, 'base64'),
      format: 'der',
      type: 'spki',
    });

    const sig = Buffer.from(signatureB64, 'base64');

    // Ed25519 uses null algorithm (the algorithm is intrinsic to the key type)
    const ok = crypto.verify(null, packData, pubKey, sig);

    return {
      verified: ok,
      keyId: KEY_ID,
      error: ok ? undefined : 'Ed25519 signature mismatch',
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      verified: false,
      keyId: KEY_ID,
      error: message,
    };
  }
}

/**
 * Verify a signed manifest (the format used by prismer.cloud/releases/vX.Y.Z/manifest.sig.json).
 *
 * The manifest contains:
 *   { packages: Array<{name, version, sha256}>, signature: string, signedAt: string }
 *
 * The signed payload is the deterministic JSON of the sorted packages array.
 *
 * @returns VerifyResult — never throws.
 */
export function verifyManifestSignature(
  manifest: {
    packages: Array<{ name: string; version?: string; sha256?: string }>;
    signature: string;
    signedAt?: string;
  },
  publicKeyB64?: string,
): VerifyResult {
  try {
    if (!manifest.packages || !manifest.signature) {
      return { verified: false, keyId: KEY_ID, error: 'Manifest missing packages or signature' };
    }

    // Reconstruct the signed payload (deterministic: sorted JSON of packages array)
    const sorted = [...manifest.packages].sort((a, b) => a.name.localeCompare(b.name));
    const payload = Buffer.from(JSON.stringify(sorted));

    return verifyPackSignature(payload, manifest.signature, publicKeyB64);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { verified: false, keyId: KEY_ID, error: message };
  }
}
