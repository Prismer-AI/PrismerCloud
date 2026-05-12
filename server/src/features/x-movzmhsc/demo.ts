/**
 * X-movzmhsc Demo
 *
 * Demonstrates the X-movzmhsc smoke test feature execution.
 */

import { executeMovzmhsc, verifyMovzmhsc, X_MOVZMHSC_TAG } from './index';

console.log('========================================');
console.log('X-movzmhsc MVP M3/M4 Smoke Test Demo');
console.log('========================================\n');

// Demo 1: M4 Active Mode
console.log('--- Demo 1: M4 Active Mode ---');
const m4Result = executeMovzmhsc({
  id: 'cmovznc0o000nxzviz1jdv9j3',
  targetDaemonId: 'daemon-movzmhsc-test',
  mode: 'm4-active',
  executedAt: new Date(),
});

console.log('\nResult:', JSON.stringify(m4Result, null, 2));
console.log('\nVerification:', verifyMovzmhsc(m4Result) ? '✅ PASSED' : '❌ FAILED');

// Demo 2: M3 Fallback Mode
console.log('\n\n--- Demo 2: M3 Fallback Mode ---');
const m3Result = executeMovzmhsc({
  id: 'cmovznc0o000nxzviz1jdv9j3-fallback',
  targetDaemonId: 'daemon-movzmhsc-test',
  mode: 'm3-fallback',
  executedAt: new Date(),
});

console.log('\nResult:', JSON.stringify(m3Result, null, 2));
console.log('\nVerification:', verifyMovzmhsc(m3Result) ? '✅ PASSED' : '❌ FAILED');

// Demo 3: Expected output format
console.log('\n\n--- Demo 3: Expected CEO Response ---');
console.log(`M4OK-${X_MOVZMHSC_TAG}: Engineer completed the deterministic M4 smoke run.`);

console.log('\n========================================');
console.log('Demo completed successfully!');
console.log('========================================');
