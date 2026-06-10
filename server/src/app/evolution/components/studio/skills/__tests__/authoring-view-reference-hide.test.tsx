/**
 * @vitest-environment jsdom
 *
 * release201 v2.0.8 Y1 + Y2 — Reference panel auto-hide + SkillDetail dedup.
 *
 * Y1 — Reference panel占了 3rd column 320px 即使内容与 SkillDetail manifest
 *      完全重复 (sources section) 或两个非重复数据源 (related-published,
 *      recent-drafts) 都为空。新用户单 skill workspace 永远卡这种状态。
 *      Fix: ReferencePanel 只在 (related > 0 || recentDrafts > 0) 时渲染；
 *      sources section 永久移除；父 grid 在不渲染 ReferencePanel 时退化到
 *      2-col。
 *
 * Y2 — 用户感觉"点击草稿→展开 SkillDetail→关闭"无信息增量。原因是 SkillDetail
 *      卡片只是把 brief 行的 description 用 leading-relaxed 重复一次 + 显示
 *      文件清单（也在右栏 sources section 重复）。
 *      Fix: SkillDetail 去掉 description 重复 (brief 已显示)，保留**独占**
 *      信息: 文件清单 with size + 总 bytes + revision SHA + updatedAt。
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Single-skill workspace fixture — common new-user state.
vi.mock('../../types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../types')>();
  return {
    ...actual,
    fetchDrafts: vi.fn(async () => [
      {
        id: 'draft-only',
        slug: 'product-intro-md-v2',
        name: 'Product intro v2',
        description: 'Single draft in this workspace',
        status: 'draft',
        updatedAt: '2026-05-28T10:00:00Z',
      },
    ]),
    fetchDraftDetail: vi.fn(async (id: string) => ({
      id,
      slug: 'product-intro-md-v2',
      name: 'Product intro v2',
      description: 'Single draft in this workspace',
      status: 'draft',
      updatedAt: '2026-05-28T10:00:00Z',
      contentManifestRevision: 'abc1234567890def',
      files: [
        { path: 'SKILL.md', size: 3174 },
        { path: 'skill.json', size: 717 },
      ],
    })),
    // No published skills in this workspace → related is always empty.
    fetchWorkspaceSkillsByStage: vi.fn(async () => []),
  };
});

import { AuthoringView } from '../authoring-view';
import { I18nProvider } from '@/contexts/i18n-context';

async function mount(props: { draftId: string | null }): Promise<{
  host: HTMLElement;
  cleanup: () => Promise<void>;
}> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider>
        <AuthoringView
          isDark={true}
          workspaceId="ws-single"
          draftId={props.draftId}
          onDraftChange={() => undefined}
          onHasDraftChange={() => undefined}
        />
      </I18nProvider>,
    );
  });
  // Drain microtasks: fetchDrafts → fetchDraftDetail → fetchWorkspaceSkillsByStage.
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
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

describe('authoring-view — Reference panel auto-hide (Y1)', () => {
  it('hides the reference panel when single-skill workspace has no related-published + no other recent drafts', async () => {
    const { host, cleanup } = await mount({ draftId: 'draft-only' });
    // The active draft IS the only draft; recentDrafts excludes it → empty.
    // Related published is mocked empty. So the panel earns 0 columns and
    // disappears entirely, freeing the 320px for the centre track.
    expect(host.querySelector('[data-testid="reference-panel"]')).toBeNull();
    await cleanup();
  });

  it('collapses workshop grid to 2-col when reference panel is hidden', async () => {
    const { host, cleanup } = await mount({ draftId: 'draft-only' });
    const workshop = host.querySelector('[data-testid="authoring-workshop"]');
    expect(workshop).toBeTruthy();
    // 2-col layout: no 320px 3rd track.
    expect(workshop?.className).toMatch(/lg:grid-cols-\[280px_minmax\(0,1fr\)\](?!_)/);
    expect(workshop?.className).not.toMatch(/_320px\]/);
    // data attribute exposes the collapse decision for downstream styling.
    expect(workshop?.getAttribute('data-reference-visible')).toBe('false');
    await cleanup();
  });

  it('does NOT render a "sources" section anywhere in the panel even if it were forced visible', async () => {
    // With draftId=null, recentDrafts is empty (single draft is the only one
    // and it's not selected; filter excludes detail?.id which is null so
    // nothing is filtered → recentDrafts has the 1 draft).
    // So the panel DOES render (recent-drafts has content) — but sources is
    // still permanently removed.
    const { host, cleanup } = await mount({ draftId: null });
    const panel = host.querySelector('[data-testid="reference-panel"]');
    expect(panel).toBeTruthy(); // 1 recent draft → panel visible
    expect(panel?.querySelector('[data-section="sources"]')).toBeNull();
    expect(panel?.querySelector('[data-section="recent-drafts"]')).toBeTruthy();
    await cleanup();
  });
});

describe('authoring-view — SkillDetail dedup (Y2)', () => {
  it('SkillDetail card omits the description (already shown in brief row)', async () => {
    const { host, cleanup } = await mount({ draftId: 'draft-only' });
    const detail = host.querySelector('[data-testid="skill-detail"]');
    expect(detail).toBeTruthy();
    // Brief description text should NOT appear inside SkillDetail.
    expect(detail?.textContent ?? '').not.toMatch(/Single draft in this workspace/);
    await cleanup();
  });

  it('SkillDetail card shows the file manifest with size — the increment over brief', async () => {
    const { host, cleanup } = await mount({ draftId: 'draft-only' });
    const detail = host.querySelector('[data-testid="skill-detail"]');
    expect(detail).toBeTruthy();
    const text = detail?.textContent ?? '';
    expect(text).toMatch(/SKILL\.md/);
    expect(text).toMatch(/skill\.json/);
    // Per-file KB display (3174 / 1024 ≈ 3.1 KB).
    expect(text).toMatch(/3\.1 KB/);
    await cleanup();
  });

  it('SkillDetail card shows revision SHA (short-form)', async () => {
    const { host, cleanup } = await mount({ draftId: 'draft-only' });
    const detail = host.querySelector('[data-testid="skill-detail"]');
    expect(detail?.textContent ?? '').toMatch(/abc1234/);
    await cleanup();
  });

  it('SkillDetail card shows total file count + size summary', async () => {
    const { host, cleanup } = await mount({ draftId: 'draft-only' });
    const detail = host.querySelector('[data-testid="skill-detail"]');
    const text = detail?.textContent ?? '';
    expect(text).toMatch(/2 files/);
    // 3174 + 717 = 3891 bytes → 3.8 KB
    expect(text).toMatch(/3\.8 KB/);
    await cleanup();
  });
});
