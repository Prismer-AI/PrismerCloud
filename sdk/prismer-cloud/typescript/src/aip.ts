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

// ─── Platform-specific integration (v1.7.4 planned) ────────

// TODO: PrismerAIPAgent class that wraps AIPIdentity with platform registration:
//   - Auto-register DID with Prismer IM on creation
//   - Auto-sign messages with senderDid
//   - Auto-present VCs when joining new workspaces
//
// import { AIPIdentity } from '@prismer/aip-sdk';
//
// export class PrismerAIPAgent {
//   readonly identity: AIPIdentity;
//
//   static async register(client: PrismerClient, apiKey: string): Promise<PrismerAIPAgent> {
//     const identity = await AIPIdentity.fromApiKey(apiKey);
//     await client.im.keys.register(identity.publicKeyBase64);
//     return new PrismerAIPAgent(identity);
//   }
// }
