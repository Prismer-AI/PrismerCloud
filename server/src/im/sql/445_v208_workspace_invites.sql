-- ============================================================================
-- Migration 445: v2.0.8 Phase 9 — im_workspace_invites
-- Date: 2026-05-28
-- Spec: docs/release201/16-human-collaboration-onboarding.md §3.2.1 + §0.2.1 Phase 2
--
-- What
-- ----
-- New table backing the invite-token system for human collaborators.
-- Carries two flows in one shape:
--   (1) "link invite": inviteeEmail set, inviteeImUserId NULL → emailed link,
--       acceptable by anyone who logs in and clicks (16 §5.4 trade-off)
--   (2) "direct request": inviteeImUserId set, inviteeEmail optional → in-app
--       notification, only that imUser may accept
--
-- Status state machine (16 §0.2.3): pending → accepted | rejected | revoked | expired.
-- Terminal states are immutable; no reverse transitions.
--
-- Indexes
-- -------
--   - token UNIQUE   → GET /api/im/invites/:token public lookup
--   - workspace+status → list pending invites per workspace
--   - invitee email / imUserId → "what invites am I currently looking at"
--   - expiresAt index supports a background sweeper (Phase 9 may run a cron;
--     until then the service-layer accept path checks expiry inline)
--
-- FKs
-- ---
--   - workspaceId  → im_workspaces.id ON DELETE CASCADE
--     (deleting a workspace voids its outstanding invites)
--   - inviterUserId → im_users.id (RESTRICT default — never delete the inviter
--     without first dealing with their workspace invites)
--   - inviteeImUserId is NOT FK'd: an invite addressed to an email may resolve
--     to a freshly-registered imUserId at accept time. Keeping it loose lets
--     us record the acceptor without an upfront row.
--
-- Owner role omitted from `role` enum
-- -----------------------------------
-- Ownership transfer is v2.1+ RFC (16 §5.2). Invites only mint admin/member.
--
-- Idempotency
-- -----------
-- CREATE TABLE IF NOT EXISTS; safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS im_workspace_invites (
  -- VARCHAR(30) matches every other im_* table; cuid() output is ~25 chars.
  id               VARCHAR(30)  PRIMARY KEY,
  workspaceId      VARCHAR(30)  NOT NULL,
  inviterUserId    VARCHAR(30)  NOT NULL,
  token            VARCHAR(128) NOT NULL,
  inviteeEmail     VARCHAR(255) NULL,
  inviteeImUserId  VARCHAR(30)  NULL,
  role             VARCHAR(16)  NOT NULL DEFAULT 'member',  -- 'admin' | 'member'
  status           VARCHAR(16)  NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired'
  expiresAt        DATETIME(3)  NOT NULL,
  acceptedByUserId VARCHAR(30)  NULL,
  acceptedAt       DATETIME(3)  NULL,
  createdAt        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_invite_token (token),
  INDEX idx_invite_workspace_status (workspaceId, status),
  INDEX idx_invite_email (inviteeEmail),
  INDEX idx_invite_imuser (inviteeImUserId),
  INDEX idx_invite_expires (expiresAt),
  CONSTRAINT fk_invite_workspace FOREIGN KEY (workspaceId) REFERENCES im_workspaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_invite_inviter FOREIGN KEY (inviterUserId) REFERENCES im_users(id)
);

-- Sanity check guidance (manual; runner doesn't execute):
--
--   SELECT status, COUNT(*) FROM im_workspace_invites GROUP BY status;
--
-- After Phase 9 launches, `expired` rows should accumulate as TTL sweeps.
-- A 0 row return for `pending` after sustained traffic typically signals the
-- service-layer accept/reject path isn't flipping status correctly.
