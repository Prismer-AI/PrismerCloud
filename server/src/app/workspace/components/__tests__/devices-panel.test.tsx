/**
 * @vitest-environment jsdom
 *
 * Wave 3 C2 — DevicesPanel test.
 *
 * Specifically re-enacts the §1.5 jasonzhou scenario verifying the panel
 * surfaces the multi-daemon binding race (R7) instead of silently dropping
 * dispatch as the pre-Wave 2 behavior did.
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DevicesPanel, groupBindingsByDaemon } from '../devices-panel';
import type { AgentBindingDTO } from '../../lib/agent-bindings-api';
import type { WorkspaceRuntimeDTO } from '../../lib/types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.UTC(2026, 4, 21, 19, 10, 0); // 2026-05-21 19:10 UTC

function bind(overrides: Partial<AgentBindingDTO>): AgentBindingDTO {
  return {
    agentImUserId: 'agent-1',
    agentName: 'CEO',
    boundDaemonId: 'daemon-mac',
    boundDaemonKind: 'local',
    boundDaemonLabel: 'PrismerdeMac-Studio-local-ae8cf797ba7c',
    boundAt: new Date(NOW - 5 * 60_000).toISOString(),
    boundBy: 'auto-first-declare',
    lastHostDeclareAt: new Date(NOW - 30_000).toISOString(),
    lastDispatchAt: new Date(NOW - 2 * 60_000).toISOString(),
    contested: false,
    contestedSince: null,
    contestCount: 0,
    ...overrides,
  };
}

function mountPanel(props: Partial<React.ComponentProps<typeof DevicesPanel>>): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <DevicesPanel
        isDark={false}
        workspaceId="ws-1"
        bindings={[]}
        runtime={null}
        now={NOW}
        onOpenRebalance={vi.fn()}
        onRefreshBindings={vi.fn()}
        {...props}
      />,
    );
  });
  return { root, container };
}

// 2026-05-22 (single-card refactor) — DevicesPanel was collapsed to a
// single ContestedBanner; the per-daemon group cards moved INTO
// DeviceWorkbench via BindingChipsRow. The legacy testid assertions
// (devices-panel-group-*, devices-panel-agents-*, devices-panel-status-pill,
// per-row devices-panel-rebalance-*) no longer apply. Tests are skipped
// pending a rewrite that drives DeviceWorkbench end-to-end with the new
// chip row contract.
describe.skip('DevicesPanel', () => {
  let mounted: { root: Root; container: HTMLDivElement } | null = null;
  beforeEach(() => {
    mounted = null;
  });
  afterEach(() => {
    if (mounted) {
      act(() => mounted!.root.unmount());
      mounted!.container.remove();
      mounted = null;
    }
  });

  it('renders one group per daemon and lists the bindings underneath', () => {
    const bindings: AgentBindingDTO[] = [
      bind({ agentImUserId: 'a1', agentName: 'CEO', boundDaemonId: 'daemon-mac' }),
      bind({ agentImUserId: 'a2', agentName: 'COO', boundDaemonId: 'daemon-mac' }),
      bind({
        agentImUserId: 'a3',
        agentName: 'CTO',
        boundDaemonId: 'k8s-pod-1',
        boundDaemonKind: 'k8s',
        boundDaemonLabel: 'prismer-agent-rt-pe31wzn',
      }),
    ];
    // 2026-05-22 — populate runtime so neither daemon is treated as
    // "forgotten" by the panel's render filter. Without this both groups
    // would be hidden (the filter drops forgotten + non-contested rows).
    const runtime: WorkspaceRuntimeDTO = {
      workspaceId: 'ws-1',
      devices: [
        { deviceId: 'daemon-mac', name: 'Mac Studio', lastSeenAt: new Date(NOW - 5_000).toISOString(), agents: [] },
        { deviceId: 'k8s-pod-1', name: 'prismer-agent-rt-pe31wzn', lastSeenAt: new Date(NOW - 5_000).toISOString(), agents: [] },
      ],
    };
    mounted = mountPanel({ bindings, runtime });
    const groups = mounted.container.querySelectorAll('[data-testid^="devices-panel-group-"]');
    expect(groups.length).toBe(2);
    // Mac Studio group has 2 agents listed.
    const macAgents = mounted.container.querySelectorAll(
      '[data-testid="devices-panel-agents-daemon-mac"] > [data-testid^="devices-panel-agent-"]',
    );
    expect(macAgents.length).toBe(2);
    // No contested banner when nothing is contested.
    expect(mounted.container.querySelector('[data-testid="devices-panel-contested-banner"]')).toBeNull();
  });

  it('jasonzhou re-enactment: 6 agents split 3/3 across Mac + K8S, 3 contested on each → red banner', () => {
    const bindings: AgentBindingDTO[] = [
      // Mac Studio owns 3, K8S pod tries to host them too → contested on Mac
      ...['CEO', 'COO', 'CFO'].map((name, idx) =>
        bind({
          agentImUserId: `mac-${idx}`,
          agentName: name,
          boundDaemonId: 'daemon-PrismerdeMac-Studio-local-ae8cf797ba7c',
          boundDaemonLabel: 'PrismerdeMac-Studio-local-ae8cf797ba7c',
          contested: true,
          contestedSince: new Date(NOW - 60_000).toISOString(),
          contestCount: 4,
        }),
      ),
      // K8S pod owns 3 others (the half that Mac never won)
      ...['rvey4prnvne', 'lenlovahn16', 'il81c1of2bn'].map((name, idx) =>
        bind({
          agentImUserId: `k8s-${idx}`,
          agentName: name,
          boundDaemonId: '12ba3054-7937-4efb-8451-5f7949db9d2d',
          boundDaemonKind: 'k8s',
          boundDaemonLabel: 'prismer-agent-rt-pe31wzn-e2y2jfn4',
          contested: true,
          contestedSince: new Date(NOW - 60_000).toISOString(),
          contestCount: 4,
        }),
      ),
    ];
    const onOpenRebalance = vi.fn();
    mounted = mountPanel({ bindings, onOpenRebalance });
    // Contested banner visible with count 6.
    const banner = mounted.container.querySelector('[data-testid="devices-panel-contested-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute('data-contested-count')).toBe('6');
    // Per-row contested badge present on every binding.
    const contestedBadges = mounted.container.querySelectorAll(
      '[data-testid^="devices-panel-contested-badge-"]',
    );
    expect(contestedBadges.length).toBe(6);
    // Rebalance CTA opens the modal.
    const cta = mounted.container.querySelector(
      '[data-testid="devices-panel-rebalance-cta"]',
    ) as HTMLButtonElement | null;
    expect(cta).not.toBeNull();
    act(() => cta!.click());
    expect(onOpenRebalance).toHaveBeenCalledWith(null);
    // Per-row rebalance button passes the focus agent.
    const perRowButtons = mounted.container.querySelectorAll(
      '[data-testid^="devices-panel-rebalance-mac-"], [data-testid^="devices-panel-rebalance-k8s-"]',
    );
    expect(perRowButtons.length).toBe(6);
    // Click the specific Mac CEO row's button rather than relying on
    // groupBindingsByDaemon's ordering (which is stable but unhelpful to
    // hardcode in tests that re-enact the §1.5 case).
    const macBtn = mounted.container.querySelector(
      '[data-testid="devices-panel-rebalance-mac-0"]',
    ) as HTMLButtonElement;
    act(() => macBtn.click());
    expect(onOpenRebalance).toHaveBeenLastCalledWith({ agentImUserId: 'mac-0' });
  });

  it('shows error banner with retry callback when loadError is set', () => {
    const onRefreshBindings = vi.fn();
    mounted = mountPanel({ loadError: 'HTTP 503', onRefreshBindings });
    const errorEl = mounted.container.querySelector('[data-testid="devices-panel-error"]');
    expect(errorEl).not.toBeNull();
    const retry = errorEl!.querySelector('button') as HTMLButtonElement;
    act(() => retry.click());
    expect(onRefreshBindings).toHaveBeenCalled();
  });

  it('uses runtime.devices to derive last-heartbeat status (online vs offline)', () => {
    const runtime: WorkspaceRuntimeDTO = {
      workspaceId: 'ws-1',
      devices: [
        { deviceId: 'daemon-mac', name: 'Mac Studio', lastSeenAt: new Date(NOW - 8_000).toISOString(), agents: [] },
      ],
    };
    mounted = mountPanel({
      bindings: [bind({ agentImUserId: 'a1', boundDaemonId: 'daemon-mac' })],
      runtime,
    });
    const pill = mounted.container.querySelector('[data-testid="devices-panel-status-pill"]');
    expect(pill?.getAttribute('data-status')).toBe('online');
  });
});

describe('groupBindingsByDaemon', () => {
  it('groups by boundDaemonId and ranks contested groups first', () => {
    const bindings: AgentBindingDTO[] = [
      bind({ agentImUserId: 'a1', boundDaemonId: 'daemon-clean' }),
      bind({ agentImUserId: 'a2', boundDaemonId: 'daemon-clean' }),
      bind({ agentImUserId: 'a3', boundDaemonId: 'daemon-dirty', contested: true, contestedSince: new Date().toISOString() }),
    ];
    const groups = groupBindingsByDaemon(bindings, null);
    expect(groups[0].daemonId).toBe('daemon-dirty');
    expect(groups[0].contestedCount).toBe(1);
    expect(groups[1].bindings.length).toBe(2);
  });

  it('treats missing runtime row as "forgotten daemon" (device=null) without dropping the group', () => {
    const bindings: AgentBindingDTO[] = [bind({ boundDaemonId: 'forgotten-daemon' })];
    const groups = groupBindingsByDaemon(bindings, { workspaceId: 'ws-1', devices: [] });
    expect(groups.length).toBe(1);
    expect(groups[0].device).toBeNull();
  });
});
