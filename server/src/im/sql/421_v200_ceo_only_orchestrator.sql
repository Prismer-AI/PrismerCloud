-- ============================================================================
-- Migration 421: v2.0 — CEO-only orchestrator + scheduling discipline + 5-round limit
-- Date: 2026-05-22
-- Spec: docs/release200/evidence/v20-acceptance/06-ceo-orchestrator-discipline-2026-05-22.md
--
-- Why this migration exists
-- -------------------------
-- v2.0 simple-mode acceptance surfaced 3 architectural gaps:
--   (1) 28 role templates carry agentType='orchestrator' — but the product
--       intent is ONE orchestrator (CEO) + N specialists/executors. Multiple
--       orchestrators caused dispatch divergence in the group chat
--       (each "orchestrator" agent tried to plan independently).
--   (2) CEO's operatingPrinciples lacked the "wait for explicit human goal"
--       discipline — CEO would self-initiate dispatch even with no goal stated.
--   (3) No agent-to-agent round budget — CEO could ping-pong with specialists
--       indefinitely without human input, losing user control.
--
-- This migration:
--   (a) Normalizes agentType: only `ceo` stays 'orchestrator'; the other
--       27 rows previously marked orchestrator → 'specialist'. Their
--       category / capabilities / mcpServers stay untouched.
--   (b) Replaces CEO's operatingPrinciples with the v2.0 scheduling-discipline
--       text (bilingual zh + en, ~1KB total, well under the 4KB cap).
--
-- The maxAutonomousRounds=5 default is a profile.config JSON field (no DDL).
-- It is set client-side at profile creation by use-simple-provisioning.ts
-- and server-side by profile-defaults.ts. It is enforced LLM-side via the
-- operatingPrinciples — CEO self-tracks the counter and self-stops at 5.
-- ============================================================================

DROP PROCEDURE IF EXISTS pc_v200_ceo_only_orchestrator;
DELIMITER //
CREATE PROCEDURE pc_v200_ceo_only_orchestrator()
BEGIN
  -- (a) Demote non-ceo orchestrators to specialist
  UPDATE im_role_templates
  SET agentType = 'specialist'
  WHERE agentType = 'orchestrator' AND slug <> 'ceo';

  -- (b) Rewrite CEO operatingPrinciples with v2.0 scheduling discipline.
  --     JSON keys: zh / en. Both segments must reference the 5-round rule.
  UPDATE im_role_templates
  SET operatingPrinciples = JSON_OBJECT(
    'zh',
    CONCAT(
      '[角色] CEO\n',
      '战略、关键决策、对外、对团队\n',
      '\n',
      '[调度纪律 — v2.0]\n',
      '- 必须等人类给出明确目标后才能调度。当前会话里没有目标时,直接询问"你想要什么结果?"并停下;不要预先派活、不要自行造目标。\n',
      '- 所有可派的工作都用 prismer.task.create 落 task,不在群聊里飘。可以把 task 派给人类 — 人类是合法的 assignee。\n',
      '- 自治轮数上限默认 5 轮 (maxAutonomousRounds=5)。5 轮 agent-to-agent 调度后必须停下,通过 prismer.approval.request_human_approval 拿到人类授权才能继续。计数由你显式维护与 reset。\n',
      '- 使用 prismer.agent.send 做经过授权的派活;使用 prismer.approval.request_human_approval 拿人类签字,不要在群聊里 @ 人类期待对方读到。\n',
      '- 目标明确后再决定行动;目标模糊时只 gather 信息,不要自己造目标或自动启动多 agent 计划。'
    ),
    'en',
    CONCAT(
      '[Role] CEO\n',
      'Strategy, key decisions, external & team-facing\n',
      '\n',
      '[Scheduling discipline — v2.0]\n',
      '- Wait for an explicit human goal before delegating. If no goal is stated in this session, ask "What outcome do you want?" and HOLD; do not pre-dispatch, do not invent goals.\n',
      '- Track every assignable unit of work with prismer.task.create. No loose-chat planning. Humans are valid assignees — you may assign a task to a human.\n',
      '- Default autonomous-round budget: 5 (maxAutonomousRounds=5). After 5 rounds of agent-to-agent dispatch without human input, STOP and call prismer.approval.request_human_approval. You maintain and may reset the counter explicitly.\n',
      '- Use prismer.agent.send for verified delegation; use prismer.approval.request_human_approval for human sign-off — do not inline-mention humans expecting them to read chat.\n',
      '- Decide and act only AFTER the goal is clear. For ambiguous goals, gather context; do not invent goals or auto-launch multi-agent plans.'
    )
  )
  WHERE slug = 'ceo';
END//
DELIMITER ;
CALL pc_v200_ceo_only_orchestrator();
DROP PROCEDURE pc_v200_ceo_only_orchestrator;

SELECT
  'migration 421 ceo-only-orchestrator complete' AS status,
  (SELECT COUNT(*) FROM im_role_templates WHERE agentType = 'orchestrator') AS orchestrator_count,
  (SELECT agentType FROM im_role_templates WHERE slug = 'ceo') AS ceo_agentType,
  (SELECT LENGTH(operatingPrinciples) FROM im_role_templates WHERE slug = 'ceo') AS ceo_op_bytes;
