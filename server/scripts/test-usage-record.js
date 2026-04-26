/**
 * Test script for Usage Record & Dashboard APIs
 * 
 * Tests the newly implemented backend endpoints:
 * - POST /api/v1/cloud/usage/record
 * - GET /api/v1/cloud/activities
 * - GET /api/v1/cloud/dashboard/stats
 * 
 * Usage: 
 *   node scripts/test-usage-record.js
 * 
 * Environment variables:
 *   BASE_URL - Backend base URL (default: https://prismer.services)
 *   TEST_EMAIL - Test user email
 *   TEST_PASSWORD - Test user password
 */

const crypto = require('crypto');

// Configuration - using prismer.services as test environment
const BASE_URL = process.env.BASE_URL || 'https://prismer.services';
const TEST_EMAIL = process.env.TEST_EMAIL || 'test@example.com';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'test123456';

// SHA256 hash password
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Generate unique task ID
function generateTaskId() {
  const timestamp = Date.now();
  const random = crypto.randomBytes(6).toString('hex');
  return `task_${timestamp}_${random}`;
}

// Helper to make requests
async function request(method, endpoint, body = null, token = null) {
  const url = `${BASE_URL}/api/v1${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  const options = {
    method,
    headers,
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  console.log(`\n${method} ${url}`);
  if (body) {
    console.log('Body:', JSON.stringify(body, null, 2).slice(0, 500));
  }
  
  try {
    const res = await fetch(url, options);
    const text = await res.text();
    let data = null;
    
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 500) };
    }
    
    console.log(`Status: ${res.status}`);
    console.log('Response:', JSON.stringify(data, null, 2).slice(0, 1000));
    
    return { status: res.status, data };
  } catch (error) {
    console.error('Error:', error.message);
    return { status: 0, error: error.message };
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('Usage Record & Dashboard API Test');
  console.log('='.repeat(60));
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Test Email: ${TEST_EMAIL}`);
  console.log();
  
  let jwtToken = null;
  
  // Step 1: Login to get JWT token
  console.log('\n' + '-'.repeat(60));
  console.log('Step 1: Login to get JWT token');
  console.log('-'.repeat(60));
  
  const loginResult = await request('POST', '/auth/login', {
    email: TEST_EMAIL,
    password: hashPassword(TEST_PASSWORD)
  });
  
  if (loginResult.status === 200 && loginResult.data?.token) {
    jwtToken = loginResult.data.token;
    console.log('✅ Login successful, got JWT token');
  } else {
    console.log('❌ Login failed');
    console.log('Trying with API key from environment...');
    jwtToken = process.env.TEST_API_KEY;
    if (!jwtToken) {
      console.log('No API key available. Please set TEST_EMAIL/TEST_PASSWORD or TEST_API_KEY');
      return;
    }
  }
  
  // Step 2: Test GET /cloud/dashboard/stats
  console.log('\n' + '-'.repeat(60));
  console.log('Step 2: GET /api/v1/cloud/dashboard/stats');
  console.log('-'.repeat(60));
  
  const statsResult = await request('GET', '/cloud/dashboard/stats?period=7d', null, jwtToken);
  
  if (statsResult.status === 200 && statsResult.data?.success) {
    console.log('✅ Dashboard stats retrieved successfully');
    if (statsResult.data.data) {
      console.log('  - Chart data points:', statsResult.data.data.chartData?.length || 0);
      console.log('  - Monthly requests:', statsResult.data.data.monthlyRequests);
      console.log('  - Cache hit rate:', statsResult.data.data.cacheHitRate);
      console.log('  - Credits remaining:', statsResult.data.data.creditsRemaining);
    }
  } else {
    console.log('❌ Dashboard stats failed or returned unexpected format');
  }
  
  // Step 3: Test GET /cloud/activities
  console.log('\n' + '-'.repeat(60));
  console.log('Step 3: GET /api/v1/cloud/activities');
  console.log('-'.repeat(60));
  
  const activitiesResult = await request('GET', '/cloud/activities?page=1&limit=10', null, jwtToken);
  
  if (activitiesResult.status === 200 && activitiesResult.data?.success) {
    console.log('✅ Activities retrieved successfully');
    const activities = activitiesResult.data.data || [];
    console.log(`  - Total activities: ${activities.length}`);
    if (activities.length > 0) {
      console.log('  - First activity:', JSON.stringify(activities[0], null, 2).slice(0, 300));
    }
    if (activitiesResult.data.pagination) {
      console.log('  - Pagination:', JSON.stringify(activitiesResult.data.pagination));
    }
  } else {
    console.log('❌ Activities failed or returned unexpected format');
  }
  
  // Step 4: Test POST /cloud/usage/record
  console.log('\n' + '-'.repeat(60));
  console.log('Step 4: POST /api/v1/cloud/usage/record');
  console.log('-'.repeat(60));
  
  const taskId = generateTaskId();
  const usageRecordBody = {
    task_id: taskId,
    task_type: 'agent_ingest',
    input: {
      type: 'query',
      value: 'test query from usage record test script'
    },
    metrics: {
      exa_searches: 1,
      urls_processed: 5,
      urls_cached: 3,
      urls_compressed: 2,
      tokens_input: 10000,
      tokens_output: 1500,
      processing_time_ms: 5000
    },
    cost: {
      search_credits: 1.0,
      compression_credits: 1.15,
      total_credits: 2.15
    },
    sources: [
      { url: 'https://example.com/page1', cached: true, tokens: 0 },
      { url: 'https://example.com/page2', cached: false, tokens: 5000 }
    ]
  };
  
  const usageResult = await request('POST', '/cloud/usage/record', usageRecordBody, jwtToken);
  
  if (usageResult.status === 200 || usageResult.status === 201) {
    if (usageResult.data?.success) {
      console.log('✅ Usage record created successfully');
      if (usageResult.data.data) {
        console.log('  - Record ID:', usageResult.data.data.record_id);
        console.log('  - Credits deducted:', usageResult.data.data.credits_deducted);
        console.log('  - Credits remaining:', usageResult.data.data.credits_remaining);
      }
    } else {
      console.log('⚠️  Usage record returned but success=false');
    }
  } else {
    console.log('❌ Usage record failed');
  }
  
  // Step 5: Verify the record appears in activities
  console.log('\n' + '-'.repeat(60));
  console.log('Step 5: Verify record in activities');
  console.log('-'.repeat(60));
  
  // Wait a moment for the record to be persisted
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const verifyResult = await request('GET', '/cloud/activities?page=1&limit=5', null, jwtToken);
  
  if (verifyResult.status === 200 && verifyResult.data?.success) {
    const activities = verifyResult.data.data || [];
    const found = activities.find(a => a.id === taskId || a.task_id === taskId);
    if (found) {
      console.log('✅ Record found in activities!');
      console.log('  - Activity:', JSON.stringify(found, null, 2));
    } else {
      console.log('⚠️  Record not found in recent activities (may need more time to sync)');
      console.log('  - Looking for task_id:', taskId);
    }
  } else {
    console.log('❌ Failed to verify activities');
  }
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Test Summary');
  console.log('='.repeat(60));
  console.log(`Login: ${jwtToken ? '✅ Success' : '❌ Failed'}`);
  console.log(`Dashboard Stats (GET /cloud/dashboard/stats): ${statsResult?.status === 200 ? '✅ Working' : '❌ Failed'}`);
  console.log(`Activities (GET /cloud/activities): ${activitiesResult?.status === 200 ? '✅ Working' : '❌ Failed'}`);
  console.log(`Usage Record (POST /cloud/usage/record): ${[200, 201].includes(usageResult?.status) ? '✅ Working' : '❌ Failed'}`);
}

main().catch(console.error);
