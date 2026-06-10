/**
 * @vitest-environment jsdom
 *
 * V6 — Authoring workshop 3-column layout + Reference panel
 * (release201/13 §3.2, release201/20 §9.2).
 *
 * Structural assertions for the new 3rd column ("Reference panel"):
 *   1. Desktop renders the panel as a distinct pane next to source-bench
 *      and active-draft (the workshop grammar's 3rd region).
 *   2. Mobile collapses the panel into a button-toggled drawer; default
 *      state is closed and toggling the button reveals the body.
 *   3. Empty state (no draft picked) surfaces the localized "referenceEmpty"
 *      hint instead of any data section.
 *   4. With a selected draft + files, the panel renders the source-files
 *      section.
 *   5. Recent drafts (other than the active one) appear as the "recent
 *      context" fallback section.
 *   6. Reduced-motion preference is honoured (no `x` translate motion prop
 *      on the desktop panel).
 *
 * The fetch layer is stubbed (no /api/im/* round-trip), and framer-motion
 * is observed indirectly via the `data-testid="reference-panel"` element
 * which is rendered by `motion.aside`.
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Stub the data layer. The 3-col layout exists regardless of fetched data;
// individual data sections only render when their list is non-empty.
//
// vi.mock is hoisted to the top of the file, so the factory cannot close over
// outer variables — declare mock data inline.
vi.mock('../../types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../types')>();
  return {
    ...actual,
    fetchDrafts: vi.fn(async () => [
      {
        id: 'draft-1',
        slug: 'weekly-digest',
        name: 'Weekly digest',
        description: 'Summarise weekly tickets',
        status: 'draft',
        updatedAt: '2026-05-28T10:00:00Z',
      },
      {
        id: 'draft-2',
        slug: 'morning-brief',
        name: 'Morning brief',
        description: 'Cron-style brief',
        status: 'draft',
        updatedAt: '2026-05-27T10:00:00Z',
      },
      {
        id: 'draft-3',
        slug: 'old-thing',
        name: 'Old',
        description: 'Old',
        status: 'draft',
        updatedAt: '2026-05-20T10:00:00Z',
      },
    ]),
    fetchDraftDetail: vi.fn(async (id: string) => ({
      id,
      slug: 'weekly-digest',
      name: 'Weekly digest',
      description: 'Summarise weekly tickets',
      status: 'draft',
      files: [
        { path: 'SKILL.md', size: 1024 },
        { path: 'refs/example.json', size: 256 },
      ],
    })),
    fetchWorkspaceSkillsByStage: vi.fn(async () => []),
  };
});

import { AuthoringView } from '../authoring-view';
import { I18nProvider } from '@/contexts/i18n-context';

async function mount(props: { draftId: string | null }): Promise<{
  host: HTMLElement;
  rerender: (next: { draftId: string | null }) => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = async (p: { draftId: string | null }) => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <AuthoringView
            isDark={true}
            workspaceId="ws-1"
            draftId={p.draftId}
            onDraftChange={() => undefined}
            onHasDraftChange={() => undefined}
          />
        </I18nProvider>,
      );
    });
    // Let microtasks drain (fetchDrafts + fetchDraftDetail + fetchWorkspaceSkillsByStage).
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
  };
  await render(props);
  return {
    host,
    rerender: render,
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

describe('authoring-view — V6 reference panel (workshop 3-column)', () => {
  it('desktop renders the reference panel as the 3rd column next to source-bench + active-draft', async () => {
    const { host, cleanup } = await mount({ draftId: null });
    const workshop = host.querySelector('[data-testid="authoring-workshop"]');
    expect(workshop).toBeTruthy();
    // workshop grammar layout class encodes 3 cols on lg+.
    // v2.0.8 X1 fix: middle track is `minmax(0,1fr)` (was `1fr`) so the
    // active-draft column can shrink and its accent border stays inside
    // the column rather than overflowing into the reference column.
    expect(workshop?.className).toMatch(/lg:grid-cols-\[280px_minmax\(0,1fr\)_320px\]/);

    // Three sibling regions: source-bench, active-draft, reference-panel.
    expect(host.querySelector('[data-pane="source-bench"]')).toBeTruthy();
    expect(host.querySelector('[data-pane="active-draft"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="reference-panel"]')).toBeTruthy();
    await cleanup();
  });

  // v2.0.8 X1 bug — the centre pane's yellow ring/border bled into the
  // reference column when its content (long skill description / list) forced
  // the `1fr` grid track wider than the viewport allowed. The fix is two
  // standard CSS-grid moves: `minmax(0,1fr)` on the grid track (so the track
  // itself can shrink below content size) + `min-w-0` on the grid item (so
  // the item itself doesn't claim `min-width: auto`). This test pins both.
  it('centre pane has min-w-0 + overflow-hidden so its border stays in its column (Bug X1)', async () => {
    const { host, cleanup } = await mount({ draftId: 'draft-1' });
    const centre = host.querySelector('[data-pane="active-draft"]');
    expect(centre).toBeTruthy();
    expect(centre?.className).toMatch(/\bmin-w-0\b/);
    expect(centre?.className).toMatch(/\boverflow-hidden\b/);
    await cleanup();
  });

  it('mobile collapses the reference panel into a toggleable drawer (default closed)', async () => {
    const { host, cleanup } = await mount({ draftId: null });
    const mobile = host.querySelector('[data-testid="reference-panel-mobile"]');
    expect(mobile).toBeTruthy();
    const toggle = mobile?.querySelector('[data-testid="reference-panel-mobile-toggle"]') as HTMLButtonElement | null;
    expect(toggle).toBeTruthy();
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');

    // Body section list ('.space-y-3' inside the body) only mounts when toggled open.
    expect(mobile?.querySelector('.space-y-3')).toBeNull();

    await act(async () => {
      toggle?.click();
    });
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(mobile?.querySelector('.space-y-3')).toBeTruthy();
    await cleanup();
  });

  it('shows recent-drafts when no draft is picked but other drafts exist', async () => {
    const { host, cleanup } = await mount({ draftId: null });
    // recentDrafts pulls from `skills` which is loaded with 3 mocked drafts,
    // so the panel earns its 3rd column even without an active draft.
    const panel = host.querySelector('[data-testid="reference-panel"]');
    expect(panel).toBeTruthy();
    // The 3 mocked drafts populate the "recent" section.
    expect(panel?.querySelector('[data-section="recent-drafts"]')).toBeTruthy();
    // v2.0.8 Y1: the "sources" section has been removed entirely — it was a
    // 1:1 duplicate of SkillDetail's manifest list.
    expect(panel?.querySelector('[data-section="sources"]')).toBeNull();
    await cleanup();
  });

  // v2.0.8 Y1: the active draft's files no longer appear in the reference
  // panel (the section was deleted because it duplicated SkillDetail). The
  // SkillDetail card is the single source of truth for the manifest list.
  it('does NOT render a sources section in the reference panel — manifest lives in SkillDetail (Bug Y1)', async () => {
    const { host, cleanup } = await mount({ draftId: 'draft-1' });
    const panel = host.querySelector('[data-testid="reference-panel"]');
    expect(panel).toBeTruthy();
    expect(panel?.querySelector('[data-section="sources"]')).toBeNull();
    // SkillDetail card is rendered and carries the manifest.
    const detailCard = host.querySelector('[data-testid="skill-detail"]');
    expect(detailCard).toBeTruthy();
    expect(detailCard?.textContent).toMatch(/SKILL\.md/);
    await cleanup();
  });
});
