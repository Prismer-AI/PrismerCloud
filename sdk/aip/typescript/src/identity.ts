/**
 * AIPIdentity — standalone DID identity class (no platform dependency)
 */

import { publicKeyToDIDKey, didKeyToPublicKey } from './did';

export interface DIDDocument {
  '@context': string[];
  id: string;
  controller: string;
  verificationMethod: { id: string; type: string; controller: string; publicKeyMultibase: string }[];
  authentication: string[];
  assertionMethod: string[];
  capabilityDelegation: string[];
  capabilityInvocation: string[];
  service?: { id: string; type: string; serviceEndpoint: string }[];
  'aip:capabilities'?: string[];
  created: string;
  updated: string;
}

export interface SignedPayload {
  senderDid: string;
  signature: string;
  payload: Uint8Array;
}

let _ed25519: any = null;

async function getEd25519() {
  if (_ed25519) return _ed25519;
  const mod = await import('@noble/curves/ed25519.js');
  _ed25519 = mod.ed25519;
  return _ed25519;
}

export class AIPIdentity {
  readonly did: string;
  readonly publicKey: Uint8Array;
  private readonly privateKey: Uint8Array;

  private constructor(priv: Uint8Array, pub: Uint8Array, did: string) {
    this.privateKey = priv;
    this.publicKey = pub;
    this.did = did;
  }

  static async create(): Promise<AIPIdentity> {
    const ed = await getEd25519();
    const priv = ed.utils.randomSecretKey();
    const pub = ed.getPublicKey(priv);
    return new AIPIdentity(priv, pub, publicKeyToDIDKey(pub));
  }

  static async fromApiKey(apiKey: string): Promise<AIPIdentity> {
    const ed = await getEd25519();
    const keyBytes = new TextEncoder().encode(apiKey);
    const hashBuffer = await crypto.subtle.digest('SHA-256', keyBytes);
    const seed = new Uint8Array(hashBuffer);
    const pub = ed.getPublicKey(seed);
    return new AIPIdentity(seed, pub, publicKeyToDIDKey(pub));
  }

  static async fromPrivateKey(key: Uint8Array): Promise<AIPIdentity> {
    const ed = await getEd25519();
    const pub = ed.getPublicKey(key);
    return new AIPIdentity(key, pub, publicKeyToDIDKey(pub));
  }

  get publicKeyBase64(): string {
    return typeof Buffer !== 'undefined'
      ? Buffer.from(this.publicKey).toString('base64')
      : btoa(String.fromCharCode(...this.publicKey));
  }

  async sign(data: Uint8Array): Promise<string> {
    const ed = await getEd25519();
    const sig = ed.sign(data, this.privateKey);
    return typeof Buffer !== 'undefined'
      ? Buffer.from(sig).toString('base64')
      : btoa(String.fromCharCode(...sig));
  }

  static async verify(data: Uint8Array, sigB64: string, signerDid: string): Promise<boolean> {
    const ed = await getEd25519();
    const pub = didKeyToPublicKey(signerDid);
    const sig = typeof Buffer !== 'undefined'
      ? new Uint8Array(Buffer.from(sigB64, 'base64'))
      : new Uint8Array(atob(sigB64).split('').map(c => c.charCodeAt(0)));
    try { return ed.verify(sig, data, pub); } catch { return false; }
  }

  getDIDDocument(params?: {
    services?: { type: string; endpoint: string }[];
    capabilities?: string[];
  }): DIDDocument {
    const keyId = `${this.did}#keys-1`;
    const now = new Date().toISOString();
    const doc: DIDDocument = {
      '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/ed25519-2020/v1'],
      id: this.did, controller: this.did,
      verificationMethod: [{ id: keyId, type: 'Ed25519VerificationKey2020', controller: this.did, publicKeyMultibase: this.did.slice(8) }],
      authentication: [keyId], assertionMethod: [keyId],
      capabilityDelegation: [keyId], capabilityInvocation: [keyId],
      created: now, updated: now,
    };
    if (params?.services?.length) {
      doc.service = params.services.map((s, i) => ({ id: `${this.did}#service-${i}`, type: s.type, serviceEndpoint: s.endpoint }));
    }
    if (params?.capabilities?.length) doc['aip:capabilities'] = params.capabilities;
    return doc;
  }

  exportPrivateKey(): string {
    return typeof Buffer !== 'undefined'
      ? Buffer.from(this.privateKey).toString('base64')
      : btoa(String.fromCharCode(...this.privateKey));
  }
}
