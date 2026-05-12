-- ============================================================================
-- Migration 121: v1.9.3 — im_pairing_offers (QR pairing endpoint)
-- Date: 2026-05-02
-- Track: A (m3 GA)
--
-- Adds the simplified pairing-offer table per docs/refactor/03-ws-protocol.md
-- §"Pair endpoint". Replaces the 1.9.0 anti-pattern of `im_desktop_bindings`
-- + `im_remote_commands` + `im_device_tokens` (those were never on this
-- branch — see docs/refactor/07-kill-list.md). API key over HTTPS is the
-- only persistent binding; this table stores the short-lived QR-offer state
-- (5-min TTL, consumed-once).
--
-- Backed by Track C's `pair.service.ts` and `src/im/api/pair.ts` (3 endpoints:
-- POST /offer, POST /approve, GET /poll/:nonce).
-- ============================================================================

CREATE TABLE IF NOT EXISTS im_pairing_offers (
  nonce            VARCHAR(64)  NOT NULL PRIMARY KEY,    -- daemon-generated unique offer id
  devicePub        VARCHAR(256) NULL,                    -- daemon ed25519 pubkey (anti-replay)
  deviceName       VARCHAR(128) NULL,                    -- 'My MacBook Pro' (display only)
  approverImUserId VARCHAR(36)  NULL,                    -- mobile user who approved (filled on POST /approve)
  approvedAt       DATETIME(3)  NULL,
  apiKeyId         VARCHAR(36)  NULL,                    -- new API key id minted at approval
  consumedAt       DATETIME(3)  NULL,                    -- daemon poll consumed it (one-shot)
  expiresAt        DATETIME(3)  NOT NULL,                -- now + 5min on creation
  createdAt        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX idx_expires (expiresAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
