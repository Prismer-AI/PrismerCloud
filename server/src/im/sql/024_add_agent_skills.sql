-- 022: Add im_agent_skills table (skill installation tracking)
-- Required for: POST /skills/:slug/install, GET /skills/installed, DELETE /skills/:slug/install

CREATE TABLE IF NOT EXISTS `im_agent_skills` (
  `id`          VARCHAR(30)  NOT NULL,
  `agentId`     VARCHAR(30)  NOT NULL,
  `skillId`     VARCHAR(30)  NOT NULL,
  `geneId`      VARCHAR(128) DEFAULT NULL,
  `installedAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`   DATETIME(3)  DEFAULT NULL,
  `config`      TEXT         DEFAULT NULL,
  `status`      VARCHAR(20)  NOT NULL DEFAULT 'active',
  `version`     VARCHAR(20)  DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `im_agent_skills_agentId_skillId_key` (`agentId`, `skillId`),
  KEY `im_agent_skills_agentId_idx` (`agentId`),
  KEY `im_agent_skills_skillId_idx` (`skillId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
