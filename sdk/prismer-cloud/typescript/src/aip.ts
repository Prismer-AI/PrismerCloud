/**
 * Prismer SDK — AIP Identity (Platform Integration)
 *
 * Re-exports @prismer/aip-sdk core and adds platform-specific convenience:
 * - All standalone AIP SDK types and classes are re-exported
 * - PrismerAIPAgent adds platform registration (auto-register DID on init)
 *
 * Usage (standalone — no Prismer platform needed):
 *   import { AIPIdentity } from '@prismer/sdk';
 *   const id = await AIPIdentity.create();
 *
 * Usage (platform integration — registers DID with Prismer IM):
 *   import { PrismerAIPAgent } from '@prismer/sdk';
 *   const agent = await PrismerAIPAgent.register(client, apiKey);
 */

// ─── Re-export everything from standalone AIP SDK ───────────
// Users of @prismer/sdk get full AIP SDK API without installing separately
export {
  AIPIdentity,
  type DIDDocument,
  type SignedPayload,
} from '@prismer/aip-sdk';

export {
  publicKeyToDIDKey,
  didKeyToPublicKey,
  validateDIDKey,
} from '@prismer/aip-sdk';

export {
  type VerifiableCredential,
  type VerifiablePresentation,
  buildCredential,
  buildPresentation,
  verifyCredential,
  verifyPresentation,
} from '@prismer/aip-sdk';

export {
  type VerifiableDelegation,
  type EphemeralDelegation,
  buildDelegation,
  buildEphemeralDelegation,
  verifyDelegation,
  verifyEphemeralDelegation,
} from '@prismer/aip-sdk';

// ─── Platform-specific integration (v1.8.0 S1) ────────────

import { AIPIdentity } from '@prismer/aip-sdk';

/**
 * PrismerAIPAgent — wraps AIPIdentity with platform registration.
 *
 * Auto-registers the DID with Prismer IM on creation, making the
 * agent's identity available for message signing and verification.
 *
 * @example
 * ```typescript
 * const client = new PrismerClient({ apiKey: 'sk-prismer-...' });
 * const agent = await PrismerAIPAgent.register(client, 'sk-prismer-...');
 * // agent.identity.did → 'did:key:z6Mk...'
 * // Messages sent via client.im will auto-sign if identity config is set
 * ```
 */
export class PrismerAIPAgent {
  readonly identity: AIPIdentity;
  private _registered = false;

  private constructor(identity: AIPIdentity) {
    this.identity = identity;
  }

  /** Create agent from API key + auto-register with Prismer IM */
  static async register(client: any, apiKey: string): Promise<PrismerAIPAgent> {
    const identity = await AIPIdentity.fromApiKey(apiKey);
    const agent = new PrismerAIPAgent(identity);
    await agent.ensureRegistered(client);
    return agent;
  }

  /** Create agent from existing private key + auto-register */
  static async fromPrivateKey(client: any, privateKeyBase64: string): Promise<PrismerAIPAgent> {
    const keyBytes = typeof Buffer !== 'undefined'
      ? new Uint8Array(Buffer.from(privateKeyBase64, 'base64'))
      : new Uint8Array(atob(privateKeyBase64).split('').map(c => c.charCodeAt(0)));
    const identity = await AIPIdentity.fromPrivateKey(keyBytes);
    const agent = new PrismerAIPAgent(identity);
    await agent.ensureRegistered(client);
    return agent;
  }

  /** Register identity key with the IM server (idempotent) */
  async ensureRegistered(client: any): Promise<void> {
    if (this._registered) return;
    try {
      await client.im.identity.registerKey(this.identity.publicKeyBase64);
      this._registered = true;
    } catch (err: any) {
      // Already registered is OK
      if (err?.message?.includes('already') || err?.status === 409) {
        this._registered = true;
      } else {
        throw err;
      }
    }
  }

  get did(): string { return this.identity.did; }
  get publicKeyBase64(): string { return this.identity.publicKeyBase64; }
}
