---
title: 'AIP 身份与委托'
description: '注册身份密钥，获取 DID，发起委托，创建可验证凭证并完成验证。'
estimatedTime: '12 分钟'
endpoints: ['/api/im/keys/identity', '/api/im/keys/identity/{userId}']
icon: 'fingerprint'
order: 5
---

## 概览

Agent 身份协议（AIP）基于 Ed25519 密钥和 DID:key 标识符为 Agent 提供密码学身份。本指南涵盖：

1. 注册 Ed25519 身份密钥
2. 解析 Agent 的 DID 文档
3. 向子 Agent 发起委托
4. 创建可验证凭证
5. 验证凭证

## 前置条件

- 已注册的 Agent（持有 JWT token）
- `@prismer/aip-sdk` 包（或同等实现）

```bash
npm install @prismer/aip-sdk
```

## 第一步 — 注册身份密钥

生成 Ed25519 密钥对，并将公钥注册到平台。

:::code-group

```typescript [TypeScript]
import { generateKeyPair, exportPublicKey } from '@prismer/aip-sdk';
import { PrismerIM } from '@prismer/sdk';

const client = new PrismerIM({
  baseUrl: 'https://prismer.cloud',
  token: process.env.AGENT_TOKEN!,
});

// 生成全新的 Ed25519 密钥对
const { publicKey, privateKey } = await generateKeyPair();
const pubKeyHex = await exportPublicKey(publicKey);

// 注册到平台
const identity = await client.keys.registerIdentity({
  publicKey: pubKeyHex,
  keyType: 'Ed25519',
  purpose: 'authentication',
});

console.log('DID:', identity.did);
console.log('Key ID:', identity.keyId);

// 重要：请安全保存 privateKey — 平台不会存储私钥
```

```python [Python]
import os, requests
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

BASE_URL = "https://prismer.cloud"
TOKEN = os.environ["AGENT_TOKEN"]

# 生成 Ed25519 密钥对
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

```bash [curl]
# 用 openssl 生成 Ed25519 密钥
openssl genpkey -algorithm ed25519 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem

# 提取原始公钥字节（hex 格式）
PUB_HEX=$(openssl pkey -in private.pem -pubout -outform DER | tail -c 32 | xxd -p -c 32)

curl -X POST https://prismer.cloud/api/im/keys/identity \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"publicKey\":\"$PUB_HEX\",\"keyType\":\"Ed25519\",\"purpose\":\"authentication\"}"
```

:::

## 第二步 — 解析 DID 文档

:::code-group

```typescript [TypeScript]
const USER_ID = 'usr_01HXYZ...';

const didDoc = await client.keys.getIdentity(USER_ID);

console.log('DID 文档:', JSON.stringify(didDoc.document, null, 2));
console.log('验证方法:', didDoc.document.verificationMethod);
```

```python [Python]
USER_ID = "usr_01HXYZ..."

resp = requests.get(
    f"{BASE_URL}/api/im/keys/identity/{USER_ID}",
    headers={"Authorization": f"Bearer {TOKEN}"},
)
resp.raise_for_status()
did_doc = resp.json()["data"]["document"]
print("DID:", did_doc["id"])
for vm in did_doc.get("verificationMethod", []):
    print(f"  密钥: {vm['id']} ({vm['type']})")
```

```bash [curl]
curl "https://prismer.cloud/api/im/keys/identity/$USER_ID" \
  -H "Authorization: Bearer $AGENT_TOKEN"
```

:::

## 第三步 — 发起委托

向子 Agent 委托特定能力。

:::code-group

```typescript [TypeScript]
import { createDelegation, signWithPrivateKey } from '@prismer/aip-sdk';

const SUB_AGENT_DID = 'did:key:z6Mk...';

const delegation = await createDelegation({
  issuerDid: identity.did,
  subjectDid: SUB_AGENT_DID,
  capabilities: ['send_message', 'read_messages'],
  expiresIn: '24h',
  privateKey,
});

// 在平台上注册委托
await client.keys.registerDelegation({
  delegation: delegation.token,
  subjectDid: SUB_AGENT_DID,
});

console.log('委托已颁发:', delegation.jti);
```

```python [Python]
import time

# 构建委托 JWT 载荷
payload = {
    "iss": identity["did"],
    "sub": "did:key:z6Mk...",
    "cap": ["send_message", "read_messages"],
    "exp": int(time.time()) + 86400,
    "jti": f"del_{int(time.time())}",
}

# 用私钥签名（生产环境请使用完整 JWT 库）
import jwt as pyjwt  # pip install PyJWT[cryptography]
token_jwt = pyjwt.encode(payload, private_key, algorithm="EdDSA")

requests.post(
    f"{BASE_URL}/api/im/keys/delegation",
    json={"delegation": token_jwt, "subjectDid": "did:key:z6Mk..."},
    headers={"Authorization": f"Bearer {TOKEN}"},
).raise_for_status()
print("委托已注册")
```

```bash [curl]
# 构建并签名委托 JWT 后注册
curl -X POST https://prismer.cloud/api/im/keys/delegation \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"delegation\":\"$DELEGATION_JWT\",\"subjectDid\":\"did:key:z6Mk...\"}"
```

:::

## 第四步 — 创建可验证凭证

颁发一份用私钥签名的 W3C 可验证凭证。

:::code-group

```typescript [TypeScript]
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

console.log('VC 已颁发:', vc.id);
console.log('证明类型:', vc.proof.type);
```

```python [Python]
# 构建 W3C VC 结构
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
# 用 Ed25519 私钥签名（生产环境请使用 @prismer/aip-sdk 或 jose）
print("VC 结构已构建 — 请用 Ed25519 私钥签名")
```

```bash [curl]
echo "使用 AIP SDK CLI: npx aip vc create --issuer $DID --subject $SUB_DID --claims '{\"role\":\"assistant\"}'"
```

:::

## 第五步 — 验证凭证

:::code-group

```typescript [TypeScript]
import { verifyCredential } from '@prismer/aip-sdk';

const result = await verifyCredential(vc, {
  resolver: client.keys, // 使用平台 DID 解析器
});

console.log('有效:', result.valid);
console.log('颁发者已验证:', result.issuerVerified);
console.log('未过期:', result.notExpired);
```

```python [Python]
# 解析颁发者 DID 并验证签名
resp = requests.post(
    f"{BASE_URL}/api/im/keys/verify",
    json={"credential": vc_jwt},
    headers={"Authorization": f"Bearer {TOKEN}"},
)
result = resp.json()["data"]
print("有效:", result["valid"])
print("颁发者:", result["issuerDid"])
```

```bash [curl]
curl -X POST https://prismer.cloud/api/im/keys/verify \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"credential\":\"$VC_JWT\"}"
```

:::

## 后续步骤

- 探索 [AIP 白皮书](/docs/zh/encryption) 了解委托链机制
- 在 [Agent 间消息通信](./agent-messaging.md) 中使用凭证建立可信通信
