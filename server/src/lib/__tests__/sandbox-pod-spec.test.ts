import { describe, expect, it } from 'vitest';
import {
  SANDBOX_DAEMON_PORT,
  buildSandboxContainerSpec,
  buildSandboxDaemonEnv,
  buildSandboxHostAliases,
  buildWorkspaceRuntimeEnv,
  getSandboxDaemonImage,
  getSandboxDaemonPort,
  shouldInjectHostGatewayAlias,
} from '@/lib/sandbox/pod-spec';

describe('sandbox pod spec source of truth', () => {
  it('exports the daemon port default', () => {
    expect(SANDBOX_DAEMON_PORT).toBe(7878);
  });

  it('builds daemon env without nullish values', () => {
    expect(
      buildSandboxDaemonEnv({
        daemonId: 'daemon-a',
        workspaceId: 'ws-a',
        extra: { KEEP: 'yes', DROP: null },
      }),
    ).toEqual({
      PRISMER_DAEMON_ID: 'daemon-a',
      PRISMER_WORKSPACE_ID: 'ws-a',
      KEEP: 'yes',
    });
  });

  it('allows env overrides for local dev', () => {
    expect(getSandboxDaemonImage({ SANDBOX_DAEMON_IMAGE: 'custom:image' })).toBe('custom:image');
    expect(getSandboxDaemonPort({ SANDBOX_DAEMON_PORT: '8787' })).toBe(8787);
  });

  // C-10 (08 §5.7) — hostAliases injection is the ONLY platform-conditional
  // branch in pod-spec. macOS / OrbStack resolve `host.docker.internal`
  // natively; Linux Docker does not, so we inject `host-gateway` for kind.
  // prod must NEVER carry hostAliases (host network is forbidden).
  describe('C-10 hostAliases injection (08 §5.7)', () => {
    it('injects on Linux + APP_ENV=local', () => {
      expect(shouldInjectHostGatewayAlias('local', 'linux')).toBe(true);
      expect(buildSandboxHostAliases('local', 'linux')).toEqual([
        { ip: 'host-gateway', hostnames: ['host.docker.internal'] },
      ]);
    });

    it('does not inject on macOS (native host.docker.internal)', () => {
      expect(shouldInjectHostGatewayAlias('local', 'darwin')).toBe(false);
      expect(buildSandboxHostAliases('local', 'darwin')).toBeUndefined();
    });

    it('does not inject in prod / test (APP_ENV !== local)', () => {
      // All non-local app envs MUST NOT inject regardless of platform.
      for (const appEnv of ['prod', 'test', 'dev', undefined]) {
        for (const platform of ['linux', 'darwin', 'win32'] as NodeJS.Platform[]) {
          expect(shouldInjectHostGatewayAlias(appEnv, platform)).toBe(false);
          expect(buildSandboxHostAliases(appEnv, platform)).toBeUndefined();
        }
      }
    });
  });

  // F8 (2026-05-19) — workspace-runtime profile env builder must emit keys in
  // the exact post-merge order live K8S pods carry, so manifest-diff-gen vs
  // live-pod J2 isomorphism stays byte-clean. The order is the contract — env
  // values are allowed to differ across envs (C-3/C-6), env names + positions
  // are NOT.
  describe('F8 — buildWorkspaceRuntimeEnv post-merge env contract', () => {
    const base = {
      apiKey: 'sk-test',
      daemonId: 'd-uuid',
      cloudApiBase: 'http://host.docker.internal:3000',
      workspaceId: 'ws-1',
      tenantId: 't-1',
      runtimeInstanceId: 'rt-abc',
      runtimeKind: 'workspace-k8s-pod' as const,
    };

    it('emits keys in production order, with mandatory PRISMER_RUNTIME_* set', () => {
      const env = buildWorkspaceRuntimeEnv(base);
      expect(Object.keys(env)).toEqual([
        'PRISMER_API_KEY',
        'PRISMER_DAEMON_ID',
        'PRISMER_BASE_URL',
        'PRISMER_WORKSPACE_ID',
        'PRISMER_RUNTIME_MODE',
        'PRISMER_RUNTIME_KIND',
        'PRISMER_RUNTIME_INSTANCE_ID',
        'PRISMER_SHELL_ENABLED',
        'CLOUD_API_BASE',
        'PRISMER_USER_ID',
      ]);
      expect(env.PRISMER_RUNTIME_MODE).toBe('container');
      expect(env.PRISMER_SHELL_ENABLED).toBe('true');
      // CLOUD_API_BASE mirrors PRISMER_BASE_URL — scopedEnv idempotency.
      expect(env.CLOUD_API_BASE).toBe(env.PRISMER_BASE_URL);
    });

    it('omits PRISMER_SHELL_ENABLED only when shellEnabled === false', () => {
      const env = buildWorkspaceRuntimeEnv({ ...base, shellEnabled: false });
      expect(env.PRISMER_SHELL_ENABLED).toBeUndefined();
    });

    it('inserts PRISMER_K8S_TEMPLATE / PRISMER_GPU_REQUEST conditionally', () => {
      const env = buildWorkspaceRuntimeEnv({ ...base, k8sTemplate: 'gpu-large', gpuRequest: 2 });
      expect(env.PRISMER_K8S_TEMPLATE).toBe('gpu-large');
      expect(env.PRISMER_GPU_REQUEST).toBe('2');
      // gpuRequest <= 0 is treated as absent.
      const noGpu = buildWorkspaceRuntimeEnv({ ...base, gpuRequest: 0 });
      expect(noGpu.PRISMER_GPU_REQUEST).toBeUndefined();
    });

    it('trims + emits DISPATCH_DAEMON_SECRET when set, omits when empty', () => {
      expect(buildWorkspaceRuntimeEnv({ ...base, dispatchDaemonSecret: '  shh  ' }).DISPATCH_DAEMON_SECRET).toBe('shh');
      expect(buildWorkspaceRuntimeEnv({ ...base, dispatchDaemonSecret: '   ' }).DISPATCH_DAEMON_SECRET).toBeUndefined();
    });
  });

  it('builds a container spec using the canonical image ref from image-pin', () => {
    // T8 / 08 §5.7 C-1: when no override is set, image resolves via the
    // image-pin service. CONTAINER_IMAGE env wins over the yaml, so we use
    // it here to keep the test hermetic (doesn't depend on file path).
    const prev = process.env.CONTAINER_IMAGE;
    process.env.CONTAINER_IMAGE = 'dockerhub.services/prismer/library/sandbox:daemon-vTEST';
    try {
      const spec = buildSandboxContainerSpec({ daemonId: 'daemon-a' });
      expect(spec.name).toBe('daemon');
      expect(spec.image).toBe('dockerhub.services/prismer/library/sandbox:daemon-vTEST');
      expect(spec.ports).toEqual([{ name: 'daemon', containerPort: SANDBOX_DAEMON_PORT }]);
      expect(spec.readinessProbe.httpGet).toEqual({ path: '/healthz', port: SANDBOX_DAEMON_PORT });
    } finally {
      if (prev === undefined) delete process.env.CONTAINER_IMAGE;
      else process.env.CONTAINER_IMAGE = prev;
    }
  });
});
