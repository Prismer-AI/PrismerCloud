# Agent Identity Protocol (AIP)

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./docs/zh/README.md">简体中文</a> ·
  <a href="./docs/de/README.md">Deutsch</a> ·
  <a href="./docs/fr/README.md">Français</a> ·
  <a href="./docs/es/README.md">Español</a> ·
  <a href="./docs/ja/README.md">日本語</a>
</p>

AIP is an open identity and trust protocol for agents. It is independently usable and independently versioned: no Prismer Cloud account or Runtime process is required to create a key, derive a `did:key`, sign bytes, or verify a signed artifact.

## Protocol scope

The current implementation provides:

- Ed25519 identities and `did:key` encoding/decoding;
- local DID Document derivation for `did:key`;
- byte signatures and verification;
- directly signed, scoped, time-bounded delegations and ephemeral delegations;
- signed Verifiable Credential and challenge-bound Presentation structures;
- shared TypeScript/Python conformance vectors for positive and negative cases.

AIP does **not** own agent execution, provider lifecycle, skill delivery, memory extraction, Cloud task schemas, or their transport. Runtime host-declare, task, and result messages may carry AIP signatures in the future, but their wire schemas remain Runtime/Cloud contracts.

The 2.2.x SDK does not claim `did:web` resolution, zero-knowledge proofs, automatic multi-hop delegation-chain validation, or standalone StatusList processing. Prismer Cloud has credential and revocation adoption points, but those server data flows are not silently presented as features of the standalone AIP SDK.

## Supported implementations

| Language   | Package            | Status                           |
| ---------- | ------------------ | -------------------------------- |
| TypeScript | `@prismer/aip-sdk` | Supported and conformance-tested |
| Python     | `prismer-aip`      | Supported and conformance-tested |

Go and Rust implementations are not part of the active 2.2.5 support surface.

## TypeScript quick start

```bash
npm install @prismer/aip-sdk @noble/curves
```

```typescript
import { AIPIdentity } from '@prismer/aip-sdk';

// New identities use a random keypair. Persist the private key securely.
const agent = await AIPIdentity.create();
const message = new TextEncoder().encode('hello AIP');
const signature = await agent.sign(message);

console.log(agent.did); // did:key:z6Mk...
console.log(await AIPIdentity.verify(message, signature, agent.did)); // true
```

`AIPIdentity.fromApiKey()` remains available only to preserve existing deterministic Prismer Cloud DIDs during the 2.x line. It is deprecated for new identities; use `create()` and persist the generated private key.

## Python quick start

```bash
pip install prismer-aip
```

```python
from aip import AIPIdentity

agent = AIPIdentity.create()
message = b"hello AIP"
signature = agent.sign(message)

assert AIPIdentity.verify(message, signature, agent.did)
```

## Delegation

```typescript
import { AIPIdentity, buildDelegation, verifyDelegation } from '@prismer/aip-sdk';

const issuer = await AIPIdentity.create();
const worker = await AIPIdentity.create();
const delegation = await buildDelegation({
  issuer,
  subjectDid: worker.did,
  scope: ['task:read', 'task:write'],
  validDays: 7,
});

console.log(await verifyDelegation(delegation)); // true
```

This verifies one signed delegation artifact and its time bounds. Applications that accept a chain remain responsible for chain construction, authority semantics, and policy evaluation.

## Credentials and presentations

```typescript
import { buildCredential, buildPresentation, verifyPresentation } from '@prismer/aip-sdk';

const credential = await buildCredential({
  issuer,
  holderDid: worker.did,
  type: 'AgentCapabilityCredential',
  claims: { 'aip:capability': 'code-review' },
});
const presentation = await buildPresentation({
  holder: worker,
  credentials: [credential],
  challenge: 'verifier-nonce',
});

console.log(await verifyPresentation(presentation, 'verifier-nonce')); // true
```

## CLI

The npm package publishes the canonical `aip` binary:

```bash
npx --package @prismer/aip-sdk aip identity create
npx --package @prismer/aip-sdk aip resolve did:key:z6Mk...
npx --package @prismer/aip-sdk aip sign ./message.txt
npx --package @prismer/aip-sdk aip verify ./message.txt --sig <base64> --did <did:key>
```

Signing, delegation, and credential issuance use `AIP_PRIVATE_KEY` (a Base64 Ed25519 seed). `identity from-key` / `AIP_API_KEY` is a deprecated compatibility path.

## Conformance

The two implementations consume the same fixtures in `fixtures/`:

```bash
(cd typescript && npm test)
(cd python && python -m pytest tests)
node scripts/verify-conformance-negative.mjs
```

Set `AIP_FIXTURES_DIR` to run either suite against an alternate vector directory. The negative-control script tampers with a copied valid signature and requires both suites to fail on that vector.

## Prismer Cloud adoption

Prismer Cloud currently uses AIP concepts and artifacts at these boundaries:

- identity-key registration and a user's primary DID;
- DID-bound message signatures;
- credential storage/presentation endpoints;
- credential/DID revocation data and status endpoints.

These are adoption points, not ownership: AIP remains a public protocol, while Cloud auth, database models, endpoint authorization, Runtime lifecycle, and task/result schemas stay in their respective products.

## Standards and encoding

AIP builds on Ed25519, the `did:key` Ed25519 multicodec prefix, Base58btc, W3C DID Core concepts, and W3C Verifiable Credentials Data Model structures. Signed JSON artifacts are verified against their exact compact protocol JSON field order; producers must preserve the encoded artifact rather than reconstructing an equivalent object with arbitrary key reordering.

## License

MIT
