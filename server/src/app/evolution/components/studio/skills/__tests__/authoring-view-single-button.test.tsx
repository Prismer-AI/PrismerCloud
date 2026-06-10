/**
 * @vitest-environment jsdom
 *
 * release201 v2.0.8 F-bug — Skill 编写 view 删除 EmptyState 内冗余的
 * "+ 新建技能" 按钮.
 *
 * 用户原话 (截图实测): "evolution studio skill 编写 view 有两个'新建技能'按钮"
 *
 * 之前 EmptyState 同时渲染了:
 *   1. Workshop banner 顶部的 always-visible `[data-testid="studio-new-skill"]`
 *   2. EmptyState hero card 内的 shrink-0 Button
 *   3. 4 张 source kind card (每张 onClick={() => onNew(card.mode)})
 *
 * 修复后只保留 (1) + (3); (2) 删除 — 因为 4 张 source kind card 已经是
 * onNew 的入口, 且 (1) 在 banner 顶部 always-visible.
 *
 * 行为契约:
 *   - skills 列表为空时, `[data-testid="studio-new-skill"]` 只出现一次
 *   - skills 列表有内容时, banner 按钮仍可见
 *   - empty state 仍然渲染 4 张 source kind card
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Stub the data layer; fetchDrafts is what flips empty / non-empty in the view.
vi.mock('../../types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../types')>();
  return {
    ...actual,
    fetchDrafts: vi.fn(),
    fetchDraftDetail: vi.fn(async () => null),
    fetchWorkspaceSkillsByStage: vi.fn(async () => []),
  };
});

import { AuthoringView } from '../authoring-view';
import { fetchDrafts } from '../../types';
import { I18nProvider } from '@/contexts/i18n-context';

async function mount(): Promise<{ host: HTMLElement; cleanup: () => Promise<void> }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider>
        <AuthoringView
          isDark={false}
          workspaceId="ws-1"
          draftId={null}
          onDraftChange={() => undefined}
          onHasDraftChange={() => undefined}
        />
      </I18nProvider>,
    );
  });
  // Drain fetchDrafts microtasks.
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
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

beforeEach(() => {
  vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('{"token":"t"}');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('authoring-view + 新建技能 buttons (release201 v2.0.8 F-bug)', () => {
  it('exactly ONE [data-testid="studio-new-skill"] button when skill list is empty', async () => {
    vi.mocked(fetchDrafts).mockResolvedValue([]);
    const { host, cleanup } = await mount();
    const buttons = host.querySelectorAll('[data-testid="studio-new-skill"]');
    expect(buttons.length).toBe(1);
    // The remaining button is the banner one — it lives inside the
    // workshop header bar (the .workshop spatial grammar block).
    const btn = buttons[0];
    expect(btn.closest('[data-spatial-grammar="workshop"]')).toBeTruthy();
    await cleanup();
  });

  it('empty state still renders the 4 source kind cards as onNew entries', async () => {
    vi.mocked(fetchDrafts).mockResolvedValue([]);
    const { host, cleanup } = await mount();
    // 4 motion.button cards inside the empty state grid (sm:grid-cols-2 lg:grid-cols-4).
    // We check by looking at the source-bench chips (`data-source-kind="..."`)
    // exposing the 4 kinds — same kinds used by the EmptyState grid.
    const sourceKinds = host.querySelectorAll('[data-source-kind]');
    expect(sourceKinds.length).toBe(4);
    const kinds = Array.from(sourceKinds).map((el) => el.getAttribute('data-source-kind'));
    expect(kinds.sort()).toEqual(['api', 'doc', 'plain', 'script']);
    await cleanup();
  });

  it('banner button still visible when skill list has items (not empty state)', async () => {
    vi.mocked(fetchDrafts).mockResolvedValue([
      {
        id: 'd-1',
        slug: 'weekly-digest',
        name: 'Weekly digest',
        description: 'Summarise weekly tickets',
        status: 'draft',
        updatedAt: '2026-05-28T10:00:00Z',
      },
    ]);
    const { host, cleanup } = await mount();
    const buttons = host.querySelectorAll('[data-testid="studio-new-skill"]');
    // 列表非空仍只剩 banner 上那一个 button (不会因为列表非空就多渲染一个).
    expect(buttons.length).toBe(1);
    await cleanup();
  });
});
