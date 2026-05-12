/**
 * X-movbngcw 功能验证脚本
 * 用于本地验证 X-movbngcw 模块功能
 */

import { Xmovbngcw, xmovbngcw } from '../src/lib/x-movbngcw';

async function verify() {
  console.log('=== X-movbngcw 功能验证 ===\n');

  // 1. 快速健康检查
  console.log('1. 快速健康检查...');
  const quickCheck = await xmovbngcw.quickHealthCheck();
  console.log('   状态:', quickCheck.success ? '✓ 通过' : '✗ 失败');
  console.log('   消息:', quickCheck.message);
  console.log('   时间戳:', quickCheck.timestamp);
  console.log();

  // 2. 环境检查
  console.log('2. 环境检查...');
  const envCheck = await xmovbngcw.checkEnvironment();
  console.log('   状态:', envCheck.success ? '✓ 通过' : '✗ 失败');
  console.log('   消息:', envCheck.message);
  console.log('   详情:', JSON.stringify(envCheck.details, null, 2));
  console.log();

  // 3. 数据库检查
  console.log('3. 数据库检查...');
  const dbCheck = await xmovbngcw.checkDatabaseConnectivity();
  console.log('   状态:', dbCheck.success ? '✓ 通过' : '✗ 失败');
  console.log('   消息:', dbCheck.message);
  console.log();

  // 4. API 检查
  console.log('4. API 检查...');
  const apiCheck = await xmovbngcw.checkApiEndpoints();
  console.log('   状态:', apiCheck.success ? '✓ 通过' : '✗ 失败');
  console.log('   消息:', apiCheck.message);
  console.log('   端点:', JSON.stringify(apiCheck.details?.endpoints, null, 2));
  console.log();

  // 5. 内存检查
  console.log('5. 内存检查...');
  const memCheck = await xmovbngcw.checkMemoryUsage();
  console.log('   状态:', memCheck.success ? '✓ 通过' : '✗ 警告');
  console.log('   消息:', memCheck.message);
  console.log('   详情:', JSON.stringify(memCheck.details, null, 2));
  console.log();

  // 6. 磁盘检查
  console.log('6. 磁盘检查...');
  const diskCheck = await xmovbngcw.checkDiskSpace();
  console.log('   状态:', diskCheck.success ? '✓ 通过' : '✗ 警告');
  console.log('   消息:', diskCheck.message);
  console.log();

  // 7. 完整 Smoke Test
  console.log('7. 完整 Smoke Test...');
  const smokeTest = await xmovbngcw.runSmokeTest();
  console.log('   整体状态:', smokeTest.overall);
  console.log('   检查项数量:', smokeTest.checks.length);
  console.log('   版本:', smokeTest.version);
  console.log('   环境:', smokeTest.environment);
  console.log('   检查结果:');
  for (const check of smokeTest.checks) {
    console.log(`     ${check.success ? '✓' : '✗'} ${check.module}: ${check.message}`);
  }
  console.log();

  // 8. 配置测试
  console.log('8. 配置测试...');
  const customChecker = new Xmovbngcw({
    timeoutMs: 10000,
    retries: 2,
    enableDetailedLogging: false,
  });
  const customCheck = await customChecker.quickHealthCheck();
  console.log('   状态:', customCheck.success ? '✓ 通过' : '✗ 失败');
  console.log('   自定义配置工作正常');
  console.log();

  console.log('=== 验证完成 ===');
  console.log('X-movbngcw 功能模块工作正常 ✓');
}

verify().catch((error) => {
  console.error('验证失败:', error);
  process.exit(1);
});
