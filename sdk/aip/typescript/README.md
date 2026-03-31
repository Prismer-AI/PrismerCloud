# @prismer/aip-sdk

Agent Identity Protocol (AIP) — standalone DID-based identity for AI Agents.

No dependency on Prismer platform. Any Agent framework can use this.

## Install

```bash
npm install @prismer/aip-sdk @noble/curves
```

## Quick Start

```typescript
import { AIPIdentity } from '@prismer/aip-sdk';

// Generate new identity
const agent = await AIPIdentity.create();
console.log(agent.did); // did:key:z6Mk...

// Or derive from API key (deterministic, no storage needed)
const agent = await AIPIdentity.fromApiKey(process.env.API_KEY);

// Sign a message
const sig = await agent.sign(new TextEncoder().encode('hello'));

// Anyone can verify with just the DID
const valid = await AIPIdentity.verify(data, sig, agent.did); // true
```

## Modules

| Module | Description |
|--------|-------------|
| `identity` | Ed25519 keypair → did:key, DID Document generation |
| `did` | DID:KEY encoding/decoding (Multicodec + Base58btc) |
| `delegation` | Verifiable Delegation (Human→Agent) + Ephemeral Delegation (Agent→SubAgent) |
| `credentials` | Verifiable Credentials (issue, present, verify) |
| `resolver` | DID resolution (did:key local, did:web planned) |

## CLI

```bash
npx @prismer/aip-sdk identity create
npx @prismer/aip-sdk identity from-key <apiKey>
npx @prismer/aip-sdk resolve <did>
npx @prismer/aip-sdk sign <file>
npx @prismer/aip-sdk verify <file> --sig <b64> --did <did>
npx @prismer/aip-sdk delegate --to <did> --scope read,write --days 90
npx @prismer/aip-sdk credential issue --to <did> --type TaskCompletion --claims '{"score":95}'
npx @prismer/aip-sdk inspect <artifact.json>
```

## Delegation

```typescript
import { AIPIdentity, buildDelegation, verifyDelegation } from '@prismer/aip-sdk';

const human = await AIPIdentity.create();
const agent = await AIPIdentity.create();

// Human delegates to Agent (90 days)
const delegation = await buildDelegation({
  issuer: human,
  subjectDid: agent.did,
  scope: ['messaging:send', 'task:execute'],
  validDays: 90,
});

console.log(await verifyDelegation(delegation)); // true
```

## Credentials

```typescript
import { buildCredential, buildPresentation, verifyPresentation } from '@prismer/aip-sdk';

// Platform issues a TaskCompletion VC
const vc = await buildCredential({
  issuer: platform,
  holderDid: agent.did,
  type: 'TaskCompletionCredential',
  claims: { 'aip:score': 0.95 },
});

// Agent presents VC to new platform (challenge-response)
const vp = await buildPresentation({
  holder: agent,
  credentials: [vc],
  challenge: 'nonce-from-verifier',
});

console.log(await verifyPresentation(vp, 'nonce-from-verifier')); // true
```

## Multi-Language Support

AIP identity is interoperable across all Prismer SDKs:

| Language | Package | AIP Module |
|----------|---------|------------|
| TypeScript | `@prismer/aip-sdk` | This package |
| Python | `prismer` | `from prismer.aip import AIPIdentity` |
| Go | `prismer-sdk-go` | `prismer.NewAIPIdentity()` |
| Rust | `prismer-sdk` | `prismer::AIPIdentity::create()` |

A signature created in TypeScript can be verified in Python (and vice versa).

## Protocol Spec

See [AIP Whitepaper](../../docs/encryption/AIP-WHITEPAPER-CN.md) and [AIP Protocol Spec](../../docs/encryption/AIP-SPEC-CN.md).

## License

MIT
