import { describe, expect, it, vi } from 'vitest';
import type { K8sSandbox } from '@/lib/k8s-sandbox';
import { K8sSandboxProvider } from '@/lib/sandbox/k8s-provider';
import { createDefaultSandboxProviderRegistry, SandboxProviderRegistry } from '@/lib/sandbox/registry';

describe('sandbox provider registry', () => {
  it('registers k8s + docker-host by default; e2b is gated on E2B_API_KEY (T10)', () => {
    const prevKey = process.env.E2B_API_KEY;
    delete process.env.E2B_API_KEY;
    try {
      const registry = createDefaultSandboxProviderRegistry();
      expect(
        registry
          .list()
          .map((p) => p.kind)
          .sort(),
      ).toEqual(['docker-host', 'k8s']);
    } finally {
      if (prevKey !== undefined) process.env.E2B_API_KEY = prevKey;
    }
  });

  it('registers e2b when E2B_API_KEY is set', () => {
    const prevKey = process.env.E2B_API_KEY;
    process.env.E2B_API_KEY = 'test-key';
    try {
      const registry = createDefaultSandboxProviderRegistry();
      expect(
        registry
          .list()
          .map((p) => p.kind)
          .sort(),
      ).toEqual(['docker-host', 'e2b', 'k8s']);
    } finally {
      if (prevKey === undefined) delete process.env.E2B_API_KEY;
      else process.env.E2B_API_KEY = prevKey;
    }
  });

  it('throws for unknown providers', () => {
    const registry = new SandboxProviderRegistry();
    expect(() => registry.get('k8s')).toThrow('Sandbox provider is not registered: k8s');
  });
});

describe('K8sSandboxProvider', () => {
  it('uses an injectable k8s sandbox client for unit tests', async () => {
    const fakeSandbox = {
      createContainer: vi.fn(async () => ({
        containerId: 'pod-a',
        podName: 'pod-a',
        status: 'active',
        gatewayUrl: 'ws://10.0.0.1:7878',
      })),
      getContainer: vi.fn(),
      startContainer: vi.fn(),
      stopContainer: vi.fn(),
      removeContainer: vi.fn(),
      runCmd: vi.fn(),
      daemonDispatch: vi.fn(),
      installAgent: vi.fn(),
      snapshot: vi.fn(),
      podStatusVerdict: vi.fn(),
      getContainerLogs: vi.fn(),
      provisionContainer: vi.fn(),
    } as unknown as K8sSandbox;

    const provider = new K8sSandboxProvider(async () => fakeSandbox);
    const env = await provider.provisionEnvironment({
      id: 'agent-a',
      image: 'local/image:test',
      environment: { A: '1' },
    });

    expect(env).toEqual({
      id: 'pod-a',
      provider: 'k8s',
      status: 'running',
      gatewayUrl: 'ws://10.0.0.1:7878',
      metadata: { podName: 'pod-a' },
    });
    expect(fakeSandbox.createContainer).toHaveBeenCalledWith('agent-a', {
      image: 'local/image:test',
      environment: { A: '1' },
      cpuRequest: undefined,
      cpuLimit: undefined,
      memoryRequest: undefined,
      memoryLimitStr: undefined,
    });
  });
});
