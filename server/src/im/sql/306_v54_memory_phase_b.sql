-- ============================================================================
-- Migration 306: v5.4 — Workspace memory Phase B tables
-- Date: 2026-05-07
--
-- Creates the workspace memory page/version/link/sync/observability tables used
-- by the Phase B cloud bridge. Idempotent via CREATE TABLE IF NOT EXISTS.
-- ============================================================================

CREATE TABLE IF NOT EXISTS im_memory_pages (
  id                VARCHAR(30)  NOT NULL,
  workspaceId       VARCHAR(30)  NOT NULL,
  path              VARCHAR(500) NOT NULL,
  title             VARCHAR(500) NULL,
  content           LONGTEXT     NOT NULL,
  version           INT          NOT NULL DEFAULT 1,
  createdByImUserId VARCHAR(30)  NOT NULL,
  createdAt         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  parentPageId      VARCHAR(30)  NULL,
  pageType          VARCHAR(32)  NOT NULL DEFAULT 'hub',
  sourceRef         VARCHAR(500) NULL,
  sourceKind        VARCHAR(32)  NULL,
  sourceAssetId     VARCHAR(30)  NULL,
  ingestRunId       VARCHAR(30)  NULL,
  ingestVersion     INT          NULL,

  stale             TINYINT(1)   NOT NULL DEFAULT 0,
  staleReason       VARCHAR(255) NULL,
  archivedAt        DATETIME(3)  NULL,

  provenanceJson    TEXT         NOT NULL,
  visibility        VARCHAR(50)  NOT NULL DEFAULT 'workspace',
  aclJson           TEXT         NULL,
  encrypted         TINYINT(1)   NOT NULL DEFAULT 0,
  contentHash       CHAR(64)     NOT NULL,

  PRIMARY KEY (id),
  UNIQUE KEY im_memory_pages_workspaceId_path_key (workspaceId, path),
  KEY idx_im_memory_pages_workspace_parent (workspaceId, parentPageId),
  KEY idx_im_memory_pages_workspace_source_ref (workspaceId, sourceRef),
  KEY idx_im_memory_pages_workspace_source_asset (workspaceId, sourceAssetId),
  KEY idx_im_memory_pages_workspace_stale (workspaceId, stale),
  KEY idx_im_memory_pages_workspace_page_type (workspaceId, pageType)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS im_memory_page_versions (
  id                VARCHAR(30) NOT NULL,
  workspaceId       VARCHAR(30) NOT NULL,
  pageId            VARCHAR(30) NOT NULL,
  version           INT         NOT NULL,
  content           LONGTEXT    NOT NULL,
  contentHash       CHAR(64)    NOT NULL,
  createdByImUserId VARCHAR(30) NOT NULL,
  createdAt         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  parentVersion     INT         NULL,
  changeSummary     TEXT        NULL,
  payloadJson       TEXT        NULL,
  encrypted         TINYINT(1)  NOT NULL DEFAULT 0,
  sourceKind        VARCHAR(32) NULL,
  sourceRef         VARCHAR(500) NULL,

  PRIMARY KEY (id),
  UNIQUE KEY im_memory_page_versions_pageId_version_key (pageId, version),
  KEY idx_im_memory_page_versions_workspace_page (workspaceId, pageId),
  KEY idx_im_memory_page_versions_workspace_hash (workspaceId, contentHash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS im_memory_links (
  id                   VARCHAR(30)  NOT NULL,
  workspaceId          VARCHAR(30)  NOT NULL,
  sourcePageId         VARCHAR(30)  NOT NULL,
  targetPageId         VARCHAR(30)  NULL,
  sourceUri            VARCHAR(500) NOT NULL,
  targetUri            VARCHAR(500) NOT NULL,
  relation             VARCHAR(50)  NOT NULL DEFAULT 'markdown',
  extractedFromVersion INT          NULL,
  weight               DOUBLE       NOT NULL DEFAULT 1,
  broken               TINYINT(1)   NOT NULL DEFAULT 0,
  createdAt            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  UNIQUE KEY im_memory_links_workspace_source_target_relation_key (workspaceId, sourcePageId, targetUri, relation),
  KEY idx_im_memory_links_workspace_source (workspaceId, sourcePageId),
  KEY idx_im_memory_links_workspace_target (workspaceId, targetPageId),
  KEY idx_im_memory_links_workspace_broken (workspaceId, broken)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS im_memory_sync_events (
  id             VARCHAR(30)  NOT NULL,
  workspaceId    VARCHAR(30)  NOT NULL,
  eventId        VARCHAR(40)  NOT NULL,
  direction      VARCHAR(12)  NOT NULL,
  eventType      VARCHAR(64)  NOT NULL,
  schemaVersion  INT          NOT NULL DEFAULT 1,
  actorImUserId  VARCHAR(30)  NOT NULL,
  actorKind      VARCHAR(12)  NOT NULL,
  deviceId       VARCHAR(64)  NULL,
  pageId         VARCHAR(30)  NULL,
  status         VARCHAR(20)  NOT NULL DEFAULT 'pending',
  idempotencyKey VARCHAR(255) NOT NULL,
  payloadJson    LONGTEXT     NOT NULL,
  errorJson      TEXT         NULL,
  conflictJson   TEXT         NULL,
  `cursor`       VARCHAR(128) NULL,
  createdAt      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processedAt    DATETIME(3)  NULL,

  PRIMARY KEY (id),
  UNIQUE KEY im_memory_sync_events_workspaceId_eventId_key (workspaceId, eventId),
  UNIQUE KEY im_memory_sync_events_workspaceId_idempotencyKey_key (workspaceId, idempotencyKey),
  KEY idx_im_memory_sync_events_workspace_status_created (workspaceId, status, createdAt),
  KEY idx_im_memory_sync_events_workspace_page (workspaceId, pageId),
  KEY idx_im_memory_sync_events_workspace_cursor (workspaceId, `cursor`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS im_memory_observability_events (
  id            VARCHAR(30) NOT NULL,
  workspaceId   VARCHAR(30) NOT NULL,
  eventType     VARCHAR(64) NOT NULL,
  actorImUserId VARCHAR(30) NULL,
  actorKind     VARCHAR(12) NULL,
  pageId        VARCHAR(30) NULL,
  targetEventId VARCHAR(40) NULL,
  query         TEXT        NULL,
  metricsJson   TEXT        NULL,
  metadataJson  TEXT        NULL,
  createdAt     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  KEY idx_im_memory_observability_workspace_event_created (workspaceId, eventType, createdAt),
  KEY idx_im_memory_observability_workspace_page (workspaceId, pageId),
  KEY idx_im_memory_observability_workspace_actor (workspaceId, actorImUserId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'migration 306 complete' AS status;
