/**
 * Prismer IM — Delegation Service
 *
 * AIP Layer 6 (unified Layer 3): Authorization & Revocation.
 * - Issue Verifiable Delegations (Human → Agent, Agent → Agent)
 * - Issue Ephemeral Delegations (Agent → SubAgent)
 * - Verify delegation chains (walk up to Principal)
 * - Revoke delegations
 */

import prisma from '../db';
import { signMessage, verifySignature } from '../crypto';
import { IdentityService } from './identity.service';

// ─── Types ──────────────────────────────────────────────────

export interface VerifiableDelegation {
  '@context': string[];
  type: string[];
  issuer: string; // DID of delegator
  validFrom: string;
  validUntil?: string;
  credentialSubject: {
    id: string; // DID of delegatee
    'aip:role'?: string;
    'aip:scope': string[];
    'aip:constraints'?: Record<string, any>;
  };
  credentialStatus?: {
    id: string;
    type: string;
    statusPurpose: string;
    statusListIndex: string;
  };
  proof: {
    type: string;
    verificationMethod: string;
    proofPurpose: string;
    created: string;
    proofValue: string;
  };
}

export interface EphemeralDelegation {
  type: 'EphemeralDelegation';
  parentDid: string;
  sessionId: string;
  scope: string[];
  validFrom: string;
  validUntil: string;
  nonce: string;
  proof: {
    type: string;
    verificationMethod: string;
    proofValue: string;
  };
}

export interface DelegationChainResult {
  valid: boolean;
  chain: string[]; // DIDs from leaf to root
  reason?: string;
}

// ─── Delegation Service ─────────────────────────────────────

export class DelegationService {
  /**
   * Issue a Verifiable Delegation from issuer to subject.
   * The issuer must have an active identity key.
   */
  async issueDelegation(params: {
    issuerUserId: string;
    subjectDid: string;
    scope: string[];
    role?: string;
    validDays?: number;
    constraints?: Record<string, any>;
  }): Promise<VerifiableDelegation> {
    // Lookup issuer's identity
    const issuerKey = await prisma.iMIdentityKey.findUnique({
      where: { imUserId: params.issuerUserId },
    });
    if (!issuerKey || issuerKey.revokedAt || !issuerKey.didKey) {
      throw new DelegationError('Issuer has no active AIP identity');
    }

    const now = new Date();
    const validUntil = params.validDays ? new Date(now.getTime() + params.validDays * 86400000) : undefined;

    // Build the delegation credential
    const delegation: Omit<VerifiableDelegation, 'proof'> = {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential', 'AgentDelegation'],
      issuer: issuerKey.didKey,
      validFrom: now.toISOString(),
      ...(validUntil && { validUntil: validUntil.toISOString() }),
      credentialSubject: {
        id: params.subjectDid,
        'aip:scope': params.scope,
        ...(params.role && { 'aip:role': params.role }),
        ...(params.constraints && { 'aip:constraints': params.constraints }),
      },
    };

    // Server-attested signing: the platform signs on behalf of the issuer.
    // Client-signed delegations (where the agent signs locally with its own key)
    // are created via the SDK and submitted pre-signed — the server only stores them.
    const identityService = new IdentityService();
    const serverPrivateKey = identityService.getServerPrivateKey();
    const serverDid = identityService.getServerDID();
    const canonical = JSON.stringify(delegation);
    const dataBytes = new TextEncoder().encode(canonical);
    const proofValue = signMessage(serverPrivateKey, dataBytes);

    console.log(`[Delegation] Issued: ${issuerKey.didKey} → ${params.subjectDid}, scope=${params.scope.join(',')}`);

    const fullDelegation: VerifiableDelegation = {
      ...delegation,
      proof: {
        type: 'Ed25519Signature2020',
        verificationMethod: `${serverDid}#keys-1`,
        proofPurpose: 'assertionMethod',
        created: now.toISOString(),
        proofValue,
      },
    };

    // Store as credential
    await prisma.iMAgentCredential.create({
      data: {
        holderDid: params.subjectDid,
        credentialType: 'AgentDelegation',
        issuerDid: issuerKey.didKey,
        credential: JSON.stringify(fullDelegation),
        validFrom: now,
        validUntil: validUntil ?? null,
      },
    });

    return fullDelegation;
  }

  /**
   * Create an Ephemeral Delegation for a SubAgent.
   * Short-lived (seconds to minutes), no storage needed.
   */
  createEphemeralDelegation(params: {
    parentDid: string;
    parentPrivateKey: string;
    scope: string[];
    ttlSeconds: number;
    sessionId?: string;
  }): EphemeralDelegation {
    const now = new Date();
    const validUntil = new Date(now.getTime() + params.ttlSeconds * 1000);

    // Generate random nonce
    const nonceBytes = new Uint8Array(32);
    if (typeof globalThis.crypto?.getRandomValues !== 'undefined') {
      globalThis.crypto.getRandomValues(nonceBytes);
    } else {
      const { webcrypto } = require('node:crypto');
      webcrypto.getRandomValues(nonceBytes);
    }
    const nonce = Buffer.from(nonceBytes).toString('hex');

    const sessionId = params.sessionId || `sub_${nonce.slice(0, 8)}`;

    const body: Omit<EphemeralDelegation, 'proof'> = {
      type: 'EphemeralDelegation',
      parentDid: params.parentDid,
      sessionId,
      scope: params.scope,
      validFrom: now.toISOString(),
      validUntil: validUntil.toISOString(),
      nonce,
    };

    const canonical = JSON.stringify(body);
    const dataBytes = new TextEncoder().encode(canonical);
    const proofValue = signMessage(params.parentPrivateKey, dataBytes);

    return {
      ...body,
      proof: {
        type: 'Ed25519Signature2020',
        verificationMethod: `${params.parentDid}#keys-1`,
        proofValue,
      },
    };
  }

  /**
   * Verify a Verifiable Delegation's signature and expiry.
   */
  async verifyDelegation(delegation: VerifiableDelegation): Promise<{ valid: boolean; reason?: string }> {
    // Check not-before
    if (new Date(delegation.validFrom) > new Date()) {
      return { valid: false, reason: 'delegation_not_yet_valid' };
    }

    // Check expiry
    if (delegation.validUntil && new Date(delegation.validUntil) < new Date()) {
      return { valid: false, reason: 'delegation_expired' };
    }

    // Determine which public key to use for verification.
    // Server-attested delegations have verificationMethod pointing to the server DID.
    // Client-signed delegations point to the issuer's DID.
    const { proof, ...body } = delegation;
    const signerDid = proof.verificationMethod.replace(/#.*$/, '');

    let signerPublicKey: string;
    const identityService = new IdentityService();
    const serverDid = identityService.getServerDID();

    if (signerDid === serverDid) {
      // Server-attested: verify with server public key
      signerPublicKey = identityService.getServerPublicKey();
    } else {
      // Client-signed: verify with issuer's public key
      const issuerKey = await prisma.iMIdentityKey.findFirst({
        where: { didKey: signerDid, revokedAt: null },
      });
      if (!issuerKey) {
        return { valid: false, reason: 'signer_key_not_found' };
      }
      signerPublicKey = issuerKey.publicKey;
    }

    // Verify signature
    const canonical = JSON.stringify(body);
    const dataBytes = new TextEncoder().encode(canonical);
    const valid = verifySignature(signerPublicKey, proof.proofValue, dataBytes);

    if (!valid) {
      return { valid: false, reason: 'invalid_signature' };
    }

    // Check revocation
    const revoked = await prisma.iMRevocationEntry.findFirst({
      where: { targetDid: delegation.credentialSubject.id, issuerDid: delegation.issuer },
    });
    if (revoked) {
      return { valid: false, reason: 'delegation_revoked' };
    }

    return { valid: true };
  }

  /**
   * Verify an Ephemeral Delegation token.
   */
  async verifyEphemeralDelegation(token: EphemeralDelegation): Promise<{ valid: boolean; reason?: string }> {
    // Check expiry
    if (new Date(token.validUntil) < new Date()) {
      return { valid: false, reason: 'token_expired' };
    }

    // Lookup parent's public key
    const parentKey = await prisma.iMIdentityKey.findFirst({
      where: { didKey: token.parentDid, revokedAt: null },
    });
    if (!parentKey) {
      return { valid: false, reason: 'parent_key_not_found' };
    }

    // Verify signature
    const { proof, ...body } = token;
    const canonical = JSON.stringify(body);
    const dataBytes = new TextEncoder().encode(canonical);
    const valid = verifySignature(parentKey.publicKey, proof.proofValue, dataBytes);

    if (!valid) {
      return { valid: false, reason: 'invalid_signature' };
    }

    return { valid: true };
  }

  /**
   * Walk a delegation chain from a subject DID up to the root Principal.
   * Returns the chain of DIDs and whether it's valid.
   */
  async verifyChain(subjectDid: string): Promise<DelegationChainResult> {
    const chain: string[] = [subjectDid];
    let currentDid = subjectDid;
    let previousScope: string[] | null = null;
    const maxDepth = 10; // prevent infinite loops

    for (let i = 0; i < maxDepth; i++) {
      // Find delegation credential where this DID is the subject
      const cred = await prisma.iMAgentCredential.findFirst({
        where: {
          holderDid: currentDid,
          credentialType: 'AgentDelegation',
          revoked: false,
        },
        orderBy: { createdAt: 'desc' },
      });

      if (!cred) {
        // No active delegation found. Check if one was revoked —
        // a revoked delegation means this DID's access was explicitly removed.
        if (i === 0) {
          const revoked = await prisma.iMAgentCredential.findFirst({
            where: { holderDid: currentDid, credentialType: 'AgentDelegation', revoked: true },
          });
          if (revoked) {
            return { valid: false, chain, reason: 'delegation_revoked' };
          }
        }
        // Otherwise this is the root (a human Principal with no delegation above it)
        break;
      }

      const delegation: VerifiableDelegation = JSON.parse(cred.credential);

      // Verify this delegation's signature and expiry
      const result = await this.verifyDelegation(delegation);
      if (!result.valid) {
        return { valid: false, chain, reason: `chain_broken_at_${i}: ${result.reason}` };
      }

      // G6 fix: Verify scope subsetting — each level's scope must be ⊆ parent's scope.
      // The first (leaf) delegation in the chain sets the scope.
      // Each parent delegation must contain all scopes granted to the child.
      const currentScope = delegation.credentialSubject['aip:scope'];
      if (previousScope !== null && currentScope.length > 0) {
        const scopeViolations = previousScope.filter((s) => !currentScope.includes(s) && s !== '*');
        if (scopeViolations.length > 0) {
          return {
            valid: false,
            chain,
            reason: `scope_escalation_at_${i}: child has scopes [${scopeViolations.join(',')}] not in parent [${currentScope.join(',')}]`,
          };
        }
      }
      // Wildcard '*' in parent scope allows any child scope
      if (currentScope.includes('*')) {
        // Parent grants everything — child scope is always valid
      } else {
        previousScope = currentScope;
      }

      chain.push(delegation.issuer);
      currentDid = delegation.issuer;
    }

    return { valid: true, chain };
  }

  /**
   * Revoke a delegation to a specific DID.
   */
  async revokeDelegation(params: { issuerDid: string; targetDid: string; reason: string }): Promise<void> {
    // Verify that a delegation from this issuer to this target actually exists
    const existing = await prisma.iMAgentCredential.findFirst({
      where: {
        holderDid: params.targetDid,
        issuerDid: params.issuerDid,
        credentialType: 'AgentDelegation',
      },
    });
    if (!existing) {
      throw new DelegationError('No delegation found from this issuer to this target');
    }

    // Use interactive transaction to safely get next statusListIndex
    await prisma.$transaction(async (tx: any) => {
      const maxEntry = await tx.iMRevocationEntry.findFirst({
        orderBy: { statusListIndex: 'desc' },
        select: { statusListIndex: true },
      });
      const nextIndex = (maxEntry?.statusListIndex ?? 0) + 1;

      await tx.iMRevocationEntry.create({
        data: {
          issuerDid: params.issuerDid,
          targetDid: params.targetDid,
          reason: params.reason,
          statusListIndex: nextIndex,
        },
      });

      await tx.iMAgentCredential.updateMany({
        where: {
          holderDid: params.targetDid,
          issuerDid: params.issuerDid,
          credentialType: 'AgentDelegation',
        },
        data: { revoked: true },
      });
    });

    console.log(`[Delegation] Revoked: ${params.issuerDid} → ${params.targetDid}, reason=${params.reason}`);
  }
}

export class DelegationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DelegationError';
  }
}
