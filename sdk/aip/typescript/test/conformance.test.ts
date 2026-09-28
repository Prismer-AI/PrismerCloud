import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AIPIdentity } from '../src/identity';
import { didKeyToPublicKey, publicKeyToDIDKey, validateDIDKey } from '../src/did';
import { verifyDelegation, type VerifiableDelegation } from '../src/delegation';
import {
  verifyCredential,
  verifyPresentation,
  type VerifiableCredential,
  type VerifiablePresentation,
} from '../src/credentials';

interface DidVector {
  name: string;
  privateKeyBase64: string;
  publicKeyBase64: string;
  did: string;
}

interface SignatureVector {
  name: string;
  messageUtf8: string;
  signerDid: string;
  signerPrivateKeyBase64?: string;
  signatureBase64: string;
  expectedValid: boolean;
}

interface DelegationVector {
  name: string;
  expectedValid: boolean;
  delegation: VerifiableDelegation;
}

interface CredentialVector {
  name: string;
  expectedValid: boolean;
  credential: VerifiableCredential;
}

interface PresentationVector {
  name: string;
  expectedChallenge: string;
  expectedValid: boolean;
  presentation: VerifiablePresentation;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = process.env.AIP_FIXTURES_DIR
  ? path.resolve(process.env.AIP_FIXTURES_DIR)
  : path.resolve(here, '../../fixtures');

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as T;
}

async function run(): Promise<void> {
  const didFixture = fixture<{
    vectors: DidVector[];
    compatibilityDerivations: Array<{ apiKey: string; did: string }>;
    invalidDids: string[];
  }>('did-key.json');
  for (const vector of didFixture.vectors) {
    const privateKey = new Uint8Array(Buffer.from(vector.privateKeyBase64, 'base64'));
    const identity = await AIPIdentity.fromPrivateKey(privateKey);
    assert.equal(identity.did, vector.did, `${vector.name}: private key → DID`);
    assert.equal(identity.publicKeyBase64, vector.publicKeyBase64, `${vector.name}: public key`);
    assert.equal(publicKeyToDIDKey(identity.publicKey), vector.did, `${vector.name}: public key → DID`);
    assert.deepEqual(didKeyToPublicKey(vector.did), identity.publicKey, `${vector.name}: DID → public key`);
  }
  for (const vector of didFixture.compatibilityDerivations) {
    assert.equal((await AIPIdentity.fromApiKey(vector.apiKey)).did, vector.did, '2.x API-key derivation');
  }
  for (const did of didFixture.invalidDids) assert.equal(validateDIDKey(did), false, did);

  const signatureFixture = fixture<{ vectors: SignatureVector[] }>('signatures.json');
  for (const vector of signatureFixture.vectors) {
    const message = new TextEncoder().encode(vector.messageUtf8);
    assert.equal(
      await AIPIdentity.verify(message, vector.signatureBase64, vector.signerDid),
      vector.expectedValid,
      vector.name,
    );
    if (vector.signerPrivateKeyBase64) {
      const identity = await AIPIdentity.fromPrivateKey(
        new Uint8Array(Buffer.from(vector.signerPrivateKeyBase64, 'base64')),
      );
      assert.equal(await identity.sign(message), vector.signatureBase64, `${vector.name}: deterministic Ed25519`);
    }
  }

  const delegationFixture = fixture<{ vectors: DelegationVector[] }>('delegations.json');
  for (const vector of delegationFixture.vectors) {
    assert.equal(await verifyDelegation(vector.delegation), vector.expectedValid, vector.name);
  }

  const credentialFixture = fixture<{
    credentialVectors: CredentialVector[];
    presentationVectors: PresentationVector[];
  }>('credentials.json');
  for (const vector of credentialFixture.credentialVectors) {
    assert.equal(await verifyCredential(vector.credential), vector.expectedValid, vector.name);
  }
  for (const vector of credentialFixture.presentationVectors) {
    assert.equal(
      await verifyPresentation(vector.presentation, vector.expectedChallenge),
      vector.expectedValid,
      vector.name,
    );
  }

  console.log(
    `AIP shared conformance: ${didFixture.vectors.length} identities, ` +
      `${signatureFixture.vectors.length} signatures, ${delegationFixture.vectors.length} delegations, ` +
      `${credentialFixture.credentialVectors.length} credentials, ` +
      `${credentialFixture.presentationVectors.length} presentations`,
  );
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
