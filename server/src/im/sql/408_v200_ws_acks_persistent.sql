-- ============================================================================
-- Migration 408: v2.0 — Persistent WS ack tracker (im_ws_acks)
-- Date: 2026-05-21
-- Spec: docs/release200/14-messaging-state-machine-reliability.md §4.5
--
-- Background
-- ----------
-- §4.5 Track-D: ackTracker is currently in-memory with 5min TTL on each Pod —
-- Pod restart / pod drift loses pending acks. Multi-instance + Redis Backplane
-- requires a persisted ack table so a reconnecting WS client can ask the
-- server "what unacked events do I have since cursor T?" and get them
-- replayed (at-least-once delivery for client→server).
--
-- §P1 invariant: SOT-A (DB) + SOT-B (event log) + SOT-C (WS); im_ws_acks is
-- the durable counterpart to in-memory ackTracker.
--
-- Schema
-- ------
-- (id PK, userId, ackId, payloadJson, createdAt, ackedAt nullable)
-- Pending = ackedAt IS NULL. WS reconnect catch-up:
--   SELECT * FROM im_ws_acks WHERE userId=? AND ackedAt IS NULL
--     AND createdAt > <cursor>;
--
-- Idempotent
-- ----------
-- CREATE TABLE IF NOT EXISTS.
-- ============================================================================

CREATE TABLE IF NOT EXISTS im_ws_acks (
  id          VARCHAR(40)  NOT NULL,
  userId      VARCHAR(40)  NOT NULL,
  ackId       VARCHAR(64)  NOT NULL,
  payloadJson JSON         NOT NULL,
  createdAt   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ackedAt     DATETIME(3)  NULL,
  PRIMARY KEY (id),
  KEY user_pending_idx (userId, ackedAt),
  KEY user_ack_idx (userId, ackId),
  KEY created_idx (createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT
  'migration 408 v200 ws_acks persistent complete' AS status,
  (SELECT COUNT(*) FROM im_ws_acks) AS total_ws_acks;
