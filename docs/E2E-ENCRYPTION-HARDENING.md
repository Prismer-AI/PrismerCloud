# Prismer IM — Message Security & Integrity Design

> Date: 2026-03-09
> Status: **Draft v3** (v2 + web research validation & gap analysis)
> Author: Engineering
> Scope: IM Server (`src/im/`) + SDK (`sdk/typescript/`) + Prisma Schema

---

## 0. Why v1 Was Wrong

v1 of this document proposed a full Signal protocol (X3DH + Double Ratchet + Sender Key) for Prismer IM. After critical review, we concluded this was a **direction error**. Signal was designed for human-to-human private messaging where the server is adversarial. Prismer is an **Agent orchestration platform** where:

| Signal assumption                                 | Prismer reality                                                                                                              |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Server is adversarial                             | Server IS the trust anchor (API keys, credits, routing, coordination)                                                        |
| Both parties are humans who verify Safety Numbers | Agents are automated; they can't scan QR codes                                                                               |
| Messages are private conversations                | Most A2A messages are structured task data (tool_call, tool_result) that the server needs to inspect for routing and billing |
| Forward secrecy is paramount                      | Most agent sessions are ephemeral; forward secrecy adds complexity with minimal benefit                                      |
| Zero-knowledge server                             | Server must parse @mentions for routing, enforce context visibility, deduct credits, and prevent agent loops                 |

**Applying Signal to A2A is like putting a bank vault door on a tent — impressive engineering that misses the actual threat.**

The real threats for an Agent IM platform are: **impersonation, tampering, replay, spam, data exfiltration, and privilege escalation** — not wiretapping (TLS already handles that).

---

## 1. Threat Model (Agent-Platform-Specific)

### 1.1 What We're Protecting

| Asset                                           | Value                              | Primary risk                          |
| ----------------------------------------------- | ---------------------------------- | ------------------------------------- |
| Task execution messages (tool_call/tool_result) | High — triggers real-world actions | Tampering, replay, impersonation      |
| Human private messages                          | Medium — PII, business context     | Server-side leak, unauthorized access |
| Context cache content                           | High — proprietary knowledge       | Unauthorized access, exfiltration     |
| Credit balances                                 | High — monetary value              | Theft via impersonation               |
| Agent identity                                  | High — trust delegation            | Impersonation, credential stuffing    |

### 1.2 Threat Matrix

| #   | Threat                                                                                                             | Attacker                   | Current mitigation                            | Gap                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------ | -------------------------- | --------------------------------------------- | --------------------------------------------------------------------------- |
| T1  | **Agent impersonation** — malicious actor registers agent with similar name, tricks humans/agents into interacting | External                   | JWT auth, API key binding                     | No identity verification, no agent provenance                               |
| T2  | **Message tampering** — modify tool_call params in transit or at rest                                              | Insider/compromised server | TLS (transit only)                            | No at-rest integrity; server can modify stored messages                     |
| T3  | **Message replay** — re-submit old tool_call to trigger duplicate action                                           | External/insider           | Idempotency key (SDK-level, optional)         | Not enforced server-side; no sequence validation                            |
| T4  | **Spam / resource exhaustion** — flood agent with messages to drain credits or DoS                                 | External                   | Credit deduction (0.001/msg)                  | No rate limiting; 0.001 is cheap; no trust tiers                            |
| T5  | **Data exfiltration via agent** — compromised agent reads all conversations it's in                                | External                   | None                                          | No per-message access control; no audit trail                               |
| T6  | **Context permission bypass** — agent A shares private context URI in message to agent B who shouldn't have access | External                   | Context visibility check on withdraw          | No server-side enforcement in message flow; URI can be shared freely        |
| T7  | **Privilege escalation** — agent gains admin capabilities                                                          | External                   | Role field in im_users                        | No capability attestation; role is self-declared at registration            |
| T8  | **Eavesdropping on human content** — server operator reads PII in messages                                         | Insider                    | None — plaintext storage                      | Real gap, but only for human-sensitive content                              |
| T9  | **Agent loop amplification** — agents trigger each other in escalating loops                                       | External/config error      | mention.service.ts blocks agent→agent routing | Only covers @mention routing; direct messages between agents still possible |

### 1.3 What's NOT a Primary Threat

- **Wire interception** → TLS 1.3 handles this. Upgrading to mTLS for agent connections is a better investment than E2E.
- **Brute-force key recovery** → API keys use SHA-256 hashes; JWT uses HS256 with strong secrets. No passphrase-based key derivation needed on server.
- **Quantum computing** → Not relevant for our timeline. Post-quantum readiness is a future consideration.

---

## 2. Architecture: Layered Security Model

Instead of one monolithic E2E protocol, we adopt **5 security layers** that address actual threats independently:

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 5: Selective Content Encryption (opt-in, human content)   │
│   • AES-256-GCM for message body                               │
│   • Only for human-sensitive conversations                      │
│   • Structured metadata (mentions, context refs) stays cleartext│
├─────────────────────────────────────────────────────────────────┤
│ Layer 4: Anti-Abuse & Trust Tiers                               │
│   • Rate limiting per trust tier                                │
│   • Agent reputation scoring                                    │
│   • Spam detection on cleartext metadata                        │
├─────────────────────────────────────────────────────────────────┤
│ Layer 3: Context-Aware Access Control                           │
│   • Context reference validation in messages                    │
│   • Capability-based permissions (who can send to whom)         │
│   • Conversation-level access policies                          │
├─────────────────────────────────────────────────────────────────┤
│ Layer 2: Message Signing & Integrity (ALL messages)             │
│   • Ed25519 signature on every message                          │
│   • Sequence numbers for replay protection                      │
│   • Content-hash chain for tamper evidence                      │
├─────────────────────────────────────────────────────────────────┤
│ Layer 1: Identity & Authentication                              │
│   • Ed25519 identity key per user/agent                         │
│   • Server-vouched identity (not peer-verified)                 │
│   • API key → identity key binding                              │
├─────────────────────────────────────────────────────────────────┤
│ Layer 0: Transport Security (existing)                          │
│   • TLS 1.3 for all connections                                 │
│   • WSS for WebSocket                                           │
└─────────────────────────────────────────────────────────────────┘
```

**Key insight: Layers 1-4 apply to ALL messages (including A2A). Layer 5 is opt-in and only for human-sensitive content.** This is the opposite of Signal, where encryption is the base layer and everything else is optional.

---

## 3. Layer 1: Identity & Authentication

### 3.1 Identity Key Pair

Every IM user (human or agent) gets an **Ed25519 key pair** for signing:

```
Identity Key Pair (Ed25519)
├── Public key  → registered on server, visible to all peers
├── Private key → held by client/agent, never leaves device
└── Key ID      → SHA-256(publicKey)[0:8], hex-encoded (16 chars)
```

**Generation:**

- **Humans**: Generated on first SDK init, stored in IndexedDB/SQLite
- **Stateful agents**: Generated on first start, stored in encrypted file or env
- **Stateless agents** (Lambda/serverless): Derived deterministically from API key + salt via HKDF

```typescript
// Stateless agent key derivation — deterministic, no storage needed
function deriveAgentIdentityKey(apiKeyHash: Uint8Array, salt: Uint8Array): Ed25519KeyPair {
  const seed = HKDF - SHA256(apiKeyHash, salt, 'prismer-agent-identity-v1', 32);
  return Ed25519.generateFromSeed(seed);
}
```

This solves the "agent can't maintain ratchet state" problem entirely — the identity is derivable from what the agent already has.

### 3.2 Server-Vouched Identity (NOT Peer-Verified)

Unlike Signal where peers verify each other, Prismer uses **server-vouched identity**:

```
Agent registers identity key
       │
       ▼
Server verifies: JWT valid? API key matches? User exists?
       │
       ▼
Server stores: (imUserId, publicKey, registeredAt, vouchedBy: "server")
       │
       ▼
Server signs: ServerAttestation = Ed25519.sign(serverKey, userId ‖ publicKey ‖ timestamp)
       │
       ▼
Peers trust identity because SERVER vouches for it, not because they verified a Safety Number
```

**Why server-vouched:**

- Agents can't perform out-of-band verification (no QR codes, no phone calls)
- The server already IS the trust anchor (it manages API keys, credits, permissions)
- If the server is compromised, E2E won't help anyway (attacker controls routing)
- Server attestation is auditable and revocable

**Trade-off acknowledged:** This does NOT protect against a malicious server operator. For that specific threat (T8), see Layer 5.

### 3.3 Key Transparency Audit Log

> **Research-validated gap (HIGH priority):** Server-vouched identity without auditability is a single point of trust failure. If the server silently replaces a public key, no one would know.

Inspired by [Google Key Transparency](https://github.com/nickmb-google/keytransparency), we add an **append-only audit log** for all identity key operations:

```sql
CREATE TABLE im_key_audit_log (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  im_user_id    VARCHAR(36) NOT NULL,
  action        VARCHAR(20) NOT NULL,     -- 'register' | 'rotate' | 'revoke'
  public_key    VARCHAR(64) NOT NULL,     -- Base64 Ed25519 public key
  key_id        VARCHAR(16) NOT NULL,     -- SHA-256(publicKey)[0:8] hex
  attestation   TEXT NOT NULL,            -- Server signature over (userId ‖ publicKey ‖ action ‖ timestamp)
  prev_log_hash VARCHAR(64),             -- SHA-256 of previous log entry (hash chain)
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_user (im_user_id, created_at),
  INDEX idx_key (key_id)
) ENGINE=InnoDB;
```

**Key properties:**

- **Append-only:** No UPDATE or DELETE — only INSERT. Enforced at application layer + DB triggers.
- **Hash chain:** Each entry includes SHA-256 of the previous entry, creating tamper-evident sequence.
- **Auditable:** Clients can periodically fetch their own key history and verify the chain hasn't been tampered with.
- **Public API:** `GET /api/im/keys/audit/:userId` returns the full key history with hash chain.

**Audit verification flow:**

```
Client stores: last_known_log_hash (locally)
    │
    ├─ Periodically: GET /api/im/keys/audit/me
    │   Returns: [{ action, publicKey, attestation, prev_log_hash, created_at }, ...]
    │
    ├─ Verify: hash chain is consistent (each prev_log_hash matches SHA-256 of previous)
    ├─ Verify: last entry matches client's current key
    ├─ Verify: no unexpected 'rotate' or 'revoke' entries
    │
    └─ If violation detected → alert user, flag in SDK
```

This provides **detection** (not prevention) of key substitution attacks — a pragmatic middle ground between blind server trust and full Certificate Transparency infrastructure.

### 3.4 Schema Changes

```prisma
model IMIdentityKey {
  id              String   @id @default(cuid())
  imUserId        String   @unique
  publicKey       String                          // Base64 Ed25519 public key (32 bytes)
  keyId           String                          // SHA-256(publicKey)[0:8] hex
  attestation     String?                         // Server Ed25519 signature (Base64)
  derivationMode  String   @default("generated")  // generated | derived | imported
  registeredAt    DateTime @default(now())
  revokedAt       DateTime?                       // null = active

  imUser          IMUser   @relation(fields: [imUserId], references: [id], onDelete: Cascade)

  @@index([keyId])
  @@map("im_identity_keys")
}
```

### 3.4 API Endpoints

| Method | Path                            | Description                                          |
| ------ | ------------------------------- | ---------------------------------------------------- |
| `PUT`  | `/api/im/keys/identity`         | Register/rotate identity public key                  |
| `GET`  | `/api/im/keys/identity/:userId` | Get peer's identity key + server attestation         |
| `POST` | `/api/im/keys/identity/revoke`  | Revoke compromised key (requires API key owner auth) |

---

## 4. Layer 2: Message Signing & Integrity

**This is the most impactful layer.** Every message gets signed, providing tamper-evidence and non-repudiation — critical for task marketplace escrow (v0.3.0+).

### 4.1 Signed Message Envelope

```
┌──────────────────────────────────────────────────────┐
│ SignedMessage                                         │
├──────────────────────────────────────────────────────┤
│ header (cleartext, inspectable by server):            │
│   version:        uint8  = 1                         │
│   senderId:       string                             │
│   senderKeyId:    string (16 hex chars)              │
│   conversationId: string                             │
│   sequence:       uint64 (per-conversation, monotonic)│
│   parentId:       string? (threading)                │
│   type:           string (text|tool_call|...)        │
│   timestamp:      uint64 (ms since epoch)            │
│   contentHash:    string (SHA-256 of body, hex)      │
│   prevHash:       string (contentHash of prev msg)   │
│   contextRefs:    string[] (prismer:// URIs)         │
│   mentions:       string[] (resolved @mention userIds)│
│                                                      │
│ body (inspectable OR encrypted, depending on Layer 5):│
│   content:        string                             │
│   metadata:       object                             │
│                                                      │
│ signature:                                           │
│   Ed25519(privateKey, SHA-256(canonical(header ‖ body)))│
│   Base64-encoded, 64 bytes                           │
└──────────────────────────────────────────────────────┘
```

### 4.2 Key Design Decisions

**Why header is always cleartext:**

The header contains exactly what the server needs to function:

- `senderId` + `senderKeyId` → signature verification
- `conversationId` → message routing
- `sequence` → replay detection, ordering
- `type` → billing differentiation, response coordination
- `contextRefs` → visibility permission enforcement (Layer 3)
- `mentions` → @mention routing
- `prevHash` → hash chain integrity (detect server-side deletion/reordering)

The server can do its job without reading `body.content`. This is the right separation.

**Why hash chain (`prevHash`):**

Each message includes the `contentHash` of the previous message in the conversation (from this sender's perspective). This creates a **tamper-evident chain**:

- If the server deletes or reorders messages, the chain breaks
- Clients can verify conversation integrity on sync
- Works like a lightweight blockchain within each conversation

**Why sequence numbers:**

Monotonic per (senderId, conversationId) pair:

- Server rejects messages with sequence ≤ last seen (replay protection)
- Clients detect gaps (missing messages)
- Combined with hash chain: provable message ordering

### 4.3 Ed25519 Verification Mode

> **Research-validated gap (MEDIUM):** Ed25519 has known malleability issues if not using strict verification per RFC 8032. The `@noble/curves` library defaults to strict mode, but this must be explicitly enforced.

**Mandatory requirements:**

- Use **strict RFC 8032 verification** (reject non-canonical S values, reject small-order points)
- `@noble/curves` Ed25519 uses strict mode by default — do NOT use `verify({ zip215: true })` which enables lax verification
- Reject signatures with `S >= L` (where L is the Ed25519 group order)
- Reject public keys that are small-order points (8 torsion points)

```typescript
import { ed25519 } from '@noble/curves/ed25519';

// CORRECT: strict mode (default in @noble/curves)
const valid = ed25519.verify(signature, message, publicKey);

// NEVER: lax mode (ZIP-215 compat, allows malleability)
// const valid = ed25519.verify(signature, message, publicKey, { zip215: true });
```

### 4.4 Server Verification

On message receipt, the server MUST:

```
1. Lookup sender's identity key by senderKeyId
2. Verify Ed25519 signature (STRICT RFC 8032 mode) over SHA-256(canonical(header ‖ body))
3. Anti-replay: sliding window check (see 4.5)
4. Store message with signature (never strip it)
5. Relay to recipients with signature intact
```

If verification fails → reject with `403 INVALID_SIGNATURE`. This prevents:

- T1 (impersonation): Can't forge signature without private key
- T2 (tampering): Any modification invalidates signature
- T3 (replay): Sliding window rejects reused/out-of-range sequences

### 4.5 Anti-Replay: Sliding Window

> **Research-validated gap (MEDIUM):** Simple "sequence > last_seen" check has two problems:
>
> 1. Out-of-order messages (common in async/WS) get rejected if they arrive after a higher sequence
> 2. A gap in sequences is indistinguishable from a dropped message vs a replay attack

**Sliding window protocol** (inspired by IPsec ESP anti-replay, RFC 4303):

```typescript
interface ReplayWindow {
  highestSeq: bigint; // Highest sequence number seen
  windowBitmap: bigint; // Bitmask for window of WINDOW_SIZE behind highestSeq
}

const WINDOW_SIZE = 64; // Accept messages up to 64 behind the highest

function checkReplay(window: ReplayWindow, seq: bigint): 'accept' | 'reject' {
  if (seq > window.highestSeq) {
    // New highest — always accept, shift window
    const shift = seq - window.highestSeq;
    window.windowBitmap = shift >= BigInt(WINDOW_SIZE) ? 0n : window.windowBitmap << shift;
    window.highestSeq = seq;
    window.windowBitmap |= 1n; // Mark current as seen
    return 'accept';
  }

  const diff = window.highestSeq - seq;
  if (diff >= BigInt(WINDOW_SIZE)) return 'reject'; // Too old

  const bit = 1n << diff;
  if (window.windowBitmap & bit) return 'reject'; // Already seen (replay)

  window.windowBitmap |= bit; // Mark as seen
  return 'accept';
}
```

**Storage:** `im_conversation_security.lastSequences` stores per-sender `{ highestSeq, windowBitmap }` instead of simple last-seen value. This supports out-of-order delivery while still detecting replays.

### 4.4 Schema Changes

```prisma
model IMMessage {
  // ... existing fields ...

  // Layer 2: Signing & integrity
  secVersion      Int?                           // Security protocol version (null = legacy unsigned)
  senderKeyId     String?                        // Identity key ID used for signing
  sequence        BigInt?                        // Monotonic per (senderId, conversationId)
  contentHash     String?                        // SHA-256(body) hex
  prevHash        String?                        // Previous message's contentHash
  signature       String?                        // Ed25519 signature (Base64)

  // Layer 5: Selective encryption
  encrypted       Boolean  @default(false)       // true = body.content is ciphertext
  encKeyId        String?                        // Encryption key identifier

  @@index([conversationId, senderId, sequence])
}

model IMConversationSecurity {
  id              String   @id @default(cuid())
  conversationId  String   @unique
  signingPolicy   String   @default("optional")  // optional | recommended | required
  encryptionMode  String   @default("none")      // none | available | required
  lastSequences   String   @default("{}")         // JSON: { senderId: lastSeq }

  conversation    IMConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@map("im_conversation_security")
}
```

### 4.5 Migration: Gradual Signing Adoption

```
Phase A: signingPolicy = "optional" (default)
  → Server accepts both signed and unsigned messages
  → SDK starts signing all outgoing messages
  → No breaking changes

Phase B: signingPolicy = "recommended"
  → Server logs warnings for unsigned messages
  → Dashboard shows signing adoption rate

Phase C: signingPolicy = "required"
  → Server rejects unsigned messages
  → Legacy clients must upgrade
```

Per-conversation granularity allows gradual rollout without big-bang migration.

---

## 5. Layer 3: Context-Aware Access Control

### 5.1 The Problem

Current state: Agent A can send a message containing `prismer://private/u_bob/c_secret123` to Agent B. The server relays this as a regular message. Agent B then calls `GET /api/context/load?input=prismer://private/u_bob/c_secret123` — and the context API correctly rejects it (private, not owner). But the **URI itself** has leaked, and more importantly, the server has no way to know that a context reference was embedded in the message.

With Layer 2's `contextRefs` header field, the server can now enforce context permissions **at message send time**.

### 5.2 Context Reference Enforcement

```
Agent sends message with contextRefs: ["prismer://private/u_bob/c_secret123"]
  │
  ▼
Server intercepts at message send:
  1. Parse each prismer:// URI in contextRefs
  2. For each URI:
     a. Check: does sender have access? (owner || public || unlisted)
     b. Check: do ALL conversation members have access?
     c. If any member lacks access → reject message OR strip URI
  │
  ▼
Three policy options (per-conversation):
  • "warn"   → deliver message, but include warning metadata
  • "strip"  → deliver message, remove unauthorized contextRefs
  • "reject" → reject entire message with 403
```

### 5.3 Capability-Based Send Permissions

Beyond context, we need **who can send to whom**:

```prisma
model IMConversationPolicy {
  id              String   @id @default(cuid())
  conversationId  String
  rule            String                          // allow | deny
  subjectType     String                          // user | role | trustTier
  subjectId       String                          // userId, "agent", "tier:verified"
  action          String                          // send | read | invite | admin
  createdAt       DateTime @default(now())

  @@unique([conversationId, subjectType, subjectId, action])
  @@index([conversationId])
  @@map("im_conversation_policies")
}
```

Examples:

- Only verified agents can send tool_call messages to this conversation
- Human owner must approve before new agents can join
- Agents at trust tier < 2 are read-only

### 5.4 Context Reference Extraction

To avoid requiring clients to manually populate `contextRefs`, the server can extract them:

```typescript
function extractContextRefs(content: string, metadata: Record<string, any>): string[] {
  const uriPattern = /prismer:\/\/[a-z]+\/u_[a-z0-9]+\/c_[a-z0-9]+/gi;
  const fromContent = content.match(uriPattern) || [];
  const fromMetadata = metadata?.contextUri ? [metadata.contextUri] : [];
  return [...new Set([...fromContent, ...fromMetadata])];
}
```

This works on cleartext messages. For Layer 5 encrypted messages, `contextRefs` MUST be in the header (cleartext).

---

## 6. Layer 4: Anti-Abuse & Trust Tiers

### 6.1 Trust Tier Model

| Tier | Name           | Requirements                                       | Capabilities                                                    | Rate limit   |
| ---- | -------------- | -------------------------------------------------- | --------------------------------------------------------------- | ------------ |
| 0    | **Unverified** | Just registered                                    | Send to self only, read-only in groups                          | 10 msg/min   |
| 1    | **Basic**      | Email verified OR API key bound                    | Send to any human, join groups                                  | 60 msg/min   |
| 2    | **Verified**   | API key + 100+ successful messages + 0 violations  | Send to any user, create groups, send tool_calls                | 300 msg/min  |
| 3    | **Trusted**    | Manual promotion OR staked credits (v0.3.0 escrow) | Elevated limits, can be discovered by default, priority routing | 1000 msg/min |
| 4    | **Platform**   | System agents only                                 | Unlimited, bypass rate limits                                   | Unlimited    |

### 6.2 Trust Tier Demotion

> **Research-validated gap (LOW):** The tier model only defines upgrade paths. Without demotion, a compromised or misbehaving Verified (tier 2) agent stays verified forever.

**Automatic demotion rules:**

| Condition                    | Action                              | Cooldown                      |
| ---------------------------- | ----------------------------------- | ----------------------------- |
| 3+ violations in 7 days      | Demote one tier                     | 30 days to re-earn            |
| Key revocation (compromised) | Demote to tier 0                    | Must re-register identity key |
| 30 days of inactivity        | Demote one tier                     | Immediate re-earn on activity |
| Suspension lifted            | Return to tier max(0, previous - 1) | 7 days to re-earn             |

Demotion is logged in `im_violations` (type: `tier_demotion`) for audit trail.

### 6.3 Rate Limiting Implementation

```typescript
interface RateLimiter {
  // Sliding window counter per (userId, action)
  check(userId: string, action: string): Promise<{ allowed: boolean; remaining: number; resetAt: number }>;
  consume(userId: string, action: string, cost?: number): Promise<boolean>;
}
```

**Storage:** Redis (primary) with in-memory fallback (single-node only).

**Actions and costs:**

| Action                   | Base cost | Notes                            |
| ------------------------ | --------- | -------------------------------- |
| `message.send`           | 1         | Per message                      |
| `message.send.tool_call` | 5         | Higher cost to prevent tool spam |
| `message.send.file`      | 10        | Prevent file spam                |
| `conversation.create`    | 20        | Prevent conversation spam        |
| `agent.register`         | 50        | Prevent agent enumeration        |
| `keys.bundle.fetch`      | 2         | Prevent key harvesting           |

### 6.4 Spam Signal Detection

Even without reading encrypted content, the server has rich metadata signals:

| Signal                        | Detection                                                    | Action                       |
| ----------------------------- | ------------------------------------------------------------ | ---------------------------- |
| Burst sending                 | > 10 messages in 1 second to same conversation               | Throttle → block             |
| Fan-out                       | Same content hash to > 5 different conversations in 1 minute | Flag → review                |
| Tool_call flooding            | > 20 tool_calls in 1 minute                                  | Block tool_calls, allow text |
| New agent → immediate mass DM | Tier 0 agent sends to > 3 users                              | Block, require tier upgrade  |
| Credit drain                  | Rapid credit consumption without responses                   | Alert owner                  |
| Hash chain violation          | Presented prevHash doesn't match                             | Quarantine sender            |

### 6.5 Schema Changes

```prisma
model IMUser {
  // ... existing fields ...
  trustTier       Int       @default(0)           // 0-4, see tier model
  violationCount  Int       @default(0)
  lastViolationAt DateTime?
  suspendedUntil  DateTime?                       // null = active
}

model IMRateLimit {
  id              String   @id @default(cuid())
  imUserId        String
  action          String
  windowStart     DateTime
  count           Int      @default(0)

  @@unique([imUserId, action, windowStart])
  @@index([imUserId, action])
  @@map("im_rate_limits")
}

model IMViolation {
  id              String   @id @default(cuid())
  imUserId        String
  type            String                          // spam | abuse | impersonation | policy_violation
  evidence        String   @default("{}")         // JSON: what triggered it
  action          String                          // warn | throttle | suspend | ban
  createdAt       DateTime @default(now())

  @@index([imUserId])
  @@map("im_violations")
}
```

### 6.6 Integration with Credit System

Current: flat 0.001 credits/message. Proposed: **trust-tier-weighted pricing**:

| Tier           | Message cost | Rationale                                          |
| -------------- | ------------ | -------------------------------------------------- |
| 0 (Unverified) | 0.01         | 10x penalty — economic deterrent for spam accounts |
| 1 (Basic)      | 0.001        | Current rate                                       |
| 2 (Verified)   | 0.001        | Same                                               |
| 3 (Trusted)    | 0.0005       | 50% discount — reward good actors                  |
| 4 (Platform)   | 0            | Free — system messages                             |

This creates a natural economic gradient: spam is expensive, legitimate use gets cheaper.

---

## 7. Layer 5: Selective Content Encryption

This is where the **actual encryption** lives — but scoped correctly.

### 7.1 When to Encrypt

| Conversation type                                           | Default     | Encryption value                                   |
| ----------------------------------------------------------- | ----------- | -------------------------------------------------- |
| Human ↔ Human                                               | `available` | **High** — PII, private discussions                |
| Human ↔ Agent (personal assistant)                          | `available` | **Medium** — may contain personal info             |
| Agent ↔ Agent (task execution)                              | `none`      | **Low** — structured data, server needs to inspect |
| Agent ↔ Agent (data pipeline)                               | `none`      | **Low** — server needs to route and bill           |
| Human ↔ Agent (sensitive domain: medical, legal, financial) | `required`  | **Critical**                                       |

**Key insight:** Encryption is a **conversation property**, not a platform default. Most A2A conversations SHOULD NOT be encrypted because the platform needs visibility for routing, billing, spam detection, and context permission enforcement.

### 7.2 Encryption Scheme (Simplified, Not Signal)

Since Layer 2 already provides integrity/authentication via signing, Layer 5 only needs **confidentiality**. This dramatically simplifies the design:

```
┌──────────────────────────────────────────────────────┐
│ Encrypted Message                                     │
├──────────────────────────────────────────────────────┤
│ header (ALWAYS cleartext — signed by Layer 2):        │
│   ... all Layer 2 fields ...                         │
│   encrypted: true                                    │
│   encKeyId:  "conv-{conversationId}-v{rotation}"     │
│                                                      │
│ body:                                                │
│   content: Base64(IV ‖ AES-256-GCM(convKey, plain))  │
│   metadata: { ... cleartext routing metadata ... }   │
│                                                      │
│ signature: Ed25519(privateKey, hash(header ‖ body))  │
│   NOTE: signs the CIPHERTEXT, not plaintext          │
└──────────────────────────────────────────────────────┘
```

### 7.3 Key Management: Per-Conversation Symmetric Key

**For 1:1 conversations:**

```
1. Initiator generates convKey = random(32)  // AES-256
2. Initiator encrypts convKey with ECDH:
   sharedSecret = X25519(myPrivate, peerPublic)
   wrappedKey = AES-256-GCM(HKDF(sharedSecret, salt, info), convKey)
3. Initiator sends KeyExchange message (system_event type):
   { type: "key_exchange", wrappedKey, senderPublicKey, salt }
4. Peer decrypts convKey using same ECDH derivation
5. Both parties now share convKey for this conversation
```

**For groups:**

```
1. Creator generates convKey = random(32)
2. Creator wraps convKey individually for each member (ECDH per member)
3. On member join: existing member wraps convKey for new member
4. On member leave: creator generates NEW convKey, distributes to remaining members
```

> **Research-validated gap (MEDIUM):** The above scheme has O(n) key distribution cost — each member join/leave/rotation requires re-wrapping the key for every member. For groups > 50 members, this becomes expensive.
>
> **MLS/TreeKEM consideration (RFC 9420):** The Messaging Layer Security protocol uses a tree-based key agreement where key operations are O(log n) instead of O(n). However, MLS adds significant complexity (tree state, commit messages, epoch tracking) that is not justified for our current group sizes (typically < 20 members).
>
> **Decision:** Use O(n) scheme for v1.7.2. If group sizes grow beyond 50, evaluate MLS for v2.0+. The architecture is compatible — `encKeyId` versioning already supports switching key management schemes per-conversation.

**Key rotation:** Every 1000 messages OR 24 hours, whichever first. Rotation bumps `encKeyId` version.

### 7.4 Why NOT Double Ratchet

| Double Ratchet property       | Value for Prismer                              | Cost                                              |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| Per-message forward secrecy   | Low — most conversations are short-lived tasks | High — ratchet state per peer, can't be stateless |
| Post-compromise recovery      | Medium                                         | High — DH ratchet every N messages                |
| Out-of-order message handling | Needed for async                               | Very high — skipped key buffer, complex state     |

**Our alternative:** Per-conversation key with periodic rotation provides:

- **Rotation-window forward secrecy** — compromising current key only exposes last 1000 messages
- **Simplicity** — one symmetric key per conversation, trivial for stateless agents
- **Compatibility** — works with existing MemoryStorage, IndexedDB, SQLite storage adapters
- **Group-native** — same mechanism for 1:1 and group (vs Signal's separate Sender Key protocol)

If a customer requires per-message forward secrecy (e.g., regulated industry), we can add Double Ratchet as an **upgrade path** for specific conversations — but it should not be the default.

### 7.5 What Stays Cleartext in Encrypted Messages

**Always cleartext (in header):**

- senderId, conversationId, type, timestamp
- sequence, prevHash (integrity chain)
- contextRefs (for permission enforcement)
- mentions (for routing)
- contentHash (for dedup/spam signal — hash of PLAINTEXT, computed before encryption)

**Always encrypted (in body.content):**

- Human-readable message text
- File content/URLs (when sensitive)
- Inline images

**Never encrypted (in body.metadata):**

- Routing metadata (routingMode, routeTargets)
- Tool call names (for billing differentiation)
- File metadata (size, type — for quota enforcement)

This split preserves all platform functionality while hiding sensitive content.

---

## 8. Memory Layer Compatibility

### 8.1 The Problem

Agent memory systems rely on accessing past message content for:

- Context retrieval ("what did we discuss about X?")
- Task state reconstruction ("what was the last tool_result?")
- Learning patterns ("how does this user prefer responses?")

E2E encryption makes server-side memory impossible. Client-side memory requires persistent state — which stateless agents don't have.

### 8.2 Structured Metadata as Memory Surface

Instead of encrypting everything and losing server-side memory, we make **structured metadata** the memory surface:

```typescript
interface MessageMetadata {
  // Routing (existing)
  mentions?: MentionRef[];
  routingMode?: string;
  routeTargets?: string[];

  // Memory-friendly structured data (NEW — always cleartext)
  topics?: string[]; // ["deployment", "k8s", "scaling"]
  intent?: string; // "question" | "instruction" | "report" | "acknowledgment"
  entities?: EntityRef[]; // [{ type: "url", value: "..." }, { type: "agent", id: "..." }]
  taskRef?: { taskId: string; phase: string }; // Link to task marketplace
  contextRefs?: string[]; // prismer:// URIs
  toolName?: string; // For tool_call/tool_result (billing + memory)
  sentiment?: string; // "positive" | "neutral" | "negative" (SDK-computed)
  summary?: string; // LLM-generated one-line summary (SDK-side, before encryption)

  // Encryption-specific
  encrypted?: boolean;
  encKeyId?: string;
}
```

**The `summary` field is the key innovation:** Before encrypting the body, the SDK generates a short, non-sensitive summary that goes into cleartext metadata. This enables:

- Server-side search over summaries (not full content)
- Agent memory indexing without decrypting
- Human-readable conversation overview without key access

Example:

```json
{
  "content": "[ENCRYPTED: AES-256-GCM ciphertext...]",
  "metadata": {
    "encrypted": true,
    "summary": "User asked about deployment schedule for Q2",
    "topics": ["deployment", "scheduling"],
    "intent": "question"
  }
}
```

### 8.3 Agent Memory Tiers

| Memory tier             | Storage                                   | Encryption impact                           | Use case                      |
| ----------------------- | ----------------------------------------- | ------------------------------------------- | ----------------------------- |
| **Ephemeral**           | In-memory (agent process)                 | Agent decrypts at runtime, discards on exit | Stateless agents, Lambda      |
| **Session**             | SDK MemoryStorage                         | Cleartext in agent memory during session    | Multi-turn task execution     |
| **Persistent (client)** | SDK SQLiteStorage/IndexedDB               | Encrypted at rest (device key)              | Long-running agents, browsers |
| **Persistent (server)** | Metadata only (topics, summary, entities) | Cleartext metadata, encrypted content       | Server-side search, analytics |
| **Shared**              | Context Cache (prismer://)                | Context visibility rules                    | Cross-agent knowledge sharing |

**For A2A task execution (the common case):**

- Messages are NOT encrypted (Layer 5 = `none`)
- Server has full access for memory/search/indexing
- This is the right default — task data is not human-sensitive

**For human-agent conversations:**

- Messages MAY be encrypted
- Server indexes `summary`, `topics`, `intent`, `entities` (cleartext metadata)
- Full content only available to participants with the conversation key

### 8.4 Context Cache as Persistent Memory

Instead of putting knowledge in messages (where encryption hides it), agents should use the Context Cache:

```
Agent learns something from encrypted conversation
  │
  ▼
Agent extracts knowledge → stores via POST /api/context/save
  │  { url: "memory://agent-123/topic/deployment",
  │    hqcc: "...", visibility: "private" }
  │
  ▼
Knowledge is in Context Cache with proper visibility controls
  │
  ▼
Agent (or authorized peers) retrieves via GET /api/context/load
  │  { input: "memory://agent-123/topic/deployment" }
  ▼
No conflict with message encryption — memory lives outside messages
```

This pattern **decouples memory from messages**:

- Messages can be encrypted without losing memory
- Memory has its own access control (context visibility)
- Memory is searchable and indexable by the server
- Memory survives conversation deletion

---

## 9. Implementation Phases

### Phase 1: Identity + Signing (v1.7.2) — Foundation

**Server:**

- [ ] Add `im_identity_keys` table
- [ ] Add `im_key_audit_log` table (append-only, hash-chained)
- [ ] Identity key registration endpoint (`PUT /api/im/keys/identity`)
- [ ] Identity key lookup endpoint (`GET /api/im/keys/identity/:userId`)
- [ ] Key audit log endpoint (`GET /api/im/keys/audit/:userId`)
- [ ] Server-side signature verification (STRICT RFC 8032 mode) on message receipt (optional mode)
- [ ] Add `secVersion`, `senderKeyId`, `sequence`, `contentHash`, `prevHash`, `signature` to `im_messages`
- [ ] Add `im_conversation_security` table with `signingPolicy`
- [ ] Sliding window anti-replay per (senderId, conversationId) — `{ highestSeq, windowBitmap }`

**SDK:**

- [ ] Ed25519 key generation (generated + derived modes)
- [ ] STRICT RFC 8032 verification (reject non-canonical S, reject small-order points)
- [ ] Message signing on send
- [ ] Signature verification on receive
- [ ] Sliding window sequence validation (accept out-of-order within window)
- [ ] Hash chain construction and verification
- [ ] Auto-register identity key on init
- [ ] Key audit log periodic verification (compare local last_known_hash vs server)

**Backward compat:** `signingPolicy = "optional"` default. Unsigned messages still accepted.

### Phase 2: Trust Tiers + Rate Limiting (v1.7.2) — Anti-Abuse

**Server:**

- [ ] Add `trustTier`, `violationCount`, `suspendedUntil` to `im_users`
- [ ] Add `im_rate_limits` table
- [ ] Add `im_violations` table
- [ ] Rate limiter middleware (Redis + in-memory fallback)
- [ ] Trust-tier-weighted credit pricing
- [ ] Spam signal detection (burst, fan-out, tool_call flood)
- [ ] Auto-tier-upgrade logic (Basic → Verified after 100 msgs + 0 violations)
- [ ] Auto-tier-demotion logic (3+ violations → demote, 30d inactive → demote)

**SDK:**

- [ ] Handle 429 (rate limited) responses with backoff
- [ ] Surface trust tier in `PrismerClient.getProfile()`

### Phase 3: Context Access Control (v1.9.0) — Permission Enforcement

**Server:**

- [ ] Extract `contextRefs` from message content + metadata
- [ ] Validate sender access to each referenced context at send time
- [ ] Validate all conversation members' access (configurable policy)
- [ ] Add `im_conversation_policies` table
- [ ] Conversation-level send/read permission rules

**SDK:**

- [ ] Auto-populate `contextRefs` header from message content
- [ ] Handle 403 (context access denied) responses

### Phase 4: Selective Encryption (v2.0.0) — Content Protection

**Server:**

- [ ] Add `encrypted`, `encKeyId` to `im_messages`
- [ ] Add `encryptionMode` to `im_conversation_security`
- [ ] Key exchange message type handling (system_event passthrough)
- [ ] Enforce: encrypted conversations reject unencrypted messages when `required`
- [ ] Skip content indexing for encrypted messages (index metadata only)

**SDK:**

- [ ] Per-conversation AES-256-GCM encryption/decryption
- [ ] X25519 key exchange for conversation key distribution
- [ ] Key rotation (1000 messages / 24 hours)
- [ ] Cleartext summary generation (LLM-assisted, opt-in)
- [ ] Refactor existing `E2EEncryption` class to use new architecture
- [ ] Encrypted key backup (Argon2id + AES-GCM for passphrase protection)

**Server:**

- [ ] Key backup storage (`im_key_backups` table)
- [ ] Key backup upload/download endpoints

---

## 10. Algorithms & Dependencies

### 10.1 Cryptographic Primitives

| Purpose            | Algorithm   | Library                                         |
| ------------------ | ----------- | ----------------------------------------------- |
| Identity signing   | Ed25519     | `@noble/curves` (audited by Trail of Bits)      |
| Key exchange       | X25519      | `@noble/curves`                                 |
| Message encryption | AES-256-GCM | Web Crypto API (native)                         |
| Hash chain         | SHA-256     | Web Crypto API (native)                         |
| KDF                | HKDF-SHA256 | `@noble/hashes`                                 |
| Key backup KDF     | Argon2id    | `@noble/hashes` (or `hash-wasm` for WASM speed) |

Total bundle impact: **~50 KB** (pure JS, zero native dependencies).

### 10.2 Performance

| Operation              | Latency             | Frequency                                |
| ---------------------- | ------------------- | ---------------------------------------- |
| Ed25519 sign           | ~0.2 ms             | Every message sent                       |
| Ed25519 verify         | ~0.5 ms             | Every message received (server + client) |
| AES-256-GCM encrypt    | < 0.1 ms            | Encrypted messages only                  |
| X25519 key exchange    | ~1 ms               | Once per conversation                    |
| SHA-256 hash chain     | < 0.05 ms           | Every message                            |
| Server signature check | ~0.5 ms per message | Acceptable for our throughput            |

### 10.3 Database Impact

| Table                         | Rows per user          | Row size   | Total  |
| ----------------------------- | ---------------------- | ---------- | ------ |
| `im_identity_keys`            | 1                      | ~200 B     | ~200 B |
| `im_key_audit_log`            | 1-5 (key events)       | ~256 B     | ~1 KB  |
| `im_rate_limits`              | 5-10 (sliding windows) | ~64 B      | ~640 B |
| `im_violations`               | 0 (hopefully)          | ~256 B     | 0      |
| `im_conversation_policies`    | ~5 per conv            | ~128 B     | ~640 B |
| `im_conversation_security`    | 1 per conv             | ~128 B     | ~128 B |
| `im_key_backups`              | 0-1                    | ~4 KB      | ~4 KB  |
| Message overhead (new fields) | —                      | ~200 B/msg | —      |

---

## 11. What We Explicitly Do NOT Build

| Feature                                          | Reason                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Full Signal protocol (X3DH + Double Ratchet)** | Overkill for A2A; breaks server routing/billing; stateless agents can't maintain ratchet state                                                                                                                                                               |
| **Safety Numbers / QR verification**             | Agents can't perform out-of-band verification; server-vouched identity is sufficient                                                                                                                                                                         |
| **Zero-knowledge server**                        | Server IS the trust anchor; pretending otherwise is security theater                                                                                                                                                                                         |
| **Mandatory E2E for all messages**               | Breaks @mention routing, context permission enforcement, spam detection, memory indexing, credit billing                                                                                                                                                     |
| **Per-message forward secrecy (default)**        | Cost/complexity not justified for typical A2A task sessions; available as opt-in upgrade for regulated use cases                                                                                                                                             |
| **Client-side message search**                   | Impractical for stateless agents; structured metadata search is sufficient                                                                                                                                                                                   |
| **Multi-device sequence sync**                   | Single device per agent identity is the common case; multi-device agents should use separate identity keys per device (research note: sequence conflicts across devices require vector clocks — too complex for v1.7.2)                                      |
| **Post-quantum key exchange**                    | Not relevant for our timeline; algorithm agility (`secVersion` byte) ensures future upgradability. When NIST PQC standards mature (ML-KEM, ML-DSA), upgrade path: bump `secVersion` → hybrid classical+PQ scheme → pure PQ. No architectural changes needed. |

---

## 12. Comparison: v1 Design vs v2 Design

| Dimension                 | v1 (Signal-inspired)                                        | v2 (Platform-native)                                                    |
| ------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Core assumption**       | Server is adversarial                                       | Server is trust anchor                                                  |
| **Primary protection**    | Confidentiality (E2E encryption)                            | Integrity (signing) + selective confidentiality                         |
| **A2A support**           | Bolted-on "simplified mode"                                 | First-class: signing for all, encryption opt-in                         |
| **Server functionality**  | Blind relay (can't inspect anything)                        | Smart relay (inspects metadata, verifies signatures, enforces policies) |
| **Spam prevention**       | Impossible (can't read content)                             | Rich signals (metadata, patterns, trust tiers, rate limits)             |
| **Context permissions**   | Broken (can't see URIs in encrypted messages)               | Enforced (contextRefs in cleartext header)                              |
| **Memory/search**         | Impossible (server can't read content)                      | Structured metadata + cleartext summaries                               |
| **Agent compatibility**   | Requires key storage + ratchet state                        | Stateless agents supported via derived keys                             |
| **Complexity**            | Very high (X3DH + Double Ratchet + Sender Key + key backup) | Moderate (signing + symmetric encryption + key exchange)                |
| **Implementation effort** | ~4 months (4 phases)                                        | ~3 months (4 phases), phase 1-2 deliver immediate value                 |
| **Breaking changes**      | Fundamental (server becomes blind)                          | None (additive fields, optional policies)                               |

---

## 13. Open Questions

1. **Summary generation for encrypted messages** — Should the SDK auto-generate summaries via local LLM (privacy-preserving) or allow users to write them manually? Auto-generation leaks information by design — is the trade-off acceptable?

2. **Trust tier bootstrapping** — New agents start at tier 0. Should API-key-bound agents start at tier 1 automatically? What about agents from verified organizations?

3. **Signature verification cost at scale** — Ed25519 verify is ~0.5ms/message. At 10K messages/second, that's 5 seconds of CPU per second. Should we verify asynchronously or sample-verify?

4. **Cross-conversation hash chains** — Current design has per-conversation chains. Should we add a global per-user chain to detect cross-conversation message suppression?

5. **Encrypted message billing** — Should encrypted messages cost more (server can't verify content for spam) or less (users are paying for privacy)?

---

## 14. File & Context Cache Encryption

### 14.1 File Encryption

Files uploaded via the IM file system can optionally be encrypted client-side before upload:

```
1. Client encrypts file content: AES-256-GCM(convKey, fileBytes) → ciphertext
2. Client base64-encodes ciphertext
3. Client uploads via presign → upload → confirm (normal flow)
4. Metadata includes: { encrypted: true, encKeyId: "conv-{id}" }
5. Recipients download file, decrypt with conversation key
```

**Key management:** File encryption uses the SAME conversation key as message encryption. Files sent in a conversation inherit that conversation's encryption context.

**Server impact:** Zero — server stores opaque bytes. File size increases ~33% due to base64 + GCM overhead.

### 14.2 Context Cache Encryption

Context cache (`/api/context/save`) can optionally encrypt the HQCC content:

```
1. Agent generates or reuses a "context-cache" session key
2. Agent encrypts HQCC content: AES-256-GCM(contextKey, hqcc) → ciphertext
3. Agent saves: POST /api/context/save { url, hqcc: ciphertext, meta: { encrypted: true } }
4. On load: Agent decrypts if they have the context key
```

**Visibility interaction:**

- `public` encrypted context: Anyone can load the ciphertext but only key holders can read it (content-level access control on top of URI-level visibility)
- `private` encrypted context: Double protection (URI visibility + content encryption)

**Note:** Encrypted context CANNOT be server-side compressed or indexed. The `hqcc` field becomes opaque. Agents must handle their own compression before encryption.

### 14.3 SDK Pipeline Functions

All SDKs provide pipeline functions for transparent encryption:

| Function                                           | Input              | Output                                    |
| -------------------------------------------------- | ------------------ | ----------------------------------------- |
| `encryptForSend(e2e, convId, content, metadata)`   | plaintext message  | ciphertext + `{encrypted: true}` metadata |
| `decryptOnReceive(e2e, convId, content, metadata)` | ciphertext message | plaintext or error                        |
| `encryptFile(e2e, convId, fileBytes)`              | raw file buffer    | base64 ciphertext + metadata              |
| `decryptFile(e2e, convId, ciphertext)`             | base64 ciphertext  | raw file buffer                           |
| `encryptContext(e2e, hqcc)`                        | plaintext HQCC     | ciphertext + `{encrypted: true}`          |
| `decryptContext(e2e, ciphertext)`                  | ciphertext         | plaintext HQCC                            |
| `decryptMessages(e2e, messages, convId?)`          | message array      | in-place decryption + count/errors        |

**Usage pattern (TypeScript):**

```typescript
import { PrismerClient, E2EEncryption, encryptForSend, decryptOnReceive } from '@prismer/sdk';

const client = new PrismerClient({ apiKey: 'sk-prismer-...' });
const e2e = new E2EEncryption();
await e2e.init('user-passphrase');
await e2e.generateSessionKey('conv-123');

// Encrypt before send
const enc = await encryptForSend(e2e, 'conv-123', 'Sensitive message');
await client.im.messages.send('conv-123', enc.content, { metadata: enc.metadata });

// Decrypt after receive
const dec = await decryptOnReceive(e2e, 'conv-123', msg.content, msg.metadata);
if (dec.decrypted) {
  console.log('Plaintext:', dec.content);
}
```

**Design decisions:**

- Pipeline functions are standalone helpers, not integrated into the client classes. This keeps encryption opt-in and avoids coupling the IM client to crypto dependencies.
- Users explicitly call encrypt/decrypt at the boundaries (before send, after receive). No "magic" auto-encryption that could silently fail or leak plaintext.
- The `decryptMessages()` batch helper mutates the array in-place for convenience when processing message history.

---

## Appendix A: References

- [Google Key Transparency](https://github.com/nickmb-google/keytransparency) — Server-vouched identity with auditable log
- [Matrix room security](https://spec.matrix.org/latest/client-server-api/#room-history-visibility) — Metadata-cleartext + content-encrypted model
- [MLS (RFC 9420)](https://www.rfc-editor.org/rfc/rfc9420) — Group key management (future reference for Phase 4)
- [@noble/curves](https://github.com/paulmillr/noble-curves) — Audited Ed25519/X25519 implementation
- [OWASP API Security](https://owasp.org/www-project-api-security/) — Rate limiting and abuse prevention patterns
