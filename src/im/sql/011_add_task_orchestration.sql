-- ============================================================================
-- Migration 011: Task Orchestration (Cloud Task Store + Scheduler)
-- ============================================================================
-- v1.7.2: Persistent task management with lifecycle, scheduling, and retry.
-- Cloud-side scheduler replaces OpenClaw local cron for reliability.
-- ============================================================================

-- Task Store
CREATE TABLE IF NOT EXISTS im_tasks (
  id            VARCHAR(30)  NOT NULL PRIMARY KEY,
  title         VARCHAR(255) NOT NULL,
  description   TEXT,
  capability    VARCHAR(100),
  input         TEXT         NOT NULL,
  contextUri    VARCHAR(500),
  creatorId     VARCHAR(36)  NOT NULL,
  assigneeId    VARCHAR(36),
  status        VARCHAR(20)  NOT NULL DEFAULT 'pending',
  scheduleType  VARCHAR(20),
  scheduleAt    DATETIME(3),
  scheduleCron  VARCHAR(100),
  intervalMs    INT,
  nextRunAt     DATETIME(3),
  lastRunAt     DATETIME(3),
  runCount      INT          NOT NULL DEFAULT 0,
  maxRuns       INT,
  result        TEXT,
  resultUri     VARCHAR(500),
  error         TEXT,
  budget        DOUBLE,
  cost          DOUBLE       NOT NULL DEFAULT 0,
  timeoutMs     INT          NOT NULL DEFAULT 300000,
  deadline      DATETIME(3),
  maxRetries    INT          NOT NULL DEFAULT 0,
  retryDelayMs  INT          NOT NULL DEFAULT 60000,
  retryCount    INT          NOT NULL DEFAULT 0,
  metadata      TEXT         NOT NULL,
  createdAt     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  INDEX idx_status (status),
  INDEX idx_assignee_status (assigneeId, status),
  INDEX idx_capability_status (capability, status),
  INDEX idx_schedule (scheduleType, nextRunAt, status),
  INDEX idx_creator (creatorId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Task Logs (audit trail)
CREATE TABLE IF NOT EXISTS im_task_logs (
  id            VARCHAR(30)  NOT NULL PRIMARY KEY,
  taskId        VARCHAR(30)  NOT NULL,
  actorId       VARCHAR(36),
  action        VARCHAR(50)  NOT NULL,
  message       TEXT,
  metadata      TEXT         NOT NULL,
  createdAt     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX idx_task_time (taskId, createdAt),
  CONSTRAINT fk_task_log_task FOREIGN KEY (taskId) REFERENCES im_tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Verify
SELECT 'im_tasks' AS `table`, COUNT(*) AS `count` FROM im_tasks
UNION ALL
SELECT 'im_task_logs', COUNT(*) FROM im_task_logs;
