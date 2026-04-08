# RFC: @prismer/sdk v1.8.0 — Contact & Relationship System

> Author: luminpulse mobile team
> Date: 2026-04-02
> Status: **Proposed**
> Scope: Generic IM / A2A platform features — NOT project-specific

---

## Motivation

`@prismer/sdk` v1.7.4 has a mature IM core (messaging, conversations, groups, realtime, offline, files, E2E encryption) but lacks the **contact/relationship layer** that every IM and A2A system needs. Currently `ContactsClient` only provides `list()` (users communicated with) and `discover()` (agent discovery).

Any client building an IM product — whether human-to-human, human-to-agent, or agent-to-agent — needs:

1. A way to **find** users/agents by query
2. A **relationship lifecycle** (request → accept/reject → established → remove)
3. **Safety controls** (block/unblock)
4. **Realtime events** for relationship state changes
5. **Conversation-level controls** (pin, mute, archive)

These are universal IM primitives, not specific to any single client.

---

## P0: Contact & Friend System

### 1. User/Agent Search

```typescript
// ContactsClient addition
async search(query: string, options?: {
  type?: 'human' | 'agent' | 'all';  // default: 'all'
  limit?: number;                      // default: 20
  offset?: number;
}): Promise<IMResult<IMUserProfile[]>>
```

**Backend**: `GET /api/im/users/search?q=xxx&type=all&limit=20`

Returns partial user profiles (no sensitive data). Searches across `username`, `displayName`, and optionally `email` (if user has set it visible).

### 2. User Profile by ID

```typescript
// ContactsClient addition
async getProfile(userId: string): Promise<IMResult<IMUserProfile>>
```

**Backend**: `GET /api/im/users/:userId/profile`

Needed to show a user card before sending a friend request.

### 3. Friend Request Lifecycle

```typescript
// ContactsClient additions

/** Send a contact/friend request */
async request(userId: string, options?: {
  reason?: string;
  source?: string;  // e.g. 'search', 'qr_code', 'group', 'recommendation'
}): Promise<IMResult<IMFriendRequest>>

/** List received pending requests */
async pendingReceived(options?: IMPaginationOptions): Promise<IMResult<IMFriendRequest[]>>

/** List sent pending requests */
async pendingSent(options?: IMPaginationOptions): Promise<IMResult<IMFriendRequest[]>>

/** Accept a friend request — auto-creates mutual contact + direct conversation */
async accept(requestId: string): Promise<IMResult<{ contact: IMContact; conversationId: string }>>

/** Reject a friend request */
async reject(requestId: string): Promise<IMResult<void>>
```

**Backend endpoints**:
- `POST /api/im/contacts/request` — create request
- `GET /api/im/contacts/requests/received` — pending received
- `GET /api/im/contacts/requests/sent` — pending sent
- `POST /api/im/contacts/requests/:id/accept` — accept (side-effect: create mutual contact + conversation)
- `POST /api/im/contacts/requests/:id/reject` — reject

### 4. Contact Management

```typescript
// ContactsClient additions

/** Remove a contact (bidirectional) */
async remove(userId: string): Promise<IMResult<void>>

/** Set contact remark/alias (local display name override) */
async setRemark(userId: string, remark: string): Promise<IMResult<void>>

/** Block a user (hides from contacts, blocks messages) */
async block(userId: string): Promise<IMResult<void>>

/** Unblock a user */
async unblock(userId: string): Promise<IMResult<void>>

/** Get block list */
async blocklist(options?: IMPaginationOptions): Promise<IMResult<IMBlockedUser[]>>
```

**Backend endpoints**:
- `DELETE /api/im/contacts/:userId` — remove
- `PATCH /api/im/contacts/:userId/remark` — set remark
- `POST /api/im/contacts/:userId/block` — block
- `DELETE /api/im/contacts/:userId/block` — unblock
- `GET /api/im/contacts/blocked` — blocklist

### 5. New Types

```typescript
/** Enriched contact (replaces current minimal IMContact) */
export interface IMContact {
  userId: string;           // NEW — was missing
  username: string;
  displayName: string;
  role: string;
  avatarUrl?: string;       // NEW
  status?: string;          // NEW — online/offline/busy
  isAgent?: boolean;        // NEW — human vs agent
  remark?: string;          // NEW — custom alias
  addedAt?: string;         // NEW — when friendship established
  lastMessageAt?: string;
  unreadCount: number;
  conversationId: string;
}

/** Public user profile (returned from search / getProfile) */
export interface IMUserProfile {
  userId: string;
  username: string;
  displayName: string;
  role: string;
  avatarUrl?: string;
  status?: string;
  isAgent?: boolean;
  agentType?: string;       // if isAgent
  capabilities?: string[];  // if isAgent
  institution?: string;     // optional public field
}

/** Friend request */
export interface IMFriendRequest {
  id: string;
  fromUserId: string;
  fromUsername: string;
  fromDisplayName: string;
  fromAvatarUrl?: string;
  fromIsAgent?: boolean;
  toUserId: string;
  toUsername: string;
  toDisplayName: string;
  reason?: string;
  source?: string;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  createdAt: string;
  updatedAt?: string;
}

/** Blocked user entry */
export interface IMBlockedUser {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  blockedAt: string;
}
```

---

## P0: Realtime Events for Contact Lifecycle

The current `RealtimeEventMap` needs contact-related events. These are essential for push-based UX (badges, toast notifications).

```typescript
// RealtimeEventMap additions
export interface RealtimeEventMap {
  // ... existing events ...

  /** Someone sent you a friend request */
  'contact.request': ContactRequestPayload;

  /** Your sent request was accepted */
  'contact.accepted': ContactAcceptedPayload;

  /** Your sent request was rejected */
  'contact.rejected': ContactRejectedPayload;

  /** A contact removed you */
  'contact.removed': ContactRemovedPayload;

  /** A user blocked you (optional — some platforms don't notify) */
  'contact.blocked': ContactBlockedPayload;
}

export interface ContactRequestPayload {
  requestId: string;
  fromUserId: string;
  fromUsername: string;
  fromDisplayName: string;
  fromAvatarUrl?: string;
  reason?: string;
}

export interface ContactAcceptedPayload {
  requestId: string;
  userId: string;
  username: string;
  displayName: string;
  conversationId: string;
}

export interface ContactRejectedPayload {
  requestId: string;
  userId: string;
}

export interface ContactRemovedPayload {
  userId: string;
}

export interface ContactBlockedPayload {
  userId: string;
}
```

**Server-side**: After each contact mutation, broadcast the corresponding event to the affected user's realtime connections (WS + SSE).

---

## P1: Conversation Controls

Every IM client needs per-conversation settings. Currently `ConversationsClient` has `list`, `get`, `createDirect`, `markAsRead` — missing lifecycle controls.

```typescript
// ConversationsClient additions

/** Pin/unpin a conversation to the top of the list */
async pin(conversationId: string, pinned: boolean): Promise<IMResult<void>>

/** Mute/unmute notifications for a conversation */
async mute(conversationId: string, muted: boolean): Promise<IMResult<void>>

/** Archive a conversation (hide from active list) */
async archive(conversationId: string): Promise<IMResult<void>>

/** Unarchive a conversation */
async unarchive(conversationId: string): Promise<IMResult<void>>

/** Delete a conversation (local — hides, does not destroy server-side) */
async delete(conversationId: string): Promise<IMResult<void>>
```

**Backend endpoints**:
- `PATCH /api/im/conversations/:id/pin`
- `PATCH /api/im/conversations/:id/mute`
- `POST /api/im/conversations/:id/archive`
- `DELETE /api/im/conversations/:id/archive`
- `DELETE /api/im/conversations/:id`

**Type enrichment**:
```typescript
export interface IMConversation {
  // ... existing fields ...
  pinned?: boolean;       // NEW
  muted?: boolean;        // NEW
  archived?: boolean;     // NEW
}
```

---

## P1: Read Receipts & Delivery Status

Message delivery lifecycle events are a universal IM feature for both H2H and A2A.

```typescript
// MessagesClient addition
async markDelivered(conversationId: string, messageIds: string[]): Promise<IMResult<void>>

// RealtimeEventMap additions
'message.delivered': MessageDeliveredPayload;
'message.read': MessageReadPayload;
```

```typescript
export interface MessageDeliveredPayload {
  conversationId: string;
  messageIds: string[];
  userId: string;       // who received
  deliveredAt: string;
}

export interface MessageReadPayload {
  conversationId: string;
  messageIds: string[];
  userId: string;       // who read
  readAt: string;
}
```

**Server-side**: When `markAsRead(conversationId)` is called, broadcast `message.read` to the message senders. For delivery, the client calls `markDelivered()` upon receiving `message.new` events.

**Note**: For A2A, delivery/read receipts confirm that an agent has processed a message — important for task orchestration.

---

## P2: Online Status Queries

`presence.changed` events exist in realtime, but there's no REST API to batch-query online statuses (needed at app launch to populate contact list).

```typescript
// ContactsClient addition

/** Get online status for a list of user IDs */
async getPresence(userIds: string[]): Promise<IMResult<Array<{
  userId: string;
  status: string;     // 'online' | 'busy' | 'offline'
  lastSeenAt?: string;
}>>>
```

**Backend**: `POST /api/im/presence/batch` with `{ userIds: [...] }`

---

## P2: Account Profile Update

`AccountClient` has `register()` and `me()` but no way to update profile fields.

```typescript
// AccountClient addition
async updateProfile(options: {
  displayName?: string;
  avatarUrl?: string;
  institution?: string;
  description?: string;
}): Promise<IMResult<IMMeData>>
```

**Backend**: `PATCH /api/im/me/profile`

---

## P2: Conversation Created Event

When someone creates a direct conversation or adds you to a group, the SDK should emit a realtime event.

```typescript
// RealtimeEventMap addition
'conversation.created': ConversationCreatedPayload;

export interface ConversationCreatedPayload {
  conversationId: string;
  type: 'direct' | 'group';
  title?: string;
  createdBy: string;
  members: Array<{ userId: string; displayName: string }>;
}
```

---

## Database Schema Suggestions

These are backend implementation details, listed here for reference:

```sql
-- Friend requests
CREATE TABLE im_friend_requests (
  id            VARCHAR(36) PRIMARY KEY,
  from_user_id  VARCHAR(36) NOT NULL,
  to_user_id    VARCHAR(36) NOT NULL,
  reason        TEXT,
  source        VARCHAR(50),
  status        ENUM('pending', 'accepted', 'rejected', 'expired') DEFAULT 'pending',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_request (from_user_id, to_user_id, status),
  INDEX idx_to_pending (to_user_id, status),
  INDEX idx_from_pending (from_user_id, status)
);

-- Contacts (bidirectional friendship)
CREATE TABLE im_contacts (
  user_id       VARCHAR(36) NOT NULL,
  contact_id    VARCHAR(36) NOT NULL,
  remark        VARCHAR(100),
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, contact_id),
  INDEX idx_contact (contact_id)
);

-- Block list
CREATE TABLE im_blocks (
  user_id       VARCHAR(36) NOT NULL,
  blocked_id    VARCHAR(36) NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, blocked_id)
);

-- User profile extensions (optional, if im_users doesn't have these)
ALTER TABLE im_users ADD COLUMN avatar_url VARCHAR(500);
ALTER TABLE im_users ADD COLUMN institution VARCHAR(200);
ALTER TABLE im_users ADD COLUMN last_seen_at DATETIME;
```

---

## Priority Summary

| Priority | Feature | Scope |
|----------|---------|-------|
| **P0** | User search (`contacts.search()`) | Backend + SDK |
| **P0** | User profile (`contacts.getProfile()`) | Backend + SDK |
| **P0** | Friend request lifecycle (request/pending/accept/reject) | Backend + SDK |
| **P0** | Contact management (remove/remark/block/unblock/blocklist) | Backend + SDK |
| **P0** | Realtime events (contact.request/accepted/rejected/removed) | Backend + SDK |
| **P0** | `IMContact` type enrichment (userId, avatarUrl, status, isAgent, remark, addedAt) | SDK types |
| **P1** | Conversation controls (pin/mute/archive/delete) | Backend + SDK |
| **P1** | Read receipts & delivery status | Backend + SDK |
| **P2** | Online status batch query | Backend + SDK |
| **P2** | Account profile update | Backend + SDK |
| **P2** | `conversation.created` realtime event | Backend + SDK |

### Compatibility

All additions are **additive** — no breaking changes to existing v1.7.x API. New methods on existing clients, new types, new event types. Existing code continues to work unchanged.

### CLI Commands (optional)

```
prismer im search <query>           # search users
prismer im request <user-id>        # send friend request
prismer im requests                 # list pending received
prismer im accept <request-id>      # accept request
prismer im reject <request-id>      # reject request
prismer im block <user-id>          # block user
prismer im unblock <user-id>        # unblock user
```
