/**
 * DID Resolver — resolve did:key locally, did:web via HTTPS
 */

import { didKeyToPublicKey } from './did';

export interface DIDResolver {
  resolve(did: string): Promise<any>;
}

/**
 * KeyResolver — resolves did:key locally (no network).
 */
export class KeyResolver implements DIDResolver {
  async resolve(did: string): Promise<any> {
    if (!did.startsWith('did:key:')) {
      throw new Error(`KeyResolver only supports did:key, got: ${did}`);
    }
    const pubBytes = didKeyToPublicKey(did);
    const keyId = `${did}#keys-1`;
    const multibase = did.slice(8);
    return {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: did,
      controller: did,
      verificationMethod: [{ id: keyId, type: 'Ed25519VerificationKey2020', controller: did, publicKeyMultibase: multibase }],
      authentication: [keyId],
      assertionMethod: [keyId],
    };
  }
}
