-- ============================================================================
-- Migration 416: v2.0 — Drop experimental im_conversation_seq_test table
-- Date: 2026-05-21
-- Spec: Wave 2-B1 §4.1 reviewer rev.2 LAST_INSERT_ID 实验残留 (scripts/exp-seq2.ts)
--
-- 背景：
-- Wave 2 之前 reviewer 用 scripts/exp-seq2.ts 做了 LAST_INSERT_ID 并发实验，
-- 创建临时表 `im_conversation_seq_test`。脚本里只在开头 DROP IF EXISTS 然后
-- CREATE，没在结尾清理 → 表残留在 dev MySQL 里，触发 db-drift gate 报警。
--
-- 解法：
-- 1. 永久 drop 这个实验表
-- 2. 同时 idempotent（IF EXISTS）— 已经被 reviewer 手动 drop 的环境也能 noop apply
--
-- 不影响生产：该表从未在 prisma schema / 生产 migration 里出现，仅是 dev-only
-- 实验残留。
-- ============================================================================

DROP TABLE IF EXISTS `im_conversation_seq_test`;
