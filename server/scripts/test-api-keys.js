/**
 * Test script for API Keys management endpoints
 * 
 * Usage: node scripts/test-api-keys.js
 * 
 * This script tests the full flow:
 * 1. Login to get JWT token
 * 2. Create API Key
 * 3. List API Keys
 * 4. Use API Key for Context API
 */

const crypto = require('crypto');

// Configuration
const BASE_URL = process.env.BASE_URL || 'https://prismer.dev';
const TEST_EMAIL = process.env.TEST_EMAIL || 'test@example.com';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'test123456';

// SHA256 hash password
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
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
  if (body) console.log('Body:', JSON.stringify(body, null, 2));
  
  try {
    const res = await fetch(url, options);
    const data = await res.json();
    
    console.log(`Status: ${res.status}`);
    console.log('Response:', JSON.stringify(data, null, 2));
    
    return { status: res.status, data };
  } catch (error) {
    console.error('Error:', error.message);
    return { status: 0, error: error.message };
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('API Keys Management Test');
  console.log('='.repeat(60));
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Test Email: ${TEST_EMAIL}`);
  
  let jwtToken = null;
  let apiKey = null;
  let keyId = null;
  
  // Step 1: Login to get JWT token
  console.log('\n' + '-'.repeat(60));
  console.log('Step 1: Login to get JWT token');
  console.log('-'.repeat(60));
  
  const loginResult = await request('POST', '/auth/login', {
    email: TEST_EMAIL,
    password: hashPassword(TEST_PASSWORD)
  });
  
  if (loginResult.status === 200 && loginResult.data.token) {
    jwtToken = loginResult.data.token;
    console.log('✅ Login successful, got JWT token');
  } else {
    console.log('❌ Login failed');
    console.log('Note: You may need to register first or use valid credentials');
    return;
  }
  
  // Step 2: List existing API Keys
  console.log('\n' + '-'.repeat(60));
  console.log('Step 2: List existing API Keys');
  console.log('-'.repeat(60));
  
  const listResult = await request('GET', '/cloud/keys', null, jwtToken);
  
  if (listResult.status === 200) {
    console.log(`✅ Found ${listResult.data.data?.length || 0} existing keys`);
  } else {
    console.log('❌ Failed to list keys');
  }
  
  // Step 3: Create new API Key
  console.log('\n' + '-'.repeat(60));
  console.log('Step 3: Create new API Key');
  console.log('-'.repeat(60));
  
  const createResult = await request('POST', '/cloud/keys', {
    label: `Test Key ${Date.now()}`
  }, jwtToken);
  
  if (createResult.status === 201 && createResult.data.data?.key) {
    apiKey = createResult.data.data.key;
    keyId = createResult.data.data.id;
    console.log('✅ Created API Key:', apiKey);
  } else {
    console.log('❌ Failed to create API key');
    return;
  }
  
  // Step 4: Use API Key for Context withdraw
  console.log('\n' + '-'.repeat(60));
  console.log('Step 4: Use API Key for Context withdraw');
  console.log('-'.repeat(60));
  
  const withdrawResult = await request('POST', '/context/withdraw', {
    raw_link: 'https://www.figure.ai/news/helix',
    format: 'hqcc',
    embed: false
  }, apiKey);
  
  if (withdrawResult.status === 200) {
    if (withdrawResult.data.found) {
      console.log('✅ Context found in cache!');
      console.log('HQCC preview:', withdrawResult.data.hqcc_content?.slice(0, 200) + '...');
    } else {
      console.log('✅ Context not in cache (this is expected for new URLs)');
    }
  } else {
    console.log('❌ Context withdraw failed');
  }
  
  // Step 5: Revoke API Key (optional)
  console.log('\n' + '-'.repeat(60));
  console.log('Step 5: Revoke API Key');
  console.log('-'.repeat(60));
  
  if (keyId) {
    const revokeResult = await request('PATCH', `/cloud/keys/${keyId}/revoke`, {
      action: 'revoke'
    }, jwtToken);
    
    if (revokeResult.status === 200) {
      console.log('✅ API Key revoked');
    } else {
      console.log('❌ Failed to revoke key');
    }
  }
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Test Summary');
  console.log('='.repeat(60));
  console.log(`JWT Token: ${jwtToken ? '✅ Obtained' : '❌ Failed'}`);
  console.log(`API Key: ${apiKey ? '✅ Created' : '❌ Failed'}`);
  console.log(`Context API: ${withdrawResult?.status === 200 ? '✅ Working' : '❌ Failed'}`);
}

main().catch(console.error);









