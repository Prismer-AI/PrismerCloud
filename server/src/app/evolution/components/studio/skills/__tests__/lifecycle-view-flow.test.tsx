/**
 * @vitest-environment jsdom
 *
 * V1 — Pipeline 液态流真渲染 (release201/13 §3.3 + doc 20 §9.2).
 *
 * Asserts that the `FlowingDraftBall` overlay actually mounts inside the
 * lifecycle view (regression guard for user pain
 * "evolution studio 点来点去没有任何分别的界面"). Before V1 the
 * pipeline only painted a 1px css gradient placeholder; after V1 a real
 * SVG ball + trail rides the rail driven by `activeSubStage`.
 *
 * Three checks:
 *   1. Ball renders with `data-testid="flowing-draft-ball"` when a draft is selected.
 *   2. `data-active-stage` attr reflects the resolved sub-stage from skill detail.
 *   3. Under `prefers-reduced-motion`, the trail node is omitted and
 *      `data-reduced-motion="true"` is set on the ball container.
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Track which reducedMotion the framer-motion hook should report.
// Variable is hoisted-safe because we only read it inside the mock factory
// at call time (after assignment in beforeEach).
let __reducedMotion = false;

vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>();
  return {
    ...actual,
    useReducedMotion: () => __reducedMotion,
  };
});

// Stub the studio data layer so the view renders with a real skill detail.
vi.mock('../../types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../types')>();
  const SKILL = {
    id: 'skill-1',
    slug: 'my-skill',
    name: 'My skill',
    description: 'Does a thing.',
    lifecycleStage: 'review',
    status: 'draft',
    publishScope: 'workspace',
    files: [],
    executableJson: {},
    metadata: {
      lifecycleSubStage: 'sandbox_smoke',
      skillJson: {
        description: 'Does a thing.',
        provenance: { sourceKind: 'doc-url', sourceRefs: [] },
        security: {},
        runtime: { requires: {} },
        sampleTasks: [],
      },
    },
  };
  return {
    ...actual,
    fetchWorkspaceSkillsByStage: vi.fn(async () => [
      { id: 'skill-1', slug: 'my-skill', lifecycleStage: 'review', status: 'draft' },
    ]),
    fetchSkillDetail: vi.fn(async () => SKILL),
    fetchEvalRun: vi.fn(async () => null),
  };
});

import { LifecycleView } from '../lifecycle-view';
import { I18nProvider } from '@/contexts/i18n-context';

class FakeEventSource {
  url: string;
  readyState = 0;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider>
        <LifecycleView isDark={true} workspaceId="ws-1" draftId="skill-1" onDraftChange={() => undefined} />
      </I18nProvider>,
    );
  });
  // Let async useEffects flush (fetchSkillDetail + fetchEvalRun chain).
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
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
  __reducedMotion = false;
  // EventSource is not in jsdom; LifecycleView opens one for SSE.
  (globalThis as any).EventSource = FakeEventSource;
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation((k) => {
    if (k === 'prismer_auth') return JSON.stringify({ token: 't' });
    if (k === 'prismer_active_api_key') return 'sk-prismer-test';
    return null;
  });
  // Suppress noisy framer-motion / canvas warnings.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('lifecycle-view — V1 flowing-draft-ball', () => {
  it('renders FlowingDraftBall when a draft is selected', async () => {
    const { host, cleanup } = await mount();
    const ball = host.querySelector('[data-testid="flowing-draft-ball"]');
    expect(ball, 'expected FlowingDraftBall to mount when draftId is set').not.toBeNull();
    await cleanup();
  });

  it('ball data-active-stage reflects resolved sub-stage from skill detail', async () => {
    const { host, cleanup } = await mount();
    const ball = host.querySelector('[data-testid="flowing-draft-ball"]');
    expect(ball?.getAttribute('data-active-stage')).toBe('sandbox_smoke');
    // index of sandbox_smoke in LIFECYCLE_PIPELINE_STAGES (intake, source_review,
    // design, scaffold, implement, static_validate, sandbox_smoke, ...) → 6
    expect(ball?.getAttribute('data-active-index')).toBe('6');
    await cleanup();
  });

  it('omits the trail and flags reduced-motion under prefers-reduced-motion', async () => {
    __reducedMotion = true;
    const { host, cleanup } = await mount();
    const ball = host.querySelector('[data-testid="flowing-draft-ball"]');
    expect(ball?.getAttribute('data-reduced-motion')).toBe('true');
    // Trail is gated on `!reducedMotion && safeIdx > 0` — should be absent
    // even though safeIdx (6) > 0.
    const trail = host.querySelector('[data-testid="flowing-draft-ball-trail"]');
    expect(trail).toBeNull();
    await cleanup();
  });
});
