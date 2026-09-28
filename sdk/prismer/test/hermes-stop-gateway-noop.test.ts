import { describe, expect, it } from 'vitest';

import { stopHermesGatewayForProfile } from '../src/adapters/persistence/hermes/index.js';

/**
 * 2026-08-30 fxr fixture 复现：ACS 沙箱 profile 无 apiKey（ConfigDelivery
 * 「no env-injected key」路径），`Runner.rebindHermesMemoryCapabilities` →
 * `ServicePool.invalidate` → stop 的 ZodError 未捕获 → daemon exited(1)，两轮后
 * bundle 被 bootstrapper blacklist，healthz 长期 503。stop（杀 gateway）对从未
 * spawn 过 gateway 的 profile 必须是 no-op，不能抛。
 */
describe('stopHermesGatewayForProfile with apiKey-less profile config', () => {
  it('resolves as no-op when config lacks apiKey (ACS sandbox shape)', async () => {
    await expect(
      stopHermesGatewayForProfile({
        id: 'profile-fxr-no-key',
        agentUsername: 'fxr-no-key',
        config: {},
      }),
    ).resolves.toBeUndefined();
  });

  it('resolves as no-op when config has non-string apiKey', async () => {
    await expect(
      stopHermesGatewayForProfile({
        id: 'profile-fxr-bad-key',
        agentUsername: 'fxr-bad-key',
        config: { apiKey: 123 },
      }),
    ).resolves.toBeUndefined();
  });
});
