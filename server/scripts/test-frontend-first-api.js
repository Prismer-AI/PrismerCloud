#!/usr/bin/env node
/**
 * 测试前端先行实现的 API
 * 
 * 测试项目：
 * 1. POST /api/usage/record - 写入使用记录
 * 2. GET /api/activities - 读取活动列表
 * 3. GET /api/dashboard/stats - 获取统计数据
 */

const BASE_URL = process.env.API_BASE || 'http://localhost:3000';

// 你需要一个有效的 JWT token 来测试
// 可以从浏览器 localStorage 的 prismer_auth 中获取
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

async function testUsageRecord() {
  console.log('\n=== 测试 POST /api/usage/record ===');
  
  const taskId = `test_task_${Date.now()}`;
  const body = {
    task_id: taskId,
    task_type: 'load',
    input: {
      type: 'url',
      value: 'https://example.com/test'
    },
    metrics: {
      urls_processed: 1,
      urls_cached: 0,
      urls_compressed: 1,
      tokens_output: 5000,
      processing_time_ms: 2500
    },
    cost: {
      compression_credits: 0.5,
      total_credits: 0.5
    },
    sources: [
      { url: 'https://example.com/test', cached: false, tokens: 5000 }
    ]
  };
  
  try {
    const res = await fetch(`${BASE_URL}/api/usage/record`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AUTH_TOKEN}`
      },
      body: JSON.stringify(body)
    });
    
    const data = await res.json();
    console.log(`Status: ${res.status}`);
    console.log('Response:', JSON.stringify(data, null, 2));
    
    return { success: res.ok, taskId };
  } catch (error) {
    console.error('Error:', error.message);
    return { success: false };
  }
}

async function testActivities() {
  console.log('\n=== 测试 GET /api/activities ===');
  
  try {
    const res = await fetch(`${BASE_URL}/api/activities?page=1&limit=10`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`
      }
    });
    
    const data = await res.json();
    console.log(`Status: ${res.status}`);
    console.log('Response:', JSON.stringify(data, null, 2));
    
    return { success: res.ok };
  } catch (error) {
    console.error('Error:', error.message);
    return { success: false };
  }
}

async function testDashboardStats() {
  console.log('\n=== 测试 GET /api/dashboard/stats ===');
  
  try {
    const res = await fetch(`${BASE_URL}/api/dashboard/stats?period=7d`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`
      }
    });
    
    const data = await res.json();
    console.log(`Status: ${res.status}`);
    console.log('Response:', JSON.stringify(data, null, 2));
    
    return { success: res.ok };
  } catch (error) {
    console.error('Error:', error.message);
    return { success: false };
  }
}

async function main() {
  console.log('========================================');
  console.log('前端先行 API 测试');
  console.log('========================================');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Auth Token: ${AUTH_TOKEN ? AUTH_TOKEN.substring(0, 20) + '...' : '(未设置)'}`);
  
  if (!AUTH_TOKEN) {
    console.log('\n⚠️  警告: AUTH_TOKEN 未设置');
    console.log('请设置环境变量 AUTH_TOKEN 为有效的 JWT token');
    console.log('例如: AUTH_TOKEN=eyJhbGc... node scripts/test-frontend-first-api.js');
    console.log('\n继续测试（将返回 401 错误）...');
  }
  
  // 运行测试
  const results = {
    usageRecord: await testUsageRecord(),
    activities: await testActivities(),
    dashboardStats: await testDashboardStats()
  };
  
  // 汇总
  console.log('\n========================================');
  console.log('测试结果汇总');
  console.log('========================================');
  console.log(`Usage Record: ${results.usageRecord.success ? '✅ 成功' : '❌ 失败'}`);
  console.log(`Activities: ${results.activities.success ? '✅ 成功' : '❌ 失败'}`);
  console.log(`Dashboard Stats: ${results.dashboardStats.success ? '✅ 成功' : '❌ 失败'}`);
}

main().catch(console.error);
