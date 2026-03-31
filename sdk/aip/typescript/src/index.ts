/**
 * @prismer/aip-sdk — Agent Identity Protocol standalone SDK
 *
 * No dependency on Prismer platform. Implements AIP Layer 1-4:
 * - Layer 1: Identity (Ed25519 keypair → did:key)
 * - Layer 2: DID Document (build, sign, verify)
 * - Layer 3: Delegation (Verifiable Delegation, Ephemeral Delegation, chain verification)
 * - Layer 4: Credentials (VC issue, VP present, verify)
 */

export { AIPIdentity, type DIDDocument, type SignedPayload } from './identity';
export {
  type VerifiableCredential,
  type VerifiablePresentation,
  buildCredential,
  buildPresentation,
  verifyCredential,
  verifyPresentation,
} from './credentials';
export {
  type VerifiableDelegation,
  type EphemeralDelegation,
  buildDelegation,
  buildEphemeralDelegation,
  verifyDelegation,
  verifyEphemeralDelegation,
} from './delegation';
export {
  publicKeyToDIDKey,
  didKeyToPublicKey,
  validateDIDKey,
} from './did';
export {
  type DIDResolver,
  KeyResolver,
} from './resolver';
