-- ============================================================================
-- Migration 410: v2.0 — Explicit IMAgentBinding (R7 multi-daemon race fix)
-- Date: 2026-05-21
-- Spec: docs/release200/14-messaging-state-machine-reliability.md §4.8.2
--       (v2.0 GA blocker — see §1.5 jasonzhou production case study)
--
-- Background
-- ----------
-- §1.5 server-log smoking gun: same user has both a local Mac Studio daemon
-- AND a K8S pod simultaneously declaring host for 6 agents → first-write
-- wins, subsequent declarations silently `return false` in handler.ts:611.
-- Half the agents bound to the half-dead K8S pod → dispatches to those go
-- into the void. The user sees "UI says Sent but agent never replies".
--
-- §4.8.2 fix: hoist binding out of metadata into an explicit row, surface
-- contests to the UI instead of silent reject, and add /agent-bindings APIs
-- so the user can explicitly re-bind an agent to a chosen daemon.
--
-- Schema
-- ------
-- (agentImUserId UNIQUE, boundDaemonId, boundDaemonKind, boundDaemonLabel,
--  boundAt, boundBy, lastHostDeclareAt, lastDispatchAt, contestedSince,
--  contestCount)
--
-- Backfill strategy
-- -----------------
-- Wave 1 leaves this empty — backfill from existing im_agent_cards.metadata
-- or im_containers (agentImUserId → daemonId) is intentionally deferred to
-- Wave 2 since the derivation path is unclear and depends on which daemon
-- last successfully dispatched (no audit trail). Wave 2 owner decides
-- whether to seed from im_containers.daemonId (most recent), or to leave
-- empty and let host.declare populate organically on first declare.
--
-- Idempotent
-- ----------
-- CREATE TABLE IF NOT EXISTS.
-- ============================================================================

CREATE TABLE IF NOT EXISTS im_agent_bindings (
  id                  VARCHAR(40)  NOT NULL,
  agentImUserId       VARCHAR(40)  NOT NULL,
  boundDaemonId       VARCHAR(60)  NOT NULL,
  boundDaemonKind     VARCHAR(20)  NOT NULL,  -- 'k8s' | 'local' | 'edge'
  boundDaemonLabel    VARCHAR(100) NOT NULL,  -- human-readable, e.g. "Mac Studio (Jason's office)"
  boundAt             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  boundBy             VARCHAR(30)  NOT NULL,  -- 'auto-first-declare' | 'user-explicit' | 'cloud-rebalance'
  lastHostDeclareAt   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  lastDispatchAt      DATETIME(3)  NULL,
  contestedSince      DATETIME(3)  NULL,
  contestCount        INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_agent (agentImUserId),
  KEY bound_daemon_idx (boundDaemonId),
  KEY contested_idx (contestedSince),
  KEY last_dispatch_idx (lastDispatchAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Backfill (Wave 1: deferred — see header comment) ────────────────────
-- Wave 2 must decide: seed from im_containers.daemonId (most recent agent→
-- container mapping) OR leave empty + let host.declare populate naturally.
-- The risk of seeding from im_containers is binding to a half-dead pod (the
-- exact scenario this migration fixes); the risk of leaving empty is a
-- transient window where any daemon can claim the agent on first declare.
-- Wave 2 owner: please document the chosen strategy in the implementation PR.

SELECT
  'migration 410 v200 agent_binding explicit complete' AS status,
  (SELECT COUNT(*) FROM im_agent_bindings) AS total_bindings,
  (SELECT COUNT(*) FROM im_agent_cards) AS total_agent_cards,
  (SELECT COUNT(*) FROM im_containers WHERE agentImUserId IS NOT NULL) AS container_agent_links;
