#!/usr/bin/env node

/**
 * Prismer Cloud New Context API - Local Test Suite
 * 
 * 完整测试新的 /api/context/load 和 /api/context/save API
 * 
 * Usage:
 *   node scripts/test-new-api-local.js
 *   node scripts/test-new-api-local.js --base http://localhost:3000
 */

const API_BASE = process.argv.includes('--base') 
  ? process.argv[process.argv.indexOf('--base') + 1]
  : 'http://localhost:3000';

const API_KEY = process.env.PRISMER_API_KEY || 'sk-prismer-test-local-key-for-testing-purposes-only-32chars';

console.log('');
console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║     Prismer Cloud New Context API - Local Test Suite          ║');
console.log('╚════════════════════════════════════════════════════════════════╝');
console.log('');
console.log(`API Base: ${API_BASE}`);
console.log(`API Key:  ${API_KEY.slice(0, 30)}...`);
console.log('');

// Test results collector
const results = [];

function logTest(name, passed, details = '') {
  const status = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${status}: ${name}`);
  if (details) console.log(`       ${details}`);
  results.push({ name, passed, details });
}

async function makeRequest(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const startTime = Date.now();
  
  try {
    const response = await fetch(url, {
      method: options.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options.auth !== false ? { 'Authorization': `Bearer ${API_KEY}` } : {}),
        ...options.headers
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    const elapsed = Date.now() - startTime;
    let data;
    const contentType = response.headers.get('content-type');
    
    if (contentType?.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    return {
      ok: response.ok,
      status: response.status,
      data,
      elapsed,
      headers: Object.fromEntries(response.headers.entries())
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error.message,
      elapsed: Date.now() - startTime
    };
  }
}

// ==================== Load API Tests ====================

async function testLoadSingleUrl() {
  console.log('\n📦 Testing Load API - Single URL Mode');
  console.log('─'.repeat(50));

  // Test 1: Valid URL input
  const res1 = await makeRequest('/api/context/load', {
    body: { input: 'https://www.figure.ai/news/helix' }
  });
  logTest(
    'Load single URL - basic request',
    res1.ok && res1.data?.mode === 'single_url',
    `Status: ${res1.status}, Mode: ${res1.data?.mode}, Elapsed: ${res1.elapsed}ms`
  );

  // Test 2: With format option
  const res2 = await makeRequest('/api/context/load', {
    body: { 
      input: 'https://arxiv.org/html/2310.05400v1',
      return: { format: 'both' }
    }
  });
  logTest(
    'Load single URL - with format option',
    res2.ok,
    `Status: ${res2.status}, Elapsed: ${res2.elapsed}ms`
  );

  // Test 3: Invalid URL (should still work, detected as query)
  const res3 = await makeRequest('/api/context/load', {
    body: { input: 'not-a-url' }
  });
  logTest(
    'Load non-URL input - detected as query',
    res3.ok && res3.data?.mode === 'query',
    `Mode: ${res3.data?.mode}`
  );

  // Test 4: Empty input
  const res4 = await makeRequest('/api/context/load', {
    body: { input: '' }
  });
  logTest(
    'Load empty input - returns error',
    !res4.ok && res4.status === 400,
    `Status: ${res4.status}, Error: ${res4.data?.error?.message}`
  );

  // Test 5: Missing input
  const res5 = await makeRequest('/api/context/load', {
    body: {}
  });
  logTest(
    'Load missing input - returns error',
    !res5.ok && res5.status === 400,
    `Status: ${res5.status}`
  );
}

async function testLoadBatchUrls() {
  console.log('\n📦 Testing Load API - Batch URLs Mode');
  console.log('─'.repeat(50));

  // Test 1: Array of URLs
  const res1 = await makeRequest('/api/context/load', {
    body: {
      input: [
        'https://www.figure.ai/news/helix',
        'https://arxiv.org/html/2310.05400v1',
        'https://example.com/nonexistent'
      ]
    }
  });
  logTest(
    'Load batch URLs - basic request',
    res1.ok && res1.data?.mode === 'batch_urls',
    `Mode: ${res1.data?.mode}, Results: ${res1.data?.results?.length}, Elapsed: ${res1.elapsed}ms`
  );

  // Test 2: Check summary
  logTest(
    'Load batch URLs - has summary',
    res1.data?.summary?.total === 3,
    `Total: ${res1.data?.summary?.total}, Found: ${res1.data?.summary?.found}`
  );

  // Test 3: Empty array
  const res3 = await makeRequest('/api/context/load', {
    body: { input: [] }
  });
  logTest(
    'Load empty array - returns error',
    !res3.ok && res3.status === 400,
    `Status: ${res3.status}`
  );

  // Test 4: Too many URLs
  const manyUrls = Array.from({ length: 60 }, (_, i) => `https://example.com/${i}`);
  const res4 = await makeRequest('/api/context/load', {
    body: { input: manyUrls }
  });
  logTest(
    'Load 60 URLs - exceeds limit',
    !res4.ok && res4.status === 400,
    `Status: ${res4.status}, Error: ${res4.data?.error?.message}`
  );
}

async function testLoadQuery() {
  console.log('\n📦 Testing Load API - Query Mode');
  console.log('─'.repeat(50));

  // Test 1: Basic query
  const res1 = await makeRequest('/api/context/load', {
    body: { input: 'latest developments in humanoid robots 2024' }
  });
  logTest(
    'Load query - basic request',
    res1.ok && res1.data?.mode === 'query',
    `Mode: ${res1.data?.mode}, Results: ${res1.data?.results?.length}, Elapsed: ${res1.elapsed}ms`
  );

  // Test 2: With search options
  const res2 = await makeRequest('/api/context/load', {
    body: {
      input: 'AI agent frameworks',
      search: { topK: 5 },
      return: { topK: 3 }
    }
  });
  logTest(
    'Load query - with options',
    res2.ok,
    `Results returned: ${res2.data?.results?.length}`
  );

  // Test 3: With ranking preset
  const res3 = await makeRequest('/api/context/load', {
    body: {
      input: 'machine learning papers',
      ranking: { preset: 'relevance_first' }
    }
  });
  logTest(
    'Load query - with ranking preset',
    res3.ok,
    `Results: ${res3.data?.results?.length}`
  );

  // Test 4: Check ranking factors in response
  if (res3.ok && res3.data?.results?.[0]?.ranking) {
    logTest(
      'Load query - has ranking factors',
      res3.data.results[0].ranking.score !== undefined,
      `Score: ${res3.data.results[0].ranking.score}`
    );
  }
}

async function testLoadInputDetection() {
  console.log('\n📦 Testing Load API - Input Type Detection');
  console.log('─'.repeat(50));

  // Test various inputs
  const testCases = [
    { input: 'https://example.com', expected: 'single_url', desc: 'HTTPS URL' },
    { input: 'http://example.com', expected: 'single_url', desc: 'HTTP URL' },
    { input: ['https://a.com', 'https://b.com'], expected: 'batch_urls', desc: 'URL array' },
    { input: 'what is machine learning', expected: 'query', desc: 'Question text' },
    { input: 'example.com', expected: 'query', desc: 'Domain without protocol' },
    { input: 'AI robots 2024', expected: 'query', desc: 'Search keywords' },
  ];

  for (const tc of testCases) {
    const res = await makeRequest('/api/context/load', {
      body: { input: tc.input }
    });
    logTest(
      `Input detection: ${tc.desc}`,
      res.data?.mode === tc.expected,
      `Expected: ${tc.expected}, Got: ${res.data?.mode}`
    );
  }

  // Test forced input type
  const res = await makeRequest('/api/context/load', {
    body: {
      input: 'https://example.com',
      inputType: 'query'  // Force as query even though it's a URL
    }
  });
  logTest(
    'Force input type to query',
    res.data?.mode === 'query',
    `Mode: ${res.data?.mode}`
  );
}

// ==================== Save API Tests ====================

async function testSaveSingle() {
  console.log('\n💾 Testing Save API - Single Mode');
  console.log('─'.repeat(50));

  const testUrl = `https://test-${Date.now()}.example.com/article`;

  // Test 1: Basic save
  const res1 = await makeRequest('/api/context/save', {
    body: {
      url: testUrl,
      hqcc: '# Test Article\n\nThis is a test article content.\n\n## Section 1\n\nMore content here.',
      meta: { strategy: 'Technical Content', test: true }
    }
  });
  logTest(
    'Save single - basic request',
    res1.ok && (res1.data?.status === 'created' || res1.data?.status === 'exists'),
    `Status: ${res1.status}, Result: ${res1.data?.status}, Elapsed: ${res1.elapsed}ms`
  );

  // Test 2: Save with raw content
  const res2 = await makeRequest('/api/context/save', {
    body: {
      url: `https://test-raw-${Date.now()}.example.com/article`,
      hqcc: '# Compressed Content',
      raw: 'Original raw content before compression',
      meta: { hasRaw: true }
    }
  });
  logTest(
    'Save single - with raw content',
    res2.ok,
    `Status: ${res2.status}`
  );

  // Test 3: Missing required fields
  const res3 = await makeRequest('/api/context/save', {
    body: { url: 'https://example.com' }  // Missing hqcc
  });
  logTest(
    'Save without hqcc - returns error',
    !res3.ok && res3.status === 400,
    `Status: ${res3.status}, Error: ${res3.data?.error?.message || res3.data?.error}`
  );

  // Test 4: No auth
  const res4 = await makeRequest('/api/context/save', {
    auth: false,
    body: {
      url: 'https://example.com/no-auth',
      hqcc: 'Content'
    }
  });
  logTest(
    'Save without auth - returns 401',
    !res4.ok && res4.status === 401,
    `Status: ${res4.status}`
  );
}

async function testSaveBatch() {
  console.log('\n💾 Testing Save API - Batch Mode');
  console.log('─'.repeat(50));

  const timestamp = Date.now();

  // Test 1: Basic batch save
  const res1 = await makeRequest('/api/context/save', {
    body: {
      items: [
        { url: `https://batch-${timestamp}-1.example.com`, hqcc: '# Article 1', meta: { index: 1 } },
        { url: `https://batch-${timestamp}-2.example.com`, hqcc: '# Article 2', meta: { index: 2 } },
        { url: `https://batch-${timestamp}-3.example.com`, hqcc: '# Article 3', meta: { index: 3 } },
      ]
    }
  });
  logTest(
    'Save batch - basic request',
    res1.ok,
    `Status: ${res1.status}, Results: ${res1.data?.results?.length}, Elapsed: ${res1.elapsed}ms`
  );

  // Test 2: Check summary
  if (res1.ok) {
    logTest(
      'Save batch - has summary',
      res1.data?.summary?.total === 3,
      `Total: ${res1.data?.summary?.total}, Created: ${res1.data?.summary?.created}`
    );
  }

  // Test 3: Empty items array
  const res3 = await makeRequest('/api/context/save', {
    body: { items: [] }
  });
  logTest(
    'Save empty batch - returns error',
    !res3.ok && res3.status === 400,
    `Status: ${res3.status}`
  );

  // Test 4: Invalid item in batch
  const res4 = await makeRequest('/api/context/save', {
    body: {
      items: [
        { url: 'https://valid.com', hqcc: 'Content' },
        { url: 'https://invalid.com' }  // Missing hqcc
      ]
    }
  });
  logTest(
    'Save batch with invalid item - returns error',
    !res4.ok && res4.status === 400,
    `Status: ${res4.status}`
  );

  // Test 5: Too many items
  const manyItems = Array.from({ length: 60 }, (_, i) => ({
    url: `https://many-${i}.example.com`,
    hqcc: `# Article ${i}`
  }));
  const res5 = await makeRequest('/api/context/save', {
    body: { items: manyItems }
  });
  logTest(
    'Save 60 items - exceeds limit',
    !res5.ok && res5.status === 400,
    `Status: ${res5.status}`
  );
}

// ==================== Legacy API Deprecation Tests ====================

async function testLegacyDeprecation() {
  console.log('\n⚠️  Testing Legacy API Deprecation');
  console.log('─'.repeat(50));

  // Test withdraw deprecation
  const res1 = await makeRequest('/api/context/withdraw', {
    body: { raw_link: 'https://example.com' }
  });
  logTest(
    'Legacy withdraw - has Deprecation header',
    res1.headers?.['deprecation'] === 'true',
    `Deprecation: ${res1.headers?.['deprecation']}`
  );
  logTest(
    'Legacy withdraw - has _deprecated in response',
    res1.data?._deprecated !== undefined,
    `Sunset: ${res1.data?._deprecated?.sunset}`
  );

  // Test deposit deprecation
  const res2 = await makeRequest('/api/context/deposit', {
    body: { raw_link: 'https://example.com', hqcc_content: 'Test' }
  });
  logTest(
    'Legacy deposit - has Deprecation header',
    res2.headers?.['deprecation'] === 'true',
    `Deprecation: ${res2.headers?.['deprecation']}`
  );
}

// ==================== Integration Tests ====================

async function testSaveAndLoad() {
  console.log('\n🔄 Testing Save → Load Integration');
  console.log('─'.repeat(50));

  const testUrl = `https://integration-test-${Date.now()}.example.com/article`;
  const testContent = '# Integration Test\n\nThis content was saved and should be loadable.';

  // Save content
  const saveRes = await makeRequest('/api/context/save', {
    body: {
      url: testUrl,
      hqcc: testContent,
      meta: { test: 'integration' }
    }
  });
  logTest(
    'Integration: Save content',
    saveRes.ok,
    `Status: ${saveRes.data?.status}`
  );

  // Load it back
  const loadRes = await makeRequest('/api/context/load', {
    body: { input: testUrl }
  });
  logTest(
    'Integration: Load saved content',
    loadRes.ok && loadRes.data?.result?.url === testUrl,
    `Found: ${loadRes.data?.result?.cached}, Has HQCC: ${!!loadRes.data?.result?.hqcc}`
  );
}

// ==================== Main Test Runner ====================

async function runAllTests() {
  const startTime = Date.now();

  try {
    // Check if server is running
    console.log('Checking server connection...');
    const healthCheck = await fetch(`${API_BASE}/api/context/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'test' })
    }).catch(() => null);

    if (!healthCheck) {
      console.log('❌ Cannot connect to server. Make sure the dev server is running:');
      console.log('   npm run dev');
      process.exit(1);
    }
    console.log('✅ Server is running\n');

    // Run all test suites
    await testLoadSingleUrl();
    await testLoadBatchUrls();
    await testLoadQuery();
    await testLoadInputDetection();
    await testSaveSingle();
    await testSaveBatch();
    await testLegacyDeprecation();
    await testSaveAndLoad();

  } catch (error) {
    console.error('\n❌ Test suite error:', error.message);
  }

  // Summary
  const totalTime = Date.now() - startTime;
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log('\n');
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║                       TEST SUMMARY                             ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Total Tests:  ${results.length}`);
  console.log(`  Passed:       ${passed} ✅`);
  console.log(`  Failed:       ${failed} ❌`);
  console.log(`  Duration:     ${totalTime}ms`);
  console.log('');

  if (failed > 0) {
    console.log('Failed Tests:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  ❌ ${r.name}`);
      if (r.details) console.log(`     ${r.details}`);
    });
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

runAllTests();







