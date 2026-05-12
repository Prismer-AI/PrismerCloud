-- Migration 308: v1.9.7 Task Runs / Events base tables
-- Date: 2026-05-07
--
-- Adds im_task_runs and im_task_events for the first-phase task run/event
-- data model. Legacy agent_run rows continue to live in im_tasks.metadata and
-- are read through the service adapter only.

CREATE TABLE IF NOT EXISTS im_task_runs (
  id VARCHAR(30) NOT NULL PRIMARY KEY,
  taskId VARCHAR(30) NULL,
  workspaceId VARCHAR(30) NULL,
  conversationId VARCHAR(36) NULL,
  triggerMessageId VARCHAR(30) NULL,
  creatorId VARCHAR(36) NOT NULL,
  assigneeId VARCHAR(36) NULL,
  actorId VARCHAR(36) NULL,
  sourceKind VARCHAR(30) NOT NULL DEFAULT 'task',
  capability VARCHAR(100) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  runtimeRoute VARCHAR(20) NULL DEFAULT 'agent',
  input TEXT NOT NULL DEFAULT (_utf8mb4'{}'),
  output LONGTEXT NULL,
  outputUri VARCHAR(500) NULL,
  error TEXT NULL,
  startedAt DATETIME(3) NULL,
  completedAt DATETIME(3) NULL,
  metadata TEXT NOT NULL DEFAULT (_utf8mb4'{}'),
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_im_task_runs_task FOREIGN KEY (taskId) REFERENCES im_tasks(id) ON DELETE SET NULL,
  INDEX idx_im_task_runs_task_created (taskId, createdAt),
  INDEX idx_im_task_runs_workspace_status_created (workspaceId, status, createdAt),
  INDEX idx_im_task_runs_conversation_created (conversationId, createdAt),
  INDEX idx_im_task_runs_assignee_status (assigneeId, status),
  INDEX idx_im_task_runs_creator_created (creatorId, createdAt),
  INDEX idx_im_task_runs_source_status (sourceKind, status),
  INDEX idx_im_task_runs_actor_status (actorId, status),
  INDEX idx_im_task_runs_status_created (status, createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS im_task_events (
  id VARCHAR(30) NOT NULL PRIMARY KEY,
  runId VARCHAR(30) NOT NULL,
  taskId VARCHAR(30) NULL,
  workspaceId VARCHAR(30) NULL,
  conversationId VARCHAR(36) NULL,
  actorId VARCHAR(36) NULL,
  type VARCHAR(50) NOT NULL,
  level VARCHAR(20) NOT NULL DEFAULT 'info',
  message TEXT NULL,
  payload TEXT NOT NULL DEFAULT (_utf8mb4'{}'),
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_im_task_events_run FOREIGN KEY (runId) REFERENCES im_task_runs(id) ON DELETE CASCADE,
  INDEX idx_im_task_events_run_created (runId, createdAt),
  INDEX idx_im_task_events_task_created (taskId, createdAt),
  INDEX idx_im_task_events_workspace_created (workspaceId, createdAt),
  INDEX idx_im_task_events_conversation_created (conversationId, createdAt),
  INDEX idx_im_task_events_type_created (type, createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'migration 308 complete' AS status;
