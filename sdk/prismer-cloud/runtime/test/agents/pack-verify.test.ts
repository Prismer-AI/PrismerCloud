import { describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import { verifyPackSignature, verifyManifestSignature } from '../../src/agents/pack-verify.js';

// Generate a fresh Ed25519 test keypair for each test run
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const testPubKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function signData(data: Buffer): string {
  return crypto.sign(null, data, privateKey).toString('base64');
}

describe('verifyPackSignature', () => {
  it('should verify a valid signature', () => {
    const data = Buffer.from('test pack data');
    const sig = signData(data);
    const result = verifyPackSignature(data, sig, testPubKeyB64);
    expect(result.verified).toBe(true);
    expect(result.keyId).toBe('prismer-release-ed25519-v1');
    expect(result.error).toBeUndefined();
  });

  it('should reject an invalid signature', () => {
    const data = Buffer.from('test pack data');
    const result = verifyPackSignature(data, 'invalid-base64-sig', testPubKeyB64);
    expect(result.verified).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should reject a valid signature for different data (tampered payload)', () => {
    const data = Buffer.from('original data');
    const sig = signData(data);
    const tampered = Buffer.from('tampered data');
    const result = verifyPackSignature(tampered, sig, testPubKeyB64);
    expect(result.verified).toBe(false);
    expect(result.error).toBe('Ed25519 signature mismatch');
  });

  it('should reject with wrong public key (default Prismer release key)', () => {
    const data = Buffer.from('test data');
    const sig = signData(data);
    // Omit publicKeyB64 to use the hardcoded Prismer release key
    const result = verifyPackSignature(data, sig);
    expect(result.verified).toBe(false);
  });

  it('should handle malformed base64 gracefully (never throws)', () => {
    const data = Buffer.from('test');
    const result = verifyPackSignature(data, '!!!not-base64!!!');
    expect(result.verified).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should handle empty signature gracefully', () => {
    const data = Buffer.from('test');
    const result = verifyPackSignature(data, '');
    expect(result.verified).toBe(false);
  });

  it('should handle empty data buffer', () => {
    const data = Buffer.alloc(0);
    const sig = signData(data);
    const result = verifyPackSignature(data, sig, testPubKeyB64);
    expect(result.verified).toBe(true);
  });

  it('should handle large data buffer', () => {
    const data = crypto.randomBytes(1024 * 1024); // 1 MB
    const sig = signData(data);
    const result = verifyPackSignature(data, sig, testPubKeyB64);
    expect(result.verified).toBe(true);
  });

  it('should reject with malformed public key', () => {
    const data = Buffer.from('test');
    const sig = signData(data);
    const result = verifyPackSignature(data, sig, 'not-a-valid-spki-key');
    expect(result.verified).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('verifyManifestSignature', () => {
  it('should verify a valid manifest signature', () => {
    const packages = [
      { name: '@prismer/claude-code-plugin', version: '1.9.0', sha256: 'abc123' },
      { name: '@prismer/openclaw-channel', version: '1.9.0', sha256: 'def456' },
    ];
    // Sign the deterministic sorted JSON (same logic as the implementation)
    const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name));
    const payload = Buffer.from(JSON.stringify(sorted));
    const signature = signData(payload);

    const result = verifyManifestSignature(
      { packages, signature, signedAt: new Date().toISOString() },
      testPubKeyB64,
    );
    expect(result.verified).toBe(true);
    expect(result.keyId).toBe('prismer-release-ed25519-v1');
    expect(result.error).toBeUndefined();
  });

  it('should verify manifest regardless of input package order', () => {
    const packagesA = [
      { name: 'b-package', version: '1.0.0' },
      { name: 'a-package', version: '2.0.0' },
    ];
    const packagesB = [
      { name: 'a-package', version: '2.0.0' },
      { name: 'b-package', version: '1.0.0' },
    ];
    // Sign with order A
    const sorted = [...packagesA].sort((a, b) => a.name.localeCompare(b.name));
    const payload = Buffer.from(JSON.stringify(sorted));
    const signature = signData(payload);

    // Verify with order B — should still pass since implementation sorts
    const result = verifyManifestSignature(
      { packages: packagesB, signature },
      testPubKeyB64,
    );
    expect(result.verified).toBe(true);
  });

  it('should reject manifest with missing packages', () => {
    const result = verifyManifestSignature(
      { packages: undefined as any, signature: 'sig' },
      testPubKeyB64,
    );
    expect(result.verified).toBe(false);
    expect(result.error).toContain('missing');
  });

  it('should reject manifest with missing signature', () => {
    const result = verifyManifestSignature(
      { packages: [{ name: 'test' }], signature: '' },
      testPubKeyB64,
    );
    expect(result.verified).toBe(false);
  });

  it('should reject manifest with null packages', () => {
    const result = verifyManifestSignature(
      { packages: null as any, signature: 'some-sig' },
      testPubKeyB64,
    );
    expect(result.verified).toBe(false);
    expect(result.error).toContain('missing');
  });

  it('should reject manifest with tampered package entry', () => {
    const packages = [
      { name: '@prismer/sdk', version: '1.9.0', sha256: 'original-hash' },
    ];
    const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name));
    const payload = Buffer.from(JSON.stringify(sorted));
    const signature = signData(payload);

    // Tamper with the sha256
    const tampered = [
      { name: '@prismer/sdk', version: '1.9.0', sha256: 'tampered-hash' },
    ];
    const result = verifyManifestSignature(
      { packages: tampered, signature },
      testPubKeyB64,
    );
    expect(result.verified).toBe(false);
  });

  it('should reject manifest signed with a different key', () => {
    const packages = [{ name: 'test-pkg', version: '1.0.0' }];
    const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name));
    const payload = Buffer.from(JSON.stringify(sorted));
    const signature = signData(payload);

    // Verify with default (hardcoded) key — should fail
    const result = verifyManifestSignature({ packages, signature });
    expect(result.verified).toBe(false);
  });
});
