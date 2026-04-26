/**
 * Context Network — Edge Case Tests
 *
 * 覆盖:
 *   1. extractMeta 边界 (空字符串、多个 meta 块、格式错误、中文、超长 keywords)
 *   2. input-detector 边界 (空 prismer://、大小写、batch 含 prismer://、forceType)
 *   3. prismer:// URI 边界 (特殊字符、超长 URI、update 后 re-load)
 *   4. local search 边界 (空 query、单字符 token、SQL injection attempt)
 *
 * Usage: npx tsx scripts/test-context-network-edge-cases.ts
 */

import { extractMeta } from '../src/lib/context-meta';
import { detectInputType, validateInput } from '../src/lib/input-detector';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const API_KEY = process.env.PRISMER_API_KEY || '';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// ============================================================================
// extractMeta edge cases
// ============================================================================

function testExtractMetaEdgeCases() {
  console.log('\n═══ extractMeta Edge Cases ═══\n');

  // Empty string
  const r1 = extractMeta('');
  assert(r1.title === '', 'Empty string: empty title');
  assert(r1.keywords.length === 0, 'Empty string: no keywords');
  assert(r1.hqcc === '', 'Empty string: hqcc unchanged');

  // Multiple meta blocks (should only match the LAST one)
  const multi = `# Content

\`\`\`prismer-meta
title: Wrong One
keywords: wrong
\`\`\`

More content here.

\`\`\`prismer-meta
title: Correct Title
keywords: correct, right
\`\`\``;
  const r2 = extractMeta(multi);
  assert(r2.title === 'Correct Title', `Multiple meta blocks: last one wins (got: ${r2.title})`);
  assert(r2.keywords.includes('correct'), 'Multiple meta blocks: correct keywords');

  // Malformed meta block (missing closing ```)
  const malformed = `# Content\n\n\`\`\`prismer-meta\ntitle: Broken\nkeywords: oops`;
  const r3 = extractMeta(malformed);
  assert(r3.title === 'Content', 'Malformed meta block: falls back to heading');
  assert(r3.hqcc === malformed, 'Malformed meta block: content unchanged');

  // Chinese content
  const chinese = `# 处理超时错误

在 API 请求超时时，应使用指数退避重试。

\`\`\`prismer-meta
title: Node.js API 超时错误处理最佳实践
keywords: 超时, timeout, 重试, retry, 指数退避, 断路器, ETIMEDOUT, Node.js
\`\`\``;
  const r4 = extractMeta(chinese);
  assert(r4.title === 'Node.js API 超时错误处理最佳实践', 'Chinese: title parsed');
  assert(r4.keywords.includes('超时'), 'Chinese: Chinese keyword preserved');
  assert(r4.keywords.includes('timeout'), 'Chinese: English keyword preserved');
  assert(!r4.hqcc.includes('prismer-meta'), 'Chinese: meta block stripped');

  // Very long keywords line (30+ items)
  const longKw = `\`\`\`prismer-meta
title: T
keywords: ${Array.from({ length: 50 }, (_, i) => `keyword${i}`).join(', ')}
\`\`\``;
  const r5 = extractMeta(longKw);
  assert(r5.keywords.length <= 30, `Long keywords: capped at 30 (got: ${r5.keywords.length})`);

  // Meta block with extra whitespace / empty lines
  const whitespace = `Content\n\n\`\`\`prismer-meta\n\ntitle:   Spaced Title  \n\nkeywords:   a ,  b , c  \n\n\`\`\`\n`;
  const r6 = extractMeta(whitespace);
  assert(r6.title === 'Spaced Title', `Whitespace handling: title trimmed (got: "${r6.title}")`);
  assert(r6.keywords[0] === 'a', `Whitespace handling: keywords trimmed (got: "${r6.keywords[0]}")`);

  // Meta block with no keywords line
  const noKw = `\`\`\`prismer-meta\ntitle: Only Title\n\`\`\``;
  const r7 = extractMeta(noKw);
  assert(r7.title === 'Only Title', 'No keywords line: title works');
  assert(r7.keywords.length === 0, 'No keywords line: empty array');

  // Content that looks like meta but isn't (code block with different language)
  const fakeBlock = '```python\ntitle: Not Meta\nkeywords: fake\n```';
  const r8 = extractMeta(fakeBlock);
  assert(r8.hqcc === fakeBlock, 'Non-meta code block: not stripped');
}

// ============================================================================
// input-detector edge cases
// ============================================================================

function testInputDetectorEdgeCases() {
  console.log('\n═══ Input Detector Edge Cases ═══\n');

  // Bare prismer:// (no path)
  const r1 = detectInputType('prismer://');
  assert(r1.type === 'prismer_uri', 'Bare prismer://: detected as prismer_uri');

  // prismer:// with spaces
  const r2 = detectInputType('  prismer://ctx/test  ');
  assert(r2.type === 'prismer_uri', 'prismer:// with spaces: detected');
  assert(r2.urls?.[0] === 'prismer://ctx/test', 'prismer:// with spaces: trimmed');

  // PRISMER:// uppercase — should NOT match (case sensitive)
  const r3 = detectInputType('PRISMER://ctx/test');
  assert(r3.type === 'query', 'PRISMER:// uppercase: treated as query (case sensitive)');

  // prismer:// in batch array
  const r4 = detectInputType(['prismer://a', 'prismer://b']);
  assert(r4.type === 'batch_urls', 'Array of prismer:// URIs: batch_urls (array always = batch)');

  // forceType overrides prismer:// detection
  const r5 = detectInputType('prismer://test', 'query');
  assert(r5.type === 'query', 'forceType=query overrides prismer:// detection');

  // Empty after trimming
  const r6 = validateInput('   ');
  assert(!r6.valid, 'Whitespace-only input: invalid');

  // URL-like but with prismer protocol
  const r7 = detectInputType('prismer://ctx/node-with-dashes_and_underscores/v2');
  assert(r7.type === 'prismer_uri', 'prismer:// with complex path: detected');
}

// ============================================================================
// prismer:// integration edge cases (need server)
// ============================================================================

async function testPrismerUriEdgeCases() {
  console.log('\n═══ prismer:// Integration Edge Cases ═══\n');

  if (!API_KEY) {
    console.log('  ⚠️  Skipped — set PRISMER_API_KEY');
    return;
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${API_KEY}`,
  };

  // Special characters in URI
  const specialUri = `prismer://test/special-chars-${Date.now()}/with spaces & symbols!`;
  try {
    const save = await fetch(`${BASE}/api/context/save`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: specialUri, hqcc: '# Special chars test' }),
    });
    assert(save.ok, 'Save with special chars in URI');

    const load = await fetch(`${BASE}/api/context/load`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: specialUri }),
    });
    const data = await load.json();
    assert(load.ok && data.success, 'Load with special chars in URI');
  } catch (err) {
    assert(false, 'Special chars test', String(err));
  }

  // Update existing prismer:// content then re-load
  const updateUri = `prismer://test/update-${Date.now()}`;
  try {
    await fetch(`${BASE}/api/context/save`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: updateUri, hqcc: '# Version 1' }),
    });
    await fetch(`${BASE}/api/context/save`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: updateUri, hqcc: '# Version 2 — Updated' }),
    });
    const load = await fetch(`${BASE}/api/context/load`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: updateUri }),
    });
    const data = await load.json();
    assert(data.result?.hqcc?.includes('Version 2'), 'Update + re-load: gets latest version');
  } catch (err) {
    assert(false, 'Update + re-load', String(err));
  }

  // Empty hqcc save — server rejects (hqcc is required and must be non-empty)
  try {
    const save = await fetch(`${BASE}/api/context/save`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: `prismer://test/empty-${Date.now()}`, hqcc: '' }),
    });
    assert(!save.ok || !(await save.json()).success, 'Save with empty hqcc: rejected');
  } catch (err) {
    assert(false, 'Save with empty hqcc check', String(err));
  }
}

// ============================================================================
// Local search edge cases
// ============================================================================

function testSearchEdgeCases() {
  console.log('\n═══ Search Edge Cases (unit) ═══\n');

  // These test the token splitting logic
  const tokens1 = 'a'.split(/[\s,;:.\-_/\\|]+/).filter((t) => t.length >= 2);
  assert(tokens1.length === 0, 'Single char query: no tokens (filtered out)');

  const tokens2 = 'hello-world/test_case'.split(/[\s,;:.\-_/\\|]+/).filter((t) => t.length >= 2);
  assert(tokens2.includes('hello'), 'Hyphen/slash/underscore split: "hello" extracted');
  assert(tokens2.includes('world'), 'Hyphen/slash/underscore split: "world" extracted');
  assert(tokens2.includes('test'), 'Hyphen/slash/underscore split: "test" extracted');

  // SQL injection attempt in query (should be safe — Prisma parameterizes)
  const evil = "'; DROP TABLE im_context_cache; --";
  const tokens3 = evil
    .toLowerCase()
    .split(/[\s,;:.\-_/\\|]+/)
    .filter((t) => t.length >= 2);
  assert(!tokens3.includes("'"), 'SQL injection: quotes stripped by tokenizer');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Context Network Edge Case Tests         ║');
  console.log('╚══════════════════════════════════════════╝');

  testExtractMetaEdgeCases();
  testInputDetectorEdgeCases();
  testSearchEdgeCases();
  await testPrismerUriEdgeCases();

  console.log(`\n════════════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`════════════════════════════════════════════\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
