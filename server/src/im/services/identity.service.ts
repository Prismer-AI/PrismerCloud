/**
 * Prismer IM — Identity Key Service
 *
 * Manages Ed25519 identity keys for message signing (E2E Layer 1).
 * - Key registration / rotation / revocation
 * - Server attestation (server-vouched identity)
 * - Key audit log (append-only hash chain)
 * - Key lookup for signature verification
 */

import prisma from '../db';
import {
  deriveKeyId,
  validatePublicKey,
  createAttestation,
  computeAuditLogHash,
  generateKeyPair,
  publicKeyToDIDKey,
} from '../crypto';
import { buildDIDDocument, hashDIDDocument } from './did.service';
import type { IdentityKeyInfo, KeyAuditEntry } from '../types';

// Server identity key — generated once at startup, used for attestations.
// In production, this should come from a secure key store (e.g., AWS KMS).
let _serverKeyPair: { publicKey: string; privateKey: string } | null = null;

function getServerKeyPair() {
  if (!_serverKeyPair) {
    // Check env for pre-configured server key
    const envPriv = process.env.IM_SERVER_SIGNING_KEY;
    if (envPriv) {
      // Import from env (Base64 private key)
      const { ed25519 } = require('@noble/curves/ed25519.js');
      const privBytes = Buffer.from(envPriv, 'base64');
      const pubBytes = ed25519.getPublicKey(privBytes);
      _serverKeyPair = {
        publicKey: Buffer.from(pubBytes).toString('base64'),
        privateKey: envPriv,
      };
    } else if (
      process.env.NODE_ENV === 'production' ||
      process.env.APP_ENV === 'test' ||
      process.env.APP_ENV === 'prod'
    ) {
      throw new Error(
        '[Identity] FATAL: IM_SERVER_SIGNING_KEY must be set in non-dev environments. ' +
          "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
      );
    } else {
      // Generate ephemeral key for dev/test
      _serverKeyPair = generateKeyPair();
      console.log('[Identity] Generated ephemeral server signing key (set IM_SERVER_SIGNING_KEY for production)');
    }
  }
  return _serverKeyPair;
}

export class IdentityService {
  /**
   * Get the server's public key (for clients to verify attestations).
   */
  getServerPublicKey(): string {
    return getServerKeyPair().publicKey;
  }

  /**
   * Get the server's private key for server-attested signing.
   * Used internally by delegation/credential services — never exposed via API.
   */
  getServerPrivateKey(): string {
    return getServerKeyPair().privateKey;
  }

  /**
   * Register or rotate an identity key for a user/agent.
   *
   * - If no key exists: register new key
   * - If key exists: rotate (revoke old, register new)
   * - Creates audit log entry with hash chain
   */
  async registerKey(
    imUserId: string,
    publicKeyBase64: string,
    derivationMode: string = 'generated',
  ): Promise<IdentityKeyInfo> {
    // Validate the public key
    if (!validatePublicKey(publicKeyBase64)) {
      throw new IdentityError('Invalid Ed25519 public key (must be 32 bytes, Base64-encoded)');
    }

    const keyId = deriveKeyId(publicKeyBase64);
    const now = new Date();
    const serverKey = getServerKeyPair();

    // Check if user already has a key
    const existing = await prisma.iMIdentityKey.findUnique({
      where: { imUserId },
    });

    const action = existing ? 'rotate' : 'register';

    // Create server attestation
    const attestation = createAttestation(serverKey.privateKey, imUserId, publicKeyBase64, action, now.toISOString());

    // Get last audit log entry for hash chain
    const lastLog = await prisma.iMKeyAuditLog.findFirst({
      where: { imUserId },
      orderBy: { id: 'desc' },
    });
    const prevLogHash = lastLog
      ? computeAuditLogHash({
          imUserId: lastLog.imUserId,
          action: lastLog.action,
          publicKey: lastLog.publicKey,
          keyId: lastLog.keyId,
          createdAt: lastLog.createdAt.toISOString(),
          prevLogHash: lastLog.prevLogHash,
        })
      : null;

    // AIP: Compute did:key and DID Document
    const didKey = publicKeyToDIDKey(publicKeyBase64);
    const didDoc = buildDIDDocument({ publicKeyBase64 });
    const didDocJson = JSON.stringify(didDoc);
    const didDocHash = hashDIDDocument(didDoc);

    // Upsert key + audit log atomically
    const [identityKey] = await prisma.$transaction([
      prisma.iMIdentityKey.upsert({
        where: { imUserId },
        create: {
          imUserId,
          publicKey: publicKeyBase64,
          keyId,
          attestation,
          derivationMode,
          registeredAt: now,
          didKey,
          didDocument: didDocJson,
          didDocumentHash: didDocHash,
        },
        update: {
          publicKey: publicKeyBase64,
          keyId,
          attestation,
          derivationMode,
          registeredAt: now,
          revokedAt: null,
          didKey,
          didDocument: didDocJson,
          didDocumentHash: didDocHash,
        },
      }),
      prisma.iMKeyAuditLog.create({
        data: {
          imUserId,
          action,
          publicKey: publicKeyBase64,
          keyId,
          attestation,
          prevLogHash,
          createdAt: now,
        },
      }),
      // AIP: Update user's primaryDid
      prisma.iMUser.update({
        where: { id: imUserId },
        data: { primaryDid: didKey },
      }),
    ]);

    return this.toIdentityKeyInfo(identityKey);
  }

  /**
   * Revoke a user's identity key.
   * Marks the key as revoked and writes audit log entry.
   */
  async revokeKey(imUserId: string): Promise<void> {
    const existing = await prisma.iMIdentityKey.findUnique({
      where: { imUserId },
    });
    if (!existing) {
      throw new IdentityError('No identity key found for this user');
    }
    if (existing.revokedAt) {
      throw new IdentityError('Key is already revoked');
    }

    const now = new Date();
    const serverKey = getServerKeyPair();

    // Create revocation attestation
    const attestation = createAttestation(
      serverKey.privateKey,
      imUserId,
      existing.publicKey,
      'revoke',
      now.toISOString(),
    );

    // Get last audit log for hash chain
    const lastLog = await prisma.iMKeyAuditLog.findFirst({
      where: { imUserId },
      orderBy: { id: 'desc' },
    });
    const prevLogHash = lastLog
      ? computeAuditLogHash({
          imUserId: lastLog.imUserId,
          action: lastLog.action,
          publicKey: lastLog.publicKey,
          keyId: lastLog.keyId,
          createdAt: lastLog.createdAt.toISOString(),
          prevLogHash: lastLog.prevLogHash,
        })
      : null;

    // Build transaction ops: revoke key + audit log + AIP revocation entry
    const txOps: any[] = [
      prisma.iMIdentityKey.update({
        where: { imUserId },
        data: { revokedAt: now },
      }),
      prisma.iMKeyAuditLog.create({
        data: {
          imUserId,
          action: 'revoke',
          publicKey: existing.publicKey,
          keyId: existing.keyId,
          attestation,
          prevLogHash,
          createdAt: now,
        },
      }),
    ];

    // AIP: Write revocation entry if the key has a DID
    if (existing.didKey) {
      const serverDid = this.getServerDID();
      // Get next statusListIndex
      const maxEntry = await prisma.iMRevocationEntry.findFirst({
        orderBy: { statusListIndex: 'desc' },
        select: { statusListIndex: true },
      });
      const nextIndex = (maxEntry?.statusListIndex ?? -1) + 1;

      txOps.push(
        prisma.iMRevocationEntry.create({
          data: {
            issuerDid: serverDid,
            targetDid: existing.didKey,
            reason: 'key_revoked',
            statusListIndex: nextIndex,
          },
        }),
      );
      // Clear user's primaryDid
      txOps.push(
        prisma.iMUser.update({
          where: { id: imUserId },
          data: { primaryDid: null },
        }),
      );
    }

    await prisma.$transaction(txOps);
  }

  /**
   * Lookup a user's current (non-revoked) identity key.
   */
  async lookupKey(imUserId: string): Promise<IdentityKeyInfo | null> {
    const key = await prisma.iMIdentityKey.findUnique({
      where: { imUserId },
    });
    if (!key || key.revokedAt) return null;
    return this.toIdentityKeyInfo(key);
  }

  /**
   * Lookup a key by keyId (for signature verification).
   * Returns the identity key info if found and not revoked.
   */
  async lookupByKeyId(keyId: string): Promise<IdentityKeyInfo | null> {
    const key = await prisma.iMIdentityKey.findFirst({
      where: { keyId, revokedAt: null },
    });
    if (!key) return null;
    return this.toIdentityKeyInfo(key);
  }

  /**
   * Lookup a key by DID (AIP preferred path for signature verification).
   */
  async lookupByDID(didKey: string): Promise<IdentityKeyInfo | null> {
    const key = await prisma.iMIdentityKey.findFirst({
      where: { didKey, revokedAt: null },
    });
    if (!key) return null;
    return this.toIdentityKeyInfo(key);
  }

  /**
   * Get the server's did:key (computed from the server signing key).
   */
  getServerDID(): string {
    const serverKey = getServerKeyPair();
    return publicKeyToDIDKey(serverKey.publicKey);
  }

  /**
   * Get the audit log for a user's key operations.
   * Returns entries in chronological order.
   */
  async getAuditLog(imUserId: string): Promise<KeyAuditEntry[]> {
    const logs = await prisma.iMKeyAuditLog.findMany({
      where: { imUserId },
      orderBy: { id: 'asc' },
    });
    return logs.map((l: any) => ({
      id: l.id,
      imUserId: l.imUserId,
      action: l.action,
      publicKey: l.publicKey,
      keyId: l.keyId,
      attestation: l.attestation,
      prevLogHash: l.prevLogHash,
      createdAt: l.createdAt,
    }));
  }

  /**
   * Verify the integrity of a user's audit log hash chain.
   * Returns true if the chain is intact.
   */
  async verifyAuditChain(imUserId: string): Promise<{ valid: boolean; entries: number; brokenAt?: number }> {
    const logs = await prisma.iMKeyAuditLog.findMany({
      where: { imUserId },
      orderBy: { id: 'asc' },
    });

    for (let i = 0; i < logs.length; i++) {
      const entry = logs[i];

      if (i === 0) {
        // First entry should have no prevLogHash
        if (entry.prevLogHash !== null) {
          return { valid: false, entries: logs.length, brokenAt: i };
        }
      } else {
        // Verify prevLogHash matches computed hash of previous entry
        const prev = logs[i - 1];
        const expectedHash = computeAuditLogHash({
          imUserId: prev.imUserId,
          action: prev.action,
          publicKey: prev.publicKey,
          keyId: prev.keyId,
          createdAt: prev.createdAt.toISOString(),
          prevLogHash: prev.prevLogHash,
        });

        if (entry.prevLogHash !== expectedHash) {
          return { valid: false, entries: logs.length, brokenAt: i };
        }
      }
    }

    return { valid: true, entries: logs.length };
  }

  /**
   * Check if a user's identity key needs rotation.
   * Thresholds: 1000 signed messages OR 24 hours since registration.
   * Returns { needed, reason } advisory — actual rotation is triggered by the caller.
   */
  async checkKeyRotation(imUserId: string): Promise<{ needed: boolean; reason?: string }> {
    const key = await prisma.iMIdentityKey.findUnique({ where: { imUserId } });
    if (!key || key.revokedAt) return { needed: false };

    // Check age: 24 hours
    const ageMs = Date.now() - key.registeredAt.getTime();
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;
    if (ageMs > MAX_AGE_MS) {
      return { needed: true, reason: 'key_age_exceeded_24h' };
    }

    // Check message count: 1000 signed messages
    const orConditions: any[] = [{ senderKeyId: key.keyId }];
    if (key.didKey) orConditions.push({ senderDid: key.didKey });

    const signedCount = await prisma.iMMessage.count({
      where: {
        senderId: imUserId,
        OR: orConditions,
      },
    });
    const MAX_MESSAGES = 1000;
    if (signedCount >= MAX_MESSAGES) {
      return { needed: true, reason: `signed_message_count_${signedCount}_exceeds_${MAX_MESSAGES}` };
    }

    return { needed: false };
  }

  private toIdentityKeyInfo(key: any): IdentityKeyInfo {
    return {
      imUserId: key.imUserId,
      publicKey: key.publicKey,
      keyId: key.keyId,
      didKey: key.didKey ?? undefined,
      didDocument: key.didDocument ?? undefined,
      didDocumentHash: key.didDocumentHash ?? undefined,
      attestation: key.attestation,
      derivationMode: key.derivationMode,
      registeredAt: key.registeredAt,
      revokedAt: key.revokedAt,
    };
  }
}

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}
