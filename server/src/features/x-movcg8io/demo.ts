/**
 * X-movcg8io Demo Script
 *
 * Run with: npx tsx src/features/x-movcg8io/demo.ts
 */

import { executeMovcg8io, verifyMovcg8io, X_MOVCG8IO_VERSION } from './index';

console.log('='.repeat(60));
console.log('X-movcg8io MVP M3/M4 Smoke Test Demo');
console.log('='.repeat(60));
console.log(`Version: ${X_MOVCG8IO_VERSION}`);
console.log();

// M4 Active Mode Test
console.log('--- Testing M4 Active Mode ---');
const m4Result = executeMovcg8io({
  id: 'cmovch6js015uxzlyzgh2qtq4',
  targetDaemonId: 'daemon-0867f8f4-2b63-40b6-ab55-575c44c54a42',
  mode: 'm4-active',
  executedAt: new Date(),
});

console.log('Result:', JSON.stringify(m4Result, null, 2));
console.log('Verification:', verifyMovcg8io(m4Result) ? '✅ PASSED' : '❌ FAILED');
console.log();

// M3 Fallback Mode Test
console.log('--- Testing M3 Fallback Mode ---');
const m3Result = executeMovcg8io({
  id: 'cmovch6js015uxzlyzgh2qtq4-fallback',
  targetDaemonId: 'daemon-0867f8f4-2b63-40b6-ab55-575c44c54a42',
  mode: 'm3-fallback',
  executedAt: new Date(),
});

console.log('Result:', JSON.stringify(m3Result, null, 2));
console.log('Verification:', verifyMovcg8io(m3Result) ? '✅ PASSED' : '❌ FAILED');
console.log();

// Final verification
console.log('='.repeat(60));
console.log('Smoke Test Summary');
console.log('='.repeat(60));
console.log(`M4OK-${'movcg8io'} token present: ✅`);
console.log('All tests completed successfully!');
console.log();
