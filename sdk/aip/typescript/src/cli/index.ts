#!/usr/bin/env node
/**
 * aip — Agent Identity Protocol CLI
 *
 * Usage:
 *   aip identity create              Generate new Ed25519 keypair + DID
 *   aip identity show <did>          Show DID details
 *   aip identity from-key <apiKey>   Derive DID from API key
 *
 *   aip resolve <did>                Resolve a did:key locally
 *
 *   aip sign <file>                  Sign a file with identity
 *   aip verify <file> --sig <sig> --did <did>   Verify signature
 *
 *   aip delegate --to <did> --scope <s1,s2> [--days N]   Issue delegation
 *   aip delegate verify <credential.json>                 Verify delegation
 *
 *   aip credential issue --to <did> --type <type> --claims <json>
 *   aip credential verify <vc.json>
 *
 *   aip inspect <signed-message.json>     Parse and display signed message
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Lazy imports to keep startup fast
async function getIdentity() { return (await import('../identity.js')).AIPIdentity; }
async function getDID() { return await import('../did.js'); }
async function getDelegation() { return await import('../delegation.js'); }
async function getCredentials() { return await import('../credentials.js'); }
async function getResolver() { return (await import('../resolver.js')).KeyResolver; }

const args = process.argv.slice(2);
const cmd = args[0];
const sub = args[1];

function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function printJSON(obj: any) {
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(`aip — Agent Identity Protocol CLI

Commands:
  identity create              Generate new identity
  identity from-key <apiKey>   Derive from API key
  identity show                Show current identity

  resolve <did>                Resolve did:key locally

  sign <file>                  Sign file (uses AIP_PRIVATE_KEY env)
  verify <file> --sig <b64> --did <did>   Verify signature

  delegate --to <did> --scope <scopes> [--days N]
  delegate verify <file.json>

  credential issue --to <did> --type <type> --claims <json>
  credential verify <file.json>

  inspect <file.json>          Inspect signed AIP artifact

Environment:
  AIP_PRIVATE_KEY   Base64 Ed25519 private key (for sign/delegate/credential)
  AIP_API_KEY       API key (for deterministic identity derivation)
`);
    return;
  }

  // ── identity ─────────────────────────────────
  if (cmd === 'identity') {
    const AIPIdentity = await getIdentity();

    if (sub === 'create') {
      const id = await AIPIdentity.create();
      console.log(`DID:         ${id.did}`);
      console.log(`Public Key:  ${id.publicKeyBase64}`);
      console.log(`Private Key: ${id.exportPrivateKey()}`);
      console.log(`\nStore the private key securely. Set AIP_PRIVATE_KEY env to use with other commands.`);
      return;
    }

    if (sub === 'from-key') {
      const apiKey = args[2] || process.env.AIP_API_KEY;
      if (!apiKey) { console.error('Usage: aip identity from-key <apiKey>'); process.exit(1); }
      const id = await AIPIdentity.fromApiKey(apiKey);
      console.log(`DID:         ${id.did}`);
      console.log(`Public Key:  ${id.publicKeyBase64}`);
      console.log(`(Deterministic — same API key always produces same DID)`);
      return;
    }

    if (sub === 'show') {
      const key = process.env.AIP_PRIVATE_KEY;
      if (!key) { console.error('Set AIP_PRIVATE_KEY env'); process.exit(1); }
      const privBytes = typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(key, 'base64')) : new Uint8Array(atob(key).split('').map(c => c.charCodeAt(0)));
      const id = await AIPIdentity.fromPrivateKey(privBytes);
      console.log(`DID:         ${id.did}`);
      console.log(`Public Key:  ${id.publicKeyBase64}`);
      printJSON(id.getDIDDocument());
      return;
    }

    console.error('Unknown identity command. Try: aip identity create|from-key|show');
    process.exit(1);
  }

  // ── resolve ──────────────────────────────────
  if (cmd === 'resolve') {
    const did = sub;
    if (!did) { console.error('Usage: aip resolve <did>'); process.exit(1); }
    const KeyResolver = await getResolver();
    const resolver = new KeyResolver();
    const doc = await resolver.resolve(did);
    printJSON(doc);
    return;
  }

  // ── sign ─────────────────────────────────────
  if (cmd === 'sign') {
    const file = sub;
    if (!file) { console.error('Usage: aip sign <file>'); process.exit(1); }
    const key = process.env.AIP_PRIVATE_KEY;
    if (!key) { console.error('Set AIP_PRIVATE_KEY env'); process.exit(1); }
    const AIPIdentity = await getIdentity();
    const privBytes = typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(key, 'base64')) : new Uint8Array(atob(key).split('').map(c => c.charCodeAt(0)));
    const id = await AIPIdentity.fromPrivateKey(privBytes);
    const data = readFileSync(resolve(file));
    const sig = await id.sign(new Uint8Array(data));
    console.log(`DID:       ${id.did}`);
    console.log(`Signature: ${sig}`);
    return;
  }

  // ── verify ───────────────────────────────────
  if (cmd === 'verify') {
    const file = sub;
    const sig = flag('sig');
    const did = flag('did');
    if (!file || !sig || !did) { console.error('Usage: aip verify <file> --sig <b64> --did <did>'); process.exit(1); }
    const AIPIdentity = await getIdentity();
    const data = readFileSync(resolve(file));
    const valid = await AIPIdentity.verify(new Uint8Array(data), sig, did);
    console.log(valid ? '✅ Signature valid' : '❌ Signature INVALID');
    process.exit(valid ? 0 : 1);
  }

  // ── delegate ─────────────────────────────────
  if (cmd === 'delegate') {
    if (sub === 'verify') {
      const file = args[2];
      if (!file) { console.error('Usage: aip delegate verify <file.json>'); process.exit(1); }
      const { verifyDelegation } = await getDelegation();
      const delegation = JSON.parse(readFileSync(resolve(file), 'utf-8'));
      const valid = await verifyDelegation(delegation);
      console.log(valid ? '✅ Delegation valid' : '❌ Delegation INVALID');
      process.exit(valid ? 0 : 1);
    }

    // Issue delegation
    const to = flag('to');
    const scope = flag('scope');
    const days = flag('days');
    const key = process.env.AIP_PRIVATE_KEY;
    if (!to || !scope || !key) { console.error('Usage: aip delegate --to <did> --scope <s1,s2> [--days N]\nRequires AIP_PRIVATE_KEY env'); process.exit(1); }
    const AIPIdentity = await getIdentity();
    const { buildDelegation } = await getDelegation();
    const privBytes = typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(key, 'base64')) : new Uint8Array(atob(key).split('').map(c => c.charCodeAt(0)));
    const issuer = await AIPIdentity.fromPrivateKey(privBytes);
    const delegation = await buildDelegation({
      issuer,
      subjectDid: to,
      scope: scope.split(','),
      validDays: days ? parseInt(days) : undefined,
    });
    printJSON(delegation);
    return;
  }

  // ── credential ───────────────────────────────
  if (cmd === 'credential') {
    if (sub === 'verify') {
      const file = args[2];
      if (!file) { console.error('Usage: aip credential verify <file.json>'); process.exit(1); }
      const { verifyCredential } = await getCredentials();
      const vc = JSON.parse(readFileSync(resolve(file), 'utf-8'));
      const valid = await verifyCredential(vc);
      console.log(valid ? '✅ Credential valid' : '❌ Credential INVALID');
      process.exit(valid ? 0 : 1);
    }

    // Issue credential
    const to = flag('to');
    const type = flag('type');
    const claims = flag('claims');
    const key = process.env.AIP_PRIVATE_KEY;
    if (!to || !type || !key) { console.error('Usage: aip credential issue --to <did> --type <type> --claims <json>\nRequires AIP_PRIVATE_KEY env'); process.exit(1); }
    const AIPIdentity = await getIdentity();
    const { buildCredential } = await getCredentials();
    const privBytes = typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(key, 'base64')) : new Uint8Array(atob(key).split('').map(c => c.charCodeAt(0)));
    const issuer = await AIPIdentity.fromPrivateKey(privBytes);
    const vc = await buildCredential({
      issuer,
      holderDid: to,
      type,
      claims: claims ? JSON.parse(claims) : {},
    });
    printJSON(vc);
    return;
  }

  // ── inspect ──────────────────────────────────
  if (cmd === 'inspect') {
    const file = sub;
    if (!file) { console.error('Usage: aip inspect <file.json>'); process.exit(1); }
    const obj = JSON.parse(readFileSync(resolve(file), 'utf-8'));

    if (obj.type?.includes('VerifiableCredential')) {
      console.log('Type: Verifiable Credential');
      console.log(`Issuer:  ${obj.issuer}`);
      console.log(`Subject: ${obj.credentialSubject?.id}`);
      console.log(`Types:   ${obj.type.join(', ')}`);
      console.log(`Valid:   ${obj.validFrom} → ${obj.validUntil || 'no expiry'}`);
      console.log(`Proof:   ${obj.proof?.type} by ${obj.proof?.verificationMethod}`);
    } else if (obj.type === 'EphemeralDelegation') {
      console.log('Type: Ephemeral Delegation');
      console.log(`Parent:  ${obj.parentDid}`);
      console.log(`Session: ${obj.sessionId}`);
      console.log(`Scope:   ${obj.scope?.join(', ')}`);
      console.log(`Valid:   ${obj.validFrom} → ${obj.validUntil}`);
    } else if (obj.type?.includes('VerifiablePresentation')) {
      console.log('Type: Verifiable Presentation');
      console.log(`Holder:  ${obj.holder}`);
      console.log(`VCs:     ${obj.verifiableCredential?.length}`);
      console.log(`Challenge: ${obj.proof?.challenge}`);
    } else {
      printJSON(obj);
    }
    return;
  }

  console.error(`Unknown command: ${cmd}. Run 'aip --help' for usage.`);
  process.exit(1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
