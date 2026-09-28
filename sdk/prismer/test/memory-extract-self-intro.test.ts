/**
 * 2026-08-30（product210/03 同轮遗留）：agent 自我介绍不应铸成 memory 页。
 *
 * 事故形状（test 环境 ws-e1785f14，群「你们都能干什么？」）：3-agent kickoff
 * 的每条自我介绍回复各被 post-turn 抽取成一页角色页（engineer/marketer 角色
 * 与工作方式，provenance traceId = api_*-uuid 即 plugin sync_turn → post_llm_call
 * → runBackgroundExtraction 链）。门槛 `agent_self_intro` 是确定性防线；
 * EXTRACTION_SYSTEM_PROMPT 的 self-description 规则是教学防线（管住变体）。
 *
 * 负控口径：(a) 正常工作汇报（含「我是」但非自我介绍形状）不得误杀；
 * (b) 用户显式 retention contract（require）必须放行——用户说「记住我们的
 * 角色分工」时抽取照常进行。
 */

import { describe, expect, it } from 'vitest';
import { isAgentSelfIntro, shouldSkipExtraction, EXTRACTION_SYSTEM_PROMPT } from '../src/daemon/memory/extract.js';

function input(userMessage: string, assistantResponse: string) {
  return {
    userMessage,
    assistantResponse,
    conversationHistory: [],
    agentImUserId: 'agent_x',
    workspaceId: 'ws_x',
    roleSlug: null,
    conversationId: 'conv_x',
    runId: 'run_x',
    sessionMetadata: { model: 'm', platform: 'p' },
  };
}

const LONG_ENOUGH = 'x'.repeat(80);
const LONG_REPLY = 'y'.repeat(200);

describe('agent self-introduction extraction gate', () => {
  it('blocks the observed kickoff shapes (per-reply self-intros)', () => {
    // 实录形状一：团队管家转场 + 自我介绍
    const managerReply =
      '我先把团队能力介绍一下，@engineer @marketer 也请各自补一段自我介绍。  我是 @team-manager-j6uy，团队管家（Team Manager），主要负责：  1. 目标澄清与拆解：你把目标说清楚，我帮你定可交付的产出、约束和验收标准，拆成看板任务分派给对应角色。' + LONG_REPLY;
    expect(isAgentSelfIntro(managerReply)).toBe(true);
    expect(shouldSkipExtraction(input(LONG_ENOUGH, managerReply))).toBe('agent_self_intro');
    // 实录形状二：成员自我介绍
    const engineerReply =
      '@team-manager-j6uy 收到，自我介绍来了。  我是 @engineer，团队里的工程执行，主要负责：  1. 写代码与实现：按 PRD 或需求文档落地功能，代码、脚本、自动化流程都归我。  2. 测试与验证：写测试用例、跑测试套件、做技术验证和 bug 排查，交付前用真实执行结果自证。' + LONG_REPLY;
    expect(isAgentSelfIntro(engineerReply)).toBe(true);
    expect(shouldSkipExtraction(input(LONG_ENOUGH, engineerReply))).toBe('agent_self_intro');
    // 实录形状三：无 @ 前缀的自我介绍
    const marketerReply = '收到，自我介绍来了。  我是 marketer，团队里的市场/运营……' + LONG_REPLY;
    expect(isAgentSelfIntro(marketerReply)).toBe(true);
  });

  it('does not kill ordinary work reports (narrow shape only)', () => {
    // 「我是」出现在句中/后段，且无自我介绍措辞 —— 不是 kickoff 回复。
    const workReport =
      '部署完成了。我是用蓝绿策略切的流量，回滚脚本在仓库 ops/rollback.sh。' + LONG_REPLY;
    expect(isAgentSelfIntro(workReport)).toBe(false);
    expect(shouldSkipExtraction(input(LONG_ENOUGH, workReport))).toBeNull();
    // 自我介绍措辞出现在 160 字符头部之外（比如引用早前的话）不算。
    const lateMention = LONG_REPLY + '（前文里有人提过自我介绍这个词）' + LONG_REPLY;
    expect(isAgentSelfIntro(lateMention)).toBe(false);
  });

  it('an explicit user retention contract overrides the gate', () => {
    const introReply = '收到，自我介绍来了。  我是 @engineer，团队里的工程执行……' + LONG_REPLY;
    const requireMsg =
      '麻烦把刚才各位的角色分工整理一下：team-manager 管目标拆解与看板，engineer 管工程交付，marketer 管内容与增长。这些分工请跨会话记住，后续会话要复用，不要再问第二遍。';
    expect(shouldSkipExtraction(input(requireMsg, introReply))).toBeNull();
  });

  it('the teaching prompt carries the self-description rule (variant net)', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('AGENT SELF-DESCRIPTIONS ARE NOT DURABLE');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('ROLE-TEMPLATE material');
  });
});

// product210/03 W2-4 (X4) — attached-asset turns are exempt from the raw
// length gates: "传个 pdf 说『记住这个』" must extract, not die on
// too_short_user. Greeting / self-intro / fabric gates still apply.
describe('W2-4 attached-asset gate exemption', () => {
  const attachedShort =
    '记住这份文档 <attached_assets><asset id="ast_1" filename="a.pdf" mime="application/pdf"></asset></attached_assets>';

  it('exempts an attached-asset turn from the 80/200 length gates', () => {
    expect(shouldSkipExtraction(input(attachedShort, 'y'.repeat(30)))).toBeNull();
  });

  it('NEGATIVE CONTROL — the same short turn without attachments still dies on too_short_user', () => {
    expect(shouldSkipExtraction(input('记住这份文档', 'y'.repeat(30)))).toBe('too_short_user');
  });

  it('attached exemption does NOT rescue the self-intro gate', () => {
    // GREETING_RE is anchored (^…$) so an attached XML tail never matches it;
    // the gate that must still fire on an attached turn is agent_self_intro.
    const introReply =
      '我是 @engineer，软件工程师，负责按 PRD 实现 feature、写代码与测试。' + 'y'.repeat(200);
    expect(
      shouldSkipExtraction(
        input(attachedShort + ' ', introReply),
      ),
    ).toBe('agent_self_intro');
  });
});
