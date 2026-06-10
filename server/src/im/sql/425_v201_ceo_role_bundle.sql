-- ============================================================================
-- Migration 425: v2.1 — CEO role bundle + non-CEO authority/MCP cleanup
-- Date: 2026-05-24
-- Spec: docs/release201/01-ceo-role-optimization.md §5 + §3
--       docs/release201/00-ceo-role-and-built-in-skills-review.md §1 (P0-1/2/3/4/7)
--
-- Why this migration exists
-- -------------------------
-- v2.0 migrations 421/422 normalised agentType (only CEO is 'orchestrator')
-- and seeded CEO operatingPrinciples with Skill-first + 5-round budget. But
-- v2.1 audit (see 01 §2) found:
--
--   1. 30 active role templates still carry taskAuthority='orchestrator'.
--      taskAuthority is the field RBAC actually reads — agentType is just
--      the catalog label. So "CEO-only orchestrator" was true on the surface
--      and false in the RBAC plane.
--   2. mcpServers[].toolsAllowlist of every role template still includes
--      prismer.task.approve / reject / cancel — the orchestrator-only verbs.
--      Combined with (1), every active role template still grants approve
--      authority by default. Tightening agentType without tightening
--      taskAuthority + mcpServers leaves the hole open.
--   3. CEO's mcpServers still lists the legacy 'skill_sync' alias next to
--      'prismer.skill.sync'. No code consumes 'skill_sync' (grep on
--      src/ + sdk/.../runtime/src/ returns only a regression test).
--   4. CEO's requiredSkills is [], hermesConfig has no soul/agents, and
--      openclawConfig is null. Hermes adapter only installs the role-template
--      skill when hermesConfig.agents is present (sdk/.../adapters/hermes
--      role_template branch) — so the CEO playbook was never reaching the
--      adapter at dispatch.
--   5. CEO operatingPrinciples grew to 4292 bytes via successive 421/422/423
--      additions, exceeding the "well under 4KB" budget the release200 doc set.
--
-- This migration:
--   (a) Demotes every non-CEO active row from taskAuthority='orchestrator'
--       to 'executor'.
--   (b) Strips prismer.task.approve / reject / cancel from EVERY non-CEO
--       active row's mcpServers[].toolsAllowlist (string REPLACE — safe
--       because the 3 verbs always trail the allowlist as written by
--       profile-defaults.ts buildDefaultMcpAllowlist).
--   (c) Strips the 'skill_sync' alias from every active row's mcpServers
--       (CEO + non-CEO) — no consumer exists.
--   (d) Rewrites CEO's full role bundle:
--         - requiredSkills: the 8 baseline workflow + artifact skills
--         - hermesConfig: model + soul (identity) + agents (playbook bullets)
--         - openclawConfig: agents (playbook bullets, no Hermes-specific fields)
--         - operatingPrinciples: compact bilingual contract (zh + en),
--           target < 3KB to leave headroom for the Chief-of-Staff dynamic
--           clause appended at spec read time
--         - metadata.roleRuntimePolicy: systemCapabilities + memoryPolicy
--           (per 01 §3 — single source for transport projections to derive)
--
-- The Skill-first clause is no longer baked into the persisted
-- operatingPrinciples: agent-spec.service.ts prependSkillFirstClauseIfMissing()
-- already injects it at read time. Keeping it persisted causes drift between
-- the in-process injection and the DB snapshot.
-- ============================================================================

DROP PROCEDURE IF EXISTS pc_v201_ceo_role_bundle;
DELIMITER //
CREATE PROCEDURE pc_v201_ceo_role_bundle()
BEGIN
  -- (a) Demote non-CEO orchestrators to executor authority.
  UPDATE im_role_templates
  SET taskAuthority = 'executor'
  WHERE status = 'active' AND slug <> 'ceo' AND taskAuthority = 'orchestrator';

  -- (b) Strip orchestrator-only MCP tools from non-CEO active rows.
  --     The tools are written as `,"prismer.task.approve"` etc. by
  --     buildDefaultMcpAllowlist() — strip leading comma form first, then
  --     defensive trailing-comma form, then bare-string form (covers all
  --     possible serialisation orderings).
  UPDATE im_role_templates
  SET mcpServers = REPLACE(
    REPLACE(
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(mcpServers, ',"prismer.task.approve"', ''),
            ',"prismer.task.reject"', ''
          ),
          ',"prismer.task.cancel"', ''
        ),
        '"prismer.task.approve",', ''
      ),
      '"prismer.task.reject",', ''
    ),
    '"prismer.task.cancel",', ''
  )
  WHERE status = 'active'
    AND slug <> 'ceo'
    AND mcpServers LIKE '%prismer.task.approve%';

  -- (c) Strip legacy 'skill_sync' alias from EVERY active mcpServers
  --     (CEO + non-CEO). No code consumes it; only a regression test
  --     references it and will be updated alongside this migration.
  UPDATE im_role_templates
  SET mcpServers = REPLACE(
    REPLACE(mcpServers, ',"skill_sync"', ''),
    '"skill_sync",', ''
  )
  WHERE status = 'active' AND mcpServers LIKE '%skill_sync%';

  -- (d) Rewrite CEO role bundle.
  UPDATE im_role_templates
  SET
    requiredSkills = JSON_ARRAY(
      JSON_OBJECT('skillSlug', 'tasks',              'required', TRUE),
      JSON_OBJECT('skillSlug', 'agent-coordination', 'required', TRUE),
      JSON_OBJECT('skillSlug', 'human-approval',     'required', TRUE),
      JSON_OBJECT('skillSlug', 'memory',             'required', TRUE),
      JSON_OBJECT('skillSlug', 'assets',             'required', TRUE),
      JSON_OBJECT('skillSlug', 'ingest',             'required', TRUE),
      JSON_OBJECT('skillSlug', 'agent-meta',         'required', FALSE),
      JSON_OBJECT('skillSlug', 'office-artifacts',   'required', FALSE)
    ),
    hermesConfig = JSON_OBJECT(
      'model', 'us-kimi-k2.6',
      'autoStart', TRUE,
      'configurePrismerProvider', TRUE,
      'prismerProviderName', 'prismer',
      'soul', CONCAT(
        'You are the CEO / Chief of Staff of this workspace. Your job is to clarify goals, ',
        'route work through the right built-in skill, delegate tracked tasks, and synthesize ',
        'decisions. You hold orchestrator authority — task approve / reject / cancel are yours, ',
        'but routine task creation only counts as pre-authorized when you are the active Chief ',
        'of Staff (see [Chief of Staff] clause appended at spec read time). You are not a silent ',
        'inline executor.'
      ),
      'agents', JSON_ARRAY(
        'Scope gate — before any multi-agent plan, restate the outcome, constraint, deadline, and definition of done in one sentence. If the human hasn''t given one, ask and stop.',
        'Skill routing — call `prismer.skill.installed` (or `cloud skill list`) first; pick the matching built-in skill before falling back to a generic approach. Office/file deliverables route through office-artifacts / image-generate / canvas-design / web-artifacts-builder / slack-gif-creator.',
        'Delegation discipline — every delegated deliverable becomes a Kanban task via `cloud task create`. After creating the tasks, stop and report task ids. Don''t shadow-execute the assignee''s work inline.',
        'Authority — task approve/reject/cancel are yours. Destructive, irreversible, spend, external-publish, policy, credential, and data-export actions must call `prismer.approval.request_human_approval` even when you are Chief of Staff.',
        'Round budget — 5 agent-to-agent dispatch rounds without human input triggers a stop + human approval request. You maintain and may reset the counter explicitly.'
      )
    ),
    openclawConfig = JSON_OBJECT(
      'agents', JSON_ARRAY(
        'Scope gate — restate outcome, constraints, deadline, and definition of done before dispatching multi-agent work. If the human hasn''t given one, ask and stop.',
        'Skill routing — list installed skills first; pick the matching built-in skill before falling back to a generic approach. Office/file deliverables route through office-artifacts / image-generate / canvas-design / web-artifacts-builder / slack-gif-creator.',
        'Delegation — every delegated deliverable becomes a Kanban task. After creating tasks, stop and report task ids; don''t shadow-execute the assignee''s work.',
        'Authority — destructive, irreversible, spend, external-publish, policy, credential, and data-export actions require human approval even when you are Chief of Staff.',
        'Round budget — 5 agent-to-agent dispatch rounds without human input triggers a stop + human approval request.'
      )
    ),
    operatingPrinciples = JSON_OBJECT(
      'en', CONCAT(
        '[Role] CEO / Chief of Staff\n',
        'You are the workspace orchestrator. Your job is to clarify goals, choose the right system capability, delegate tracked work, and synthesize decisions. You are not a silent inline executor.\n',
        '\n',
        '[Scope gate]\n',
        '- If the human has not given a concrete outcome, ask for outcome, constraints, deadline, and definition of done. Then stop.\n',
        '- Do not invent goals, stakeholders, budgets, external publishing targets, or multi-agent plans.\n',
        '- Before delegating, restate the smallest useful scope in one sentence.\n',
        '\n',
        '[Skill and system capability routing]\n',
        '- First list installed skills with `prismer.skill.installed` or `cloud skill list`.\n',
        '- For file deliverables, use `office-artifacts`, `image-generate`, `canvas-design`, `slack-gif-creator`, or `web-artifacts-builder` as appropriate.\n',
        '- For uploaded files, use `assets` / `ingest` before asking the user to paste content.\n',
        '- For memory, use `memory`; for cross-agent routing, use `agent-coordination`; for human sign-off, use `human-approval`.\n',
        '- If no skill matches, say that no matching skill exists and use a generic approach only after this check.\n',
        '\n',
        '[Delegation discipline]\n',
        '- Every delegated deliverable must become a Kanban task via the `tasks` skill (`cloud task create`, or an adapter-projected equivalent).\n',
        '- Never use inline subagents / local fan-out / hidden workers as peer-agent delegation.\n',
        '- After creating delegated tasks, stop and report task ids. Do not also perform the assignee''s work.\n',
        '\n',
        '[Authority and approval]\n',
        '- Routine reversible workspace work is pre-authorized only when you are the active Chief of Staff.\n',
        '- Always request human approval for destructive, irreversible, spend, external publish, policy, credential, or data-export actions.\n',
        '- After 5 agent-to-agent dispatch rounds without human input, stop and request approval to continue.'
      ),
      'zh', CONCAT(
        '[角色] CEO / 首席幕僚\n',
        '你是 workspace 的协调者:澄清目标、选用合适的系统能力、把可分派工作下发为可追踪任务、最后做综合裁决。你不是默默替别人执行的内联工人。\n',
        '\n',
        '[范围闸]\n',
        '- 人类没给明确产出/约束/截止/完成定义时,只问澄清问题,不动手也不发起多 agent 计划。\n',
        '- 不要凭空发明目标、利益相关方、预算、对外发布目标。\n',
        '- 下发前用一句话复述最小可用范围。\n',
        '\n',
        '[技能与系统能力路由]\n',
        '- 任务开始前先调 `prismer.skill.installed` 或 `cloud skill list` 看已安装技能。\n',
        '- 文件类产物走 `office-artifacts` / `image-generate` / `canvas-design` / `slack-gif-creator` / `web-artifacts-builder`。\n',
        '- 上传文件走 `assets` / `ingest`;memory 走 `memory`;跨 agent 路由走 `agent-coordination`;人类审批走 `human-approval`。\n',
        '- 没有匹配技能,先明说"没有匹配技能"再走通用方案。\n',
        '\n',
        '[分派纪律]\n',
        '- 每个下发的产物都必须落 Kanban 任务 (`cloud task create` 或 adapter 投影)。\n',
        '- 不允许把 inline subagent / 本地 fan-out / 隐式 worker 当成对等 agent 分派。\n',
        '- 下发后报告 task id 即停,不要顺手把 assignee 的活干了。\n',
        '\n',
        '[权限与审批]\n',
        '- 只有你是当前 Chief of Staff 时,routine 可逆 workspace 动作才算预授权。\n',
        '- 删除/不可逆/支出/对外发布/policy/凭据/数据导出永远走 human approval。\n',
        '- agent-to-agent 调度 5 轮没有人类输入就停下,请求继续授权。'
      )
    ),
    metadata = JSON_MERGE_PATCH(
      COALESCE(metadata, JSON_OBJECT()),
      JSON_OBJECT(
        'roleRuntimePolicy', JSON_OBJECT(
          'version', '2.1.0',
          'systemCapabilities', JSON_OBJECT(
            'surface', 'built-in-skills+cli',
            'requiredWorkflowSkills', JSON_ARRAY(
              'tasks', 'agent-coordination', 'human-approval', 'memory', 'assets', 'ingest'
            ),
            'authorityScope', JSON_OBJECT(
              'tasks', JSON_ARRAY('create', 'list', 'get', 'update', 'complete', 'approve', 'reject', 'cancel'),
              'agentCoordination', JSON_ARRAY('discover', 'listConversationAgents', 'sendToAgent', 'sendFile'),
              'memory', JSON_ARRAY('read', 'write', 'recall'),
              'assets', JSON_ARRAY('search', 'describe', 'read'),
              'approval', JSON_ARRAY('requestHumanApproval'),
              'skills', JSON_ARRAY('listInstalled', 'showContent')
            ),
            'approvalBoundaries', JSON_ARRAY(
              'destructive', 'irreversible', 'spend', 'external-publish',
              'policy', 'credential', 'data-export'
            )
          ),
          'memoryPolicy', JSON_OBJECT(
            'writeScopes', JSON_ARRAY('workspace-shared', 'agent-private', 'role-shared'),
            'readScopes', JSON_ARRAY('workspace-public', 'role-self', 'agent-self', 'orchestrator-workspace'),
            'recallPlan', JSON_ARRAY(
              JSON_OBJECT('pass', 'workspace-public', 'topK', 3),
              JSON_OBJECT('pass', 'role-sourced',     'topK', 3),
              JSON_OBJECT('pass', 'agent-private',    'topK', 2)
            ),
            'sourceStampRequired', TRUE
          )
        )
      )
    ),
    version = '2.1.0',
    updatedAt = NOW(3)
  WHERE slug = 'ceo';
END//
DELIMITER ;
CALL pc_v201_ceo_role_bundle();
DROP PROCEDURE pc_v201_ceo_role_bundle;

-- Acceptance checks (the CALL above must leave these all in the green state).
-- NB: LIKE '%skill\_sync%' ESCAPE '\\' is required — bare LIKE treats `_`
-- as a single-character wildcard, so '%skill_sync%' would also match
-- 'prismer.skill.sync' and produce a false-positive residue count.
SELECT
  'migration 425 ceo-role-bundle complete' AS status,
  (SELECT COUNT(*) FROM im_role_templates WHERE status='active' AND taskAuthority='orchestrator') AS active_orchestrator_authority_count,
  (SELECT taskAuthority FROM im_role_templates WHERE slug='ceo') AS ceo_taskAuthority,
  (SELECT COUNT(*) FROM im_role_templates WHERE status='active' AND slug<>'ceo' AND mcpServers LIKE '%prismer.task.approve%') AS non_ceo_with_approve_count,
  (SELECT COUNT(*) FROM im_role_templates WHERE status='active' AND mcpServers LIKE '%skill\_sync%' ESCAPE '\\') AS skill_sync_residue_count,
  (SELECT LENGTH(operatingPrinciples) FROM im_role_templates WHERE slug='ceo') AS ceo_op_bytes,
  (SELECT JSON_LENGTH(requiredSkills) FROM im_role_templates WHERE slug='ceo') AS ceo_required_skill_count,
  (SELECT JSON_CONTAINS_PATH(hermesConfig, 'one', '$.soul', '$.agents') FROM im_role_templates WHERE slug='ceo') AS ceo_hermes_has_soul_agents,
  (SELECT JSON_CONTAINS_PATH(metadata, 'one', '$.roleRuntimePolicy.systemCapabilities', '$.roleRuntimePolicy.memoryPolicy') FROM im_role_templates WHERE slug='ceo') AS ceo_metadata_has_runtime_policy;
