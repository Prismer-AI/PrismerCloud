/**
 * X-movzmhsc - MVP M3/M4 Smoke Test Feature
 *
 * This module implements a minimal feature for testing the work_item dispatch flow
 * between M3 (fallback) and M4 (active agent) execution paths.
 *
 * @module x-movzmhsc
 * @tag movzmhsc
 * @mvp m3-m4
 */

export const X_MOVZMHSC_VERSION = '1.0.0';
export const X_MOVZMHSC_TAG = 'movzmhsc';

export interface MovzmhscConfig {
  /** Unique identifier for this smoke test instance */
  id: string;
  /** Target daemon ID for dispatch verification */
  targetDaemonId: string;
  /** Execution mode: 'm3-fallback' | 'm4-active' */
  mode: 'm3-fallback' | 'm4-active';
  /** Timestamp of execution */
  executedAt: Date;
}

export interface MovzmhscResult {
  /** Success flag */
  success: boolean;
  /** Verification token */
  token: string;
  /** Execution metadata */
  metadata: {
    version: string;
    tag: string;
    mode: string;
    timestamp: string;
  };
}

/**
 * Execute the X-movzmhsc smoke test
 */
export function executeMovzmhsc(config: MovzmhscConfig): MovzmhscResult {
  console.log(`[X-movzmhsc] Executing smoke test: ${config.id}`);
  console.log(`[X-movzmhsc] Mode: ${config.mode}`);
  console.log(`[X-movzmhsc] Target daemon: ${config.targetDaemonId}`);

  // Validate configuration
  if (!config.id || !config.targetDaemonId) {
    throw new Error('X-movzmhsc: Invalid configuration - missing required fields');
  }

  // Generate verification token
  const token = `M4OK-${X_MOVZMHSC_TAG}`;

  console.log(`[X-movzmhsc] Smoke test completed successfully`);
  console.log(`[X-movzmhsc] Token: ${token}`);

  return {
    success: true,
    token,
    metadata: {
      version: X_MOVZMHSC_VERSION,
      tag: X_MOVZMHSC_TAG,
      mode: config.mode,
      timestamp: config.executedAt.toISOString(),
    },
  };
}

/**
 * Verify the smoke test result
 */
export function verifyMovzmhsc(result: MovzmhscResult): boolean {
  const expectedToken = `M4OK-${X_MOVZMHSC_TAG}`;

  if (!result.success) {
    console.error('[X-movzmhsc] Verification failed: result indicates failure');
    return false;
  }

  if (result.token !== expectedToken) {
    console.error(`[X-movzmhsc] Verification failed: token mismatch`);
    console.error(`  Expected: ${expectedToken}`);
    console.error(`  Actual: ${result.token}`);
    return false;
  }

  if (result.metadata.tag !== X_MOVZMHSC_TAG) {
    console.error(`[X-movzmhsc] Verification failed: tag mismatch`);
    return false;
  }

  console.log('[X-movzmhsc] Verification passed');
  return true;
}

// Default export for smoke test execution
export default {
  version: X_MOVZMHSC_VERSION,
  tag: X_MOVZMHSC_TAG,
  execute: executeMovzmhsc,
  verify: verifyMovzmhsc,
};
