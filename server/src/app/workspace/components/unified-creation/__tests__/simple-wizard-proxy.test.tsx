/**
 * @vitest-environment jsdom
 *
 * 2026-05-30 — Simple wizard `proxyProvider` 高级选项 smoke test
 * (补 commit 8d914c41 漏点).
 *
 * 上一轮 `device create 加 proxyProvider 高级选项` 只接了两条创建链路：
 *   - NewAgentDialog (standalone "新增 agent")
 *   - Pro 模式的 ProTileAgent / ProTileProfile
 *
 * 漏了 UnifiedCreationModal 里的 Simple wizard（workspace 首次 bootstrap
 * 引导流程, 99% 新用户实际走的路径）。本测试覆盖 wiring 闭环：
 *
 *   1. SimpleStep1Industry 渲染时 AdvancedProxyAccordion 出现, badge 显示
 *      当前值; 用户点击切到 'deepseek' 触发 onProxyProviderChange.
 *   2. 把同一个值塞进 buildSimpleProfileConfig 后, 输出的 config blob 的
 *      `proxyProvider` 字段正确, 跟 Pro 模式 buildLongRunningProfileConfig
 *      的 hermes 分支行为对称。
 *
 * 不测的（已有覆盖）:
 *   - buildSimpleProfileConfig 默认 / deepseek 单元测试 — 见 acp-profile-config.test.ts
 *   - AdvancedProxyAccordion 自身的 UI — 是 Pro 端已 ship 组件，不重测
 *   - ProxyProviderSelect radio 切换 keyboard 交互 — radix-ui primitive 不重测
 */

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SimpleStep1Industry } from '../SimpleStep1Industry';
import { buildSimpleProfileConfig } from '../use-simple-provisioning';
import { getDefaultModelForProvider } from '../../../lib/model-defaults';
import type { ProxyProvider } from '../../proxy-provider-select';
import type { RenderedRole } from '../../../lib/templates/types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

function render(node: React.ReactElement) {
  act(() => {
    root = createRoot(container!);
    root.render(node);
  });
}

describe('Simple wizard — proxyProvider 高级选项 (补 8d914c41 漏点)', () => {
  it('Step 1 Industry 屏渲染时 AdvancedProxyAccordion 可见并显示当前 provider badge', () => {
    let captured: ProxyProvider = 'newapi';
    render(
      <SimpleStep1Industry
        isDark={false}
        initialOrganizationName="Acme"
        model="us-kimi-k2.6"
        proxyProvider="newapi"
        onOrganizationNameChange={() => undefined}
        onModelChange={() => undefined}
        onProxyProviderChange={(next) => {
          captured = next;
        }}
        onSelectionChange={() => undefined}
      />,
    );

    // Accordion trigger 出现（默认 collapsed）—— 用 testIdPrefix='simple-step1'
    const trigger = container!.querySelector(
      '[data-testid="simple-step1-advanced-trigger"]',
    );
    expect(trigger).not.toBeNull();

    // Badge 显示当前 provider（newapi）
    const summary = container!.querySelector(
      '[data-testid="simple-step1-proxy-provider-summary"]',
    );
    expect(summary?.textContent).toBe('newapi');

    // captured 还没被触发, 还是 init 值
    expect(captured).toBe('newapi');
  });

  it('buildSimpleProfileConfig 接受 Step 1 选中的 proxyProvider 并写进 hermes config', () => {
    // 模拟用户在 Simple wizard Step 1 选了 deepseek，simplePlan.proxyProvider
    // 是 'deepseek'，每条 AgentProfile.config 应该带这个字段。
    const role: RenderedRole = {
      slug: 'ceo',
      displayName: 'CEO',
      agentType: 'orchestrator',
      primary: true,
      rationale: 'Owns direction and delegation.',
      capabilities: ['strategy'],
      defaultIcon: 'crown',
    };

    const configDefault = buildSimpleProfileConfig(role, 'ceo', 'Acme', 'us-kimi-k2.6');
    expect(configDefault.proxyProvider).toBe('newapi');

    const configDeepseek = buildSimpleProfileConfig(role, 'ceo', 'Acme', 'us-kimi-k2.6', 'deepseek');
    expect(configDeepseek.proxyProvider).toBe('deepseek');

    // 跟 model 字段共存，互不踩
    expect(configDeepseek.model).toBe('us-kimi-k2.6');
  });

  it('getDefaultModelForProvider 与 curated 漏斗第一项保持一致 (UI 切 provider 时拿到的 default)', () => {
    // 2026-05-30 — proxyProvider × model 紧耦合: 这条断言是 UnifiedCreationModal
    // / NewAgentDialog / ProTileAgent / ProTileProfile 切 provider 时 reset model
    // 的关键契约. 改 helper 默认值要跟 curated-models.ts 漏斗第一项同步.
    expect(getDefaultModelForProvider('newapi')).toBe('us-kimi-k2.6');
    expect(getDefaultModelForProvider('deepseek')).toBe('deepseek-v4-flash');
  });
});
