/**
 * X-movcg8io - MVP M3/M4 Smoke Test Feature
 *
 * This module implements a minimal feature for testing the work_item dispatch flow
 * between M3 (fallback) and M4 (active agent) execution paths.
 *
 * @module x-movcg8io
 * @tag movcg8io
 * @mvp m3-m4
 */

export const X_MOVCG8IO_VERSION = '1.0.0';
export const X_MOVCG8IO_TAG = 'movcg8io';

export interface Movcg8ioConfig {
  /** Unique identifier for this smoke test instance */
  id: string;
  /** Target daemon ID for dispatch verification */
  targetDaemonId: string;
  /** Execution mode: 'm3-fallback' | 'm4-active' */
  mode: 'm3-fallback' | 'm4-active';
  /** Timestamp of execution */
  executedAt: Date;
}

export interface Movcg8ioResult {
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
 * Execute the X-movcg8io smoke test
 */
export function executeMovcg8io(config: Movcg8ioConfig): Movcg8ioResult {
  console.log(`[X-movcg8io] Executing smoke test: ${config.id}`);
  console.log(`[X-movcg8io] Mode: ${config.mode}`);
  console.log(`[X-movcg8io] Target daemon: ${config.targetDaemonId}`);

  // Validate configuration
  if (!config.id || !config.targetDaemonId) {
    throw new Error('X-movcg8io: Invalid configuration - missing required fields');
  }

  // Generate verification token
  const token = `M4OK-${X_MOVCG8IO_TAG}`;

  console.log(`[X-movcg8io] Smoke test completed successfully`);
  console.log(`[X-movcg8io] Token: ${token}`);

  return {
    success: true,
    token,
    metadata: {
      version: X_MOVCG8IO_VERSION,
      tag: X_MOVCG8IO_TAG,
      mode: config.mode,
      timestamp: config.executedAt.toISOString(),
    },
  };
}

/**
 * Verify the smoke test result
 */
export function verifyMovcg8io(result: Movcg8ioResult): boolean {
  const expectedToken = `M4OK-${X_MOVCG8IO_TAG}`;

  if (!result.success) {
    console.error('[X-movcg8io] Verification failed: result indicates failure');
    return false;
  }

  if (result.token !== expectedToken) {
    console.error(`[X-movcg8io] Verification failed: token mismatch`);
    console.error(`  Expected: ${expectedToken}`);
    console.error(`  Actual: ${result.token}`);
    return false;
  }

  if (result.metadata.tag !== X_MOVCG8IO_TAG) {
    console.error(`[X-movcg8io] Verification failed: tag mismatch`);
    return false;
  }

  console.log('[X-movcg8io] Verification passed');
  return true;
}

// Default export for smoke test execution
export default {
  version: X_MOVCG8IO_VERSION,
  tag: X_MOVCG8IO_TAG,
  execute: executeMovcg8io,
  verify: verifyMovcg8io,
};
