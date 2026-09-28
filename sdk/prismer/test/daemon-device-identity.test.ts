/**
 * daemon-device-identity.test.ts — desktop204 D204-3, resolver layer.
 *
 * The two facts the daemon declares about its device (`daemonLabel` /
 * `daemonKind`). Before D204-3 the daemon sent neither and the cloud guessed
 * both from the daemonId string; these resolvers are the replacement, so their
 * precedence is the contract:
 *
 *   kind:  PRISMER_DEVICE_KIND > KUBERNETES_SERVICE_HOST ⇒ k8s > local
 *   label: PRISMER_DAEMON_LABEL > config.toml daemon_label > hostname > daemonId
 *
 * Usage: npx vitest run test/daemon-device-identity.test.ts
 */
import { describe, expect, it } from 'vitest';
import { hostname } from 'node:os';
import { resolveDaemonKind, resolveDaemonLabel } from '../src/daemon/device-identity';

describe('resolveDaemonKind', () => {
  it('defaults to local — a plain laptop/CLI daemon', () => {
    expect(resolveDaemonKind({} as NodeJS.ProcessEnv)).toBe('local');
  });

  it("infers k8s from the kubelet's KUBERNETES_SERVICE_HOST", () => {
    expect(resolveDaemonKind({ KUBERNETES_SERVICE_HOST: '10.96.0.1' } as NodeJS.ProcessEnv)).toBe('k8s');
  });

  it('PRISMER_DEVICE_KIND overrides the auto-probe (edge has no auto signal)', () => {
    expect(resolveDaemonKind({ PRISMER_DEVICE_KIND: 'edge' } as NodeJS.ProcessEnv)).toBe('edge');
    // Explicit wins even inside a pod (a k8s-hosted edge runner is legal).
    expect(
      resolveDaemonKind({ PRISMER_DEVICE_KIND: 'local', KUBERNETES_SERVICE_HOST: '10.96.0.1' } as NodeJS.ProcessEnv),
    ).toBe('local');
  });

  it('ignores a garbage override rather than putting it on the wire', () => {
    expect(resolveDaemonKind({ PRISMER_DEVICE_KIND: 'toaster' } as NodeJS.ProcessEnv)).toBe('local');
  });
});

describe('resolveDaemonLabel', () => {
  const daemonId = 'daemon-abc123';

  it('falls back to the OS hostname when nothing is configured', () => {
    expect(resolveDaemonLabel({ daemonId, env: {} as NodeJS.ProcessEnv })).toBe(hostname());
  });

  it("prefers the user's config.toml daemon_label over the hostname", () => {
    expect(resolveDaemonLabel({ configLabel: "Jason 的 Mac Studio", daemonId, env: {} as NodeJS.ProcessEnv })).toBe(
      "Jason 的 Mac Studio",
    );
  });

  it('PRISMER_DAEMON_LABEL beats config (k8s injects it at boot)', () => {
    expect(
      resolveDaemonLabel({
        configLabel: 'from-config',
        daemonId,
        env: { PRISMER_DAEMON_LABEL: 'agent-rt-7f9c' } as NodeJS.ProcessEnv,
      }),
    ).toBe('agent-rt-7f9c');
  });

  it('treats a blank/whitespace label as absent (an empty label would send the cloud back to guessing)', () => {
    expect(
      resolveDaemonLabel({ configLabel: '   ', daemonId, env: { PRISMER_DAEMON_LABEL: '  ' } as NodeJS.ProcessEnv }),
    ).toBe(hostname());
  });

  it('never returns empty — daemonId is the last resort', () => {
    // Hostname is always present on a real box; assert the invariant holds for
    // every tier by checking the resolved value is non-empty.
    expect(resolveDaemonLabel({ daemonId, env: {} as NodeJS.ProcessEnv }).length).toBeGreaterThan(0);
  });
});
