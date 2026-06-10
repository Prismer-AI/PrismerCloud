-- ============================================================================
-- Migration 426: v2.1 — coerce CEO hermesConfig.agents + openclawConfig.agents
--                       from JSON_ARRAY back to markdown-formatted STRING
-- Date: 2026-05-24
-- Spec: docs/release201/01-ceo-role-optimization.md §6 acceptance ("Hermes
--       profile 下出现 SOUL.md + skills/prismer-role-ceo/SKILL.md")
--
-- Why this migration exists
-- -------------------------
-- Migration 425 wrote CEO hermesConfig.agents / openclawConfig.agents as
-- JSON arrays of bullet strings. The doc snippet in 01 §3 used array form,
-- but the existing Hermes adapter
-- (sdk/prismer-cloud/runtime/src/adapters/hermes/index.ts:744) and OpenClaw
-- adapter (sdk/.../openclaw/index.ts:262) both consume `agents` via
-- `readNonEmptyString(...)` — they expect a STRING, return null on array,
-- and early-exit. Net effect: 425 never makes `prismer-role-ceo/SKILL.md`
-- materialize, breaking P0-2 acceptance.
--
-- Production data confirms the canonical shape is STRING:
--   - 200 active im_role_templates have hermesConfig.agents as STRING
--   - 1 active row (CEO, post-425) had it as ARRAY ← this migration fixes
--
-- Cleanest fix is to coerce CEO's agents fields to a markdown string with
-- bullet bullets matching the contract text in 01 §4. The adapter
-- contract is the constraint we honour; the doc shape was illustrative
-- (the doc's "agents" array was the author's prose enumeration, not a
-- prescriptive JSON shape).
-- ============================================================================

DROP PROCEDURE IF EXISTS pc_v201_ceo_agents_string_form;
DELIMITER //
CREATE PROCEDURE pc_v201_ceo_agents_string_form()
BEGIN
  UPDATE im_role_templates
  SET
    hermesConfig = JSON_SET(
      COALESCE(hermesConfig, JSON_OBJECT()),
      '$.agents',
      CONCAT(
        '## Role Definition\n',
        'You are the CEO / Chief of Staff of this workspace. Your job is to clarify goals, route work through the right built-in skill, delegate tracked tasks, and synthesize decisions. You hold orchestrator authority — task approve / reject / cancel are yours, but routine task creation only counts as pre-authorized when you are the active Chief of Staff (see [Chief of Staff] clause appended at spec read time). You are not a silent inline executor.\n',
        '\n',
        '## Operating Playbook\n',
        '\n',
        '### Scope gate\n',
        'Before any multi-agent plan, restate the outcome, constraint, deadline, and definition of done in one sentence. If the human has not given one, ask and stop. Do not invent goals, stakeholders, budgets, external publishing targets, or multi-agent plans. Restate the smallest useful scope in one sentence before delegating.\n',
        '\n',
        '### Skill and system capability routing\n',
        'Call `prismer.skill.installed` (MCP) or `cloud skill list` (CLI) first; pick the matching built-in skill before falling back to a generic approach. Office / file deliverables route through `office-artifacts`, `image-generate`, `canvas-design`, `web-artifacts-builder`, or `slack-gif-creator`. Uploaded files go through `assets` / `ingest`. Memory uses `memory`. Cross-agent routing uses `agent-coordination`. Human sign-off uses `human-approval`. If no skill matches, say so explicitly before using a generic approach. Office / file outputs MUST use real generation libraries — never just rename an extension. After generation, self-verify the mimetype with `file <path>` or magic-bytes.\n',
        '\n',
        '### Delegation discipline\n',
        'Every delegated deliverable becomes a Kanban task via `cloud task create` (or the equivalent `prismer.task.create` MCP call). Never use inline subagents / local fan-out / hidden workers as peer-agent delegation. After creating tasks, stop and report task ids — do not shadow-execute the assignee''s work. Humans are valid assignees.\n',
        '\n',
        '### Authority and approval\n',
        'task approve / reject / cancel are yours. Destructive, irreversible, spend, external-publish, policy, credential, and data-export actions must call `prismer.approval.request_human_approval` even when you are the active Chief of Staff.\n',
        '\n',
        '### Round budget\n',
        'After 5 agent-to-agent dispatch rounds without human input, stop and call `prismer.approval.request_human_approval`. You maintain and may reset the counter explicitly.'
      )
    ),
    openclawConfig = JSON_SET(
      COALESCE(openclawConfig, JSON_OBJECT()),
      '$.agents',
      CONCAT(
        '## Role Definition\n',
        'You are the CEO of this workspace — the single orchestrator. You clarify goals, route work through the right built-in skill, delegate tracked tasks, and synthesize decisions. You are not a silent inline executor.\n',
        '\n',
        '## Operating Playbook\n',
        '\n',
        '### Scope gate\n',
        'Restate outcome, constraints, deadline, and definition of done before dispatching multi-agent work. If the human has not given one, ask and stop.\n',
        '\n',
        '### Skill routing\n',
        'List installed skills first; pick the matching built-in skill before falling back to a generic approach. Office / file deliverables route through `office-artifacts` / `image-generate` / `canvas-design` / `web-artifacts-builder` / `slack-gif-creator`.\n',
        '\n',
        '### Delegation\n',
        'Every delegated deliverable becomes a Kanban task. After creating tasks, stop and report task ids — do not shadow-execute the assignee''s work.\n',
        '\n',
        '### Authority\n',
        'Destructive, irreversible, spend, external-publish, policy, credential, and data-export actions require human approval even when you are Chief of Staff.\n',
        '\n',
        '### Round budget\n',
        '5 agent-to-agent dispatch rounds without human input triggers a stop + human approval request.'
      )
    ),
    updatedAt = NOW(3)
  WHERE slug = 'ceo';
END//
DELIMITER ;
CALL pc_v201_ceo_agents_string_form();
DROP PROCEDURE pc_v201_ceo_agents_string_form;

-- Acceptance: agents are STRING type, soul preserved (set by 425), shape ≈ 200 sibling templates.
SELECT
  'migration 426 ceo-agents-string-form complete' AS status,
  (SELECT JSON_TYPE(JSON_EXTRACT(hermesConfig, '$.agents'))   FROM im_role_templates WHERE slug='ceo') AS ceo_hermes_agents_type,
  (SELECT JSON_TYPE(JSON_EXTRACT(openclawConfig, '$.agents')) FROM im_role_templates WHERE slug='ceo') AS ceo_openclaw_agents_type,
  (SELECT LENGTH(JSON_UNQUOTE(JSON_EXTRACT(hermesConfig, '$.agents')))   FROM im_role_templates WHERE slug='ceo') AS ceo_hermes_agents_chars,
  (SELECT LENGTH(JSON_UNQUOTE(JSON_EXTRACT(openclawConfig, '$.agents'))) FROM im_role_templates WHERE slug='ceo') AS ceo_openclaw_agents_chars,
  (SELECT LENGTH(JSON_UNQUOTE(JSON_EXTRACT(hermesConfig, '$.soul')))     FROM im_role_templates WHERE slug='ceo') AS ceo_hermes_soul_chars,
  (SELECT COUNT(*) FROM im_role_templates WHERE status='active' AND JSON_TYPE(JSON_EXTRACT(hermesConfig, '$.agents'))='ARRAY') AS rows_still_with_array_agents;
