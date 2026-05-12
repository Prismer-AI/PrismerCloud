/**
 * Prismer IM — Message Signing Service
 *
 * E2E Encryption Layer 2: Message signing, verification, and anti-replay.
 * Integrates with MessageService to sign outgoing messages and verify incoming.
 */

import prisma from '../db';
import {
  SEC_VERSION,
  computeContentHash,
  buildSigningPayload,
  buildLiteSigningPayload,
  verifySignature,
  checkReplay,
  serializeReplayWindow,
  deserializeReplayWindow,
  type ReplayWindowState,
} from '../crypto';
import { IdentityService } from './identity.service';
import { RevocationService } from './revocation.service';
import { DelegationService } from './delegation.service';

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  keyId?: string;
}

export class SigningService {
  private revocationService: RevocationService;
  private delegationService: DelegationService;

  constructor(private identityService: IdentityService) {
    this.revocationService = new RevocationService();
    this.delegationService = new DelegationService();
  }

  /**
   * Server-side verification of a signed message.
   *
   * Checks:
   * 1. senderKeyId resolves to an active (non-revoked) identity key
   * 2. Ed25519 signature is valid (STRICT RFC 8032)
   * 3. contentHash matches actual content (reject on mismatch)
   * 4. Sequence passes sliding window anti-replay
   * 5. prevHash chain continuity (v1.8.0 S4: reject on break)
   *
   * Returns { valid: true } or { valid: false, reason: "..." }
   */
  async verifyMessage(params: {
    senderId: string;
    conversationId: string;
    type: string;
    content: string;
    createdAt: number; // ms since epoch
    secVersion: number;
    senderKeyId: string;
    senderDid?: string; // AIP: preferred over senderKeyId
    delegationProof?: string; // AIP: JSON delegation chain proof
    sequence: number;
    contentHash: string;
    prevHash: string | null;
    signature: string;
  }): Promise<VerifyResult> {
    // 0. Timestamp sanity check — reject messages with >5min clock skew
    const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
    const skew = Math.abs(Date.now() - params.createdAt);
    if (skew > MAX_CLOCK_SKEW_MS) {
      return { valid: false, reason: 'timestamp_skew' };
    }

    // 1. Lookup sender's identity key — prefer DID, fallback to keyId
    const key = params.senderDid
      ? await this.identityService.lookupByDID(params.senderDid)
      : await this.identityService.lookupByKeyId(params.senderKeyId);
    if (!key) {
      return { valid: false, reason: params.senderDid ? 'unknown_did' : 'unknown_key_id' };
    }
    if (key.imUserId !== params.senderId) {
      return { valid: false, reason: 'key_sender_mismatch' };
    }

    // 1b. AIP: Check if the sender's DID has been revoked
    if (key.didKey) {
      const revoked = await this.revocationService.isRevoked(key.didKey);
      if (revoked) {
        return { valid: false, reason: 'sender_did_revoked' };
      }
    }

    // 1c. AIP: Verify delegation chain if delegationProof is provided
    if (params.delegationProof) {
      const chainResult = await this.verifyDelegationChain(params.delegationProof);
      if (!chainResult.valid) {
        return { valid: false, reason: `delegation_invalid: ${chainResult.reason}` };
      }
    }

    // 2. Verify contentHash matches actual content
    const expectedHash = computeContentHash(params.content);
    if (params.contentHash !== expectedHash) {
      return { valid: false, reason: 'content_hash_mismatch' };
    }

    // 3. Verify Ed25519 signature
    // v1.8.0: Detect lite signing mode (SDK auto-sign sends senderDid but no senderKeyId)
    const isLiteMode = params.senderDid && !params.senderKeyId;
    const payload = isLiteMode
      ? buildLiteSigningPayload({
          secVersion: params.secVersion,
          senderDid: params.senderDid!,
          type: params.type,
          timestamp: params.createdAt,
          contentHash: params.contentHash,
        })
      : buildSigningPayload({
          secVersion: params.secVersion,
          senderId: params.senderId,
          senderKeyId: params.senderKeyId,
          senderDid: params.senderDid,
          conversationId: params.conversationId,
          sequence: params.sequence,
          type: params.type,
          timestamp: params.createdAt,
          contentHash: params.contentHash,
          prevHash: params.prevHash,
        });

    const sigValid = verifySignature(key.publicKey, params.signature, payload);
    if (!sigValid) {
      return { valid: false, reason: 'invalid_signature' };
    }

    // 4. Anti-replay: sliding window check (skip for lite mode — no sequence)
    if (!isLiteMode && typeof params.sequence === 'number') {
      const replayResult = await this.checkSequence(params.senderId, params.conversationId, params.sequence);
      if (replayResult === 'reject') {
        return { valid: false, reason: 'replay_detected' };
      }
    }

    // 5. Hash chain verification (v1.8.0 S4: reject on break)
    // Skip for lite mode — SDK auto-signing doesn't track prevHash/sequence
    if (isLiteMode) {
      return { valid: true, keyId: key.keyId };
    }
    // Verify that prevHash matches the most recent message's contentHash
    // from this sender in this conversation.
    // Always check when previous messages exist — even if params.prevHash is null/undefined.
    {
      const prevMsg = await prisma.iMMessage.findFirst({
        where: {
          conversationId: params.conversationId,
          senderId: params.senderId,
          contentHash: { not: null },
        },
        orderBy: { createdAt: 'desc' },
        select: { contentHash: true },
      });

      if (prevMsg) {
        // Previous signed messages exist — prevHash must be provided and match
        if (!params.prevHash) {
          console.warn(
            `[Signing] Hash chain break: sender=${params.senderId}, ` +
              `conv=${params.conversationId}, expected=${prevMsg.contentHash}, ` +
              `got=null`,
          );
          return { valid: false, reason: 'hash_chain_break' };
        }
        if (prevMsg.contentHash !== params.prevHash) {
          console.warn(
            `[Signing] Hash chain break: sender=${params.senderId}, ` +
              `conv=${params.conversationId}, expected=${prevMsg.contentHash}, ` +
              `got=${params.prevHash}`,
          );
          return { valid: false, reason: 'hash_chain_break' };
        }
      }
    }

    return { valid: true };
  }

  /**
   * AIP: Verify a delegation chain proof.
   * Parses the proof JSON to extract the delegatee DID, then walks the chain.
   */
  private async verifyDelegationChain(delegationProofJson: string): Promise<{ valid: boolean; reason?: string }> {
    try {
      const proof = JSON.parse(delegationProofJson);
      // proof can be { delegateeDid: "did:key:..." } or a raw DID string
      const subjectDid = typeof proof === 'string' ? proof : (proof.delegateeDid ?? proof.did);
      if (!subjectDid) {
        return { valid: false, reason: 'missing_delegatee_did_in_proof' };
      }

      const result = await this.delegationService.verifyChain(subjectDid);
      return result;
    } catch (err) {
      return { valid: false, reason: `delegation_parse_error: ${(err as Error).message}` };
    }
  }

  /**
   * AIP: Check if a DID has been revoked.
   */
  async checkRevocation(did: string): Promise<boolean> {
    return this.revocationService.isRevoked(did);
  }

  /**
   * Get the next sequence number for a (senderId, conversationId) pair.
   * Used by the server to assign sequence numbers to messages that
   * arrive without client-side signing (legacy / unsigned mode).
   */
  async getNextSequence(senderId: string, conversationId: string): Promise<number> {
    // Get current highest from conversation security record
    const security = await this.getOrCreateConversationSecurity(conversationId);
    let sequences: Record<string, any>;
    try {
      sequences = JSON.parse(security.lastSequences) as Record<string, any>;
    } catch {
      sequences = {};
    }
    const senderState = sequences[senderId];
    const current = senderState?.highestSeq ?? 0;
    return current + 1;
  }

  /**
   * Get the previous message's contentHash for hash chain construction.
   */
  async getPrevHash(senderId: string, conversationId: string): Promise<string | null> {
    const lastMsg = await prisma.iMMessage.findFirst({
      where: {
        conversationId,
        senderId,
        contentHash: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { contentHash: true },
    });
    return lastMsg?.contentHash ?? null;
  }

  /**
   * Get or check the signing policy for a conversation.
   */
  async getSigningPolicy(conversationId: string): Promise<string> {
    const security = await prisma.iMConversationSecurity.findUnique({
      where: { conversationId },
    });
    return security?.signingPolicy ?? 'recommended';
  }

  /**
   * Check sequence against sliding window and update state.
   * Returns 'accept' or 'reject'.
   */
  private async checkSequence(
    senderId: string,
    conversationId: string,
    sequence: number,
  ): Promise<'accept' | 'reject'> {
    const security = await this.getOrCreateConversationSecurity(conversationId);
    let sequences: Record<string, any>;
    try {
      sequences = JSON.parse(security.lastSequences) as Record<string, any>;
    } catch {
      sequences = {};
    }

    // Get or initialize the replay window for this sender
    const senderState = sequences[senderId]
      ? deserializeReplayWindow(sequences[senderId])
      : ({ highestSeq: 0, windowBitmap: BigInt(0) } as ReplayWindowState);

    const result = checkReplay(senderState, sequence);

    if (result === 'accept') {
      // Update stored state
      sequences[senderId] = serializeReplayWindow(senderState);
      await prisma.iMConversationSecurity.update({
        where: { conversationId },
        data: {
          lastSequences: JSON.stringify(sequences),
          updatedAt: new Date(),
        },
      });
    }

    return result;
  }

  private async getOrCreateConversationSecurity(conversationId: string) {
    return prisma.iMConversationSecurity.upsert({
      where: { conversationId },
      create: { conversationId, lastSequences: '{}' },
      update: {},
    });
  }
}
