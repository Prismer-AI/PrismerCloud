/**
 * Billing API tester for prismer.services
 * Tests Alipay payment integration endpoints
 */

const https = require('https');
const crypto = require('crypto');

const BASE_URL = 'https://prismer.services/api/v1';

// Generate unique test email to avoid conflicts
const timestamp = Date.now();
const TEST_EMAIL = process.env.TEST_EMAIL || `billing-test-${timestamp}@prismer.io`;
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'Test123456!';

function hashPassword(plain) {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

function request(method, path, body, token = null) {
  const url = new URL(path, BASE_URL + '/');
  const data = body ? JSON.stringify(body) : null;

  const headers = {
    'Content-Type': 'application/json',
    ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method, headers },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk.toString(); });
        res.on('end', () => {
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch {}
          resolve({ status: res.statusCode, body: raw, json });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function log(title, res) {
  console.log(`\n=== ${title} ===`);
  console.log('Status:', res.status);
  if (res.json) {
    console.log(JSON.stringify(res.json, null, 2).slice(0, 1500));
  } else {
    console.log(res.body?.slice(0, 500) || '<empty>');
  }
}

async function sendCode(email, type = 'signup') {
  console.log(`Sending ${type} code to:`, email);
  const res = await request('POST', 'auth/send-code', {
    email,
    type,
  });
  log('Send Code', res);
  // Backend may return verification_code in test mode
  return res.json?.verification_code || res.json?.code || '123456';
}

async function register(email, password, code) {
  console.log('Registering:', email);
  const res = await request('POST', 'auth/register', {
    email,
    password: hashPassword(password),
    confirm_password: hashPassword(password),
    code,
  });
  log('Register', res);
  return res.json?.token;
}

async function login(email, password) {
  console.log('Logging in with:', email);
  const res = await request('POST', 'auth/login', {
    email,
    password: hashPassword(password),
  });
  log('Login', res);
  if (res.json?.token) {
    console.log('\n✅ Login successful!');
    return res.json.token;
  }
  return null;
}

async function testGetPaymentMethods(token) {
  const res = await request('GET', 'cloud/billing/payment-methods', null, token);
  log('GET Payment Methods', res);
  return res;
}

async function testAddAlipay(token) {
  const res = await request('POST', 'cloud/billing/payment-methods', {
    type: 'alipay',
    return_url: 'https://cloud.prismer.dev/dashboard#billing'
  }, token);
  log('POST Add Alipay', res);
  return res;
}

async function testAddCard(token) {
  const res = await request('POST', 'cloud/billing/payment-methods', {
    type: 'card'
  }, token);
  log('POST Add Card', res);
  return res;
}

async function testGetInvoices(token) {
  const res = await request('GET', 'cloud/billing/invoices', null, token);
  log('GET Invoices', res);
  return res;
}

async function main() {
  console.log('Testing Billing API on:', BASE_URL);
  console.log('Test Email:', TEST_EMAIL);
  console.log('='.repeat(50));

  try {
    let token;
    
    // Try login first
    token = await login(TEST_EMAIL, TEST_PASSWORD);
    
    // If login fails, try to register
    if (!token) {
      console.log('\nLogin failed, trying to register...');
      const code = await sendCode(TEST_EMAIL, 'signup');
      console.log('Using code:', code);
      token = await register(TEST_EMAIL, TEST_PASSWORD, code);
    }
    
    if (!token) {
      throw new Error('Could not obtain auth token');
    }
    
    console.log('\n' + '='.repeat(50));
    console.log('Testing Billing Endpoints...');
    console.log('='.repeat(50));

    await testGetPaymentMethods(token);
    await testGetInvoices(token);
    
    console.log('\n--- Testing Add Payment Methods ---');
    const alipayRes = await testAddAlipay(token);
    if (alipayRes.json?.success && alipayRes.json?.data?.redirect_url) {
      console.log('\n✅ Alipay setup successful! Redirect URL:', alipayRes.json.data.redirect_url.slice(0, 80) + '...');
    }
    
    const cardRes = await testAddCard(token);
    if (cardRes.json?.success && cardRes.json?.data?.client_secret) {
      console.log('\n✅ Card setup successful! Client secret obtained.');
    }

    console.log('\n' + '='.repeat(50));
    console.log('✅ All tests completed!');
  } catch (err) {
    console.error('\n❌ Test failed:', err.message);
    process.exitCode = 1;
  }
}

main();
