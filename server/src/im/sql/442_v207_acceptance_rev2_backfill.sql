-- ============================================================================
-- Migration 442: v2.0.7 release201/10 rev 2 — Acceptance criteria JSON backfill
-- Date: 2026-05-27
-- Spec: docs/release201/10-task-acceptance.md §3.2 (rev 2 criterion shape)
--
-- Why this migration exists
-- -------------------------
-- doc 10 rev 1 used these criterion JSON keys:
--   kind ∈ { boolean | numeric | text-match }
--   verifierKind ∈ { manual | agent-self-check | automated }
--   verifierConfig: { type, url, threshold, op, ... }  -- cloud-side runner
--   description: string
--   verifierNote: string
--
-- doc 10 rev 2 翻转哲学 — cloud 不预制具体 verifier 实施方法。criterion
-- 字段重命名为：
--   verifyMode ∈ { qualitative | quantitative | agent-self-check | manual }
--   expectation: string  (markdown 自由文本，描述"达成时应看到什么")
--   verifierAgentId: string | null  (agent routing; default = task.creatorId)
--   verifyOutcomeNote: string | null  (replaces verifierNote — agent 自评 method+result+repro)
--
-- 删除字段:
--   - kind (与 verifyMode 重复)
--   - verifierConfig (cloud 不再跑 verifier — agent 自决)
--
-- 字段重命名 + 默 mapping:
--   - verifierKind 'automated'         → verifyMode 'quantitative'  (语义最近)
--   - verifierKind 'manual'            → verifyMode 'manual'
--   - verifierKind 'agent-self-check'  → verifyMode 'agent-self-check'
--   - description → expectation
--   - verifierNote → verifyOutcomeNote
--
-- Scope
-- -----
-- 1. im_tasks.acceptanceCriteriaJson — rewrite each row's JSON array,
--    mapping each criterion object's keys.
--    (Migration 441 renamed this column from snake_case → camelCase to
--     match Prisma; templates table still uses snake_case via @map.)
-- 2. im_task_criteria_templates.criteria_json — same rewrite shape
--
-- Strategy
-- --------
-- 用 MySQL 8.0 内置 JSON 函数即可:
--   - JSON_TABLE 展开 array
--   - JSON_OBJECT 重组
--   - JSON_ARRAYAGG 重新合成
--   - NULLIF / COALESCE 处理缺失字段
--
-- 注意:
--   - 应用层 normaliseCriterion() 已可读取 rev 1 形状（向后兼容 grace
--     period）；本 migration 让 on-disk 数据彻底 rev 2 化。
--   - 跑两遍幂等 — 若已是 rev 2 shape，verifyMode/expectation 已存在，
--     COALESCE 优先选 rev 2 字段。
--
-- 验收 (§0.2.1):
--   - SELECT COUNT(*) FROM im_tasks
--       WHERE JSON_SEARCH(acceptanceCriteriaJson, 'one', 'automated', NULL, '$[*].verifierKind') IS NOT NULL
--     → 0 (rev 1 字符串已全清)
--   - 任取一行 SELECT acceptanceCriteriaJson FROM im_tasks WHERE acceptanceCriteriaJson IS NOT NULL LIMIT 1
--     → 含 verifyMode + expectation + verifierAgentId; 不含 verifierKind / verifierConfig / kind / description
-- ============================================================================

-- 2026-06-04 revision: 原 stored-function 路径需要 SUPER 权限（生产 / 测试
-- 环境的 schema-level user `prismer_cloud` 没这个权限，DELIMITER + CREATE
-- FUNCTION 直接在 binary-logging-on + log_bin_trust_function_creators=OFF
-- 下被 ERROR 1419 拒）。本版本把整段 rewrite 逻辑 inline 进 UPDATE 的
-- JSON_OBJECT() —— 用 CASE / COALESCE / NULLIF 表达原来的 IF-ELSE 分支。
-- 行为等价；UPDATE WHERE 子句保证 0 criteria 行不受影响（test env 上当前
-- 0 行需要 rewrite，是 0-op；首跑 prod 时按需 rewrite 所有 row）。

-- Step 1: rewrite im_tasks.acceptanceCriteriaJson
-- (migration 441 renamed the column to camelCase to match Prisma model)
UPDATE im_tasks AS t
SET t.acceptanceCriteriaJson = (
  SELECT JSON_ARRAYAGG(
    JSON_OBJECT(
      'id', NULLIF(JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.id')), 'null'),
      'verifyMode', CASE
        WHEN JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.verifyMode')) IS NOT NULL
         AND JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.verifyMode')) <> 'null'
         AND JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.verifyMode')) <> ''
          THEN JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.verifyMode'))
        WHEN JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.verifierKind')) = 'automated'
          THEN 'quantitative'
        WHEN JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.verifierKind')) IN ('manual', 'agent-self-check')
          THEN JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.verifierKind'))
        ELSE 'manual'
      END,
      'expectation', COALESCE(
        NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.expectation')), 'null'), ''),
        NULLIF(JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.description')), 'null'),
        ''
      ),
      'verifierAgentId', NULLIF(JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.verifierAgentId')), 'null'),
      'status', COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.status')), 'null'), 'pending'),
      'required', COALESCE(JSON_EXTRACT(JT.crit, '$.required'), CAST('true' AS JSON)),
      'evidenceRefs', COALESCE(JSON_EXTRACT(JT.crit, '$.evidenceRefs'), JSON_ARRAY()),
      'verifiedAt', NULLIF(JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.verifiedAt')), 'null'),
      'verifiedBy', NULLIF(JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.verifiedBy')), 'null'),
      'verifyOutcomeNote', COALESCE(
        NULLIF(JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.verifyOutcomeNote')), 'null'),
        NULLIF(JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.verifierNote')), 'null')
      ),
      'waiveReason', NULLIF(JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.waiveReason')), 'null'),
      'weight', COALESCE(JSON_EXTRACT(JT.crit, '$.weight'), CAST('1' AS JSON))
    )
  )
  FROM JSON_TABLE(
    COALESCE(t.acceptanceCriteriaJson, JSON_ARRAY()),
    '$[*]' COLUMNS (crit JSON PATH '$')
  ) AS JT
)
WHERE t.acceptanceCriteriaJson IS NOT NULL
  AND JSON_VALID(t.acceptanceCriteriaJson)
  AND JSON_LENGTH(t.acceptanceCriteriaJson) > 0;

-- Step 2: rewrite im_task_criteria_templates.criteria_json
-- Templates have a slightly different shape (no runtime state) but the
-- rewrite function tolerates missing fields → emits nulls. Strip
-- runtime-only keys (id/status/verifiedAt/verifiedBy/etc.) afterward by
-- re-projecting only static template keys.
-- Same rewrite, inlined (no helper FUNCTION). Templates only keep the static
-- subset: verifyMode + expectation + verifierAgentId + required + weight.
UPDATE im_task_criteria_templates AS t
SET t.criteria_json = (
  SELECT JSON_ARRAYAGG(
    JSON_OBJECT(
      'verifyMode', CASE
        WHEN JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.verifyMode')) IS NOT NULL
         AND JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.verifyMode')) <> 'null'
         AND JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.verifyMode')) <> ''
          THEN JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.verifyMode'))
        WHEN JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.verifierKind')) = 'automated'
          THEN 'quantitative'
        WHEN JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.verifierKind')) IN ('manual', 'agent-self-check')
          THEN JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.verifierKind'))
        ELSE 'manual'
      END,
      'expectation', COALESCE(
        NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.expectation')), 'null'), ''),
        NULLIF(JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.description')), 'null'),
        ''
      ),
      'verifierAgentId', NULLIF(JSON_UNQUOTE(JSON_EXTRACT(JT.crit, '$.verifierAgentId')), 'null'),
      'required', COALESCE(JSON_EXTRACT(JT.crit, '$.required'), CAST('true' AS JSON)),
      'weight', COALESCE(JSON_EXTRACT(JT.crit, '$.weight'), CAST('1' AS JSON))
    )
  )
  FROM JSON_TABLE(
    COALESCE(t.criteria_json, JSON_ARRAY()),
    '$[*]' COLUMNS (crit JSON PATH '$')
  ) AS JT
)
WHERE t.criteria_json IS NOT NULL
  AND JSON_VALID(t.criteria_json)
  AND JSON_LENGTH(t.criteria_json) > 0;

-- Acceptance smoke — log counts and a forbidden-key check.
SELECT
  'migration 442 acceptance rev2 backfill complete' AS status,
  (SELECT COUNT(*) FROM im_tasks WHERE acceptanceCriteriaJson IS NOT NULL) AS tasks_with_criteria,
  (SELECT COUNT(*) FROM im_task_criteria_templates) AS template_count,
  (
    SELECT COUNT(*) FROM im_tasks
    WHERE acceptanceCriteriaJson LIKE '%"verifierKind"%'
       OR acceptanceCriteriaJson LIKE '%"verifierConfig"%'
  ) AS rev1_residual_in_tasks_zero_expected,
  (
    SELECT COUNT(*) FROM im_task_criteria_templates
    WHERE criteria_json LIKE '%"verifierKind"%'
       OR criteria_json LIKE '%"verifierConfig"%'
  ) AS rev1_residual_in_templates_zero_expected;
