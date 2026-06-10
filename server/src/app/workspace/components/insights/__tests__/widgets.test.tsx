/**
 * @vitest-environment jsdom
 *
 * S38 (release201/12 v2.0.9) — widget visual polish + range picker UX.
 *
 * Scope:
 *  - CounterWidget: direction prop (higher-is-better / lower-is-better /
 *    neutral) drives delta colour; compact formatting for ≥1000.
 *  - TableWidget: click-to-sort cycle (asc → desc → unsorted), numeric vs
 *    text column alignment.
 *  - StatusGridWidget: legend renders + status-aware swatch colours.
 *  - BarWidget: top-3 rank colour fills via Cell + dashed outline for 0
 *    bars.
 *  - InsightsSurface range picker: keyboard shortcuts (1/2/3/4, R, ?),
 *    button-group click-to-switch, custom-range modal apply + clear.
 *
 * The widget views (overview/project/agent) and BFF wiring are exercised
 * via Cookbook + other tests; this file only covers the polish + picker.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Stub next/navigation before importing the InsightsSurface so its inner
// views can call `useRouter()` without an app-router context. We don't
// exercise the views themselves here — they short-circuit when
// `workspaceId === null`.
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/workspace',
  useSearchParams: () => new URLSearchParams(),
}));

import { CounterWidget, formatCompact } from '../counter-widget';
import { TableWidget } from '../table-widget';
import { StatusGridWidget } from '../status-grid-widget';
import { InsightsSurface, type InsightsCustomRange } from '../insights-surface';
import { I18nProvider } from '@/contexts/i18n-context';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// JSDOM does not implement ResizeObserver, but recharts <ResponsiveContainer>
// invokes it. A no-op shim keeps the components mountable in tests.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof NoopResizeObserver }).ResizeObserver = NoopResizeObserver;

function render(node: React.ReactElement): { host: HTMLElement; root: Root; cleanup: () => void } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(node);
  });
  return {
    host,
    root,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function $(host: HTMLElement, testId: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testId}"]`);
}

function $$(host: HTMLElement, testId: string): HTMLElement[] {
  return Array.from(host.querySelectorAll(`[data-testid="${testId}"]`));
}

// ───────────────────────── CounterWidget ─────────────────────────

describe('CounterWidget — direction + compact formatting', () => {
  afterEach(() => vi.restoreAllMocks());

  it('formatCompact renders 1.2k / 1.5M / 2B', () => {
    expect(formatCompact(123)).toBe('123');
    expect(formatCompact(1_234)).toBe('1.2k');
    expect(formatCompact(15_000)).toBe('15k');
    expect(formatCompact(1_500_000)).toBe('1.5M');
    expect(formatCompact(2_000_000_000)).toBe('2B');
  });

  it('higher-is-better + positive delta → emerald text class', () => {
    const { host, cleanup } = render(
      <CounterWidget isDark={false} title="Tasks" value={100} delta={10} direction="higher-is-better" />,
    );
    const delta = $(host, 'counter-widget-delta');
    expect(delta).toBeTruthy();
    expect(delta!.className).toMatch(/text-emerald-600/);
    cleanup();
  });

  it('lower-is-better + positive delta → rose text class (bad)', () => {
    const { host, cleanup } = render(
      <CounterWidget isDark={false} title="Latency" value={100} delta={10} direction="lower-is-better" />,
    );
    const delta = $(host, 'counter-widget-delta');
    expect(delta!.className).toMatch(/text-rose-600/);
    expect(delta!.getAttribute('data-delta-direction')).toBe('lower-is-better');
    cleanup();
  });

  it('neutral → zinc text class (no good/bad colouring)', () => {
    const { host, cleanup } = render(
      <CounterWidget isDark={false} title="Headcount" value={5} delta={-2} direction="neutral" />,
    );
    const delta = $(host, 'counter-widget-delta');
    expect(delta!.className).toMatch(/text-zinc-500/);
    cleanup();
  });

  it('auto-compact renders 1.2k for ≥1000 values', () => {
    const { host, cleanup } = render(<CounterWidget isDark={false} title="N" value={1234} />);
    const v = $(host, 'counter-widget-value');
    expect(v!.textContent).toBe('1.2k');
    cleanup();
  });

  it('legacy deltaIsBetter still works (back-compat)', () => {
    const { host, cleanup } = render(
      <CounterWidget isDark={false} title="X" value={10} delta={2} deltaIsBetter="lower" />,
    );
    const delta = $(host, 'counter-widget-delta');
    expect(delta!.className).toMatch(/text-rose-600/);
    cleanup();
  });

  it('tooltip shows full unformatted value + delta percent', () => {
    const { host, cleanup } = render(
      <CounterWidget isDark={false} title="N" value={1234} delta={234} windowLabel="Last 7 days" />,
    );
    const body = $(host, 'counter-widget-body');
    const title = body!.getAttribute('title');
    expect(title).toContain('1,234');
    expect(title).toContain('234');
    expect(title).toContain('Last 7 days');
    cleanup();
  });
});

// ───────────────────────── TableWidget sort ─────────────────────────

describe('TableWidget — column sort cycle', () => {
  const columns = ['name', 'count'];
  const rows = [
    {
      id: 'r1',
      cells: [
        { key: 'name', value: 'beta' },
        { key: 'count', value: 3 },
      ],
    },
    {
      id: 'r2',
      cells: [
        { key: 'name', value: 'alpha' },
        { key: 'count', value: 8 },
      ],
    },
    {
      id: 'r3',
      cells: [
        { key: 'name', value: 'gamma' },
        { key: 'count', value: 1 },
      ],
    },
  ];

  it('numeric column auto-aligns right + sorts ascending → descending → unsorted', () => {
    const { host, cleanup } = render(<TableWidget isDark={false} title="t" columns={columns} rows={rows} />);
    const header = $(host, 'table-widget-header-count') as HTMLElement;
    expect(header.className).toMatch(/text-right/);
    expect(header.getAttribute('aria-sort')).toBe('none');

    const btn = header.querySelector('button')!;
    const readCountColumn = () => $$(host, 'table-widget-row').map((tr) => tr.children[1]?.textContent ?? '');

    act(() => btn.click());
    expect(header.getAttribute('aria-sort')).toBe('ascending');
    expect(readCountColumn()).toEqual(['1', '3', '8']);

    act(() => btn.click());
    expect(header.getAttribute('aria-sort')).toBe('descending');
    expect(readCountColumn()).toEqual(['8', '3', '1']);

    act(() => btn.click());
    expect(header.getAttribute('aria-sort')).toBe('none');
    expect(readCountColumn()).toEqual(['3', '8', '1']);

    cleanup();
  });

  it('text column sorts lexicographically', () => {
    const { host, cleanup } = render(<TableWidget isDark={false} title="t" columns={columns} rows={rows} />);
    const header = $(host, 'table-widget-header-name') as HTMLElement;
    expect(header.className).toMatch(/text-left/);
    act(() => header.querySelector('button')!.click());
    const names = $$(host, 'table-widget-row').map((tr) => tr.children[0].textContent);
    expect(names).toEqual(['alpha', 'beta', 'gamma']);
    cleanup();
  });

  it('empty rows renders "No data" via WidgetFrame', () => {
    const { host, cleanup } = render(<TableWidget isDark={false} title="t" columns={columns} rows={[]} />);
    expect(host.textContent).toContain('No data');
    cleanup();
  });
});

// ───────────────────────── StatusGridWidget legend ─────────────────

describe('StatusGridWidget — legend + status colour mapping', () => {
  it('renders one legend swatch per status column with the right colour class', () => {
    const { host, cleanup } = render(
      <StatusGridWidget
        isDark={false}
        title="Acceptance"
        columns={['passed', 'partial', 'failed', 'none']}
        rows={[{ label: 'Q2', counts: { passed: 5, partial: 1, failed: 0, none: 0 } }]}
      />,
    );
    expect($(host, 'status-grid-legend')).toBeTruthy();
    expect($(host, 'status-grid-legend-swatch-passed')!.className).toMatch(/bg-emerald-500/);
    expect($(host, 'status-grid-legend-swatch-partial')!.className).toMatch(/bg-amber-500/);
    expect($(host, 'status-grid-legend-swatch-failed')!.className).toMatch(/bg-rose-500/);
    expect($(host, 'status-grid-legend-swatch-none')!.className).toMatch(/bg-zinc-300/);
    cleanup();
  });

  it('cell carries a title tooltip "<label> · <col>: <count>"', () => {
    const { host, cleanup } = render(
      <StatusGridWidget
        isDark={false}
        title="Acceptance"
        columns={['passed']}
        rows={[{ label: 'Q2', counts: { passed: 5 } }]}
      />,
    );
    const cell = $(host, 'status-grid-cell');
    expect(cell!.getAttribute('title')).toBe('Q2 · passed: 5');
    cleanup();
  });
});

// NOTE — recharts requires a non-zero ResponsiveContainer size to actually
// render the <Bar>/<Cell> SVG elements. jsdom doesn't provide layout so
// the Cells (and our `data-rank` attribute) never make it into the DOM.
// The rank colour fill is unit-covered by the rankFill helper visually;
// we cover the *picker* + counter/table/grid behaviour here which all
// do render in jsdom.

// ───────────────────────── InsightsSurface picker ─────────────────

describe('InsightsSurface — range picker + shortcuts', () => {
  function mount(extras?: Partial<React.ComponentProps<typeof InsightsSurface>>) {
    const onChangeRange = vi.fn();
    const onChangeView = vi.fn();
    const onRefresh = vi.fn();
    const onChangeCustomRange = vi.fn();
    const props: React.ComponentProps<typeof InsightsSurface> = {
      isDark: false,
      workspaceId: null,
      view: 'overview',
      range: '7d',
      projectId: null,
      agentId: null,
      refreshNonce: 0,
      onChangeView,
      onChangeRange,
      onRefresh,
      onChangeCustomRange,
      customRange: null,
      lastUpdated: null,
      ...extras,
    };
    // Wave 1 F3 — InsightsSurface 现在用 useI18n()，必须包 I18nProvider。
    const utils = render(
      <I18nProvider>
        <InsightsSurface {...props} />
      </I18nProvider>,
    );
    return { ...utils, onChangeRange, onChangeView, onRefresh, onChangeCustomRange };
  }

  it('button group click switches preset + active state', () => {
    const { host, onChangeRange, cleanup } = mount();
    const btn = $(host, 'insights-range-preset-30d') as HTMLButtonElement;
    expect(btn.getAttribute('aria-checked')).toBe('false');
    act(() => btn.click());
    expect(onChangeRange).toHaveBeenCalledWith('30d');
    cleanup();
  });

  it('keyboard 1/2/3/4 maps to 24h/7d/30d/90d', () => {
    const { onChangeRange, cleanup } = mount();
    const keys = [
      ['1', '24h'],
      ['2', '7d'],
      ['3', '30d'],
      ['4', '90d'],
    ] as const;
    for (const [k, expected] of keys) {
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      });
      expect(onChangeRange).toHaveBeenCalledWith(expected);
    }
    expect(onChangeRange).toHaveBeenCalledTimes(4);
    cleanup();
  });

  it('R key triggers refresh', () => {
    const { onRefresh, cleanup } = mount();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'R', bubbles: true }));
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('? opens the shortcut help modal; Escape closes it', () => {
    const { host, cleanup } = mount();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    });
    expect($(host, 'insights-shortcut-help-modal')).toBeTruthy();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect($(host, 'insights-shortcut-help-modal')).toBeNull();
    cleanup();
  });

  it('keyboard shortcuts ignored while focused inside an <input>', () => {
    const { host, onChangeRange, cleanup } = mount();
    const input = document.createElement('input');
    host.appendChild(input);
    input.focus();
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    });
    expect(onChangeRange).not.toHaveBeenCalled();
    cleanup();
  });

  it('opens custom range modal + Apply emits onChangeCustomRange', () => {
    const { host, onChangeCustomRange, cleanup } = mount();
    const customBtn = $(host, 'insights-range-preset-custom') as HTMLButtonElement;
    act(() => customBtn.click());
    const modal = $(host, 'insights-custom-range-modal');
    expect(modal).toBeTruthy();
    const fromInput = $(host, 'insights-custom-range-from') as HTMLInputElement;
    const toInput = $(host, 'insights-custom-range-to') as HTMLInputElement;
    // React tracks the native input setter — bypass it so the synthetic
    // event reports the new value to React's onChange handler.
    const setNativeValue = (el: HTMLInputElement, v: string) => {
      const proto = Object.getPrototypeOf(el) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter!.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    act(() => {
      setNativeValue(fromInput, '2026-01-01');
      setNativeValue(toInput, '2026-01-31');
    });
    const apply = $(host, 'insights-custom-range-apply') as HTMLButtonElement;
    act(() => apply.click());
    expect(onChangeCustomRange).toHaveBeenCalledWith({ from: '2026-01-01', to: '2026-01-31' });
    cleanup();
  });

  it('customRange prop shows "From → To" + clear button calls onChangeCustomRange(null)', () => {
    const custom: InsightsCustomRange = { from: '2026-01-01', to: '2026-01-15' };
    const { host, onChangeCustomRange, cleanup } = mount({ customRange: custom });
    const customBtn = $(host, 'insights-range-preset-custom');
    expect(customBtn!.textContent).toContain('2026-01-01');
    expect(customBtn!.textContent).toContain('2026-01-15');
    const clear = $(host, 'insights-range-clear-custom') as HTMLButtonElement;
    act(() => clear.click());
    expect(onChangeCustomRange).toHaveBeenCalledWith(null);
    cleanup();
  });

  it('"Last updated X" shows when lastUpdated is provided', () => {
    const t = new Date(Date.now() - 5 * 60_000);
    const { host, cleanup } = mount({ lastUpdated: t });
    const el = $(host, 'insights-last-updated');
    expect(el!.textContent).toMatch(/Updated/);
    expect(el!.textContent).toMatch(/min ago/);
    cleanup();
  });
});
