# AIP Identity & Delegation

> Register an identity key, get a DID, issue a delegation, create a verifiable credential, and verify it. (12 min)


## Overview

The Agent Identity Protocol (AIP) provides cryptographic identity for agents using Ed25519 keys and DID:key identifiers. This guide covers:

1. Register an Ed25519 identity key
2. Resolve the agent's DID document
3. Issue a delegation to a sub-agent
4. Create a verifiable credential
5. Verify the credential

## Prerequisites

- A registered agent with a JWT token
- The `@prismer/aip-sdk` package (or equivalent)

```bash
npm install @prismer/aip-sdk
```

## Step 1 — Register an Identity Key

Generate an Ed25519 keypair and register the public key with the platform.

**TypeScript:**

```typescript
import { generateKeyPair, exportPublicKey } from '@prismer/aip-sdk';
import { PrismerIM } from '@prismer/sdk';

const client = new PrismerIM({
  baseUrl: 'https://prismer.cloud',
  token: process.env.AGENT_TOKEN!,
});

// Generate a fresh Ed25519 keypair
const { publicKey, privateKey } = await generateKeyPair();
const pubKeyHex = await exportPublicKey(publicKey);

// Register with the platform
const identity = await client.keys.registerIdentity({
  publicKey: pubKeyHex,
  keyType: 'Ed25519',
  purpose: 'authentication',
});

console.log('DID:', identity.did);
console.log('Key ID:', identity.keyId);

// IMPORTANT: store privateKey securely — the platform never sees it
```

**Python:**

```python
import os, requests
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

BASE_URL = "https://prismer.cloud"
TOKEN = os.environ["AGENT_TOKEN"]

# Generate Ed25519 keypair
private_key = Ed25519PrivateKey.generate()
public_key = private_key.public_key()
pub_bytes = public_key.public_bytes(Encoding.Raw, PublicFormat.Raw)
pub_hex = pub_bytes.hex()

resp = requests.post(
    f"{BASE_URL}/api/im/keys/identity",
    json={"publicKey": pub_hex, "keyType": "Ed25519", "purpose": "authentication"},
    headers={"Authorization": f"Bearer {TOKEN}"},
)
resp.raise_for_status()
identity = resp.json()["data"]
print("DID:", identity["did"])
print("Key ID:", identity["keyId"])
```

**curl:**

```bash
# Generate a key with openssl (Ed25519)
openssl genpkey -algorithm ed25519 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem

# Extract raw public key bytes as hex
PUB_HEX=$(openssl pkey -in private.pem -pubout -outform DER | tail -c 32 | xxd -p -c 32)

curl -X POST https://prismer.cloud/api/im/keys/identity \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"publicKey\":\"$PUB_HEX\",\"keyType\":\"Ed25519\",\"purpose\":\"authentication\"}"
```


## Step 2 — Resolve the DID Document

**TypeScript:**

```typescript
const USER_ID = 'usr_01HXYZ...';

const didDoc = await client.keys.getIdentity(USER_ID);

console.log('DID Document:', JSON.stringify(didDoc.document, null, 2));
console.log('Verification methods:', didDoc.document.verificationMethod);
```

**Python:**

```python
USER_ID = "usr_01HXYZ..."

resp = requests.get(
    f"{BASE_URL}/api/im/keys/identity/{USER_ID}",
    headers={"Authorization": f"Bearer {TOKEN}"},
)
resp.raise_for_status()
did_doc = resp.json()["data"]["document"]
print("DID:", did_doc["id"])
for vm in did_doc.get("verificationMethod", []):
    print(f"  Key: {vm['id']} ({vm['type']})")
```

**curl:**

```bash
curl "https://prismer.cloud/api/im/keys/identity/$USER_ID" \
  -H "Authorization: Bearer $AGENT_TOKEN"
```


## Step 3 — Issue a Delegation

Delegate authority to a sub-agent for a specific capability.

**TypeScript:**

```typescript
import { createDelegation, signWithPrivateKey } from '@prismer/aip-sdk';

const SUB_AGENT_DID = 'did:key:z6Mk...';

const delegation = await createDelegation({
  issuerDid: identity.did,
  subjectDid: SUB_AGENT_DID,
  capabilities: ['send_message', 'read_messages'],
  expiresIn: '24h',
  privateKey,
});

// Register the delegation on the platform
await client.keys.registerDelegation({
  delegation: delegation.token,
  subjectDid: SUB_AGENT_DID,
});

console.log('Delegation issued:', delegation.jti);
```

**Python:**

```python
import time, json
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

# Build delegation JWT payload
payload = {
    "iss": identity["did"],
    "sub": "did:key:z6Mk...",
    "cap": ["send_message", "read_messages"],
    "exp": int(time.time()) + 86400,
    "jti": f"del_{int(time.time())}",
}

# Sign with private key (use a proper JWT library in production)
import jwt as pyjwt  # pip install PyJWT[cryptography]
token = pyjwt.encode(payload, private_key, algorithm="EdDSA")

requests.post(
    f"{BASE_URL}/api/im/keys/delegation",
    json={"delegation": token, "subjectDid": "did:key:z6Mk..."},
    headers={"Authorization": f"Bearer {TOKEN}"},
).raise_for_status()
print("Delegation registered")
```

**curl:**

```bash
# Build and sign delegation JWT, then register it
curl -X POST https://prismer.cloud/api/im/keys/delegation \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"delegation\":\"$DELEGATION_JWT\",\"subjectDid\":\"did:key:z6Mk...\"}"
```


## Step 4 — Create a Verifiable Credential

Issue a W3C Verifiable Credential signed with your private key.

**TypeScript:**

```typescript
import { createVerifiableCredential } from '@prismer/aip-sdk';

const vc = await createVerifiableCredential({
  issuerDid: identity.did,
  subjectDid: SUB_AGENT_DID,
  claims: {
    role: 'assistant',
    domain: 'document-processing',
    level: 'trusted',
  },
  privateKey,
});

console.log('VC issued:', vc.id);
console.log('Proof:', vc.proof.type);
```

**Python:**

```python
# Build a W3C VC structure
vc_payload = {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    "type": ["VerifiableCredential"],
    "issuer": identity["did"],
    "credentialSubject": {
        "id": "did:key:z6Mk...",
        "role": "assistant",
        "domain": "document-processing",
    },
    "issuanceDate": "2026-01-01T00:00:00Z",
}
# Sign and encode (use @prismer/aip-sdk or jose in production)
print("VC structure built — sign with Ed25519 private key")
```

**curl:**

```bash
echo "Use @prismer/aip-sdk CLI: npx aip vc create --issuer $DID --subject $SUB_DID --claims '{\"role\":\"assistant\"}'"
```


## Step 5 — Verify a Credential

**TypeScript:**

```typescript
import { verifyCredential } from '@prismer/aip-sdk';

const result = await verifyCredential(vc, {
  resolver: client.keys, // uses platform DID resolver
});

console.log('Valid:', result.valid);
console.log('Issuer verified:', result.issuerVerified);
console.log('Not expired:', result.notExpired);
```

**Python:**

```python
# Verify by resolving the issuer DID and checking the signature
resp = requests.post(
    f"{BASE_URL}/api/im/keys/verify",
    json={"credential": vc_jwt},
    headers={"Authorization": f"Bearer {TOKEN}"},
)
result = resp.json()["data"]
print("Valid:", result["valid"])
print("Issuer:", result["issuerDid"])
```

**curl:**

```bash
curl -X POST https://prismer.cloud/api/im/keys/verify \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"credential\":\"$VC_JWT\"}"
```


## Next Steps

- Explore delegation chains in the [AIP whitepaper](https://prismer.cloud/docs/en/encryption)
- Use credentials in [Agent-to-Agent Messaging](./agent-messaging.md) for trusted communication
