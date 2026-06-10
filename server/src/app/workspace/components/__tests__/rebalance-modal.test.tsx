/**
 * @vitest-environment jsdom
 *
 * Wave 3 C2 — RebalanceModal test.
 *
 * Verifies: (1) target-daemon selection excludes the current owner, (2)
 * submit hits rebindAgent and renders the success panel + inFlightTaskCount
 * surface, (3) onRebound is invoked so the parent refreshes binding state.
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/agent-bindings-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/agent-bindings-api')>();
  return {
    ...actual,
    rebindAgent: vi.fn(),
  };
});

import { RebalanceModal, buildDaemonOptions } from '../rebalance-modal';
import { rebindAgent, type AgentBindingDTO } from '../../lib/agent-bindings-api';
import type { WorkspaceRuntimeDTO } from '../../lib/types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.UTC(2026, 4, 21, 19, 10, 0);

function bind(overrides: Partial<AgentBindingDTO>): AgentBindingDTO {
  return {
    agentImUserId: 'agent-1',
    agentName: 'CEO',
    boundDaemonId: 'k8s-pod-1',
    boundDaemonKind: 'k8s',
    boundDaemonLabel: 'prismer-agent-rt-pe31wzn',
    boundAt: new Date(NOW - 5 * 60_000).toISOString(),
    boundBy: 'auto-first-declare',
    lastHostDeclareAt: new Date(NOW - 30_000).toISOString(),
    lastDispatchAt: null,
    contested: true,
    contestedSince: new Date(NOW - 60_000).toISOString(),
    contestCount: 2,
    ...overrides,
  };
}

const runtime: WorkspaceRuntimeDTO = {
  workspaceId: 'ws-1',
  devices: [
    { deviceId: 'k8s-pod-1', name: 'K8S Pod', lastSeenAt: new Date(NOW - 8_000).toISOString(), agents: [] },
    { deviceId: 'daemon-mac', name: 'Mac Studio', lastSeenAt: new Date(NOW - 5_000).toISOString(), agents: [] },
  ],
};

describe('RebalanceModal', () => {
  let mountInfo: { root: Root; container: HTMLDivElement } | null = null;
  beforeEach(() => {
    vi.mocked(rebindAgent).mockReset();
  });
  afterEach(() => {
    if (mountInfo) {
      act(() => mountInfo!.root.unmount());
      mountInfo!.container.remove();
      mountInfo = null;
    }
  });

  function mount(props: Partial<React.ComponentProps<typeof RebalanceModal>>) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <RebalanceModal
          isDark={false}
          open
          bindings={[bind({})]}
          runtime={runtime}
          onClose={vi.fn()}
          onRebound={vi.fn()}
          notify={vi.fn()}
          {...props}
        />,
      );
    });
    mountInfo = { root, container };
    return mountInfo;
  }

  it('renders nothing when closed', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <RebalanceModal
          isDark={false}
          open={false}
          bindings={[bind({})]}
          runtime={runtime}
          onClose={vi.fn()}
          onRebound={vi.fn()}
          notify={vi.fn()}
        />,
      );
    });
    expect(document.querySelector('[data-testid="rebalance-modal"]')).toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it('preselects the focused agent and excludes its current owner from targets', () => {
    const { container } = mount({ focusAgentImUserId: 'agent-1' });
    const select = container.querySelector(
      '[data-testid="rebalance-modal-agent-select"]',
    ) as HTMLSelectElement;
    expect(select.value).toBe('agent-1');
    // Mac Studio is the only valid target; current owner (k8s-pod-1) excluded.
    const targets = container.querySelectorAll('[data-testid^="rebalance-modal-target-"]');
    expect(targets.length).toBe(1);
    expect(targets[0].getAttribute('data-testid')).toBe('rebalance-modal-target-daemon-mac');
  });

  it('successful rebind shows success panel with inFlightTaskCount and calls onRebound', async () => {
    vi.mocked(rebindAgent).mockResolvedValueOnce({
      ok: true,
      data: {
        binding: {
          agentImUserId: 'agent-1',
          boundDaemonId: 'daemon-mac',
          boundDaemonKind: 'local',
          boundDaemonLabel: 'Mac Studio',
          boundBy: 'user-explicit',
          boundAt: new Date().toISOString(),
        },
        inFlightTaskCount: 2,
        previousDaemonId: 'k8s-pod-1',
      },
    });
    const onRebound = vi.fn();
    const notify = vi.fn();
    const { container } = mount({ focusAgentImUserId: 'agent-1', onRebound, notify });

    // Select target daemon
    // React tracks controlled-input value via a private setter; mutating
    // .checked then firing a `change` event no longer round-trips through
    // React's onChange in test envs. Clicking the radio itself triggers
    // the synthetic event the way the user would.
    const radio = container.querySelector(
      '[data-testid="rebalance-modal-target-daemon-mac"] input[type="radio"]',
    ) as HTMLInputElement;
    act(() => radio.click());

    // Submit
    const submit = container.querySelector(
      '[data-testid="rebalance-modal-submit"]',
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await act(async () => {
      submit.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(vi.mocked(rebindAgent)).toHaveBeenCalledWith('agent-1', expect.objectContaining({ targetDaemonId: 'daemon-mac' }));
    const success = container.querySelector('[data-testid="rebalance-modal-success"]');
    expect(success).not.toBeNull();
    expect(success!.getAttribute('data-inflight-count')).toBe('2');
    expect(container.querySelector('[data-testid="rebalance-modal-inflight"]')).not.toBeNull();
    expect(onRebound).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('Agent ownership updated.', 'success');
  });

  it('failed rebind shows error message and does not navigate to success', async () => {
    vi.mocked(rebindAgent).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: 'TARGET_DAEMON_STOPPED',
      message: 'target daemon is stopped',
    });
    const { container } = mount({ focusAgentImUserId: 'agent-1' });
    // React tracks controlled-input value via a private setter; mutating
    // .checked then firing a `change` event no longer round-trips through
    // React's onChange in test envs. Clicking the radio itself triggers
    // the synthetic event the way the user would.
    const radio = container.querySelector(
      '[data-testid="rebalance-modal-target-daemon-mac"] input[type="radio"]',
    ) as HTMLInputElement;
    act(() => radio.click());
    const submit = container.querySelector(
      '[data-testid="rebalance-modal-submit"]',
    ) as HTMLButtonElement;
    await act(async () => {
      submit.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="rebalance-modal-error"]')?.textContent).toContain(
      'target daemon is stopped',
    );
    expect(container.querySelector('[data-testid="rebalance-modal-success"]')).toBeNull();
  });
});

describe('buildDaemonOptions', () => {
  it('excludes the current owner and prefers online runtime devices', () => {
    const options = buildDaemonOptions(
      runtime,
      [bind({ boundDaemonId: 'k8s-pod-1' })],
      'k8s-pod-1',
    );
    expect(options.map((o) => o.daemonId)).toEqual(['daemon-mac']);
  });

  it('falls back to binding-derived daemons when runtime is empty', () => {
    const options = buildDaemonOptions(
      null,
      [
        bind({ agentImUserId: 'a1', boundDaemonId: 'k8s-pod-1' }),
        bind({ agentImUserId: 'a2', boundDaemonId: 'daemon-mac', boundDaemonKind: 'local', boundDaemonLabel: 'Mac Studio' }),
      ],
      'k8s-pod-1',
    );
    expect(options).toHaveLength(1);
    expect(options[0].daemonId).toBe('daemon-mac');
  });
});
