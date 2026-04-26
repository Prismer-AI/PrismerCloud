#!/usr/bin/env node

/**
 * Test deposit / withdraw backend APIs directly
 *
 * Backend endpoints:
 *   POST /api/v1/cloud/context/withdraw  - 查缓存
 *   POST /api/v1/cloud/context/deposit   - 存缓存
 *
 * Usage:
 *   BASE_URL=https://prismer.services/api/v1 node scripts/test-deposit-withdraw.js
 *   # Or with API key (no login):
 *   BASE_URL=https://prismer.services/api/v1 PRISMER_API_KEY=sk-prismer-live-xxx node scripts/test-deposit-withdraw.js
 *   # Or login (need TEST_EMAIL, TEST_PASSWORD):
 *   BASE_URL=https://prismer.services/api/v1 node scripts/test-deposit-withdraw.js
 */

const crypto = require('crypto');

const BASE_URL = (process.env.BASE_URL || process.env.BACKEND_API_BASE || 'https://prismer.services/api/v1').replace(/\/$/, '');
const API_KEY = process.env.PRISMER_API_KEY;
const TEST_EMAIL = process.env.TEST_EMAIL || 'test@example.com';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'test123456';

const TEST_URL = 'https://www.figure.ai/news/helix';
const TEST_HQCC = '[TEST] Compressed content snippet for deposit/withdraw test. ' + new Date().toISOString();

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

async function request(method, path, body = null, token = null) {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  console.log(`\n${method} ${url}`);
  if (body) console.log('Body:', JSON.stringify(body, null, 2).slice(0, 500) + (JSON.stringify(body).length > 500 ? '...' : ''));

  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _raw: text };
  }
  console.log(`Status: ${res.status}`);
  console.log('Response:', JSON.stringify(data, null, 2).slice(0, 800) + (text.length > 800 ? '...' : ''));
  return { status: res.status, data };
}

async function login() {
  const r = await request('POST', '/auth/login', {
    email: TEST_EMAIL,
    password: hashPassword(TEST_PASSWORD),
  });
  if (r.status === 200 && r.data?.token) return r.data.token;
  return null;
}

async function main() {
  console.log('='.repeat(60));
  console.log('Deposit / Withdraw Backend API Test');
  console.log('='.repeat(60));
  console.log('BASE_URL:', BASE_URL);
  console.log('TEST_URL:', TEST_URL);

  let token = API_KEY || null;
  if (!token) {
    console.log('\nNo PRISMER_API_KEY, trying login...');
    token = await login();
    if (!token) {
      console.log('❌ Need PRISMER_API_KEY or valid TEST_EMAIL/TEST_PASSWORD');
      process.exit(1);
    }
    console.log('✅ Got JWT token');
  } else {
    console.log('✅ Using PRISMER_API_KEY');
  }

  // 1. Withdraw (cache miss expected first time)
  console.log('\n' + '-'.repeat(60));
  console.log('1. POST /cloud/context/withdraw');
  console.log('-'.repeat(60));
  const withdraw1 = await request('POST', '/cloud/context/withdraw', {
    raw_link: TEST_URL,
    format: 'hqcc',
    embed: false,
  }, token);

  if (withdraw1.status !== 200) {
    console.log('❌ Withdraw failed');
    process.exit(1);
  }
  console.log(withdraw1.data?.found ? '✅ Cache HIT' : '✅ Cache MISS (expected if not deposited yet)');

  // 2. Deposit
  console.log('\n' + '-'.repeat(60));
  console.log('2. POST /cloud/context/deposit');
  console.log('-'.repeat(60));
  const deposit = await request('POST', '/cloud/context/deposit', {
    raw_link: TEST_URL,
    hqcc_content: TEST_HQCC,
    intr_content: 'Optional raw text for indexing.',
    visibility: 'private',
    meta: { strategy: 'auto', model: 'test', source: 'test-script' },
  }, token);

  if (deposit.status !== 200 && deposit.status !== 201) {
    console.log('❌ Deposit failed');
    if (deposit.data?.error) console.log('Error:', deposit.data.error);
    process.exit(1);
  }
  console.log('✅ Deposit success');

  // 3. Withdraw again (cache hit expected)
  console.log('\n' + '-'.repeat(60));
  console.log('3. POST /cloud/context/withdraw (again, expect cache hit)');
  console.log('-'.repeat(60));
  const withdraw2 = await request('POST', '/cloud/context/withdraw', {
    raw_link: TEST_URL,
    format: 'hqcc',
    embed: false,
  }, token);

  if (withdraw2.status !== 200) {
    console.log('❌ Withdraw failed');
    process.exit(1);
  }
  const hit = withdraw2.data?.found === true;
  console.log(hit ? '✅ Cache HIT' : '⚠️ Cache MISS (backend may not have saved or key mismatch)');
  if (hit && withdraw2.data?.hqcc_content) {
    console.log('HQCC preview:', String(withdraw2.data.hqcc_content).slice(0, 120) + '...');
  }

  // 4. Withdraw batch (v7.3: uses 'inputs' instead of 'raw_links')
  console.log('\n' + '-'.repeat(60));
  console.log('4. POST /cloud/context/withdraw/batch');
  console.log('-'.repeat(60));
  const batchWithdraw = await request('POST', '/cloud/context/withdraw/batch', {
    inputs: [TEST_URL, 'https://example.com/not-cached'],
    format: 'hqcc',
  }, token);

  if (batchWithdraw.status !== 200) {
    console.log('❌ Batch withdraw failed');
  } else {
    console.log('✅ Batch withdraw OK');
    const results = batchWithdraw.data?.results || batchWithdraw.data?.data || [];
    if (Array.isArray(results)) {
      results.forEach((r, i) => {
        console.log(`  [${i}] found=${r.found} url=${(r.raw_link || r.url || '?').slice(0, 50)}`);
      });
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log('Withdraw:    ', withdraw1.status === 200 ? '✅' : '❌');
  console.log('Deposit:     ', deposit.status === 200 || deposit.status === 201 ? '✅' : '❌');
  console.log('Withdraw 2:  ', withdraw2.status === 200 ? '✅' : '❌', hit ? '(cache hit)' : '(miss)');
  console.log('Batch withdraw:', batchWithdraw.status === 200 ? '✅' : '❌');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
