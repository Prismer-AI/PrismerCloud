# @prismer/aip-sdk

TypeScript implementation of the standalone Agent Identity Protocol (AIP): Ed25519 `did:key` identity, byte signatures, direct delegation, and credential/presentation artifacts.

```bash
npm install @prismer/aip-sdk @noble/curves
```

```typescript
import { AIPIdentity } from '@prismer/aip-sdk';

const identity = await AIPIdentity.create();
const payload = new TextEncoder().encode('hello AIP');
const signature = await identity.sign(payload);
const valid = await AIPIdentity.verify(payload, signature, identity.did);
```

Use `AIPIdentity.create()` for new identities and persist the exported private key securely. `fromApiKey()` remains deterministic for 2.x compatibility but is deprecated for new identity creation.

## CLI

The package publishes the `aip` binary:

```bash
npx --package @prismer/aip-sdk aip identity create
npx --package @prismer/aip-sdk aip resolve <did:key>
npx --package @prismer/aip-sdk aip verify <file> --sig <base64> --did <did:key>
```

## Boundary

This package does not manage agent Runtime lifecycle, skills, memory, Cloud tasks, or Cloud transport. It does not currently implement `did:web`, zero-knowledge proofs, multi-hop chain policy, or StatusList processing.

TypeScript and Python (`prismer-aip`) are the supported implementations. Both consume the shared fixtures in `../fixtures` through `npm test` / Python pytest.

See the [protocol product README](../README.md) for delegation, credentials, conformance, and Prismer Cloud adoption details.
