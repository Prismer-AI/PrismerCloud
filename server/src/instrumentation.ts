/**
 * Next.js Instrumentation Hook
 *
 * Starts the IM server in the same Node.js process as Next.js.
 *
 * IMPORTANT: This file is evaluated by BOTH Node.js and Edge runtimes.
 * All Node.js-specific code MUST be in the dynamically-imported bootstrap file.
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.IM_SERVER_ENABLED !== 'false') {
    // Load Nacos config BEFORE IM server so DB/Redis env vars are set
    try {
      const { ensureNacosConfig } = await import('./lib/nacos-config');
      await ensureNacosConfig();
    } catch (e) {
      console.warn('[Instrumentation] Nacos config load failed, using defaults:', e instanceof Error ? e.message : e);
    }

    const { bootstrapIMServer } = await import('./im/bootstrap');
    await bootstrapIMServer();

    // Wave-8 W14 — start the K8s reconcile loop in the same Node process.
    // Skip if `K8S_RECONCILE_ENABLED=false` (kill-switch) or unset and
    // `K8S_CONTROLLER_AVAILABLE=false` (dev w/o K8s). The module honors both
    // env vars internally — startup is unconditional, but the loop
    // short-circuits when K8s is known-unavailable.
    try {
      const { startK8sReconciler } = await import('./lib/sandbox-k8s-reconciler');
      startK8sReconciler();
    } catch (err) {
      console.warn('[Instrumentation] K8s reconciler start failed:', err instanceof Error ? err.message : err);
    }

    // §26 post-merge — boot probe surfaces RBAC drift loudly at startup
    // instead of as a silent 403 on the first user sandbox request. Fire-and-
    // forget so a slow apiserver doesn't block IM/Next from accepting traffic.
    // Skipped when `hasK8sConfig()` is false (local dev without K8s creds).
    try {
      const { hasK8sConfig } = await import('./lib/sandbox-config');
      if (hasK8sConfig()) {
        const { testK8sConnection, getK8sNamespace } = await import('./lib/k8s-client');
        testK8sConnection().then(
          () => {
            console.log(`[Instrumentation] K8s boot probe OK — can list pods in '${getK8sNamespace()}'`);
          },
          (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            const ns = getK8sNamespace();
            console.error(`[Instrumentation] ❌ K8s boot probe FAILED for namespace '${ns}': ${msg}`);
            if (/forbidden|cannot list|RBAC/i.test(msg)) {
              console.error(
                "[Instrumentation] 💡 RBAC hint: cloud's ServiceAccount has no Role/RoleBinding in this namespace. " +
                  'See docs/54release/26-controller-removal-architecture-pivot.md §"Post-merge ops: K8s RBAC provisioning".',
              );
            }
          },
        );
      }
    } catch (err) {
      console.warn('[Instrumentation] K8s boot probe schedule failed:', err instanceof Error ? err.message : err);
    }
  }
}
