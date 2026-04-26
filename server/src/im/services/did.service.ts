/**
 * Prismer IM — DID Service
 *
 * AIP Layer 1-2: DID:KEY identity and DID Document management.
 * - Generate did:key from Ed25519 public keys
 * - Build W3C DID Document (JSON-LD)
 * - Cache and refresh DID Documents
 * - Server DID management
 */

import { publicKeyToDIDKey, computeContentHash } from '../crypto';

// ─── Types ──────────────────────────────────────────────────

export interface DIDDocument {
  '@context': string[];
  id: string;
  controller: string;
  verificationMethod: VerificationMethod[];
  authentication: string[];
  assertionMethod: string[];
  capabilityDelegation: string[];
  capabilityInvocation: string[];
  service?: ServiceEndpoint[];
  'aip:capabilities'?: string[];
  'aip:delegation'?: string;
  created: string;
  updated: string;
  proof?: DIDProof;
}

export interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase: string;
}

export interface ServiceEndpoint {
  id: string;
  type: string;
  serviceEndpoint: string;
}

export interface DIDProof {
  type: string;
  verificationMethod: string;
  proofPurpose: string;
  created: string;
  proofValue: string;
}

// ─── DID Document Builder ──────────────────────────────────

/**
 * Build a DID Document for an Agent or User.
 *
 * NOTE: This is an AIP-flavored DID Document. The `created`/`updated` fields
 * and `aip:*` extensions are non-standard (per W3C DID Core, these belong in
 * didDocumentMetadata). This is intentional — our DID Documents are primarily
 * consumed by Prismer platform and AIP-aware tooling, not general W3C resolvers.
 */
export function buildDIDDocument(params: {
  publicKeyBase64: string;
  services?: { type: string; endpoint: string }[];
  capabilities?: string[];
  delegatedBy?: string;
  platformDomain?: string;
}): DIDDocument {
  const did = publicKeyToDIDKey(params.publicKeyBase64);
  const keyId = `${did}#keys-1`;

  // Extract the multibase portion from did:key for publicKeyMultibase
  const multibase = did.slice(8); // "did:key:".length = 8

  const now = new Date().toISOString();

  const doc: DIDDocument = {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/ed25519-2020/v1'],
    id: did,
    controller: params.delegatedBy || did,
    verificationMethod: [
      {
        id: keyId,
        type: 'Ed25519VerificationKey2020',
        controller: did,
        publicKeyMultibase: multibase,
      },
    ],
    authentication: [keyId],
    assertionMethod: [keyId],
    capabilityDelegation: [keyId],
    capabilityInvocation: [keyId],
    created: now,
    updated: now,
  };

  // Optional services
  if (params.services?.length) {
    doc.service = params.services.map((s, i) => ({
      id: `${did}#service-${i}`,
      type: s.type,
      serviceEndpoint: s.endpoint,
    }));
  }

  // Optional capabilities
  if (params.capabilities?.length) {
    doc['aip:capabilities'] = params.capabilities;
  }

  // Optional delegation
  if (params.delegatedBy) {
    doc['aip:delegation'] = params.delegatedBy;
  }

  // Add default messaging service if platform domain is provided
  if (params.platformDomain) {
    const messagingService: ServiceEndpoint = {
      id: `${did}#messaging`,
      type: 'AgentMessaging',
      serviceEndpoint: `https://${params.platformDomain}/api/im`,
    };
    doc.service = doc.service || [];
    doc.service.unshift(messagingService);
  }

  return doc;
}

/**
 * Compute a SHA-256 hash of a DID Document for cache validation.
 */
export function hashDIDDocument(doc: DIDDocument): string {
  const canonical = JSON.stringify(doc);
  return computeContentHash(canonical);
}

/**
 * Sign a DID Document with the server's Ed25519 key.
 * The proof is appended to the document.
 */
export function signDIDDocument(
  doc: DIDDocument,
  serverDid: string,
  signFn: (data: Uint8Array) => string,
): DIDDocument {
  const { proof: _, ...docWithoutProof } = doc;
  const canonical = JSON.stringify(docWithoutProof);
  const dataBytes = new TextEncoder().encode(canonical);
  const proofValue = signFn(dataBytes);

  return {
    ...doc,
    proof: {
      type: 'Ed25519Signature2020',
      verificationMethod: `${serverDid}#keys-1`,
      proofPurpose: 'assertionMethod',
      created: new Date().toISOString(),
      proofValue,
    },
  };
}

/**
 * Verify a DID Document's proof signature.
 */
export function verifyDIDDocumentProof(
  doc: DIDDocument,
  verifyFn: (publicKeyBase64: string, signatureBase64: string, data: Uint8Array) => boolean,
  serverPublicKeyBase64: string,
): boolean {
  if (!doc.proof) return false;

  const { proof, ...docWithoutProof } = doc;
  const canonical = JSON.stringify(docWithoutProof);
  const dataBytes = new TextEncoder().encode(canonical);

  return verifyFn(serverPublicKeyBase64, proof.proofValue, dataBytes);
}
