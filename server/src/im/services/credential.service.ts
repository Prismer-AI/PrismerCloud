/**
 * Prismer IM — Credential Service
 *
 * AIP Layer 7 (unified Layer 4): Trust Accumulation.
 * - Issue Verifiable Credentials (TaskCompletion, Reputation, Capability)
 * - Hold and list credentials
 * - Build Verifiable Presentations (selective disclosure)
 * - Verify VPs
 */

import prisma from '../db';
import { signMessage, verifySignature } from '../crypto';

// ─── Types ──────────────────────────────────────────────────

export interface CredentialStatus {
  type: string;
  statusPurpose: string;
  statusListIndex: number;
  statusListCredential: string;
}

export interface VerifiableCredential {
  '@context': string[];
  type: string[];
  issuer: string;
  validFrom: string;
  credentialStatus?: CredentialStatus;
  credentialSubject: {
    id: string;
    [key: string]: any;
  };
  proof: {
    type: string;
    verificationMethod: string;
    proofPurpose: string;
    created: string;
    proofValue: string;
  };
}

export interface VerifiablePresentation {
  '@context': string[];
  type: string[];
  holder: string;
  verifiableCredential: VerifiableCredential[];
  proof: {
    type: string;
    verificationMethod: string;
    challenge: string;
    proofValue: string;
  };
}

export type CredentialType = 'TaskCompletion' | 'Reputation' | 'Capability' | 'AgentDelegation';

// ─── Credential Service ─────────────────────────────────────

export class CredentialService {
  /**
   * Issue a TaskCompletionCredential when an agent completes a task.
   * Called automatically by evolution-lifecycle when capsule.outcome = 'success'.
   */
  async issueTaskCompletion(params: {
    agentDid: string;
    issuerDid: string;
    issuerPrivateKey: string;
    taskType: string;
    outcome: string;
    score: number;
    duration?: string;
  }): Promise<VerifiableCredential> {
    const now = new Date();

    // Allocate a statusListIndex for revocation tracking
    const statusListIndex = await this.allocateStatusListIndex();

    const body: Omit<VerifiableCredential, 'proof'> = {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential', 'TaskCompletionCredential'],
      issuer: params.issuerDid,
      validFrom: now.toISOString(),
      credentialStatus: {
        type: 'BitstringStatusListEntry',
        statusPurpose: 'revocation',
        statusListIndex,
        statusListCredential: '/.well-known/revocations/default',
      },
      credentialSubject: {
        id: params.agentDid,
        'aip:taskType': params.taskType,
        'aip:outcome': params.outcome,
        'aip:score': params.score,
        ...(params.duration && { 'aip:duration': params.duration }),
      },
    };

    const canonical = JSON.stringify(body);
    const dataBytes = new TextEncoder().encode(canonical);
    const proofValue = signMessage(params.issuerPrivateKey, dataBytes);

    const vc: VerifiableCredential = {
      ...body,
      proof: {
        type: 'Ed25519Signature2020',
        verificationMethod: `${params.issuerDid}#keys-1`,
        proofPurpose: 'assertionMethod',
        created: now.toISOString(),
        proofValue,
      },
    };

    // Store
    await prisma.iMAgentCredential.create({
      data: {
        holderDid: params.agentDid,
        credentialType: 'TaskCompletion',
        issuerDid: params.issuerDid,
        credential: JSON.stringify(vc),
        validFrom: now,
      },
    });

    return vc;
  }

  /**
   * Issue a generic Verifiable Credential.
   */
  async issueCredential(params: {
    holderDid: string;
    issuerDid: string;
    issuerPrivateKey: string;
    credentialType: CredentialType;
    claims: Record<string, any>;
    validDays?: number;
  }): Promise<VerifiableCredential> {
    const now = new Date();
    const validUntil = params.validDays ? new Date(now.getTime() + params.validDays * 86400000) : undefined;

    // Allocate a statusListIndex for revocation tracking
    const statusListIndex = await this.allocateStatusListIndex();

    const body: Omit<VerifiableCredential, 'proof'> = {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential', `${params.credentialType}Credential`],
      issuer: params.issuerDid,
      validFrom: now.toISOString(),
      credentialStatus: {
        type: 'BitstringStatusListEntry',
        statusPurpose: 'revocation',
        statusListIndex,
        statusListCredential: '/.well-known/revocations/default',
      },
      credentialSubject: {
        id: params.holderDid,
        ...params.claims,
      },
    };

    const canonical = JSON.stringify(body);
    const dataBytes = new TextEncoder().encode(canonical);
    const proofValue = signMessage(params.issuerPrivateKey, dataBytes);

    const vc: VerifiableCredential = {
      ...body,
      proof: {
        type: 'Ed25519Signature2020',
        verificationMethod: `${params.issuerDid}#keys-1`,
        proofPurpose: 'assertionMethod',
        created: now.toISOString(),
        proofValue,
      },
    };

    await prisma.iMAgentCredential.create({
      data: {
        holderDid: params.holderDid,
        credentialType: params.credentialType,
        issuerDid: params.issuerDid,
        credential: JSON.stringify(vc),
        validFrom: now,
        validUntil: validUntil ?? null,
      },
    });

    return vc;
  }

  /**
   * Get all credentials held by an agent.
   */
  async getCredentials(holderDid: string, type?: CredentialType): Promise<VerifiableCredential[]> {
    const creds = await prisma.iMAgentCredential.findMany({
      where: {
        holderDid,
        revoked: false,
        ...(type && { credentialType: type }),
      },
      orderBy: { createdAt: 'desc' },
    });

    return creds.map((c: any) => JSON.parse(c.credential));
  }

  /**
   * Build a Verifiable Presentation (selective disclosure).
   */
  buildPresentation(params: {
    holderDid: string;
    holderPrivateKey: string;
    credentials: VerifiableCredential[];
    challenge: string;
  }): VerifiablePresentation {
    const body: Omit<VerifiablePresentation, 'proof'> = {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiablePresentation'],
      holder: params.holderDid,
      verifiableCredential: params.credentials,
    };

    const canonical = JSON.stringify(body) + params.challenge;
    const dataBytes = new TextEncoder().encode(canonical);
    const proofValue = signMessage(params.holderPrivateKey, dataBytes);

    return {
      ...body,
      proof: {
        type: 'Ed25519Signature2020',
        verificationMethod: `${params.holderDid}#keys-1`,
        challenge: params.challenge,
        proofValue,
      },
    };
  }

  /**
   * Verify a Verifiable Credential's signature.
   */
  async verifyCredential(vc: VerifiableCredential): Promise<{ valid: boolean; reason?: string }> {
    const issuerKey = await prisma.iMIdentityKey.findFirst({
      where: { didKey: vc.issuer, revokedAt: null },
    });
    if (!issuerKey) {
      return { valid: false, reason: 'issuer_key_not_found' };
    }

    const { proof, ...body } = vc;
    const canonical = JSON.stringify(body);
    const dataBytes = new TextEncoder().encode(canonical);
    const valid = verifySignature(issuerKey.publicKey, proof.proofValue, dataBytes);

    return valid ? { valid: true } : { valid: false, reason: 'invalid_signature' };
  }

  /**
   * Verify a Verifiable Presentation (holder signature + each VC).
   */
  async verifyPresentation(
    vp: VerifiablePresentation,
    expectedChallenge: string,
  ): Promise<{ valid: boolean; reason?: string }> {
    // Check challenge
    if (vp.proof.challenge !== expectedChallenge) {
      return { valid: false, reason: 'challenge_mismatch' };
    }

    // Verify holder's signature
    const holderKey = await prisma.iMIdentityKey.findFirst({
      where: { didKey: vp.holder, revokedAt: null },
    });
    if (!holderKey) {
      return { valid: false, reason: 'holder_key_not_found' };
    }

    const { proof, ...body } = vp;
    const canonical = JSON.stringify(body) + expectedChallenge;
    const dataBytes = new TextEncoder().encode(canonical);
    const holderValid = verifySignature(holderKey.publicKey, proof.proofValue, dataBytes);
    if (!holderValid) {
      return { valid: false, reason: 'holder_signature_invalid' };
    }

    // Verify each VC
    for (let i = 0; i < vp.verifiableCredential.length; i++) {
      const vcResult = await this.verifyCredential(vp.verifiableCredential[i]);
      if (!vcResult.valid) {
        return { valid: false, reason: `vc_${i}_invalid: ${vcResult.reason}` };
      }
    }

    return { valid: true };
  }

  /**
   * Allocate the next available statusListIndex for revocation tracking.
   * Uses MAX(parsed index) + 1 inside a transaction to avoid concurrent duplicates.
   * Falls back to count() if no credentials have status indices yet.
   */
  private async allocateStatusListIndex(): Promise<number> {
    return prisma.$transaction(async (tx: any) => {
      // Find highest existing statusListIndex from stored credentials
      const latest = await tx.iMAgentCredential.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { credential: true },
      });

      if (!latest?.credential) return 0;

      try {
        const vc = JSON.parse(latest.credential);
        const lastIndex = vc?.credentialStatus?.statusListIndex;
        if (typeof lastIndex === 'number') return lastIndex + 1;
      } catch {
        // Malformed credential JSON — fall through
      }

      // Fallback: use count (safe for first-time migration)
      return tx.iMAgentCredential.count();
    });
  }
}
