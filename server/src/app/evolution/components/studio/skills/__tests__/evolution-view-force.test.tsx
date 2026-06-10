/**
 * @vitest-environment jsdom
 *
 * release201/13 §3.6 + release201/20 §9.2 V2 — Evolution garden real
 * force-layout regression.
 *
 * Three judges:
 *   1. <GardenForceGraph> mounts inside the garden canvas when nodes are
 *      present (replaces the prior hash-based static circles).
 *   2. `prefers-reduced-motion: reduce` → simulation never starts; the
 *      svg flips `data-reduced-motion="true"` and positions come from
 *      the deterministic static fallback.
 *   3. A distilled gene gets the `animate-prismer-gene-pulse` class on
 *      its splash ring.
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Stub the studio data layer so the view renders a populated garden ──
vi.mock('../../types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../types')>();
  return {
    ...actual,
    fetchStudioCapsules: vi.fn(async () => ({
      capsules: [
        { id: 'cap-001', title: 'Capsule A', intent: 'intent-a', createdAt: new Date().toISOString() },
        { id: 'cap-002', title: 'Capsule B', intent: 'intent-b', createdAt: new Date().toISOString() },
      ],
    })),
    fetchStudioGenes: vi.fn(async () => ({
      genes: [
        { id: 'gene-x', name: 'Gene X' },
        { id: 'gene-y', name: 'Gene Y' },
      ],
      distilled: [{ geneId: 'gene-x', skillId: 'sk-1', status: 'published', installedAt: new Date().toISOString() }],
    })),
    fetchMetricAggregate: vi.fn(async () => null),
    readActiveWorkspaceId: vi.fn(() => null),
  };
});

// ── framer-motion useReducedMotion mock — flipped per test ──
const reducedMotionRef = { current: false };
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>();
  return {
    ...actual,
    useReducedMotion: () => reducedMotionRef.current,
  };
});

import { EvolutionView } from '../evolution-view';
import { I18nProvider } from '@/contexts/i18n-context';

async function mountView(reduced: boolean) {
  reducedMotionRef.current = reduced;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider>
        <EvolutionView isDark={true} agentId="agent-a" />
      </I18nProvider>,
    );
  });
  // Flush data-fetch microtasks and the subsequent re-render.
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
  reducedMotionRef.current = false;
  vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('{"token":"t"}');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('evolution-view — V2 force-layout (release201/20 §9.2)', () => {
  it('renders <GardenForceGraph> svg when capsule+gene nodes are present', async () => {
    const { host, cleanup } = await mountView(false);
    const svg = host.querySelector('[data-testid="garden-force-svg"]');
    expect(svg).toBeTruthy();
    // The svg should contain at least one node group per capsule/gene.
    const nodeGroups = host.querySelectorAll('[data-node-kind]');
    expect(nodeGroups.length).toBeGreaterThanOrEqual(4); // 2 capsules + 2 genes
    await cleanup();
  });

  it('falls back to static positions under prefers-reduced-motion', async () => {
    const { host, cleanup } = await mountView(true);
    const svg = host.querySelector('[data-testid="garden-force-svg"]') as SVGElement | null;
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('data-reduced-motion')).toBe('true');
    // Static fallback still positions every node deterministically — the
    // node groups must still be present.
    const nodeGroups = host.querySelectorAll('[data-node-kind]');
    expect(nodeGroups.length).toBeGreaterThanOrEqual(4);
    await cleanup();
  });

  it('distilled gene gets a splash ring with animate-prismer-gene-pulse', async () => {
    const { host, cleanup } = await mountView(true); // reduced-motion → deterministic positions
    const distilledGroup = host.querySelector('[data-node-id="gene-gene-x"]');
    expect(distilledGroup).toBeTruthy();
    const splash = distilledGroup?.querySelector('[data-testid="distill-splash"]');
    expect(splash).toBeTruthy();
    expect(splash?.getAttribute('class') ?? '').toContain('animate-prismer-gene-pulse');
    // A non-distilled gene must NOT carry the splash ring.
    const plainGroup = host.querySelector('[data-node-id="gene-gene-y"]');
    expect(plainGroup?.querySelector('[data-testid="distill-splash"]')).toBeNull();
    await cleanup();
  });
});
