-- Migration 017: Signal Clusters
-- Co-occurrence based grouping of signals for better gene matching.

CREATE TABLE IF NOT EXISTS `im_signal_clusters` (
  `id` VARCHAR(30) NOT NULL,
  `clusterKey` VARCHAR(200) NOT NULL,
  `memberSignals` TEXT NOT NULL DEFAULT '[]',
  `frequency` INT NOT NULL DEFAULT 0,
  `agentCount` INT NOT NULL DEFAULT 0,
  `topGeneId` VARCHAR(100) DEFAULT NULL,
  `topGeneRate` DOUBLE DEFAULT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_cluster_key` (`clusterKey`),
  KEY `idx_frequency` (`frequency`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
