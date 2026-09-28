// pubkey.ts — ed25519 public key for daemon runtime-bundle OTA verification
// (product204/08 §2.2/§2.3, M9-β).
//
// Same keypair as the desktop OTA channel (08 Phase A: 复用桌面 ota-pubkey
// keypair — apps/desktop/electron/ota-pubkey.ts). The built-in constant is
// compiled into the runtime bundle; K8s deployments rotate/override it via the
// `DAEMON_BUNDLE_PUBKEY` env (base64 SPKI DER) without an image rebuild.
//
// The cloud injector is `src/lib/k8s-sandbox.ts::createContainer` (the single
// pod-env funnel), resolving through `src/lib/sandbox/pod-spec.ts::
// resolveDaemonBundlePubkey` — cloud env > Nacos. When it is unconfigured the
// cloud emits NO variable at all, precisely so the `?? DAEMON_BUNDLE_PUBKEY_SPKI_B64`
// fallback below stays reachable: `''` is not nullish and would be consumed as
// key material, failing every verify. Do not "helpfully" default it to ''.
//
// The matching PRIVATE key lives only in the release pipeline (dev: gitignored
// apps/desktop/.keys/ota-ui-private.pem).
//
// Format: base64-encoded SPKI DER — directly consumable by
// crypto.createPublicKey({ key: <der>, format: 'der', type: 'spki' }).

import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

/** Built-in ed25519 OTA signing public key (base64 SPKI DER; desktop keypair). */
export const DAEMON_BUNDLE_PUBKEY_SPKI_B64 = 'MCowBQYDK2VwAyEAS20zfFrtnpqc2EkT3scbPeEE9OsCL2UMkJCOSNwhu9w=';

/**
 * Resolve the active OTA public key: explicit override > `DAEMON_BUNDLE_PUBKEY`
 * env > built-in constant. Throws on malformed key material (caller treats any
 * throw as verify-failed — never "verify skipped").
 */
export function bundlePublicKey(overrideB64?: string): KeyObject {
  const b64 = overrideB64 ?? process.env.DAEMON_BUNDLE_PUBKEY ?? DAEMON_BUNDLE_PUBKEY_SPKI_B64;
  return createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
}

/**
 * ed25519 verify of `sigB64` (base64) over the RAW zip bytes. Any throw
 * (bad key, bad sig encoding) is a rejection — verify-or-die, never extract
 * unverified bytes.
 */
export function verifyBundleSignature(data: Buffer, sigB64: string, overrideB64?: string): boolean {
  try {
    return cryptoVerify(null, data, bundlePublicKey(overrideB64), Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}
