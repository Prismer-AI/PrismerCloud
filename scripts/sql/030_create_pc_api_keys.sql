-- =============================================================================
-- Prismer Cloud - API Key 管理 (前端先行)
-- 版本: 1.0.0
-- 日期: 2026-02-08
--
-- 设计原则：
--   ✅ 不修改后端 api_keys 表
--   ✅ 使用 pc_ 前缀，与后端解耦
--   ✅ 存储 SHA-256 hash（比后端明文更安全）
--   ✅ Feature flag: FF_API_KEYS_LOCAL=true 启用
-- =============================================================================

CREATE TABLE IF NOT EXISTS pc_api_keys (
  id VARCHAR(36) PRIMARY KEY COMMENT 'UUID',
  user_id BIGINT UNSIGNED NOT NULL COMMENT '用户 ID (对应 users.id)',
  key_hash VARCHAR(64) NOT NULL COMMENT 'SHA-256 hash of full key',
  key_prefix VARCHAR(20) NOT NULL COMMENT '显示用前缀 (sk-prismer-live-789b)',
  label VARCHAR(255) DEFAULT 'API Key',
  status VARCHAR(20) DEFAULT 'ACTIVE' COMMENT 'ACTIVE / REVOKED',
  last_used_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_key_hash (key_hash),
  INDEX idx_user_id (user_id),
  INDEX idx_user_status (user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
