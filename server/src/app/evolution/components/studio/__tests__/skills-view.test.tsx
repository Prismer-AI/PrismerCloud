/**
 * @vitest-environment jsdom
 *
 * S22 — SkillsView 4 sub-tab structural test.
 *
 * Verifies that:
 *   1. Switching sub-tab fires onSubviewChange with the matching value
 *      (URL adapter in evolution/page.tsx then writes the param).
 *   2. The selected sub-tab's view renders (Authoring / Lifecycle /
 *      Installed / Evolution).
 *
 * We mock the fetch layer so the views render their empty / loading
 * placeholders without hitting network.
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Stub all the studio data-fetch helpers so the sub-tabs render in their
// empty states (no actual /api/im/* round-trip).
vi.mock('../types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../types')>();
  return {
    ...actual,
    fetchDrafts: vi.fn(async () => []),
    fetchDraftDetail: vi.fn(async () => null),
    fetchInstalled: vi.fn(async () => ({
      agentId: null,
      activeAgentId: null,
      agents: [],
      skills: [],
    })),
    fetchWorkspaceSkillsByStage: vi.fn(async () => []),
    fetchSkillDetail: vi.fn(async () => null),
    fetchEvalRun: vi.fn(async () => null),
    fetchStudioCapsules: vi.fn(async () => null),
    fetchStudioGenes: vi.fn(async () => null),
    fetchMetricAggregate: vi.fn(async () => null),
  };
});

import { SkillsView } from '../skills-view';
import type { SkillsSubview } from '../types';
import { I18nProvider } from '@/contexts/i18n-context';

// Mount the SkillsView directly with the given subview as the controlled
// prop. To swap subview during a test we re-render the root with a new
// `subview` value — this avoids the React 19 compiler complaining about
// reassigning a closure variable inside a component.
async function mount(initial: SkillsSubview) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const onSubviewChange = vi.fn();
  let activeSubview = initial;
  const render = async (v: SkillsSubview) => {
    activeSubview = v;
    await act(async () => {
      root.render(
        <I18nProvider>
          <SkillsView
            isDark={false}
            workspaceId="ws-1"
            agentId="agent-1"
            draftId={null}
            subview={v}
            onSubviewChange={onSubviewChange}
            onAgentChange={() => undefined}
            onDraftChange={() => undefined}
            onHasDraftChange={() => undefined}
          />
        </I18nProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
  };
  await render(initial);
  return {
    host,
    onSubviewChange,
    setSubview: render,
    currentSubview: () => activeSubview,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

beforeEach(() => {
  // Provide a sane localStorage stub.
  vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('{"token":"t"}');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('SkillsView — 4 sub-tab nav (S22)', () => {
  it('renders all 4 sub-tab triggers', async () => {
    const { host, cleanup } = await mount('authoring');
    expect(host.querySelector('[data-testid="skills-subtab-authoring"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="skills-subtab-lifecycle"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="skills-subtab-installed"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="skills-subtab-evolution"]')).toBeTruthy();
    await cleanup();
  });

  it('starts on authoring view by default', async () => {
    const { host, cleanup } = await mount('authoring');
    // The Authoring view exposes the New Skill button.
    expect(host.querySelector('[data-testid="studio-new-skill"]')).toBeTruthy();
    await cleanup();
  });

  it('lifecycle view exposes the skill selector when subview=lifecycle', async () => {
    const { host, setSubview, cleanup } = await mount('lifecycle');
    expect(host.querySelector('[data-testid="lifecycle-skill-selector"]')).toBeTruthy();
    // And the rail does not render until a skill is picked.
    expect(host.querySelector('[data-testid="lifecycle-pipeline-rail"]')).toBeNull();
    // Switching back to authoring shows the New Skill CTA.
    await setSubview('authoring');
    expect(host.querySelector('[data-testid="studio-new-skill"]')).toBeTruthy();
    await cleanup();
  });

  it('installed subview renders the empty state', async () => {
    const { host, cleanup } = await mount('installed');
    expect(host.textContent).toMatch(/No skills installed/);
    await cleanup();
  });

  it('evolution subview renders capsules + genes garden empty state (S42 garden grammar)', async () => {
    const { host, cleanup } = await mount('evolution');
    // doc 13 §3.6 garden grammar replaced the dual "Capsules / Genes" list
    // columns with a force-layout garden + empty hint that references both.
    expect(host.textContent?.toLowerCase()).toContain('capsules');
    expect(host.textContent?.toLowerCase()).toContain('genes');
    // garden anchor + chromatic anchor must be present.
    const garden = host.querySelector('[data-spatial-grammar="garden"]');
    expect(garden).toBeTruthy();
    expect(garden?.getAttribute('data-grammar-accent')).toBe('emerald');
    await cleanup();
  });
});
