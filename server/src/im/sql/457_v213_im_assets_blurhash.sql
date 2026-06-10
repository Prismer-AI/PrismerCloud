-- ============================================================================
-- Migration 457: release202/13 §3b① — im_assets.blurHash
-- Date: 2026-06-07
-- Spec: docs/release202/13-asset-preview-render-pipeline-and-perf.md §3b① + §L1
--
-- What
-- ----
-- Nullable thumbHash (base64, ~20-30 bytes) on the ORIGINAL image asset row.
-- Decoded client-side via `thumbHashToDataURL` into an instant (~0-network)
-- blurred placeholder rendered behind the real <img>, which fades in on load.
-- Computed best-effort during derivative generation (image thumbnail path,
-- both the S3/Lambda worker via the derivative callback and the in-process
-- filesystem-parity path). Failure to compute NEVER fails the derivative job.
--
-- Backward compatible
-- -------------------
-- Additive, nullable. Legacy rows (and all non-image assets) keep blurHash
-- NULL → the client falls back to the existing spinner placeholder. No reads
-- or writes break on the absence of this column.
--
-- Idempotency
-- -----------
-- Column add is not natively IF NOT EXISTS in MySQL 8; re-run will error
-- "Duplicate column name". The migration runner tracks applied files, so each
-- migration applies once. Add it manually-once if patching out of band.
-- ============================================================================

ALTER TABLE im_assets
  ADD COLUMN blurHash VARCHAR(64) NULL;

-- Tracking handled by scripts/db-migrate.sh; no manual _migrations INSERT.
