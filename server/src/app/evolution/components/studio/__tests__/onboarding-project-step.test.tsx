/**
 * @vitest-environment jsdom
 *
 * release201 v2.0.8 F-bug — StudioOnboarding project step.
 *
 * 用户原话: "我们当前的用户引导和创建逻辑都没体现 project 这一层的抽象".
 * Studio 引导现在是 4 步 (pair → project → install → draft), project step
 * 跳到 /workspace 让用户用 ProjectSwitcher 创建.
 *
 * 行为契约:
 *   - hasProject=false → 渲染 4 个未完成 step, "Create a project" 显示 CTA
 *   - hasProject=true  → project step 标记为 done (不显示 CTA)
 *   - project step 的 CTA 是 <Link href="/workspace">
 *   - 4 个 step 全 done → 折叠成 "doneTitle" panel
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { StudioOnboarding } from '../onboarding';
import { I18nProvider } from '@/contexts/i18n-context';

interface MountState {
  hasAgent: boolean;
  hasInstalledSkill: boolean;
  hasDraft: boolean;
  hasProject: boolean;
}

async function mount(state: MountState): Promise<{
  host: HTMLElement;
  cleanup: () => Promise<void>;
}> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider>
        <StudioOnboarding isDark={false} state={state} onNewSkill={() => undefined} />
      </I18nProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    host,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

afterEach(() => {
  // nothing — components are self-contained
});

describe('StudioOnboarding — project step (release201 v2.0.8 F-bug)', () => {
  it('renders project step when hasProject=false (4-step variant)', async () => {
    const { host, cleanup } = await mount({
      hasAgent: false,
      hasInstalledSkill: false,
      hasDraft: false,
      hasProject: false,
    });
    const panel = host.querySelector('[data-testid="studio-onboarding"]');
    expect(panel).toBeTruthy();
    // 4 step rows (pair / project / install / draft).
    const items = panel?.querySelectorAll('ol > li');
    expect(items?.length).toBe(4);
    // Project copy is the EN string from src/lib/i18n.ts.
    expect(panel?.textContent).toContain('Create a project');
    expect(panel?.textContent).toContain(
      'Group your tasks and skills under a project to track progress and acceptance.',
    );
    await cleanup();
  });

  it('project step CTA links to /workspace', async () => {
    const { host, cleanup } = await mount({
      hasAgent: true, // 让其他 step 完成, 把焦点放在 project step CTA
      hasInstalledSkill: true,
      hasDraft: true,
      hasProject: false,
    });
    // Project step is the second row (pair → PROJECT → install → draft).
    const items = host.querySelectorAll('[data-testid="studio-onboarding"] ol > li');
    expect(items.length).toBe(4);
    const projectRow = items[1];
    expect(projectRow.textContent).toContain('Create a project');
    const link = projectRow.querySelector('a');
    expect(link).toBeTruthy();
    expect(link?.getAttribute('href')).toBe('/workspace');
    expect(link?.textContent).toContain('Open workspace');
    await cleanup();
  });

  it('project step is marked done when hasProject=true (no CTA)', async () => {
    const { host, cleanup } = await mount({
      hasAgent: false, // 故意让第 1 步没完成, 仍能进入 onboarding panel
      hasInstalledSkill: false,
      hasDraft: false,
      hasProject: true,
    });
    const items = host.querySelectorAll('[data-testid="studio-onboarding"] ol > li');
    expect(items.length).toBe(4);
    const projectRow = items[1];
    // 完成的 step 不再渲染 CTA button / link.
    expect(projectRow.querySelector('a')).toBeNull();
    expect(projectRow.querySelector('button')).toBeNull();
    // pair step (第 1 步) 仍未完成, 应有 link.
    const pairRow = items[0];
    expect(pairRow.querySelector('a')).toBeTruthy();
    await cleanup();
  });

  it('all 4 steps done collapses into done panel', async () => {
    const { host, cleanup } = await mount({
      hasAgent: true,
      hasInstalledSkill: true,
      hasDraft: true,
      hasProject: true,
    });
    // doneTitle / doneBody from i18n (en).
    expect(host.textContent).toContain('You’re set up.');
    // 不再渲染 onboarding panel.
    expect(host.querySelector('[data-testid="studio-onboarding"]')).toBeNull();
    await cleanup();
  });
});
