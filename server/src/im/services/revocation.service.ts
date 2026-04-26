/**
 * Prismer IM — Revocation Service
 *
 * AIP Layer 6: Bitstring Status List management.
 * - Check if a DID or credential is revoked
 * - Build W3C Bitstring Status List Credential for .well-known endpoint
 */

import prisma from '../db';

// ─── Types ──────────────────────────────────────────────────

export interface BitstringStatusListCredential {
  '@context': string[];
  type: string;
  issuer: string;
  validFrom: string;
  credentialSubject: {
    type: string;
    statusPurpose: string;
    encodedList: string; // Base64-encoded bitstring
  };
}

// ─── Revocation Service ─────────────────────────────────────

export class RevocationService {
  /**
   * Check if a DID has been revoked by any issuer.
   */
  async isRevoked(targetDid: string): Promise<boolean> {
    const entry = await prisma.iMRevocationEntry.findFirst({
      where: { targetDid },
    });
    return entry !== null;
  }

  /**
   * Check if a specific credential has been revoked.
   */
  async isCredentialRevoked(credentialId: string): Promise<boolean> {
    const entry = await prisma.iMRevocationEntry.findFirst({
      where: { credentialId },
    });
    return entry !== null;
  }

  /**
   * Get all revocation entries for a target DID.
   */
  async getRevocations(targetDid: string) {
    return prisma.iMRevocationEntry.findMany({
      where: { targetDid },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Build a Bitstring Status List for the .well-known/revocations endpoint.
   * Returns a W3C BitstringStatusListCredential.
   */
  async buildStatusList(listId: string, serverDid: string): Promise<BitstringStatusListCredential> {
    // Get all revocation entries
    const entries = await prisma.iMRevocationEntry.findMany({
      orderBy: { statusListIndex: 'asc' },
    });

    // Build bitstring (each bit = one credential, 1 = revoked)
    const maxIndex = entries.length > 0 ? Math.max(...entries.map((e: any) => e.statusListIndex)) : 0;
    const bitstringLength = Math.max(Math.ceil((maxIndex + 1) / 8), 1);
    const bitstring = new Uint8Array(bitstringLength);

    for (const entry of entries) {
      const byteIndex = Math.floor(entry.statusListIndex / 8);
      const bitIndex = entry.statusListIndex % 8;
      bitstring[byteIndex] |= 1 << bitIndex;
    }

    // Encode as Base64
    const encodedList = Buffer.from(bitstring).toString('base64');

    return {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: 'BitstringStatusListCredential',
      issuer: serverDid,
      validFrom: new Date().toISOString(),
      credentialSubject: {
        type: 'BitstringStatusList',
        statusPurpose: 'revocation',
        encodedList,
      },
    };
  }
}
