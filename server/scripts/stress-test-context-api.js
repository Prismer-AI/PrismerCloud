#!/usr/bin/env node

/**
 * Prismer Cloud Context API Stress Test - Real Data Edition
 * 
 * Uses actual arxiv paper data from data/output/ for realistic testing.
 * 
 * Test Flow:
 * 1. Load paper markdown files
 * 2. Compress each paper using /api/compress
 * 3. Save compressed content using /api/context/save
 * 4. Load content back using /api/context/load
 * 
 * API Endpoints Tested:
 * - POST /api/compress                - Compress content
 * - POST /api/context/save            - Save (single or batch)
 * - POST /api/context/load            - Load (single URL, batch URLs, or query)
 * 
 * Usage:
 *   node scripts/stress-test-context-api.js                    # Show help
 *   node scripts/stress-test-context-api.js --all              # Run all tests
 *   node scripts/stress-test-context-api.js --compress         # Compress only
 *   node scripts/stress-test-context-api.js --save             # Save only (requires --compress first or cached data)
 *   node scripts/stress-test-context-api.js --load             # Load only
 *   node scripts/stress-test-context-api.js --load-single      # Load single URL only
 *   node scripts/stress-test-context-api.js --load-batch       # Load batch URLs only
 *   node scripts/stress-test-context-api.js --load-query       # Load query mode only
 *   node scripts/stress-test-context-api.js --search           # Search API only
 *   node scripts/stress-test-context-api.js --compress --save  # Compress + Save
 *   node scripts/stress-test-context-api.js --local            # Use localhost:3000
 * 
 * Environment variables:
 *   PRISMER_API_KEY  - API key for authentication
 *   PRISMER_API_BASE - Base URL (default: https://prismer.cloud)
 */

const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);

function showHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════════════╗
║        Prismer Cloud Context API Stress Test                       ║
╚════════════════════════════════════════════════════════════════════╝

Usage: node scripts/stress-test-context-api.js [options]

Options:
  --all           Run all tests (compress → save → load → concurrent)
  --compress      Run compress test only
  --save          Run save test only (needs compressed data)
  --load          Run all load tests (single, batch, query)
  --load-single   Run load single URL test only
  --load-batch    Run load batch URLs test only  
  --load-query    Run load query mode test only
  --search        Run search API test only
  --concurrent    Run concurrency stress test (load & save)
  --local         Use localhost:3000 instead of production
  --help, -h      Show this help message

Examples:
  node scripts/stress-test-context-api.js --compress         # Test compress API
  node scripts/stress-test-context-api.js --load-query       # Test load query mode
  node scripts/stress-test-context-api.js --concurrent       # Concurrency stress test
  node scripts/stress-test-context-api.js --all --local      # Full test on localhost
  node scripts/stress-test-context-api.js --compress --save  # Compress + Save

Environment:
  PRISMER_API_KEY   API key (default: sk-prismer-live-...)
  PRISMER_API_BASE  Base URL (default: https://prismer.cloud)
`);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  showHelp();
}

// Configuration
const API_KEY = process.env.PRISMER_API_KEY || 'sk-prismer-live-REDACTED-SET-VIA-ENV';
const isLocal = args.includes('--local');
const API_BASE = process.env.PRISMER_API_BASE || (isLocal ? 'http://localhost:3000' : 'https://prismer.cloud');

// Test flags
const runAll = args.includes('--all');
const runCompress = runAll || args.includes('--compress');
const runSave = runAll || args.includes('--save');
const runLoad = runAll || args.includes('--load');
const runLoadSingle = runLoad || args.includes('--load-single');
const runLoadBatch = runLoad || args.includes('--load-batch');
const runLoadQuery = runLoad || args.includes('--load-query');
const runSearch = runAll || args.includes('--search');
const runConcurrent = runAll || args.includes('--concurrent');

const CONFIG = {
  concurrency: 3,           // Max concurrent requests
  batchSize: 5,             // Items per batch
  delayBetweenRequests: 100, // ms delay
  compressTimeout: 60000,    // 60s timeout for compress
  defaultTimeout: 30000,     // 30s timeout for other requests
};

// Statistics collector
class Stats {
  constructor(name) {
    this.name = name;
    this.times = [];
    this.successes = 0;
    this.failures = 0;
    this.errors = [];
    this.details = [];
  }

  record(timeMs, success, error = null, detail = null) {
    this.times.push(timeMs);
    if (success) {
      this.successes++;
    } else {
      this.failures++;
      if (error) this.errors.push(error);
    }
    if (detail) this.details.push(detail);
  }

  getReport() {
    if (this.times.length === 0) {
      return { name: this.name, error: 'No data collected' };
    }

    const sorted = [...this.times].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const avg = sum / sorted.length;
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)] || max;

    return {
      name: this.name,
      total: this.times.length,
      successes: this.successes,
      failures: this.failures,
      successRate: ((this.successes / this.times.length) * 100).toFixed(2) + '%',
      latency: {
        min: min.toFixed(2) + 'ms',
        max: max.toFixed(2) + 'ms',
        avg: avg.toFixed(2) + 'ms',
        p50: p50.toFixed(2) + 'ms',
        p90: p90.toFixed(2) + 'ms',
        p95: p95.toFixed(2) + 'ms',
        p99: p99.toFixed(2) + 'ms',
      },
      throughput: (this.times.length / (sum / 1000)).toFixed(2) + ' req/s',
      errors: this.errors.slice(0, 5),
    };
  }
}

// Load paper data from data/output directory
function loadPaperData() {
  const dataDir = path.join(__dirname, '..', 'data', 'output');
  const papers = [];
  
  if (!fs.existsSync(dataDir)) {
    console.error(`Data directory not found: ${dataDir}`);
    return papers;
  }

  const dirs = fs.readdirSync(dataDir).filter(d => {
    const stat = fs.statSync(path.join(dataDir, d));
    return stat.isDirectory() && d.match(/^\d+\.\d+v\d+$/);
  });

  for (const dir of dirs) {
    const paperPath = path.join(dataDir, dir, 'paper.md');
    const metaPath = path.join(dataDir, dir, 'metadata.json');

    if (fs.existsSync(paperPath) && fs.existsSync(metaPath)) {
      try {
        const content = fs.readFileSync(paperPath, 'utf-8');
        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        papers.push({
          id: dir,
          // Use pdf_url from metadata as the canonical URL for caching
          url: metadata.pdf_url || `https://arxiv.org/pdf/${dir}`,
          absUrl: `https://arxiv.org/abs/${dir}`,
          pdfUrl: metadata.pdf_url,
          title: metadata.title,
          authors: metadata.authors,
          abstract: metadata.abstract,
          categories: metadata.categories,
          content,
          metadata,
          contentLength: content.length,
        });
      } catch (err) {
        console.warn(`Failed to load paper ${dir}:`, err.message);
      }
    }
  }

  console.log(`📚 Loaded ${papers.length} papers from ${dataDir}`);
  return papers;
}

// HTTP request helper with timing
async function timedRequest(url, options, timeout = CONFIG.defaultTimeout) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  const start = performance.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 500) };
    }
    
    const elapsed = performance.now() - start;
    return {
      success: response.ok,
      status: response.status,
      data,
      elapsed,
      error: response.ok ? null : (data.error?.message || data.error || `HTTP ${response.status}`),
    };
  } catch (error) {
    clearTimeout(timeoutId);
    const elapsed = performance.now() - start;
    return {
      success: false,
      status: 0,
      data: null,
      elapsed,
      error: error.name === 'AbortError' ? 'Request timeout' : error.message,
    };
  }
}

// Sleep helper
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==================== COMPRESS TESTS ====================

async function testCompress(stats, paper) {
  const result = await timedRequest(
    `${API_BASE}/api/compress`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        content: paper.content,
        url: paper.url,
        title: paper.title,
        strategy: 'Academic',
        stream: false,
      }),
    },
    CONFIG.compressTimeout
  );

  const hqccLength = result.data?.hqcc?.length || 0;
  const truncated = result.data?.truncated || false;
  
  stats.record(
    result.elapsed,
    result.success && hqccLength > 0,
    result.error,
    { 
      paperId: paper.id, 
      inputLength: paper.contentLength,
      hqccLength,
      truncated,
      compressionRatio: hqccLength > 0 ? (paper.contentLength / hqccLength).toFixed(2) : 'N/A'
    }
  );

  return {
    ...result,
    hqcc: result.data?.hqcc,
    truncated,
    paperId: paper.id,
  };
}

// ==================== SAVE TESTS ====================

async function testSaveSingle(stats, url, hqcc, raw, meta) {
  const result = await timedRequest(
    `${API_BASE}/api/context/save`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        url,
        hqcc,
        raw,
        meta,
      }),
    }
  );

  stats.record(
    result.elapsed,
    result.success,
    result.error,
    { url, status: result.data?.status }
  );

  return result;
}

async function testSaveBatch(stats, items) {
  const result = await timedRequest(
    `${API_BASE}/api/context/save`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ items }),
    }
  );

  stats.record(
    result.elapsed,
    result.success,
    result.error,
    { 
      count: items.length,
      created: result.data?.summary?.created || 0,
      exists: result.data?.summary?.exists || 0,
    }
  );

  return result;
}

// ==================== LOAD TESTS ====================

async function testLoadSingleUrl(stats, url) {
  const result = await timedRequest(
    `${API_BASE}/api/context/load`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ input: url }),
    }
  );

  const cached = result.data?.result?.cached || false;
  const hasHqcc = !!(result.data?.result?.hqcc);

  stats.record(
    result.elapsed,
    result.success,
    result.error,
    { url, cached, hasHqcc }
  );

  return { ...result, cached, hasHqcc };
}

async function testLoadBatchUrls(stats, urls) {
  const result = await timedRequest(
    `${API_BASE}/api/context/load`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ input: urls }),
    }
  );

  const found = result.data?.summary?.found || 0;
  const notFound = result.data?.summary?.notFound || 0;

  stats.record(
    result.elapsed,
    result.success,
    result.error,
    { count: urls.length, found, notFound }
  );

  return { ...result, found, notFound };
}

async function testLoadQuery(stats, query) {
  const result = await timedRequest(
    `${API_BASE}/api/context/load`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ 
        input: query,
        search: { topK: 10 },
        return: { topK: 5 }
      }),
    },
    CONFIG.compressTimeout // Query may trigger compress, so longer timeout
  );

  const searched = result.data?.summary?.searched || 0;
  const cacheHits = result.data?.summary?.cacheHits || 0;
  const returned = result.data?.summary?.returned || 0;

  stats.record(
    result.elapsed,
    result.success,
    result.error,
    { query, searched, cacheHits, returned }
  );

  return { ...result, searched, cacheHits, returned };
}

// ==================== PRINT HELPERS ====================

function printHeader(title) {
  console.log('');
  console.log('━'.repeat(70));
  console.log(`  ${title}`);
  console.log('━'.repeat(70));
}

function printReport(report) {
  console.log(`┌${'─'.repeat(68)}┐`);
  console.log(`│ ${report.name.padEnd(66)}│`);
  console.log(`├${'─'.repeat(68)}┤`);
  console.log(`│  Total Requests:  ${String(report.total).padEnd(48)}│`);
  console.log(`│  Success Rate:    ${report.successRate.padEnd(48)}│`);
  console.log(`│  Throughput:      ${report.throughput.padEnd(48)}│`);
  console.log(`│${'─'.repeat(68)}│`);
  console.log(`│  Latency:                                                          │`);
  console.log(`│    Min:  ${report.latency.min.padEnd(57)}│`);
  console.log(`│    Avg:  ${report.latency.avg.padEnd(57)}│`);
  console.log(`│    P50:  ${report.latency.p50.padEnd(57)}│`);
  console.log(`│    P90:  ${report.latency.p90.padEnd(57)}│`);
  console.log(`│    P95:  ${report.latency.p95.padEnd(57)}│`);
  console.log(`│    Max:  ${report.latency.max.padEnd(57)}│`);
  if (report.errors && report.errors.length > 0) {
    console.log(`│${'─'.repeat(68)}│`);
    console.log(`│  Errors (first ${report.errors.length}):`.padEnd(69) + '│');
    report.errors.forEach(err => {
      const errStr = String(err).slice(0, 60);
      console.log(`│    - ${errStr.padEnd(61)}│`);
    });
  }
  console.log(`└${'─'.repeat(68)}┘`);
  console.log('');
}

// ==================== MAIN TEST RUNNER ====================

async function runTests() {
  console.log('╔' + '═'.repeat(68) + '╗');
  console.log('║' + '  Prismer Cloud Context API Stress Test - Real Data Edition'.padEnd(68) + '║');
  console.log('╠' + '═'.repeat(68) + '╣');
  console.log(`║  API Base: ${API_BASE.padEnd(56)}║`);
  console.log(`║  API Key:  ${(API_KEY.slice(0, 25) + '...').padEnd(56)}║`);
  console.log('╚' + '═'.repeat(68) + '╝');

  // Load paper data
  const papers = loadPaperData();
  if (papers.length === 0) {
    console.error('❌ No papers found. Please check data/output directory.');
    return;
  }

  console.log(`\n📄 Paper data:`);
  papers.forEach(p => {
    console.log(`   - ${p.id}: ${(p.contentLength / 1024).toFixed(1)}KB`);
    console.log(`     URL: ${p.url}`);
    console.log(`     Title: ${p.title.slice(0, 60)}...`);
  });

  // Use flags from command line parsing

  const compressedPapers = [];

  // ==================== TEST 1: COMPRESS ====================
  if (runCompress) {
    printHeader('TEST 1: Compress Papers (Academic Strategy)');
    const compressStats = new Stats('Compress API');

    for (let i = 0; i < papers.length; i++) {
      const paper = papers[i];
      process.stdout.write(`  [${i + 1}/${papers.length}] Compressing ${paper.id}... `);
      
      const result = await testCompress(compressStats, paper);
      
      if (result.success && result.hqcc) {
        compressedPapers.push({
          ...paper,
          hqcc: result.hqcc,
          truncated: result.truncated,
        });
        console.log(`✓ (${result.elapsed.toFixed(0)}ms, ratio: ${(paper.contentLength / result.hqcc.length).toFixed(1)}x)`);
      } else {
        console.log(`✗ ${result.error}`);
      }

      await sleep(CONFIG.delayBetweenRequests);
    }

    console.log(`\n📊 Compression Summary:`);
    console.log(`   Successful: ${compressedPapers.length}/${papers.length}`);
    if (compressedPapers.length > 0) {
      const avgRatio = compressedPapers.reduce((sum, p) => sum + p.contentLength / p.hqcc.length, 0) / compressedPapers.length;
      console.log(`   Avg Compression Ratio: ${avgRatio.toFixed(2)}x`);
    }
    
    printReport(compressStats.getReport());
  }

  // ==================== TEST 2: SAVE ====================
  if (runSave) {
    if (compressedPapers.length === 0) {
      console.log('\n⚠️  No compressed papers available. Run --compress first or use --all');
    } else {
    printHeader('TEST 2: Save Compressed Content');
    const saveSingleStats = new Stats('Save Single');
    const saveBatchStats = new Stats('Save Batch');

    // Test single save
    console.log('\n  2.1 Single Save Tests:');
    for (let i = 0; i < Math.min(3, compressedPapers.length); i++) {
      const paper = compressedPapers[i];
      process.stdout.write(`    Saving ${paper.id} (${paper.url.slice(0, 40)}...)... `);
      
      const result = await testSaveSingle(
        saveSingleStats,
        paper.url, // Use pdf_url from metadata
        paper.hqcc,
        paper.content,
        {
          title: paper.title,
          arxiv_id: paper.id,
          authors: paper.authors,
          categories: paper.categories,
          abstract: paper.abstract?.slice(0, 500),
          strategy: 'Academic',
          source: 'stress_test',
        }
      );

      if (result.success) {
        console.log(`✓ ${result.data?.status || 'saved'} (${result.elapsed.toFixed(0)}ms)`);
      } else {
        console.log(`✗ ${result.error}`);
      }

      await sleep(CONFIG.delayBetweenRequests);
    }

    // Test batch save
    console.log('\n  2.2 Batch Save Tests:');
    const batchItems = compressedPapers.slice(0, CONFIG.batchSize).map(paper => ({
      url: paper.url, // Use pdf_url from metadata
      hqcc: paper.hqcc,
      raw: paper.content.slice(0, 10000), // Truncate raw for batch
      meta: {
        title: paper.title,
        arxiv_id: paper.id,
        authors: paper.authors,
        categories: paper.categories,
        strategy: 'Academic',
        source: 'stress_test_batch',
      }
    }));

    process.stdout.write(`    Batch saving ${batchItems.length} items... `);
    const batchResult = await testSaveBatch(saveBatchStats, batchItems);
    
    if (batchResult.success) {
      console.log(`✓ created: ${batchResult.data?.summary?.created}, exists: ${batchResult.data?.summary?.exists} (${batchResult.elapsed.toFixed(0)}ms)`);
    } else {
      console.log(`✗ ${batchResult.error}`);
    }

    printReport(saveSingleStats.getReport());
    printReport(saveBatchStats.getReport());
    }
  }

  // ==================== TEST 3: LOAD ====================
  // Build test URLs from compressed papers or defaults
  const testUrls = compressedPapers.length > 0 
    ? compressedPapers.slice(0, 5).map(p => p.url)  // pdf_url from metadata
    : [
        'https://arxiv.org/pdf/2512.23684v1',
        'https://arxiv.org/pdf/2512.23565v1',
        'https://www.figure.ai/news/helix',
      ];

  // 3.1 Load Single URL
  if (runLoadSingle) {
    printHeader('TEST 3.1: Load Single URL');
    const loadSingleStats = new Stats('Load Single URL');

    for (const url of testUrls) {
      process.stdout.write(`  Loading ${url}... `);
      
      const result = await testLoadSingleUrl(loadSingleStats, url);
      
      if (result.success) {
        const status = result.cached ? '✓ CACHED' : '○ NOT CACHED';
        console.log(`${status} (${result.elapsed.toFixed(0)}ms)`);
      } else {
        console.log(`✗ ${result.error}`);
      }

      await sleep(CONFIG.delayBetweenRequests);
    }

    printReport(loadSingleStats.getReport());
  }

  // 3.2 Load Batch URLs
  if (runLoadBatch) {
    printHeader('TEST 3.2: Load Batch URLs');
    const loadBatchStats = new Stats('Load Batch URLs');

    process.stdout.write(`  Batch loading ${testUrls.length} URLs... `);
    
    const batchLoadResult = await testLoadBatchUrls(loadBatchStats, testUrls);
    
    if (batchLoadResult.success) {
      console.log(`✓ found: ${batchLoadResult.found}, not found: ${batchLoadResult.notFound} (${batchLoadResult.elapsed.toFixed(0)}ms)`);
    } else {
      console.log(`✗ ${batchLoadResult.error}`);
    }

    printReport(loadBatchStats.getReport());
  }

  // 3.3 Load Query Mode
  if (runLoadQuery) {
    printHeader('TEST 3.3: Load Query Mode (Full Pipeline)');
    const loadQueryStats = new Stats('Load Query Mode');
    const testQueries = [
      'prompt injection attacks on large language models',
      'multilingual LLM alignment',
      'machine learning peer review',
    ];

    for (const query of testQueries) {
      process.stdout.write(`  Loading query "${query.slice(0, 40)}..."... `);
      
      const result = await testLoadQuery(loadQueryStats, query);
      
      if (result.success) {
        console.log(`✓ searched: ${result.searched}, cached: ${result.cacheHits}, returned: ${result.returned} (${result.elapsed.toFixed(0)}ms)`);
      } else {
        console.log(`✗ ${result.error}`);
      }

      await sleep(1000); // Longer delay for query mode (may trigger compression)
    }

    printReport(loadQueryStats.getReport());
  }

  // 3.4 Direct Search API
  if (runSearch) {
    printHeader('TEST 3.4: Direct Search API');
    const searchStats = new Stats('Search API (Direct)');
    const testQueries = [
      'prompt injection attacks on large language models',
      'multilingual LLM alignment',
    ];

    for (const query of testQueries) {
      process.stdout.write(`  Searching "${query.slice(0, 40)}..."... `);
      
      const result = await timedRequest(
        `${API_BASE}/api/search`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        }
      );
      
      const resultCount = result.data?.results?.length || 0;
      searchStats.record(result.elapsed, result.success && resultCount > 0, result.error, { query, resultCount });
      
      if (result.success && resultCount > 0) {
        console.log(`✓ found: ${resultCount} results (${result.elapsed.toFixed(0)}ms)`);
      } else {
        console.log(`✗ ${result.error || 'No results'}`);
      }

      await sleep(500);
    }

    printReport(searchStats.getReport());
  }

  // ==================== TEST 4: CONCURRENCY STRESS TEST ====================
  if (runConcurrent) {
    printHeader('TEST 4: Concurrency Stress Test (Load & Save)');
    
    // Test URLs for concurrent testing
    const concurrentTestUrls = [
      'https://arxiv.org/pdf/2512.23684v1',
      'https://arxiv.org/pdf/2512.23565v1',
      'https://arxiv.org/pdf/2512.23601v1',
      'https://arxiv.org/pdf/2512.23617v1',
      'https://arxiv.org/pdf/2512.23624v1',
      'https://arxiv.org/pdf/2512.23626v1',
      'https://arxiv.org/pdf/2512.23631v1',
      'https://arxiv.org/pdf/2512.23633v1',
      'https://arxiv.org/pdf/2512.23647v1',
      'https://arxiv.org/pdf/2512.23676v1',
    ];

    // Concurrency levels to test
    const concurrencyLevels = [1, 2, 5, 10, 20, 50];
    const resultsTable = [];

    for (const concurrency of concurrencyLevels) {
      console.log(`\n  ▶ Testing concurrency level: ${concurrency}`);
      
      // 4.1 Concurrent Load Test
      const loadStats = new Stats(`Load (${concurrency} concurrent)`);
      console.log(`    Load test...`);
      
      const loadStartTime = performance.now();
      const loadPromises = [];
      let loadInFlight = 0;
      let loadMaxInFlight = 0;
      
      for (let i = 0; i < concurrency; i++) {
        const url = concurrentTestUrls[i % concurrentTestUrls.length];
        loadInFlight++;
        loadMaxInFlight = Math.max(loadMaxInFlight, loadInFlight);
        
        loadPromises.push(
          timedRequest(`${API_BASE}/api/context/load`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${API_KEY}`,
            },
            body: JSON.stringify({ input: url }),
          }).then(result => {
            loadInFlight--;
            loadStats.record(result.elapsed, result.success, result.error);
            return result;
          })
        );
      }
      
      await Promise.all(loadPromises);
      const loadTotalTime = performance.now() - loadStartTime;
      const loadReport = loadStats.getReport();
      const loadSequentialEstimate = parseFloat(loadReport.latency.avg) * concurrency;
      
      const loadSpeedup = loadSequentialEstimate / loadTotalTime;
      console.log(`      ✓ ${loadReport.successes}/${loadReport.total} success, avg: ${loadReport.latency.avg}, total: ${loadTotalTime.toFixed(0)}ms`);
      console.log(`        (Max in-flight: ${loadMaxInFlight}, Sequential estimate: ${loadSequentialEstimate.toFixed(0)}ms, Speedup: ${loadSpeedup.toFixed(1)}x)`);

      // 4.2 Concurrent Save Test
      const saveStats = new Stats(`Save (${concurrency} concurrent)`);
      console.log(`    Save test...`);
      
      const saveStartTime = performance.now();
      const savePromises = [];
      let saveMaxInFlight = 0;
      let saveInFlight = 0;
      
      for (let i = 0; i < concurrency; i++) {
        const testUrl = `https://concurrent-test-${Date.now()}-${i}.example.com/article`;
        saveInFlight++;
        saveMaxInFlight = Math.max(saveMaxInFlight, saveInFlight);
        
        savePromises.push(
          timedRequest(`${API_BASE}/api/context/save`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${API_KEY}`,
            },
            body: JSON.stringify({
              url: testUrl,
              hqcc: `# Concurrent Test ${i}\n\nThis is a test document for concurrency testing.\n\nTimestamp: ${new Date().toISOString()}`,
              meta: { test: 'concurrent', index: i }
            }),
          }).then(result => {
            saveInFlight--;
            saveStats.record(result.elapsed, result.success, result.error);
            return result;
          })
        );
      }
      
      await Promise.all(savePromises);
      const saveTotalTime = performance.now() - saveStartTime;
      const saveReport = saveStats.getReport();
      const saveSequentialEstimate = parseFloat(saveReport.latency.avg) * concurrency;
      const saveSpeedup = saveSequentialEstimate / saveTotalTime;
      
      console.log(`      ✓ ${saveReport.successes}/${saveReport.total} success, avg: ${saveReport.latency.avg}, total: ${saveTotalTime.toFixed(0)}ms`);
      console.log(`        (Max in-flight: ${saveMaxInFlight}, Sequential estimate: ${saveSequentialEstimate.toFixed(0)}ms, Speedup: ${saveSpeedup.toFixed(1)}x)`);

      // 4.3 Mixed Concurrent Test (Load + Save)
      const mixedStats = new Stats(`Mixed (${concurrency} concurrent)`);
      console.log(`    Mixed test (50% load, 50% save)...`);
      
      const mixedStartTime = performance.now();
      const mixedPromises = [];
      let mixedMaxInFlight = 0;
      let mixedInFlight = 0;
      
      for (let i = 0; i < concurrency; i++) {
        mixedInFlight++;
        mixedMaxInFlight = Math.max(mixedMaxInFlight, mixedInFlight);
        
        if (i % 2 === 0) {
          // Load request
          const url = concurrentTestUrls[i % concurrentTestUrls.length];
          mixedPromises.push(
            timedRequest(`${API_BASE}/api/context/load`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
              },
              body: JSON.stringify({ input: url }),
            }).then(result => {
              mixedInFlight--;
              mixedStats.record(result.elapsed, result.success, result.error);
              return result;
            })
          );
        } else {
          // Save request
          const testUrl = `https://mixed-test-${Date.now()}-${i}.example.com/article`;
          mixedPromises.push(
            timedRequest(`${API_BASE}/api/context/save`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
              },
              body: JSON.stringify({
                url: testUrl,
                hqcc: `# Mixed Test ${i}\n\nMixed concurrency test.\n\nTimestamp: ${new Date().toISOString()}`,
                meta: { test: 'mixed', index: i }
              }),
            }).then(result => {
              mixedInFlight--;
              mixedStats.record(result.elapsed, result.success, result.error);
              return result;
            })
          );
        }
      }
      
      await Promise.all(mixedPromises);
      const mixedTotalTime = performance.now() - mixedStartTime;
      const mixedReport = mixedStats.getReport();
      const mixedSequentialEstimate = parseFloat(mixedReport.latency.avg) * concurrency;
      const mixedSpeedup = mixedSequentialEstimate / mixedTotalTime;
      
      console.log(`      ✓ ${mixedReport.successes}/${mixedReport.total} success, avg: ${mixedReport.latency.avg}, total: ${mixedTotalTime.toFixed(0)}ms`);
      console.log(`        (Max in-flight: ${mixedMaxInFlight}, Sequential estimate: ${mixedSequentialEstimate.toFixed(0)}ms, Speedup: ${mixedSpeedup.toFixed(1)}x)`);

      // Record results for summary table
      resultsTable.push({
        concurrency,
        load: {
          success: loadReport.successRate,
          avgLatency: loadReport.latency.avg,
          p95Latency: loadReport.latency.p95,
          throughput: (concurrency / (loadTotalTime / 1000)).toFixed(2) + ' req/s'
        },
        save: {
          success: saveReport.successRate,
          avgLatency: saveReport.latency.avg,
          p95Latency: saveReport.latency.p95,
          throughput: (concurrency / (saveTotalTime / 1000)).toFixed(2) + ' req/s'
        },
        mixed: {
          success: mixedReport.successRate,
          avgLatency: mixedReport.latency.avg,
          p95Latency: mixedReport.latency.p95,
          throughput: (concurrency / (mixedTotalTime / 1000)).toFixed(2) + ' req/s'
        }
      });

      // Small delay between concurrency levels
      await sleep(1000);
    }

    // Print summary table
    console.log('\n');
    console.log('┌' + '─'.repeat(90) + '┐');
    console.log('│' + ' CONCURRENCY TEST RESULTS SUMMARY'.padEnd(90) + '│');
    console.log('├' + '─'.repeat(10) + '┬' + '─'.repeat(26) + '┬' + '─'.repeat(26) + '┬' + '─'.repeat(26) + '┤');
    console.log('│' + ' Conc.'.padEnd(10) + '│' + ' Load'.padEnd(26) + '│' + ' Save'.padEnd(26) + '│' + ' Mixed'.padEnd(26) + '│');
    console.log('├' + '─'.repeat(10) + '┼' + '─'.repeat(26) + '┼' + '─'.repeat(26) + '┼' + '─'.repeat(26) + '┤');
    
    for (const row of resultsTable) {
      const loadInfo = `${row.load.success} ${row.load.throughput}`;
      const saveInfo = `${row.save.success} ${row.save.throughput}`;
      const mixedInfo = `${row.mixed.success} ${row.mixed.throughput}`;
      console.log(
        '│' + ` ${row.concurrency}`.padEnd(10) + 
        '│' + ` ${loadInfo}`.padEnd(26) + 
        '│' + ` ${saveInfo}`.padEnd(26) + 
        '│' + ` ${mixedInfo}`.padEnd(26) + '│'
      );
    }
    
    console.log('└' + '─'.repeat(10) + '┴' + '─'.repeat(26) + '┴' + '─'.repeat(26) + '┴' + '─'.repeat(26) + '┘');
    console.log('');
    
    // Performance analysis
    console.log('📊 Performance Analysis:');
    const firstResult = resultsTable[0];
    const lastResult = resultsTable[resultsTable.length - 1];
    
    const loadScaling = parseFloat(lastResult.load.throughput) / parseFloat(firstResult.load.throughput);
    const saveScaling = parseFloat(lastResult.save.throughput) / parseFloat(firstResult.save.throughput);
    
    console.log(`   Load scaling: ${loadScaling.toFixed(2)}x (1 → ${concurrencyLevels[concurrencyLevels.length - 1]} concurrent)`);
    console.log(`   Save scaling: ${saveScaling.toFixed(2)}x (1 → ${concurrencyLevels[concurrencyLevels.length - 1]} concurrent)`);
    
    if (loadScaling > concurrencyLevels[concurrencyLevels.length - 1] * 0.5) {
      console.log('   ✅ Good horizontal scaling');
    } else if (loadScaling > concurrencyLevels[concurrencyLevels.length - 1] * 0.25) {
      console.log('   ⚠️  Moderate scaling - some bottleneck detected');
    } else {
      console.log('   ❌ Poor scaling - significant bottleneck');
    }
  }

  // ==================== FINAL SUMMARY ====================
  printHeader('FINAL SUMMARY');
  console.log(`  Test completed at: ${new Date().toISOString()}`);
  console.log(`  API Base: ${API_BASE}`);
  console.log(`  Papers tested: ${papers.length}`);
  
  if (compressedPapers.length > 0) {
    const totalInputChars = compressedPapers.reduce((sum, p) => sum + p.contentLength, 0);
    const totalOutputChars = compressedPapers.reduce((sum, p) => sum + p.hqcc.length, 0);
    console.log(`  Total input: ${(totalInputChars / 1024).toFixed(1)}KB`);
    console.log(`  Total output: ${(totalOutputChars / 1024).toFixed(1)}KB`);
    console.log(`  Overall compression: ${(totalInputChars / totalOutputChars).toFixed(2)}x`);
  }

  console.log('');
}

// Run
runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
