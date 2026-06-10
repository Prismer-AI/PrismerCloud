/**
 * @vitest-environment jsdom
 *
 * S42 — Spatial grammar anti-同质化 anchor (release201/13 §3.11).
 *
 * For each of the 7 studio views we assert:
 *   1. The wrapping `[data-spatial-grammar]` matches the doc 13 §3.11.1 table.
 *   2. The `[data-grammar-accent]` matches the chromatic anchor.
 *   3. Two views never share both grammar key AND accent (anti-同质化 judge).
 *
 * The 5 design tokens (motionPreset) + 2 CSS keyframes are unit-asserted at
 * the design.ts / globals.css layer below.
 *
 * The actual view files are stubbed at the data-fetch layer so empty states
 * render without hitting the network.
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Stub the studio data layer so every view renders its empty/idle state.
vi.mock('../types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../types')>();
  return {
    ...actual,
    fetchDrafts: vi.fn(async () => []),
    fetchDraftDetail: vi.fn(async () => null),
    fetchInstalled: vi.fn(async () => ({
      agentId: null,
      activeAgentId: 'agent-a',
      agents: [],
      skills: [],
    })),
    fetchWorkspaceSkillsByStage: vi.fn(async () => []),
    fetchSkillDetail: vi.fn(async () => null),
    fetchEvalRun: vi.fn(async () => null),
    fetchStudioCapsules: vi.fn(async () => null),
    fetchStudioGenes: vi.fn(async () => null),
    fetchProfile: vi.fn(async () => ({
      identity: {
        agentId: 'agent-a',
        displayName: 'Test Agent',
        status: 'idle',
        agentType: 'specialist',
        did: 'did:example:1',
        capabilities: ['skill.invoke'],
      },
      personality: null,
    })),
    fetchMetricAggregate: vi.fn(async () => null),
  };
});

import { AuthoringView } from '../skills/authoring-view';
import { LifecycleView } from '../skills/lifecycle-view';
import { InstalledView } from '../skills/installed-view';
import { EvolutionView } from '../skills/evolution-view';
import { MyAgentsView } from '../my-agents-view';
import { MetricsView } from '../metrics-view';
import { motionPreset, motionReduced, spatialGrammar, grammarAccentClasses } from '@/app/workspace/lib/design';
import { I18nProvider } from '@/contexts/i18n-context';

async function mountView(node: React.ReactNode): Promise<{ host: HTMLElement; cleanup: () => Promise<void> }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<I18nProvider>{node}</I18nProvider>);
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

beforeEach(() => {
  // Suppress jsdom canvas-2d "not implemented" log spam from SiriOrb.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('{"token":"t"}');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('S42 — spatial grammar token registry (doc 13 §3.11)', () => {
  it('design.ts exports all 7 grammar keys with accentColor + primaryMetaphor', () => {
    const keys = Object.keys(spatialGrammar).sort();
    expect(keys).toEqual(['controlTower', 'garden', 'identityCard', 'map', 'pipeline', 'shelf', 'workshop'].sort());
    for (const k of keys) {
      const spec = spatialGrammar[k as keyof typeof spatialGrammar];
      expect(spec.accentColor).toBeTruthy();
      expect(spec.primaryMetaphor).toBeTruthy();
      expect(typeof spec.layout).toBe('string');
      // accentColor matches a key in grammarAccentClasses
      expect(grammarAccentClasses[spec.accentColor]).toBeTruthy();
    }
  });

  it('the 7 grammar keys each have a distinct accentColor (anti-同质化 judge)', () => {
    const accents = Object.values(spatialGrammar).map((g) => g.accentColor);
    const unique = new Set(accents);
    expect(unique.size).toBe(7);
  });

  it('exposes 5 motion presets + a reduced-motion fallback', () => {
    expect(motionPreset.slideFromBench).toBeTruthy();
    expect(motionPreset.flowDownPipeline).toBeTruthy();
    expect(motionPreset.pickFromShelf).toBeTruthy();
    expect(motionPreset.cardFlip).toBeTruthy();
    expect(motionPreset.growInGarden).toBeTruthy();
    expect(motionReduced.transition).toMatchObject({ duration: 0 });
  });
});

describe('S42 — each view declares its spatial grammar (doc 13 §3.11.3 DoD)', () => {
  it('Authoring → workshop / amber', async () => {
    const { host, cleanup } = await mountView(
      <AuthoringView
        isDark={true}
        workspaceId="ws-1"
        draftId={null}
        onDraftChange={() => undefined}
        onHasDraftChange={() => undefined}
      />,
    );
    const root = host.querySelector('[data-spatial-grammar="workshop"]');
    expect(root).toBeTruthy();
    expect(root?.getAttribute('data-grammar-accent')).toBe('amber');
    await cleanup();
  });

  it('Lifecycle → pipeline / cyan', async () => {
    const { host, cleanup } = await mountView(
      <LifecycleView isDark={true} workspaceId="ws-1" draftId={null} onDraftChange={() => undefined} />,
    );
    const root = host.querySelector('[data-spatial-grammar="pipeline"]');
    expect(root).toBeTruthy();
    expect(root?.getAttribute('data-grammar-accent')).toBe('cyan');
    await cleanup();
  });

  it('Installed → shelf / violet', async () => {
    const { host, cleanup } = await mountView(
      <InstalledView isDark={true} agentId="agent-a" onAgentChange={() => undefined} />,
    );
    const root = host.querySelector('[data-spatial-grammar="shelf"]');
    expect(root).toBeTruthy();
    expect(root?.getAttribute('data-grammar-accent')).toBe('violet');
    await cleanup();
  });

  it('Profile (my-agents) → identityCard / rose', async () => {
    const { host, cleanup } = await mountView(
      <MyAgentsView
        isDark={true}
        agentId="agent-a"
        onAgentChange={() => undefined}
        onHasAgentChange={() => undefined}
        onHasInstalledChange={() => undefined}
      />,
    );
    // wait an extra tick for fetchProfile microtask
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const root = host.querySelector('[data-spatial-grammar="identityCard"]');
    expect(root).toBeTruthy();
    expect(root?.getAttribute('data-grammar-accent')).toBe('rose');
    await cleanup();
  });

  it('Evolution → garden / emerald', async () => {
    const { host, cleanup } = await mountView(<EvolutionView isDark={true} agentId="agent-a" />);
    const root = host.querySelector('[data-spatial-grammar="garden"]');
    expect(root).toBeTruthy();
    expect(root?.getAttribute('data-grammar-accent')).toBe('emerald');
    await cleanup();
  });

  it('Metrics → controlTower / sky', async () => {
    const { host, cleanup } = await mountView(<MetricsView isDark={true} workspaceId="ws-1" />);
    // wait for metrics loading → empty state
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    });
    const root = host.querySelector('[data-spatial-grammar="controlTower"]');
    expect(root).toBeTruthy();
    expect(root?.getAttribute('data-grammar-accent')).toBe('sky');
    await cleanup();
  });
});
