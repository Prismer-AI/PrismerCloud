-- Migration 448: v2.0.8 doc 20 Gap A — IMContainer.projectId for device × project binding
-- Date: 2026-05-28
-- Spec: docs/release201/20-project-extension-gaps.md §1
-- Scope: opt-in project scope for runtime-installation containers; NULL = workspace-level
-- Not strict FK (style aligns with 09 §3.3 task projectId)

ALTER TABLE im_containers
  ADD COLUMN projectId VARCHAR(30) NULL,
  ADD INDEX idx_im_containers_project_status (projectId, status);

-- Tracking handled by scripts/db-migrate.sh; no manual _migrations INSERT.
