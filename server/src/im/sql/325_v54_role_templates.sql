-- ACP P3: Cloud-side role template library.
-- Stores executable agent blueprints with role-specific skills, MCP servers,
-- adapter config, and operating principles.

CREATE TABLE IF NOT EXISTS `im_role_templates` (
  `id`                   VARCHAR(30) NOT NULL,
  `slug`                 VARCHAR(50) NOT NULL,
  `version`              VARCHAR(20) NOT NULL DEFAULT '1.0.0',
  `name`                 TEXT NOT NULL,
  `description`          TEXT NOT NULL,
  `agentType`            VARCHAR(20) NOT NULL DEFAULT 'specialist',
  `category`             VARCHAR(50) NOT NULL DEFAULT 'general',
  `tags`                 TEXT NOT NULL,
  `baseSkillSet`         VARCHAR(30) NOT NULL DEFAULT 'prismer-base',
  `requiredSkills`       TEXT NOT NULL,
  `mcpServers`           TEXT NOT NULL,
  `hermesConfig`         TEXT NULL,
  `openclawConfig`       TEXT NULL,
  `operatingPrinciples`  TEXT NULL,
  `taskAuthority`        VARCHAR(20) NOT NULL DEFAULT 'executor',
  `approvalPolicy`       VARCHAR(20) NOT NULL DEFAULT 'auto-low-risk',
  `status`               VARCHAR(20) NOT NULL DEFAULT 'active',
  `createdAt`            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `im_role_templates_slug_key` (`slug`),
  KEY `im_role_templates_category_idx` (`category`),
  KEY `im_role_templates_agentType_idx` (`agentType`),
  KEY `im_role_templates_status_idx` (`status`),
  KEY `im_role_templates_taskAuthority_idx` (`taskAuthority`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- MySQL TEXT columns cannot have DEFAULT values in strict mode.
UPDATE `im_role_templates` SET `name` = '{}' WHERE `name` IS NULL OR `name` = '';
UPDATE `im_role_templates` SET `description` = '{}' WHERE `description` IS NULL OR `description` = '';
UPDATE `im_role_templates` SET `tags` = '[]' WHERE `tags` IS NULL OR `tags` = '';
UPDATE `im_role_templates` SET `requiredSkills` = '[]' WHERE `requiredSkills` IS NULL OR `requiredSkills` = '';
UPDATE `im_role_templates` SET `mcpServers` = '[]' WHERE `mcpServers` IS NULL OR `mcpServers` = '';

SELECT 'migration 325 im_role_templates complete' AS status;
