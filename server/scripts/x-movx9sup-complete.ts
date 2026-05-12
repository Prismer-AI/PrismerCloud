/**
 * X-movx9sup Task Completion Script
 *
 * This script is executed by Engineer when completing the X-movx9sup work_item.
 * It performs the M3/M4 smoke test and outputs the required M4OK-movx9sup result.
 *
 * Usage: npx tsx scripts/x-movx9sup-complete.ts
 */

import { executeXmovx9supSmoke, completeXmovx9supSync, getXmovx9supMetadata } from '../src/lib/x-movx9sup';

async function main() {
  console.log('🚀 X-movx9sup Task Completion');
  console.log('============================\n');

  // Display metadata
  const metadata = getXmovx9supMetadata();
  console.log('📋 Task Metadata:');
  console.log(`   ID: ${metadata.id}`);
  console.log(`   Title: ${metadata.title}`);
  console.log(`   MVP: ${metadata.mvp}`);
  console.log(`   Engineer: ${metadata.engineerId}`);
  console.log(`   Workspace: ${metadata.workspaceId}`);
  console.log();

  // Execute smoke test
  console.log('🔄 Executing M3/M4 smoke test...\n');

  const result = await executeXmovx9supSmoke({
    assigneeImUserId: metadata.engineerId as string,
    workspaceId: metadata.workspaceId as string,
    conversationId: metadata.conversationId as string,
    taskId: metadata.taskId as string,
  });

  // Output results
  console.log('\n✅ Smoke Test Completed');
  console.log('========================\n');
  console.log('Result:', result.success ? 'SUCCESS' : 'FAILURE');
  console.log('Tag:', result.tag);
  console.log('Mode:', result.mode);
  console.log('Timestamp:', result.timestamp);
  console.log('\n📝 Output:');
  console.log('   ' + result.output);
  console.log();

  // Also show sync completion result
  console.log('🔄 Synchronous completion reference:');
  const syncResult = completeXmovx9supSync();
  console.log('   ' + syncResult.output);

  // Final status
  if (result.success) {
    console.log('\n✅ X-movx9sup task completed successfully');
    console.log('   Verdict: M4OK-movx9sup');
    process.exit(0);
  } else {
    console.log('\n❌ X-movx9sup task failed');
    console.log('   Verdict: M4FAIL-movx9sup');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
