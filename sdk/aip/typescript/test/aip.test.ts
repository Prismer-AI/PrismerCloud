/**
 * AIP Compliance Test Suite — 14 tests covering Layer 1-4
 */

import { AIPIdentity } from '../src/identity';
import { publicKeyToDIDKey, didKeyToPublicKey, validateDIDKey } from '../src/did';
import { buildCredential, verifyCredential, buildPresentation, verifyPresentation } from '../src/credentials';
import { buildDelegation, buildEphemeralDelegation, verifyDelegation, verifyEphemeralDelegation } from '../src/delegation';
import { KeyResolver } from '../src/resolver';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}`);
    failed++;
  }
}

async function run() {
  console.log('AIP Compliance Test Suite\n');

  // Layer 1: Identity
  console.log('Layer 1: Identity');
  const id1 = await AIPIdentity.create();
  assert(id1.did.startsWith('did:key:z6Mk'), '1.1 create() produces did:key:z6Mk prefix');

  const id2a = await AIPIdentity.fromApiKey('test-key');
  const id2b = await AIPIdentity.fromApiKey('test-key');
  assert(id2a.did === id2b.did, '1.2 fromApiKey() is deterministic');

  const exported = id1.exportPrivateKey();
  const imported = await AIPIdentity.fromPrivateKey(
    typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(exported, 'base64')) : new Uint8Array(atob(exported).split('').map(c => c.charCodeAt(0)))
  );
  assert(imported.did === id1.did, '1.3 private key round-trip preserves DID');

  assert(validateDIDKey(id1.did), '1.4 validateDIDKey accepts valid DID');
  assert(!validateDIDKey('not-a-did'), '1.5 validateDIDKey rejects invalid string');

  // Layer 2: Signing
  console.log('\nLayer 2: Signing');
  const data = new TextEncoder().encode('hello AIP');
  const sig = await id1.sign(data);
  assert(await AIPIdentity.verify(data, sig, id1.did), '2.1 sign+verify with own DID');
  assert(!await AIPIdentity.verify(data, sig, id2a.did), '2.2 verify rejects wrong signer');

  // Layer 2: DID Document
  const doc = id1.getDIDDocument({ capabilities: ['code-review'] });
  assert(doc.id === id1.did, '2.3 DID Document id matches DID');
  assert(doc['aip:capabilities']?.[0] === 'code-review', '2.4 DID Document includes capabilities');

  // Layer 3: Delegation
  console.log('\nLayer 3: Delegation');
  const agent = await AIPIdentity.create();
  const delegation = await buildDelegation({ issuer: id1, subjectDid: agent.did, scope: ['read', 'write'], role: 'assistant', validDays: 7 });
  assert(delegation.issuer === id1.did, '3.1 delegation issuer is correct');
  assert(await verifyDelegation(delegation), '3.2 delegation signature verifies');

  const ephemeral = await buildEphemeralDelegation({ parent: agent, scope: ['read'], ttlSeconds: 300 });
  assert(ephemeral.parentDid === agent.did, '3.3 ephemeral delegation parent is correct');
  assert(await verifyEphemeralDelegation(ephemeral), '3.4 ephemeral delegation verifies');

  // Layer 4: Credentials
  console.log('\nLayer 4: Credentials');
  const vc = await buildCredential({ issuer: id1, holderDid: agent.did, type: 'TaskCompletionCredential', claims: { 'aip:score': 95 } });
  assert(await verifyCredential(vc), '4.1 VC signature verifies');

  const vp = await buildPresentation({ holder: agent, credentials: [vc], challenge: 'test-challenge-123' });
  assert(await verifyPresentation(vp, 'test-challenge-123'), '4.2 VP verifies with correct challenge');
  assert(!await verifyPresentation(vp, 'wrong-challenge'), '4.3 VP rejects wrong challenge');

  // Resolver
  console.log('\nResolver');
  const resolver = new KeyResolver();
  const resolved = await resolver.resolve(id1.did);
  assert(resolved.id === id1.did, '5.1 KeyResolver resolves did:key');

  console.log(`\n${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
