/**
 * X-movcj70v - MVP M3/M4 Smoke Test Feature
 *
 * This module implements a minimal feature for testing the work_item dispatch flow
 * between M3 (fallback) and M4 (active agent) execution paths.
 *
 * @module x-movcj70v
 * @tag movcj70v
 * @mvp m3-m4
 */

export const X_MOVCJ70V_VERSION = '1.0.0';
export const X_MOVCJ70V_TAG = 'movcj70v';

export interface Movcj70vConfig {
  /** Unique identifier for this smoke test instance */
  id: string;
  /** Target daemon ID for dispatch verification */
  targetDaemonId: string;
  /** Execution mode: 'm3-fallback' | 'm4-active' */
  mode: 'm3-fallback' | 'm4-active';
  /** Timestamp of execution */
  executedAt: Date;
}

export interface Movcj70vResult {
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
 * Execute the X-movcj70v smoke test
 */
export function executeMovcj70v(config: Movcj70vConfig): Movcj70vResult {
  console.log(`[X-movcj70v] Executing smoke test: ${config.id}`);
  console.log(`[X-movcj70v] Mode: ${config.mode}`);
  console.log(`[X-movcj70v] Target daemon: ${config.targetDaemonId}`);

  // Validate configuration
  if (!config.id || !config.targetDaemonId) {
    throw new Error('X-movcj70v: Invalid configuration - missing required fields');
  }

  // Generate verification token
  const token = `M4OK-${X_MOVCJ70V_TAG}`;

  console.log(`[X-movcj70v] Smoke test completed successfully`);
  console.log(`[X-movcj70v] Token: ${token}`);

  return {
    success: true,
    token,
    metadata: {
      version: X_MOVCJ70V_VERSION,
      tag: X_MOVCJ70V_TAG,
      mode: config.mode,
      timestamp: config.executedAt.toISOString(),
    },
  };
}

/**
 * Verify the smoke test result
 */
export function verifyMovcj70v(result: Movcj70vResult): boolean {
  const expectedToken = `M4OK-${X_MOVCJ70V_TAG}`;

  if (!result.success) {
    console.error('[X-movcj70v] Verification failed: result indicates failure');
    return false;
  }

  if (result.token !== expectedToken) {
    console.error(`[X-movcj70v] Verification failed: token mismatch`);
    console.error(`  Expected: ${expectedToken}`);
    console.error(`  Actual: ${result.token}`);
    return false;
  }

  if (result.metadata.tag !== X_MOVCJ70V_TAG) {
    console.error(`[X-movcj70v] Verification failed: tag mismatch`);
    return false;
  }

  console.log('[X-movcj70v] Verification passed');
  return true;
}

// Default export for smoke test execution
export default {
  version: X_MOVCJ70V_VERSION,
  tag: X_MOVCJ70V_TAG,
  execute: executeMovcj70v,
  verify: verifyMovcj70v,
};
