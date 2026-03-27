-- ============================================================================
-- Migration 015: Signal Tags (v0.3.0 — SignalTag Architecture)
-- Version: v1.7.3
-- Date: 2026-03-18
-- MySQL 8.0 compatible (no ADD COLUMN IF NOT EXISTS)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. im_gene_signals: 新增 signal_tags 列
-- ---------------------------------------------------------------------------
ALTER TABLE im_gene_signals
  ADD COLUMN signal_tags JSON DEFAULT NULL;

-- ---------------------------------------------------------------------------
-- 2. im_evolution_edges: 新增 v0.3.0 信号架构字段
-- ---------------------------------------------------------------------------
ALTER TABLE im_evolution_edges
  ADD COLUMN signal_type VARCHAR(128) NULL,
  ADD COLUMN bimodality_index FLOAT NOT NULL DEFAULT 0.0,
  ADD COLUMN task_success_rate FLOAT NULL,
  ADD COLUMN coverage_level TINYINT NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 3. im_unmatched_signals: 新增 signalTags 列
-- ---------------------------------------------------------------------------
ALTER TABLE im_unmatched_signals
  ADD COLUMN signalTags JSON DEFAULT NULL;

-- ---------------------------------------------------------------------------
-- 4. im_evolution_achievements: 补全 MySQL 缺失的表
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS im_evolution_achievements (
  id         VARCHAR(30)  NOT NULL,
  agentId    VARCHAR(30)  NOT NULL,
  badgeKey   VARCHAR(100) NOT NULL,
  unlockedAt DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  metadata   TEXT         NOT NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uniq_agent_badge (agentId, badgeKey),
  INDEX idx_agent_id (agentId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
SELECT 'migration 015 complete' AS status;
