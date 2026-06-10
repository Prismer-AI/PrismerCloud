/**
 * Unit tests for the DaemonTarget builders used by useDaemonTargets.
 *
 * The hook itself is exercised indirectly: we test the pure builders that
 * decide `bindable` + `mismatchReason` per source. This keeps the test fast
 * (no jsdom / fake timers / interval polling) and covers the v200 K8S device
 * picker bindability matrix exhaustively.
 */
import { describe, expect, it } from 'vitest';
import type { LocalDaemonHealthDTO, RuntimeInstallationDTO } from '../../../../lib/types';
import { buildK8sDeviceTarget, buildLocalHostTarget } from '../use-daemon-health';

function makeHealth(overrides: Partial<LocalDaemonHealthDTO> = {}): LocalDaemonHealthDTO {
  return {
    status: 'ok',
    daemonId: 'host-daemon-abc',
    pid: 12345,
    startedAt: Date.now(),
    wsConnected: true,
    workspaceId: 'ws-1',
    ...overrides,
  };
}

function makeRow(overrides: Partial<RuntimeInstallationDTO> = {}): RuntimeInstallationDTO {
  return {
    id: 'cmpboi6do0000xzz6ppt147i3',
    workspaceId: 'ws-1',
    runtimeInstanceId: 'rt-abc',
    daemonId: 'container:rt-abc',
    podName: 'prismer-agent-rt-abc',
    namespace: 'workspace',
    runtimeKind: 'k8s',
    maxAgents: 3,
    phase: 'online',
    desiredState: 'running',
    status: 'running',
    containerStatus: 'running',
    daemonStatus: 'connected',
    hostedAgentSummary: { declared: 0, expected: 0, verified: false },
    image: 'prismer-daemon:v2.0.0',
    imageTag: 'v2.0.0',
    resources: { cpuRequest: '250m', cpuLimit: '2000m', memoryRequest: '2Gi', memoryLimit: '4Gi' },
    gatewayUrl: 'http://10.0.0.1:3210',
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metrics: { ageMs: 5_000, provisionLatencyMs: 2_000, heartbeatAgeMs: 1_000, hostedAgents: 0, onlineHostedAgents: 0 },
    observability: {
      statusFreshness: 'database',
      logsPath: '/api/sandboxes/x/logs',
      startPath: '/api/sandboxes/x/start',
      stopPath: '/api/sandboxes/x/stop',
      snapshotPath: '/api/sandboxes/x/snapshot',
    },
    events: [],
    ...overrides,
  };
}

describe('buildLocalHostTarget', () => {
  it('returns offline target when daemon is null', () => {
    const t = buildLocalHostTarget('ws-1', null, 'ECONNREFUSED');
    expect(t.source).toBe('local-host');
    expect(t.bindable).toBe(false);
    expect(t.mismatchReason).toContain('ECONNREFUSED');
    expect(t.label).toContain('not running');
  });

  it('is bindable when workspace matches and ws is connected', () => {
    const t = buildLocalHostTarget('ws-1', makeHealth(), null);
    expect(t.bindable).toBe(true);
    expect(t.mismatchReason).toBeUndefined();
    expect(t.daemonId).toBe('host-daemon-abc');
  });

  it('is not bindable when ws is disconnected', () => {
    const t = buildLocalHostTarget('ws-1', makeHealth({ wsConnected: false }), null);
    expect(t.bindable).toBe(false);
    expect(t.mismatchReason).toMatch(/Not connected/i);
  });

  it('is not bindable when workspace differs (the reported user issue)', () => {
    const t = buildLocalHostTarget('ws-1', makeHealth({ workspaceId: 'ws-2' }), null);
    expect(t.bindable).toBe(false);
    expect(t.mismatchReason).toContain('ws-2');
  });

  it('treats null daemon.workspaceId as a match (un-paired daemon)', () => {
    const t = buildLocalHostTarget('ws-1', makeHealth({ workspaceId: null }), null);
    expect(t.bindable).toBe(true);
  });
});

describe('buildK8sDeviceTarget', () => {
  it('is bindable when running + daemon connected + gateway present', () => {
    const t = buildK8sDeviceTarget(makeRow());
    expect(t.source).toBe('k8s-device');
    expect(t.bindable).toBe(true);
    expect(t.installationId).toBe('cmpboi6do0000xzz6ppt147i3');
  });

  it('is not bindable when status is provisioning', () => {
    const t = buildK8sDeviceTarget(makeRow({ status: 'provisioning', containerStatus: 'provisioning' }));
    expect(t.bindable).toBe(false);
    expect(t.mismatchReason).toMatch(/Status/);
  });

  it('is not bindable when daemon is offline', () => {
    const t = buildK8sDeviceTarget(makeRow({ daemonStatus: 'offline' }));
    expect(t.bindable).toBe(false);
    expect(t.mismatchReason).toMatch(/offline/i);
  });

  it('is not bindable when gatewayUrl is missing', () => {
    const t = buildK8sDeviceTarget(makeRow({ gatewayUrl: null }));
    expect(t.bindable).toBe(false);
    expect(t.mismatchReason).toMatch(/gateway/i);
  });

  it('accepts daemonStatus=stale as bindable (reconciler grace period)', () => {
    const t = buildK8sDeviceTarget(makeRow({ daemonStatus: 'stale' }));
    expect(t.bindable).toBe(true);
  });

  it('handles legacy rows with null daemonId', () => {
    const t = buildK8sDeviceTarget(makeRow({ daemonId: null as unknown as string }));
    expect(t.daemonId).toBeNull();
    expect(t.bindable).toBe(true); // null daemonId alone shouldn't block selection
  });
});
