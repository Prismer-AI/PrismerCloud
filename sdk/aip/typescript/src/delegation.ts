/**
 * Verifiable and Ephemeral Delegations
 */

import { AIPIdentity } from './identity';

export interface VerifiableDelegation {
  '@context': string[];
  type: string[];
  issuer: string;
  validFrom: string;
  validUntil?: string;
  credentialSubject: { id: string; 'aip:scope': string[]; 'aip:role'?: string };
  proof: { type: string; verificationMethod: string; proofPurpose: string; created: string; proofValue: string };
}

export interface EphemeralDelegation {
  type: 'EphemeralDelegation';
  parentDid: string;
  sessionId: string;
  scope: string[];
  validFrom: string;
  validUntil: string;
  nonce: string;
  proof: { type: string; verificationMethod: string; proofValue: string };
}

export async function buildDelegation(params: {
  issuer: AIPIdentity;
  subjectDid: string;
  scope: string[];
  role?: string;
  validDays?: number;
}): Promise<VerifiableDelegation> {
  const now = new Date();
  const validUntil = params.validDays ? new Date(now.getTime() + params.validDays * 86400000) : undefined;
  const body = {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: params.issuer.did,
    validFrom: now.toISOString(),
    ...(validUntil && { validUntil: validUntil.toISOString() }),
    credentialSubject: {
      id: params.subjectDid,
      'aip:scope': params.scope,
      ...(params.role && { 'aip:role': params.role }),
    },
  };
  const data = new TextEncoder().encode(JSON.stringify(body));
  const proofValue = await params.issuer.sign(data);
  return { ...body, proof: { type: 'Ed25519Signature2020', verificationMethod: `${params.issuer.did}#keys-1`, proofPurpose: 'assertionMethod', created: now.toISOString(), proofValue } };
}

export async function buildEphemeralDelegation(params: {
  parent: AIPIdentity;
  scope: string[];
  ttlSeconds: number;
}): Promise<EphemeralDelegation> {
  const now = new Date();
  const validUntil = new Date(now.getTime() + params.ttlSeconds * 1000);
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  const body = {
    type: 'EphemeralDelegation' as const,
    parentDid: params.parent.did,
    sessionId: `sub_${nonce.slice(0, 8)}`,
    scope: params.scope,
    validFrom: now.toISOString(),
    validUntil: validUntil.toISOString(),
    nonce,
  };
  const data = new TextEncoder().encode(JSON.stringify(body));
  const proofValue = await params.parent.sign(data);
  return { ...body, proof: { type: 'Ed25519Signature2020', verificationMethod: `${params.parent.did}#keys-1`, proofValue } };
}

export async function verifyDelegation(delegation: VerifiableDelegation): Promise<boolean> {
  if (new Date(delegation.validFrom) > new Date()) return false;
  if (delegation.validUntil && new Date(delegation.validUntil) < new Date()) return false;
  const { proof, ...body } = delegation;
  const data = new TextEncoder().encode(JSON.stringify(body));
  return AIPIdentity.verify(data, proof.proofValue, delegation.issuer);
}

export async function verifyEphemeralDelegation(token: EphemeralDelegation): Promise<boolean> {
  if (new Date(token.validUntil) < new Date()) return false;
  const { proof, ...body } = token;
  const data = new TextEncoder().encode(JSON.stringify(body));
  return AIPIdentity.verify(data, proof.proofValue, token.parentDid);
}
