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
  }
}
