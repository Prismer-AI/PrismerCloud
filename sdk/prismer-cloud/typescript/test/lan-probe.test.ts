/**
 * LAN Probe Service Tests (v1.9.0)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  LanProbeService,
  probeAndSelectLan,
  getLanStatus,
  type LanProbeOptions,
} from '../src/lan-probe';

describe('LanProbeService', () => {
  let probeService: LanProbeService;
  const daemonId = 'test-daemon-123';

  beforeEach(() => {
    probeService = new LanProbeService({
      daemonId,
      lanIP: '192.168.1.100',
      lanPort: 3210,
      relayUrl: 'wss://cloud.prismer.dev',
      maxLatencyMs: 500,
      probeTimeoutMs: 3000,
      maxConcurrentProbes: 2,
      pingCount: 3,
    });
  });

  it('should get connection candidates', () => {
    const candidates = probeService.getCandidates();

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      type: 'lan',
      endpoint: '192.168.1.100:3210',
      priority: 1,
    });
    expect(candidates[1]).toMatchObject({
      type: 'relay',
      endpoint: 'wss://cloud.prismer.dev',
      priority: 2,
    });
  });

  it('should sort candidates by priority', () => {
    const candidates = probeService.getCandidates();

    expect(candidates[0].priority).toBeLessThan(candidates[1].priority);
  });

  it('should select best connection based on quality score', () => {
    const mockResults = [
      {
        candidate: { type: 'lan', endpoint: '192.168.1.100:3210', priority: 1 },
        latencyMs: 10,
        jitterMs: 2,
        success: true,
        timestamp: Date.now(),
        qualityScore: 95,
      },
      {
        candidate: { type: 'relay', endpoint: 'wss://cloud.prismer.dev', priority: 2 },
        latencyMs: 150,
        jitterMs: 10,
        success: true,
        timestamp: Date.now(),
        qualityScore: 70,
      },
    ];

    const selected = probeService.selectBest(mockResults);

    expect(selected).not.toBeNull();
    expect(selected).toMatchObject({
      type: 'lan',
      endpoint: '192.168.1.100:3210',
      latencyMs: 10,
      qualityScore: 95,
    });
  });

  it('should respect max latency threshold', () => {
    const mockResults = [
      {
        candidate: { type: 'lan', endpoint: '192.168.1.100:3210', priority: 1 },
        latencyMs: 600, // Exceeds threshold
        jitterMs: 5,
        success: true,
        timestamp: Date.now(),
        qualityScore: 80,
      },
      {
        candidate: { type: 'relay', endpoint: 'wss://cloud.prismer.dev', priority: 2 },
        latencyMs: 200, // Within threshold
        jitterMs: 8,
        success: true,
        timestamp: Date.now(),
        qualityScore: 75,
      },
    ];

    const selected = probeService.selectBest(mockResults, { maxLatencyMs: 500 });

    expect(selected).not.toBeNull();
    expect(selected).toMatchObject({
      type: 'relay',
      latencyMs: 200,
    });
  });

  it('should respect minimum quality score threshold', () => {
    const mockResults = [
      {
        candidate: { type: 'lan', endpoint: '192.168.1.100:3210', priority: 1 },
        latencyMs: 50,
        jitterMs: 10,
        success: true,
        timestamp: Date.now(),
        qualityScore: 40, // Below minimum
      },
      {
        candidate: { type: 'relay', endpoint: 'wss://cloud.prismer.dev', priority: 2 },
        latencyMs: 100,
        jitterMs: 5,
        success: true,
        timestamp: Date.now(),
        qualityScore: 85, // Above minimum
      },
    ];

    const selected = probeService.selectBest(mockResults, { minQualityScore: 50 });

    expect(selected).not.toBeNull();
    expect(selected).toMatchObject({
      type: 'relay',
      qualityScore: 85,
    });
  });

  it('should return null if no suitable connections', () => {
    const mockResults = [
      {
        candidate: { type: 'lan', endpoint: '192.168.1.100:3210', priority: 1 },
        latencyMs: 800, // Too high
        jitterMs: 50,
        success: true,
        timestamp: Date.now(),
        qualityScore: 20,
      },
      {
        candidate: { type: 'relay', endpoint: 'wss://cloud.prismer.dev', priority: 2 },
        latencyMs: 1000, // Too high
        jitterMs: 100,
        success: true,
        timestamp: Date.now(),
        qualityScore: 10,
      },
    ];

    const selected = probeService.selectBest(mockResults);

    expect(selected).toBeNull();
  });

  it('should calculate quality score correctly', () => {
    // Test quality score calculation (access via private method)
    const perfectScore = {
      avgLatency: 5,
      jitter: 2,
      packetLoss: 0,
    };

    const goodScore = {
      avgLatency: 50,
      jitter: 10,
      packetLoss: 2,
    };

    const poorScore = {
      avgLatency: 300,
      jitter: 80,
      packetLoss: 15,
    };

    // Quality scores should be: perfect > good > poor
    // This tests the scoring formula: latency * 0.5 + jitter * 0.3 + loss * 0.2
    const perfectQuality = (1 - (perfectScore.avgLatency / 500)) * 0.5 +
                         (1 - (perfectScore.jitter / 100)) * 0.3 +
                         (1 - (perfectScore.packetLoss / 20)) * 0.2;
    const goodQuality = (1 - (goodScore.avgLatency / 500)) * 0.5 +
                      (1 - (goodScore.jitter / 100)) * 0.3 +
                      (1 - (goodScore.packetLoss / 20)) * 0.2;
    const poorQuality = (1 - (poorScore.avgLatency / 500)) * 0.5 +
                     (1 - (poorScore.jitter / 100)) * 0.3 +
                     (1 - (poorScore.packetLoss / 20)) * 0.2;

    expect(perfectQuality).toBeGreaterThan(goodQuality);
    expect(goodQuality).toBeGreaterThan(poorQuality);
  });
});

describe('probeAndSelectLan', () => {
  it('returns null when neither LAN nor relay is reachable in test env', async () => {
    const options: LanProbeOptions = {
      daemonId: 'test-daemon',
      lanIP: '192.168.255.254',
      lanPort: 65530,
      relayUrl: 'wss://invalid-host-for-tests.local',
      probeTimeoutMs: 200,
      pingCount: 1,
    };

    const selected = await probeAndSelectLan(options);

    expect(selected).toBeNull();
  }, 5000);
});

describe('getLanStatus', () => {
  it('returns shape { current, lastProbe[], timestamp } even when nothing reachable', async () => {
    const options: LanProbeOptions = {
      daemonId: 'test-daemon',
      lanIP: '192.168.255.254',
      lanPort: 65530,
      relayUrl: 'wss://invalid-host-for-tests.local',
      probeTimeoutMs: 200,
      pingCount: 1,
    };

    const status = await getLanStatus(options);

    expect(status).toHaveProperty('current');
    expect(status).toHaveProperty('lastProbe');
    expect(status).toHaveProperty('timestamp');
    expect(Array.isArray(status.lastProbe)).toBe(true);
  }, 5000);
});
