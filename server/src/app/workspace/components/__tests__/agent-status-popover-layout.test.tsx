/**
 * @vitest-environment jsdom
 *
 * release201 v2.0.8 UX hotfix A2 — agent-status-popover header layout.
 *
 * Bug: at the popover's fixed 304px width, the previous single-row strip
 *      `[dot · statusLabel · Cpu · daemonId(uuid) · Clock · ago]` overflowed
 *      when `daemonLabel` was a 36-char UUID, which forced the inline
 *      `statusLabel` ("工作中") to wrap one character per line — i.e. the
 *      label rendered vertically.
 *
 * Fix: split into two rows
 *   Row 1 (status) → `dot + statusLabel` only, `whitespace-nowrap`
 *   Row 2 (meta)   → `Cpu + daemonLabel(truncate) · Clock + ago`, `min-w-0`
 *
 * The assertions here are layout-contract checks (DOM topology + critical
 * Tailwind classes), not visual diff — visual diff lives in the workspace
 * e2e cookbook. We only need to guarantee that:
 *   (a) statusLabel and daemonLabel are NOT in the same flex container, so
 *       a long daemon UUID can never displace / wrap the status label.
 *   (b) statusLabel carries `whitespace-nowrap`.
 *   (c) the meta row's daemonLabel span carries `truncate` + the row carries
 *       `min-w-0` so flexbox truncation actually fires.
 */

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/contexts/i18n-context', () => ({
  useI18n: () => ({
    locale: 'zh',
    setLocale: () => {},
    t: (key: string, _values?: Record<string, string | number>) => {
      const map: Record<string, string> = {
        'workspace.session.agentStatusWorking': '工作中',
        'workspace.session.agentStatusWaiting': '等待中',
        'workspace.session.agentStatusBlocked': '阻塞',
        'workspace.session.agentStatusOffline': '离线',
        'workspace.session.agentStatusIdle': '空闲',
        'workspace.sessionDirectory.secondsAgo': '23 秒前',
      };
      return map[key] ?? key;
    },
  }),
}));

// framer-motion: render its <motion.div> as a plain <div> so the popover
// content is in the DOM synchronously (no enter animation gating).
vi.mock('framer-motion', () => {
  const passthrough = (Tag: string) =>
    function MotionPassthrough(props: Record<string, unknown>) {
      // strip motion-only props (initial / animate / exit / transition) so
      // React doesn't warn about unknown DOM attrs.
      const { initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...rest } = props;
      void _initial;
      void _animate;
      void _exit;
      void _transition;
      return React.createElement(Tag, rest);
    };
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    motion: new Proxy(
      {},
      {
        get: (_t, key) => passthrough(key as string),
      },
    ),
  };
});

import { AgentStatusPopover } from '../agent-status-popover';
import type { AgentLiveStatus } from '../../lib/agent-status';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function buildStatus(overrides: Partial<AgentLiveStatus> = {}): AgentLiveStatus {
  return {
    kind: 'working',
    currentTask: null,
    parallelTasks: [],
    recentCompletedTasks: [],
    recentSteps: [],
    lastHeartbeatAt: new Date(Date.now() - 23_000).toISOString(),
    daemonLabel: '221355fe-7239-4534-9a8b-1c4d5e6f7a8b',
    lastActivityAt: Date.now() - 23_000,
    ...overrides,
  };
}

async function renderPopover(status: AgentLiveStatus) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <AgentStatusPopover agentName="CEO" roleSlug="ceo" status={status} isDark>
        <button type="button" data-testid="trigger">
          CEO
        </button>
      </AgentStatusPopover>,
    );
  });
  // Open the popover by simulating mouseenter on the trigger, then advance
  // past OPEN_DELAY_MS (200ms). The trigger element is the wrapping <span>
  // — its parent is the rendered host's first child.
  const trigger = host.querySelector('[data-testid="agent-status-popover-trigger"]') as HTMLElement;
  // React 19 synthetic `onMouseEnter` listens via `pointerover` / `mouseover`
  // at the root delegated handler (mouseenter/leave don't bubble natively,
  // so React simulates them on top of `mouseover`). Fire both so we cover
  // whichever path React uses, then run the OPEN_DELAY_MS (200ms) timer.
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(220);
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

describe('agent-status-popover layout (release201 v2.0.8 A2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('statusLabel ("工作中") renders in its own row with whitespace-nowrap, separate from daemonLabel', async () => {
    const { cleanup } = await renderPopover(buildStatus());

    const popover = document.body.querySelector('[data-testid="agent-status-popover"]');
    expect(popover, 'popover should be portaled into document.body').not.toBeNull();

    const statusRow = popover!.querySelector('[data-testid="agent-status-popover-status-row"]');
    const statusLabel = popover!.querySelector('[data-testid="agent-status-popover-status-label"]');

    expect(statusRow, 'status row container must exist').not.toBeNull();
    expect(statusLabel, 'status label must exist').not.toBeNull();
    expect(statusLabel!.textContent).toBe('工作中');

    // (a) statusLabel sits inside the dedicated status row, not the meta row.
    expect(statusRow!.contains(statusLabel!)).toBe(true);

    // (b) statusLabel must NOT wrap — whitespace-nowrap is mandatory.
    expect(statusLabel!.className).toContain('whitespace-nowrap');

    // (c) daemonLabel must NOT live in the status row (root cause of the bug).
    expect(statusRow!.textContent).not.toContain('221355fe');

    await cleanup();
  });

  it('meta row truncates long daemonLabel and stays in row layout', async () => {
    const { cleanup } = await renderPopover(buildStatus());

    const popover = document.body.querySelector('[data-testid="agent-status-popover"]')!;
    const metaRow = popover.querySelector('[data-testid="agent-status-popover-meta-row"]');
    const daemonLabel = popover.querySelector('[data-testid="agent-status-popover-daemon-label"]');

    expect(metaRow, 'meta row must exist when daemonLabel is present').not.toBeNull();
    expect(daemonLabel, 'daemon label must exist').not.toBeNull();
    expect(daemonLabel!.textContent).toContain('221355fe-7239-4534');

    // Meta row must enable flexbox truncation:
    //   - row carries `min-w-0` so the truncating child can shrink below content width
    //   - daemonLabel span carries `truncate` (overflow-hidden + text-ellipsis + whitespace-nowrap)
    expect(metaRow!.className).toContain('min-w-0');
    expect(metaRow!.className).toContain('flex');
    expect(metaRow!.className).toContain('items-center');
    expect(daemonLabel!.className).toContain('truncate');

    await cleanup();
  });

  it('omits meta row entirely when daemonLabel and lastHeartbeatAt are both absent', async () => {
    const { cleanup } = await renderPopover(buildStatus({ daemonLabel: null, lastHeartbeatAt: null }));

    const popover = document.body.querySelector('[data-testid="agent-status-popover"]')!;
    const statusRow = popover.querySelector('[data-testid="agent-status-popover-status-row"]');
    const metaRow = popover.querySelector('[data-testid="agent-status-popover-meta-row"]');

    expect(statusRow, 'status row still renders').not.toBeNull();
    expect(metaRow, 'meta row is suppressed when there is nothing to show').toBeNull();

    await cleanup();
  });
});
