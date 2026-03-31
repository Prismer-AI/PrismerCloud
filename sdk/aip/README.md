# Agent Identity Protocol (AIP)

<p align="center">
  <a href="./README.md"><img alt="English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./docs/zh/README.md"><img alt="简体中文" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="./docs/de/README.md"><img alt="Deutsch" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="./docs/fr/README.md"><img alt="Français" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="./docs/es/README.md"><img alt="Español" src="https://img.shields.io/badge/Español-d9d9d9"></a>
  <a href="./docs/ja/README.md"><img alt="日本語" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
</p>

**Self-sovereign identity for AI Agents — no platform, no permission, no lock-in.**

## The Problem

In 2026, AI Agents have no identity of their own. An agent's "identity" is whatever API key or OAuth token a platform gave it. Switch platforms? Identity gone. Reputation gone. Authorization history gone.

| Problem | Impact |
|---------|--------|
| **Agent impersonation** | No cryptographic way to prove "I am who I claim to be" |
| **Platform lock-in** | All reputation and history locked inside one platform's database |
| **Cross-platform distrust** | Agent moving from LangChain to CrewAI starts from zero |
| **SubAgent black hole** | Sub-agents created at runtime have no traceable identity |
| **Unverifiable delegation** | No proof that a human actually authorized this agent |

**For human users, this was solved in 2020 with DIDs and Verifiable Credentials. For agents, we're still in 1995.**

## The Solution

AIP gives every agent a **cryptographic identity that exists independently of any platform**:

```
Private Key (random, Ed25519)
    ↓ elliptic curve (one-way)
Public Key
    ↓ Multicodec + Base58btc
DID (did:key:z6Mk...)  ← globally unique, self-generated, no registration
```

**Core principle: identity is generated, not assigned.** An agent creates its own DID in milliseconds, offline, with no API call. Any other agent or platform can verify its signatures using only the DID string — no need to query the issuing platform.

## Four Layers

```
Layer 4: Verifiable Credentials (VC)      "What have I accomplished?"
         ├── Platform issues TaskCompletion VC to agent
         ├── Agent presents VC to new platform (zero-knowledge proof of capability)
         └── Bitstring revocation registry (W3C StatusList2021)

Layer 3: Delegation                        "Who authorized me?"
         ├── Human → Agent delegation (scoped, time-limited, signed)
         ├── Agent → SubAgent ephemeral delegation (seconds-to-minutes TTL)
         └── Chain verification: SubAgent → Agent → Human (cryptographic proof)

Layer 2: DID Document                      "How to reach me?"
         ├── Public keys, service endpoints, capabilities
         └── Self-signed, resolvable via did:key (local) or did:web (remote)

Layer 1: Identity                          "Who am I?"
         ├── Ed25519 keypair → did:key
         └── Deterministic derivation from API key (no storage needed)
```

**No blockchain. No gas fees. No consensus.** Identity verification is pure cryptography — Ed25519 signs at 15,000 ops/sec on a single core.

## Quick Start

```bash
npm install @prismer/aip-sdk @noble/curves
```

```typescript
import { AIPIdentity } from '@prismer/aip-sdk';

// Create a new agent identity (instant, offline, no API call)
const agent = await AIPIdentity.create();
console.log(agent.did); // did:key:z6Mk...

// Sign a message — any platform can verify with just the DID
const sig = await agent.sign(new TextEncoder().encode('hello'));
const valid = await AIPIdentity.verify(data, sig, agent.did); // true

// Deterministic: same API key always produces same DID (no storage needed)
const agent2 = await AIPIdentity.fromApiKey('sk-prismer-...');
```

### Delegation (Human authorizes Agent)

```typescript
import { buildDelegation, verifyDelegation } from '@prismer/aip-sdk';

const human = await AIPIdentity.create();
const agent = await AIPIdentity.create();

const delegation = await buildDelegation({
  issuer: human,
  subjectDid: agent.did,
  scope: ['messaging:send', 'task:execute'],
  validDays: 90,
});

await verifyDelegation(delegation); // true — cryptographic proof of authorization
```

### Credentials (Portable reputation)

```typescript
import { buildCredential, buildPresentation, verifyPresentation } from '@prismer/aip-sdk';

// Platform issues a credential to agent
const vc = await buildCredential({
  issuer: platform,
  holderDid: agent.did,
  type: 'TaskCompletionCredential',
  claims: { 'aip:score': 0.95, 'aip:tasksCompleted': 47 },
});

// Agent presents credential to a NEW platform (no need to call original platform)
const vp = await buildPresentation({
  holder: agent,
  credentials: [vc],
  challenge: 'nonce-from-verifier',
});

await verifyPresentation(vp, 'nonce-from-verifier'); // true
```

## CLI

All operations available from the command line — no code needed:

```bash
# Identity
npx @prismer/aip-sdk identity create              # Generate new Ed25519 identity
npx @prismer/aip-sdk identity from-key <apiKey>   # Derive DID from API key (deterministic)
npx @prismer/aip-sdk identity show                # Show current identity (requires AIP_PRIVATE_KEY env)

# Resolve
npx @prismer/aip-sdk resolve <did>                # Resolve did:key → DID Document

# Sign & Verify
npx @prismer/aip-sdk sign <file>                  # Sign a file (requires AIP_PRIVATE_KEY env)
npx @prismer/aip-sdk verify <file> --sig <b64> --did <did>   # Verify signature

# Delegation
npx @prismer/aip-sdk delegate --to <did> --scope read,write --days 90   # Issue delegation
npx @prismer/aip-sdk delegate verify <delegation.json>                   # Verify delegation chain

# Credentials
npx @prismer/aip-sdk credential issue --to <did> --type TaskCompletion --claims '{"score":95}'
npx @prismer/aip-sdk credential verify <vc.json>

# Inspect any AIP artifact
npx @prismer/aip-sdk inspect <artifact.json>      # Auto-detects VC, VP, Delegation, or Ephemeral
```

**Environment variables:**

| Variable | Purpose |
|----------|---------|
| `AIP_PRIVATE_KEY` | Base64 Ed25519 private key (for sign, delegate, credential issue) |
| `AIP_API_KEY` | API key for deterministic identity derivation |

---

## Multi-Language

AIP is interoperable across all SDKs — a signature created in TypeScript can be verified in Python:

| Language | Package | Install |
|----------|---------|---------|
| TypeScript | `@prismer/aip-sdk` | `npm install @prismer/aip-sdk` |
| Python | `prismer` | `from prismer.aip import AIPIdentity` |
| Go | `prismer-sdk-go` | `prismer.NewAIPIdentity()` |
| Rust | `prismer-sdk` | `prismer::AIPIdentity::create()` |

## Design Principles

1. **Agent is a first-class citizen** — not an appendage of a human user or a platform's API caller
2. **Self-sovereign** — identity exists without any platform's permission; platforms are service providers, not identity providers
3. **Decentralized verification** — verify a signature with just the DID string, no server call needed
4. **Human oversight preserved** — delegation chains always trace back to a human principal
5. **Framework-agnostic** — works with LangChain, CrewAI, Claude Code, OpenCode, or any agent framework

## Standards

AIP builds on established W3C standards:

- [W3C Decentralized Identifiers (DID) v1.0](https://www.w3.org/TR/did-core/)
- [W3C Verifiable Credentials Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/)
- [Ed25519 (RFC 8032)](https://tools.ietf.org/html/rfc8032) — signing and verification
- [Multicodec](https://github.com/multiformats/multicodec) + [Base58btc](https://tools.ietf.org/id/draft-msporny-base58-03.html) — DID encoding

## Prismer Cloud Integration

When used with Prismer Cloud, AIP enables:

- **Auto-DID on registration** — `prismer setup` generates a DID alongside your API key
- **Signed messages** — every IM message carries a `senderDid` signature
- **Evolution credentials** — gene success records become portable VCs
- **Cross-agent trust** — delegation chains enable verified multi-agent collaboration

But AIP works **standalone** — you don't need Prismer Cloud to use agent identity.

## License

MIT
