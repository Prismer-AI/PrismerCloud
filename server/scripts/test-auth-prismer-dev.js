/**
 * Auth API tester for prismer.dev based on `src/app/docs/api-requirements.md`.
 *
 * Tests the following endpoints:
 * 1. GitHub OAuth callback        POST /api/v1/auth/cloud/github/callback
 * 2. Google OAuth callback        POST /api/v1/auth/cloud/google/callback
 * 3. Email/password login         POST /api/v1/auth/login
 * 4. Register (sign up)           POST /api/v1/auth/register
 * 5. Send verification code       POST /api/v1/auth/send-code
 * 6. Verify code                  POST /api/v1/auth/verify-code
 * 7. Reset password               POST /api/v1/auth/reset-password
 *
 * Base URL is resolved from Nacos configuration:
 * - APP_ENV=test  -> BACKGROUND_BASE_URL=https://prismer.dev  -> https://prismer.dev/api/v1
 * - APP_ENV=prod  -> BACKGROUND_BASE_URL=https://prismer.app  -> https://prismer.app/api/v1
 *
 * Usage (examples):
 *   # Environment selection (CI will set this automatically)
 *   # export APP_ENV=test        # or prod
 *
 *   # Optional overrides for test data
 *   # export TEST_EMAIL="user@example.com"
 *   # export TEST_PASSWORD="password123"
 *   # export TEST_NEW_PASSWORD="newpassword123"
 *   # export TEST_GITHUB_CODE="mock.github@example.com"
 *   # export TEST_GOOGLE_ACCESS_TOKEN="xxxxxx"
 *
 *   node scripts/test-auth-prismer-dev.js
 */

const https = require('https');
const crypto = require('crypto');
const { NacosConfigClient } = require('nacos');

// This will be resolved from Nacos (e.g. https://prismer.dev/api/v1/)
let BASE_URL = process.env.PRISMER_BASE_URL || '';

// Test credentials (override via env for real testing)
const TEST_EMAIL = process.env.TEST_EMAIL || 'user@example.com';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'password123';
const TEST_NEW_PASSWORD = process.env.TEST_NEW_PASSWORD || 'password123';

// From docs (or override via env if backend expects specific values)
const TEST_GITHUB_CODE =
  process.env.TEST_GITHUB_CODE || 'mock.github@example.com';
const TEST_GOOGLE_ACCESS_TOKEN =
  process.env.TEST_GOOGLE_ACCESS_TOKEN || 'xxxxxx';

/**
 * Load configuration from Nacos based on APP_ENV.
 * Mirrors the logic in src/lib/nacos-config.ts (envNamespaceMap & dataId).
 */
async function loadConfigFromNacos() {
  const appEnv = process.env.APP_ENV || 'test'; // dev 未设置 APP_ENV 时默认走 test

  const envNamespaceMap = {
    prod: 'bd5fb394-7492-440a-9626-9f8a261c500f',
    production: 'bd5fb394-7492-440a-9626-9f8a261c500f',
    test: 'a1ce57f2-0405-45c3-a8b1-35953d1e9aaf',
    dev: 'a49fb6f9-e461-4b2a-aa66-3cccde46126c',
    development: 'a49fb6f9-e461-4b2a-aa66-3cccde46126c',
  };

  const namespace = envNamespaceMap[appEnv] || envNamespaceMap.test;

  let serverAddr =
    process.env.CONFIG_CENTER_IP ||
    process.env.NACOS_SERVER_ADDR ||
    'nacos.prismer.app';

  // nacos client 需要 host:port 形式
  serverAddr = serverAddr.replace(/^https?:\/\//, '');
  if (!serverAddr.includes(':')) {
    // 默认端口 8848
    serverAddr = `${serverAddr}:8848`;
  }

  const username = process.env.NACOS_USERNAME || 'nacos';
  const password = process.env.NACOS_PASSWORD || 'prismer123';

  console.log('Loading Nacos config...', {
    APP_ENV: appEnv,
    serverAddr,
    namespace,
  });

  const client = new NacosConfigClient({
    serverAddr,
    namespace,
    username,
    password,
  });

  // dataId 采用与服务端一致的 prismercloud（兼容大小写）
  const dataIds = ['prismercloud', 'PrismerCloud'];
  let configStr = null;

  for (const dataId of dataIds) {
    try {
      const cfg = await client.getConfig(dataId, 'DEFAULT_GROUP');
      if (cfg && cfg.trim().length > 0) {
        console.log(`Loaded Nacos config for dataId=${dataId}`);
        configStr = cfg;
        break;
      }
    } catch (e) {
      console.warn(`Failed to load Nacos config for dataId=${dataId}:`, e.message);
    }
  }

  if (!configStr || configStr.trim().length === 0) {
    console.warn('⚠️  No Nacos config found, falling back to environment variables only.');
    return {};
  }

  const config = {};
  for (const line of configStr.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();

    // 去掉引号
    if (
      value &&
      (value.startsWith('"') || value.startsWith("'")) &&
      value.endsWith(value[0])
    ) {
      value = value.slice(1, -1);
    } else {
      // 去掉行尾注释
      const commentIdx = value.indexOf('#');
      if (commentIdx >= 0) {
        value = value.substring(0, commentIdx).trim();
      }
    }

    const upperKey = key.toUpperCase();
    config[upperKey] = value;

    // 没有显式环境变量时，同步写入 process.env，保持和服务端行为一致
    if (!process.env[upperKey]) {
      process.env[upperKey] = value;
    }
  }

  return config;
}

/**
 * 根据 Nacos / 环境变量解析后端基础 URL。
 * 目标是得到形如：https://prismer.dev/api/v1 或 https://prismer.app/api/v1
 */
function resolveBackendBase(config) {
  const explicit =
    process.env.BACKEND_API_BASE || config.BACKEND_API_BASE;
  const background =
    process.env.BACKGROUND_BASE_URL || config.BACKGROUND_BASE_URL;

  if (explicit) {
    return explicit.replace(/\/$/, '');
  }

  if (background) {
    const root = background.replace(/\/$/, '');
    if (root.match(/\/api\/v\d+$/)) {
      return root;
    }
    return `${root}/api/v1`;
  }

  // 最后兜底：使用 PRISMER_BASE_URL 或文档中默认的 dev 域名
  const fallback = process.env.PRISMER_BASE_URL || 'https://prismer.dev/api/v1';
  return fallback.replace(/\/$/, '');
}

function hashPassword(plain) {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

function request(method, path, body, options = {}) {
  const url = new URL(path, BASE_URL);
  const data = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(options.headers || {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk.toString();
        });
        res.on('end', () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            // ignore JSON parse errors, just return raw body
          }
          resolve({ status: res.statusCode, body: raw, json });
        });
      }
    );

    req.on('error', (err) => {
      reject(err);
    });

    if (data) {
      req.write(data);
    }
    req.end();
  });
}

function logResponse(title, res) {
  console.log(`\n=== ${title} ===`);
  console.log('Status:', res.status);
  if (!res.body) {
    console.log('<empty body>');
    return;
  }
  const preview = res.body.slice(0, 800);
  try {
    const parsed = JSON.parse(res.body);
    console.log(JSON.stringify(parsed, null, 2).slice(0, 800));
  } catch {
    console.log(preview);
  }
}

async function testGithubLogin() {
  // Cloud Auth 回调：/api/v1/auth/cloud/github/callback
  const path = 'auth/cloud/github/callback';
  const body = {
    code: TEST_GITHUB_CODE,
  };
  const res = await request('POST', path, body);
  logResponse(`GitHub Login (${path})`, res);
  return res.json && res.json.token;
}

async function testGoogleLogin() {
  // Cloud Auth 回调：/api/v1/auth/cloud/google/callback
  const path = 'auth/cloud/google/callback';
  const body = {
    access_token: TEST_GOOGLE_ACCESS_TOKEN,
  };
  const res = await request('POST', path, body);
  logResponse(`Google Login (${path})`, res);
  return res.json && res.json.token;
}

async function testPasswordLogin() {
  const path = 'auth/login';
  const body = {
    email: TEST_EMAIL,
    password: hashPassword(TEST_PASSWORD),
  };
  const res = await request('POST', path, body);
  logResponse(`Password Login (${path})`, res);
  return res.json && res.json.token;
}

async function testSendCode(type) {
  const path = 'auth/send-code';
  const body = {
    email: TEST_EMAIL,
    type,
  };
  const res = await request('POST', path, body);
  logResponse(`Send Code (${type}) (${path})`, res);
  const codeFromResponse =
    res.json && res.json.verification_code
      ? String(res.json.verification_code)
      : null;
  return codeFromResponse;
}

async function testVerifyCode(code, type) {
  const path = 'auth/verify-code';
  const body = {
    email: TEST_EMAIL,
    code,
    type,
  };
  const res = await request('POST', path, body);
  logResponse(`Verify Code (${type}) (${path})`, res);
  return res;
}

async function testRegister(code) {
  const path = 'auth/register';
  const body = {
    email: TEST_EMAIL,
    password: hashPassword(TEST_PASSWORD),
    confirm_password: hashPassword(TEST_PASSWORD),
    code,
  };
  const res = await request('POST', path, body);
  logResponse(`Register (${path})`, res);
  return res.json && res.json.token;
}

async function testResetPassword(code) {
  const path = 'auth/reset-password';
  const body = {
    email: TEST_EMAIL,
    code,
    password: hashPassword(TEST_NEW_PASSWORD),
    confirm_password: hashPassword(TEST_NEW_PASSWORD),
  };
  const res = await request('POST', path, body);
  logResponse(`Reset Password (${path})`, res);
  return res;
}

async function main() {
  const nacosConfig = await loadConfigFromNacos();
  const backendBase = resolveBackendBase(nacosConfig);
  // Ensure BASE_URL ends with trailing slash so relative paths work
  BASE_URL = backendBase.replace(/\/$/, '') + '/';

  console.log(
    `Testing backend auth API base URL (from Nacos/env): ${BASE_URL}`
  );
  console.log('Environment:');
  console.log('  APP_ENV:', process.env.APP_ENV || 'test (default)');
  console.log('  BACKGROUND_BASE_URL:', process.env.BACKGROUND_BASE_URL);
  console.log('  BACKEND_API_BASE:', process.env.BACKEND_API_BASE);
  console.log();

  console.log('Test user/email configuration:');
  console.log('  TEST_EMAIL:', TEST_EMAIL);
  console.log('  TEST_PASSWORD (plain):', TEST_PASSWORD);
  console.log('  TEST_NEW_PASSWORD (plain):', TEST_NEW_PASSWORD);
  console.log();

  try {
    // 1. OAuth logins
    await testGithubLogin().catch((err) =>
      console.error('GitHub login error:', err.message)
    );
    await testGoogleLogin().catch((err) =>
      console.error('Google login error:', err.message)
    );

    // 2. Password login
    await testPasswordLogin().catch((err) =>
      console.error('Password login error:', err.message)
    );

    // 3. Signup flow (send-code -> register -> verify-code)
    const signupCode =
      (await testSendCode('signup')) ||
      '123456'; // fallback to example code from docs
    console.log('\nUsing signup code:', signupCode);

    await testRegister(signupCode).catch((err) =>
      console.error('Register error:', err.message)
    );

    await testVerifyCode(signupCode, 'signup').catch((err) =>
      console.error('Verify signup code error:', err.message)
    );

    // 4. Reset password flow (send-code -> verify-code -> reset-password)
    const resetCode =
      (await testSendCode('reset-password')) ||
      '123456'; // fallback to example code from docs
    console.log('\nUsing reset-password code:', resetCode);

    await testVerifyCode(resetCode, 'reset-password').catch((err) =>
      console.error('Verify reset-password code error:', err.message)
    );

    await testResetPassword(resetCode).catch((err) =>
      console.error('Reset password error:', err.message)
    );
  } catch (err) {
    console.error('\nUnexpected error in tests:', err);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});


