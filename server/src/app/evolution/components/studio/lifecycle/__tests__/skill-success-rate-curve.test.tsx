/**
 * @vitest-environment jsdom
 *
 * release201/24 §Phase4 — SkillSuccessRateCurve unit tests.
 * Uses createRoot + act (no @testing-library/react dependency).
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SkillSuccessRateCurve, evaluatedRevisions } from '../skill-success-rate-curve';

vi.mock('@/contexts/i18n-context', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe('evaluatedRevisions', () => {
  it('keeps only entries with a numeric passRate, in order', () => {
    const out = evaluatedRevisions([
      { revision: 'a', passRate: 0.4, evalRunId: 'r1' },
      { revision: 'b' },
      { revision: 'c', passRate: 0.9, evalRunId: 'r2' },
    ]);
    expect(out.map((o) => o.passRate)).toEqual([0.4, 0.9]);
  });
  it('handles null/undefined safely', () => {
    expect(evaluatedRevisions(null)).toEqual([]);
    expect(evaluatedRevisions(undefined)).toEqual([]);
  });
});

describe('SkillSuccessRateCurve', () => {
  it('renders the empty state when no evaluated revisions', () => {
    mount(<SkillSuccessRateCurve isDark history={[{ revision: 'a' }]} />);
    expect(container!.querySelector('[data-testid="skill-success-rate-curve-empty"]')).toBeTruthy();
  });

  it('renders one bar per evaluated revision and shows the latest rate', () => {
    mount(
      <SkillSuccessRateCurve
        isDark
        history={[
          { revision: 'a', passRate: 0.4 },
          { revision: 'b', passRate: 0.6 },
          { revision: 'c', passRate: 1 },
        ]}
      />,
    );
    expect(container!.querySelectorAll('[data-testid="skill-success-rate-bar"]').length).toBe(3);
    expect(container!.querySelector('[data-testid="skill-success-rate-latest"]')?.textContent).toContain('100%');
  });
});
