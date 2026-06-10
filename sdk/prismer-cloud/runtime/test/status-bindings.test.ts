import { describe, expect, it } from 'vitest';
import {
  computeAgentIcon,
  computeDeviceIcon,
  formatDeviceBindings,
  formatRelative,
  type RuntimeAgentDTO,
  type RuntimeDeviceDTO,
} from '../src/cli/commands/status.js';

const NOW = new Date('2026-05-22T12:00:00.000Z');
const minutesAgo = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();
const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe('computeDeviceIcon', () => {
  it('● when seen <5min ago', () => {
    expect(computeDeviceIcon(minutesAgo(2), NOW)).toBe('●');
  });
  it('◐ when seen between 5min and 1h ago', () => {
    expect(computeDeviceIcon(minutesAgo(30), NOW)).toBe('◐');
  });
  it('○ when seen >1h ago', () => {
    expect(computeDeviceIcon(hoursAgo(3), NOW)).toBe('○');
  });
  it('○ when lastSeenAt is null', () => {
    expect(computeDeviceIcon(null, NOW)).toBe('○');
  });
  it('○ for malformed timestamp', () => {
    expect(computeDeviceIcon('not-a-date', NOW)).toBe('○');
  });
});

describe('computeAgentIcon', () => {
  it('◆ when status is error', () => {
    expect(computeAgentIcon('error', minutesAgo(1), NOW)).toBe('◆');
  });
  it('◆ when status is failed (case insensitive)', () => {
    expect(computeAgentIcon('FAILED', minutesAgo(1), NOW)).toBe('◆');
  });
  it('● when heartbeat fresh', () => {
    expect(computeAgentIcon('idle', minutesAgo(1), NOW)).toBe('●');
  });
  it('◐ when heartbeat between 5min and 1h', () => {
    expect(computeAgentIcon('idle', minutesAgo(30), NOW)).toBe('◐');
  });
  it('○ when heartbeat >1h old', () => {
    expect(computeAgentIcon('idle', hoursAgo(2), NOW)).toBe('○');
  });
  it('○ when no heartbeat and status offline', () => {
    expect(computeAgentIcon('offline', null, NOW)).toBe('○');
  });
  it('◐ when no heartbeat but status running (assume stale, not yet failed)', () => {
    expect(computeAgentIcon('running', null, NOW)).toBe('◐');
  });
});

describe('formatRelative', () => {
  it('returns "just now" for <30s', () => {
    expect(formatRelative(new Date(NOW.getTime() - 10_000).toISOString(), NOW)).toBe('just now');
  });
  it('returns "{m}m ago" for minute-scale', () => {
    expect(formatRelative(minutesAgo(5), NOW)).toBe('5m ago');
  });
  it('returns "{h}h ago" for hour-scale', () => {
    expect(formatRelative(hoursAgo(3), NOW)).toBe('3h ago');
  });
  it('returns "unknown" for unparseable', () => {
    expect(formatRelative('not-a-date', NOW)).toBe('unknown');
  });
});

describe('formatDeviceBindings', () => {
  it('renders "No paired devices." when empty', () => {
    const out = formatDeviceBindings([], NOW);
    expect(out).toEqual(['  No paired devices.']);
  });

  it('renders a single device with no agents', () => {
    const devices: RuntimeDeviceDTO[] = [
      { deviceId: 'd1', name: 'laptop-bjd', lastSeenAt: minutesAgo(1), agents: [] },
    ];
    const out = formatDeviceBindings(devices, NOW);
    expect(out[0]).toBe('  Device & Agent Bindings (1 device · 0 agents)');
    expect(out[1]).toBe('');
    // Device row: ● + name padded + last-seen
    expect(out[2]).toMatch(/^ {2}● laptop-bjd {30}  1m ago$/);
  });

  it('renders multiple devices with nested agents using tree branches', () => {
    const devices: RuntimeDeviceDTO[] = [
      {
        deviceId: 'dev_001',
        name: 'laptop-bjd',
        lastSeenAt: minutesAgo(2),
        agents: [
          { id: 'a1', name: 'hermes-cli', status: 'idle', currentTaskId: null, version: '0.12.3', lastHeartbeat: minutesAgo(1) },
          { id: 'a2', name: 'openclaw-coder', status: 'running', currentTaskId: 'task_abc', version: '1.0.0', lastHeartbeat: minutesAgo(1) },
        ],
      },
      {
        deviceId: 'dev_002',
        name: 'ci-runner',
        lastSeenAt: hoursAgo(5),
        agents: [
          { id: 'a3', name: 'release-agent', status: 'offline', currentTaskId: null, version: '1.0.0', lastHeartbeat: hoursAgo(5) },
        ],
      },
    ];
    const out = formatDeviceBindings(devices, NOW);

    // Header counts correct (plural)
    expect(out[0]).toBe('  Device & Agent Bindings (2 devices · 3 agents)');

    // First device row: ● (fresh) and ├─ branch for first agent, └─ for last
    const joined = out.join('\n');
    expect(joined).toContain('● laptop-bjd');
    expect(joined).toContain('├─ ● hermes-cli');
    expect(joined).toContain('└─ ● openclaw-coder');
    // task tail when currentTaskId present
    expect(joined).toContain('task=task_abc');

    // Second device row: ○ (>1h) and offline agent (└─ since sole agent)
    expect(joined).toContain('○ ci-runner');
    expect(joined).toContain('└─ ○ release-agent');
    expect(joined).toContain('offline');
    // Heartbeat tail when no task and lastHeartbeat present
    expect(joined).toContain('❤ 5h ago');
  });

  it('handles missing agents array gracefully', () => {
    const devices = [
      { deviceId: 'd1', name: 'no-agents', lastSeenAt: null } as unknown as RuntimeDeviceDTO,
    ];
    const out = formatDeviceBindings(devices, NOW);
    expect(out.some((l) => l.includes('no-agents'))).toBe(true);
    // Pluralization: 0 agents
    expect(out[0]).toContain('0 agents');
  });

  it('uses "never seen" when lastSeenAt is null', () => {
    const devices: RuntimeDeviceDTO[] = [
      { deviceId: 'd1', name: 'fresh-pair', lastSeenAt: null, agents: [] },
    ];
    const out = formatDeviceBindings(devices, NOW);
    expect(out.some((l) => l.includes('never seen'))).toBe(true);
  });
});
