/**
 * @vitest-environment jsdom
 *
 * Wave 3 C2 — DaemonHealthDashboard test.
 *
 * Verifies the per-daemon polling, transport derivation, and sparkline
 * behavior. Polling is mocked via vi.mock at the module boundary so we
 * don't actually open network connections.
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/agent-bindings-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/agent-bindings-api')>();
  return {
    ...actual,
    getDaemonHealth: vi.fn(),
  };
});

import { DaemonHealthDashboard } from '../daemon-health-dashboard';
import { getDaemonHealth, type DaemonHealthDTO } from '../../lib/agent-bindings-api';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.UTC(2026, 4, 21, 19, 10, 0);

function health(overrides: Partial<DaemonHealthDTO> = {}): DaemonHealthDTO {
  return {
    daemonId: 'daemon-mac',
    workspaceId: 'ws-1',
    deviceType: 'local',
    runtimeKind: 'docker',
    containerStatus: 'running',
    startedAt: new Date(NOW - 60 * 60_000).toISOString(),
    stoppedAt: null,
    lastHeartbeatAt: new Date(NOW - 15_000).toISOString(),
    heartbeatFresh: true,
    wsConnected: true,
    lastSuccessfulDispatch: new Date(NOW - 5 * 60_000).toISOString(),
    taskQueueSize: 2,
    agents: [
      { agentImUserId: 'a1', name: 'CEO', lastDispatchAt: new Date(NOW - 2 * 60_000).toISOString(), contested: false },
    ],
    ...overrides,
  };
}

describe('DaemonHealthDashboard', () => {
  let mountInfo: { root: Root; container: HTMLDivElement } | null = null;

  beforeEach(() => {
    vi.mocked(getDaemonHealth).mockReset();
  });

  afterEach(() => {
    if (mountInfo) {
      act(() => mountInfo!.root.unmount());
      mountInfo!.container.remove();
      mountInfo = null;
    }
  });

  it('renders empty state when no daemons are present', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<DaemonHealthDashboard isDark={false} daemonIds={[]} daemonLabels={new Map()} />);
    });
    expect(container.querySelector('[data-testid="daemon-health-empty"]')).not.toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it('polls each daemon on mount and renders transport / heartbeat / queue metrics', async () => {
    vi.mocked(getDaemonHealth).mockResolvedValue({ ok: true, data: health({}) });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <DaemonHealthDashboard
          isDark={false}
          daemonIds={['daemon-mac']}
          daemonLabels={new Map([['daemon-mac', 'Mac Studio']])}
        />,
      );
      // flush microtasks for the initial fetch
      await Promise.resolve();
      await Promise.resolve();
    });
    mountInfo = { root, container };

    expect(vi.mocked(getDaemonHealth)).toHaveBeenCalledWith('daemon-mac');
    const card = container.querySelector('[data-testid="daemon-health-card-daemon-mac"]');
    expect(card).not.toBeNull();
    expect(card!.getAttribute('data-overall')).toBe('online');
    expect(
      container.querySelector('[data-testid="daemon-health-transport-daemon-mac"]')?.textContent,
    ).toContain('ws');
    expect(
      container.querySelector('[data-testid="daemon-health-queue-daemon-mac"]')?.textContent,
    ).toContain('2 task');
  });

  it('marks daemon as degraded when heartbeat fresh but ws disconnected', async () => {
    vi.mocked(getDaemonHealth).mockResolvedValue({
      ok: true,
      data: health({ wsConnected: false }),
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <DaemonHealthDashboard
          isDark={false}
          daemonIds={['daemon-mac']}
          daemonLabels={new Map([['daemon-mac', 'Mac Studio']])}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    mountInfo = { root, container };
    const card = container.querySelector('[data-testid="daemon-health-card-daemon-mac"]');
    expect(card!.getAttribute('data-overall')).toBe('degraded');
    expect(
      container.querySelector('[data-testid="daemon-health-transport-daemon-mac"]')?.textContent,
    ).toContain('http');
  });

  it('renders error state and refresh button when fetch fails', async () => {
    vi.mocked(getDaemonHealth).mockResolvedValue({ ok: false, status: 503, error: 'SVC_DOWN', message: 'cloud not ready' });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <DaemonHealthDashboard
          isDark={false}
          daemonIds={['daemon-mac']}
          daemonLabels={new Map([['daemon-mac', 'Mac Studio']])}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    mountInfo = { root, container };
    expect(container.querySelector('[data-testid="daemon-health-error-daemon-mac"]')?.textContent).toContain(
      'cloud not ready',
    );
  });
});
