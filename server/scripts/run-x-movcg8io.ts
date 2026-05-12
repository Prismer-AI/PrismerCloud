/**
 * Run X-movcg8io Smoke Test
 * Entry point for executing the MVP M3/M4 smoke test
 */

import { executeXmovcg8io } from '../src/lib/features/x-movcg8io';

async function main() {
  console.log('Starting X-movcg8io smoke test...\n');

  const result = executeXmovcg8io();

  console.log('\n--- Result ---');
  console.log(JSON.stringify(result, null, 2));

  // Output the completion token for task verification
  process.stdout.write('\n' + result.output + '\n');

  process.exit(0);
}

main().catch((error) => {
  console.error('X-movcg8io execution failed:', error);
  process.exit(1);
});
