/**
 * @vitest-environment jsdom
 *
 * V4 — Installed shelf chip real 3D flip (release201/13 §3.4 + doc 20 §9.2).
 *
 * Asserts that the `<FlippableChip>` renders for each installed skill and
 * actually applies 3D card-flip semantics (perspective + preserve-3d +
 * backface-visibility + rotateY motion). Before V4, the chip only had a
 * 2D framer rotate transform and no perspective container, so the "back"
 * face never appeared and the flip looked like a flat skew.
 *
 * Four checks (one per task requirement):
 *   1. <FlippableChip> renders for each installed skill.
 *   2. Clicking the configure button drives rotateY → 180 (front motion prop).
 *   3. Under prefers-reduced-motion: front/back swap via display=none, no rotation.
 *   4. The back face has backface-visibility: hidden (3D mode).
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── framer-motion reduced-motion toggle ──
let __reducedMotion = false;

// Capture animate props per face so we can introspect rotateY values.
const motionDivAnimates: Array<unknown> = [];

vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>();
  const realMotion = actual.motion;
  // Wrap motion.div as a React component that records the `animate` prop
  // on each render and then delegates to the real framer motion.div.
  const RealMotionDiv = realMotion.div as React.ComponentType<Record<string, unknown>>;
  const SpyMotionDiv: React.FC<Record<string, unknown>> = (props) => {
    motionDivAnimates.push(props.animate);
    return React.createElement(RealMotionDiv, props);
  };
  return {
    ...actual,
    useReducedMotion: () => __reducedMotion,
    motion: new Proxy(realMotion, {
      get(target, key) {
        if (key === 'div') return SpyMotionDiv;
        return (target as never)[key];
      },
    }),
  };
});

// ── data layer stub ──
vi.mock('../../types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../types')>();
  const SKILLS = [
    {
      skillId: 'sk-1',
      slug: 'skill-one',
      name: 'Skill One',
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      lastInvokedAt: new Date().toISOString(),
      status: 'active' as const,
    },
    {
      skillId: 'sk-2',
      slug: 'skill-two',
      name: 'Skill Two',
      version: '2.0.0',
      installedAt: new Date().toISOString(),
      lastInvokedAt: null,
      status: 'active' as const,
    },
  ];
  return {
    ...actual,
    fetchInstalled: vi.fn(async () => ({
      agentId: 'agent-a',
      activeAgentId: 'agent-a',
      agents: [{ agentId: 'agent-a', displayName: 'Agent A' }],
      skills: SKILLS,
    })),
    uninstallSkill: vi.fn(async () => true),
    fetchSkillDetail: vi.fn(async () => null),
  };
});

import { InstalledView } from '../installed-view';
import { I18nProvider } from '@/contexts/i18n-context';

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider>
        <InstalledView isDark={true} agentId="agent-a" onAgentChange={() => undefined} />
      </I18nProvider>,
    );
  });
  // Flush fetchInstalled chain.
  for (let i = 0; i < 4; i++) {
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
  motionDivAnimates.length = 0;
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation((k) => {
    if (k === 'prismer_auth') return JSON.stringify({ token: 't' });
    if (k === 'prismer_active_api_key') return 'sk-prismer-test';
    return null;
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('installed-view — V4 3D chip flip', () => {
  it('renders <FlippableChip> for each installed skill', async () => {
    const { host, cleanup } = await mount();
    const chips = host.querySelectorAll('[data-installed-skill]');
    // 2 skills in mock → 2 FlippableChip wrappers.
    expect(chips.length).toBe(2);
    // Either flip mode is acceptable depending on prefers-reduced-motion;
    // default test has reduced=false → 3d mode.
    for (const chip of Array.from(chips)) {
      expect(chip.getAttribute('data-flip-mode')).toBe('3d');
      expect(chip.getAttribute('data-flipped')).toBe('false');
    }
    await cleanup();
  });

  it('clicking configure flips the chip — animate.rotateY becomes 180 on that chip only', async () => {
    const { host, cleanup } = await mount();
    const chip1 = host.querySelector('[data-installed-skill="sk-1"]') as HTMLElement | null;
    const chip2 = host.querySelector('[data-installed-skill="sk-2"]') as HTMLElement | null;
    expect(chip1, 'sk-1 chip should be present').not.toBeNull();
    expect(chip2, 'sk-2 chip should be present').not.toBeNull();

    // Click the configure button inside chip1.
    const configureBtn = chip1!.querySelector('[data-testid="installed-configure-button"]') as HTMLButtonElement;
    expect(configureBtn, 'configure button must exist on front face').not.toBeNull();

    motionDivAnimates.length = 0; // reset capture so we only see post-click renders
    await act(async () => {
      configureBtn.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The clicked chip must be flagged flipped; the other must remain not-flipped.
    expect(chip1!.getAttribute('data-flipped')).toBe('true');
    expect(chip2!.getAttribute('data-flipped')).toBe('false');

    // The chip1 motion.div animate prop must contain rotateY:180 in at least
    // one post-click render. (Two motion.divs render — sk-1 flipped + sk-2
    // not flipped — so we check that 180 was emitted at least once and 0 at
    // least once, for the two chips respectively.)
    const rotations = motionDivAnimates
      .map((a) => (a as { rotateY?: number } | undefined)?.rotateY)
      .filter((v) => typeof v === 'number');
    expect(rotations).toContain(180);
    expect(rotations).toContain(0);
    await cleanup();
  });

  it('prefers-reduced-motion: front/back swap via display, no rotateY motion', async () => {
    __reducedMotion = true;
    const { host, cleanup } = await mount();
    const chip1 = host.querySelector('[data-installed-skill="sk-1"]') as HTMLElement | null;
    expect(chip1?.getAttribute('data-flip-mode')).toBe('reduced');

    // Front visible, back hidden in reduced mode + not flipped.
    const front = chip1!.querySelector('[data-face="front"]') as HTMLElement;
    const back = chip1!.querySelector('[data-face="back"]') as HTMLElement;
    expect(front.style.display).toBe('flex');
    expect(back.style.display).toBe('none');
    // Both faces still hide their backface for visual consistency.
    expect(front.style.backfaceVisibility).toBe('hidden');
    expect(back.style.backfaceVisibility).toBe('hidden');

    // No animate prop captured because in reduced mode the component does
    // not render a `motion.div`.
    motionDivAnimates.length = 0;
    const configureBtn = chip1!.querySelector('[data-testid="installed-configure-button"]') as HTMLButtonElement;
    await act(async () => {
      configureBtn.click();
    });
    expect(motionDivAnimates.filter((a) => a && (a as { rotateY?: unknown }).rotateY !== undefined)).toHaveLength(0);

    // After click, the front is hidden via display:none and the back becomes flex.
    expect(front.style.display).toBe('none');
    expect(back.style.display).toBe('flex');
    await cleanup();
  });

  it('back face has backface-visibility: hidden in 3D mode (real 3D flip semantics)', async () => {
    const { host, cleanup } = await mount();
    const chip = host.querySelector('[data-installed-skill="sk-1"]') as HTMLElement;
    expect(chip.getAttribute('data-flip-mode')).toBe('3d');

    // The wrapper owns the perspective (parent of motion.div).
    expect(chip.style.perspective).toBe('1000px');

    const front = chip.querySelector('[data-face="front"]') as HTMLElement;
    const back = chip.querySelector('[data-face="back"]') as HTMLElement;
    // Both faces hide their own backface.
    expect(front.style.backfaceVisibility).toBe('hidden');
    expect(back.style.backfaceVisibility).toBe('hidden');
    // Back face is pre-rotated 180° so it reads right-way-up after flip.
    expect(back.style.transform).toContain('rotateY(180deg)');
    // Back face is absolutely positioned over the front.
    expect(back.style.position).toBe('absolute');
    await cleanup();
  });
});
