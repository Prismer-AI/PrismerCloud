SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `pc_notifications` (
  `id`              VARCHAR(36)   NOT NULL,
  `user_id`         INT           NOT NULL,
  `type`            VARCHAR(20)   NOT NULL DEFAULT 'info',
  `title`           VARCHAR(255)  NOT NULL,
  `message`         TEXT          NOT NULL,
  `read`            TINYINT(1)    NOT NULL DEFAULT 0,
  `reference_type`  VARCHAR(50)   DEFAULT NULL,
  `reference_id`    VARCHAR(255)  DEFAULT NULL,
  `created_at`      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_user_read` (`user_id`, `read`),
  KEY `idx_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
