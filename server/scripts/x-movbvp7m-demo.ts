#!/usr/bin/env tsx
/**
 * X-movbvp7m 功能演示脚本
 *
 * 用于演示和验证 X-movbvp7m 模块功能
 */

import { Xmovbvp7m, xmovbvp7m } from '../src/lib/x-movbvp7m';

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════════════╕');
  console.log('║           X-movbvp7m Smoke Test Demo                       ║');
  console.log('║           M3/M4 MVP Health Check Module                    ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝\n');

  // 1. 快速健康检查
  console.log('▶ Running Quick Health Check...');
  const quickCheck = await xmovbvp7m.quickHealthCheck();
  console.log(`  Status: ${quickCheck.success ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  Message: ${quickCheck.message}`);
  console.log(`  Duration: ${quickCheck.durationMs}ms\n`);

  // 2. 单项检查
  console.log('▶ Running Individual Checks...\n');

  const envCheck = await xmovbvp7m.checkEnvironment();
  console.log(`  🖥️  Environment: ${envCheck.success ? '✅' : '❌'} ${envCheck.message}`);
  console.log(`     Details: Node ${envCheck.details?.nodeVersion}, ${envCheck.details?.platform}\n`);

  const dbCheck = await xmovbvp7m.checkDatabaseConnectivity();
  console.log(`  🗄️  Database: ${dbCheck.success ? '✅' : '❌'} ${dbCheck.message}`);
  console.log(`     Latency: ${dbCheck.details?.latencyMs}ms\n`);

  const apiCheck = await xmovbvp7m.checkApiEndpoints();
  console.log(`  🌐 API Endpoints: ${apiCheck.success ? '✅' : '❌'} ${apiCheck.message}`);
  console.log(`     Endpoints checked: ${(apiCheck.details?.endpoints as Array<unknown>)?.length || 0}\n`);

  const memoryCheck = await xmovbvp7m.checkMemoryUsage();
  console.log(`  🧠 Memory: ${memoryCheck.success ? '✅' : '❌'} ${memoryCheck.message}`);
  console.log(`     Heap: ${memoryCheck.details?.heapUsedMB}MB / ${memoryCheck.details?.heapTotalMB}MB\n`);

  const diskCheck = await xmovbvp7m.checkDiskSpace();
  console.log(`  💾 Disk: ${diskCheck.success ? '✅' : '❌'} ${diskCheck.message}`);
  console.log(`     Free: ${diskCheck.details?.freeSpaceGB}GB\n`);

  // 3. 完整 Smoke Test
  console.log('▶ Running Full Smoke Test Suite...\n');
  const fullCheck = await xmovbvp7m.runSmokeTest();

  console.log(`  Overall Status: ${fullCheck.overall.toUpperCase()}`);
  console.log(`  Environment: ${fullCheck.environment}`);
  console.log(`  Version: ${fullCheck.version}`);
  console.log(`  Timestamp: ${fullCheck.timestamp}`);
  console.log(`  Checks performed: ${fullCheck.checks.length}`);
  console.log(`  Passed: ${fullCheck.checks.filter((c) => c.success).length}`);
  console.log(`  Failed: ${fullCheck.checks.filter((c) => !c.success).length}\n`);

  // 详细检查结果
  console.log('▶ Detailed Check Results:');
  fullCheck.checks.forEach((check, index) => {
    const icon = check.success ? '✅' : '❌';
    console.log(`  ${index + 1}. ${icon} [${check.module}] ${check.message} (${check.durationMs}ms)`);
  });

  console.log('\n════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('  X-movbvp7m Demo Complete');
  console.log('  M4OK-movbvp7m');
  console.log('════════════════════════════════════════════════════════════════════════════════════════════════');

  // 返回退出码
  process.exit(fullCheck.overall === 'unhealthy' ? 1 : 0);
}

main().catch((error) => {
  console.error('❌ Demo failed:', error);
  process.exit(1);
});
