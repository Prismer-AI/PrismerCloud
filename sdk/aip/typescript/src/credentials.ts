/**
 * Verifiable Credentials and Presentations (W3C VC Data Model v2)
 */

import { AIPIdentity } from './identity';

export interface VerifiableCredential {
  '@context': string[];
  type: string[];
  issuer: string;
  validFrom: string;
  credentialSubject: { id: string; [key: string]: any };
  proof: { type: string; verificationMethod: string; proofPurpose: string; created: string; proofValue: string };
}

export interface VerifiablePresentation {
  '@context': string[];
  type: string[];
  holder: string;
  verifiableCredential: VerifiableCredential[];
  proof: { type: string; verificationMethod: string; challenge: string; proofValue: string };
}

export async function buildCredential(params: {
  issuer: AIPIdentity;
  holderDid: string;
  type: string;
  claims: Record<string, any>;
}): Promise<VerifiableCredential> {
  const now = new Date().toISOString();
  const body = {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    type: ['VerifiableCredential', params.type],
    issuer: params.issuer.did,
    validFrom: now,
    credentialSubject: { id: params.holderDid, ...params.claims },
  };
  const data = new TextEncoder().encode(JSON.stringify(body));
  const proofValue = await params.issuer.sign(data);
  return { ...body, proof: { type: 'Ed25519Signature2020', verificationMethod: `${params.issuer.did}#keys-1`, proofPurpose: 'assertionMethod', created: now, proofValue } };
}

export async function buildPresentation(params: {
  holder: AIPIdentity;
  credentials: VerifiableCredential[];
  challenge: string;
}): Promise<VerifiablePresentation> {
  const body = {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    type: ['VerifiablePresentation'],
    holder: params.holder.did,
    verifiableCredential: params.credentials,
  };
  const data = new TextEncoder().encode(JSON.stringify(body) + params.challenge);
  const proofValue = await params.holder.sign(data);
  return { ...body, proof: { type: 'Ed25519Signature2020', verificationMethod: `${params.holder.did}#keys-1`, challenge: params.challenge, proofValue } };
}

export async function verifyCredential(vc: VerifiableCredential): Promise<boolean> {
  const { proof, ...body } = vc;
  const data = new TextEncoder().encode(JSON.stringify(body));
  return AIPIdentity.verify(data, proof.proofValue, vc.issuer);
}

export async function verifyPresentation(vp: VerifiablePresentation, expectedChallenge: string): Promise<boolean> {
  if (vp.proof.challenge !== expectedChallenge) return false;
  const { proof, ...body } = vp;
  const data = new TextEncoder().encode(JSON.stringify(body) + expectedChallenge);
  const holderValid = await AIPIdentity.verify(data, proof.proofValue, vp.holder);
  if (!holderValid) return false;
  for (const vc of vp.verifiableCredential) {
    if (!await verifyCredential(vc)) return false;
  }
  return true;
}
