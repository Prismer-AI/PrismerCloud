/**
 * Moonshot / Kimi K2.5 API — 性能基准测试
 *
 * 官方宣称指标：
 *   Concurrency: 400
 *   TPM: 4,000,000 (tokens/min)
 *   RPM: 5,000 (requests/min)
 *   TPD: Unlimited
 *
 * 测试项：
 *   1. TTFT (Time To First Token) — 流式首 token 延迟
 *   2. TPS (Tokens Per Second) — 单请求输出吞吐
 *   3. E2E Latency — 非流式端到端延迟
 *   4. Concurrency Ramp — 从 1→N 并发压测，找到实际吞吐拐点
 *   5. Tool Call Overhead — tool calling 额外延迟
 *
 * 用法：
 *   npx tsx scripts/bench-moonshot-api.ts
 *   npx tsx scripts/bench-moonshot-api.ts --only=ttft,tps
 *   npx tsx scripts/bench-moonshot-api.ts --concurrency=50
 *   npx tsx scripts/bench-moonshot-api.ts --rounds=5
 */

// ─── Config ─────────────────────────────────────────────

const API_KEY = process.env.MOONSHOT_API_KEY || 'sk-REDACTED';
const BASE_URL = process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.ai/v1';
const MODEL = process.env.MOONSHOT_MODEL || 'kimi-k2.5';

// CLI args
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? 'true']; })
);
const ONLY = args.only?.split(',') ?? null;
const MAX_CONCURRENCY = parseInt(args.concurrency || '50', 10);
const ROUNDS = parseInt(args.rounds || '3', 10);

// ─── Minimal Client (inline, no import dependency) ──────

const headers = { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
const isK25 = MODEL.includes('k2.5') || MODEL.includes('k2-5');

async function chatRaw(messages: Array<{ role: string; content: string }>, opts: {
  stream?: boolean; max_tokens?: number; tools?: unknown[];
} = {}): Promise<Response> {
  const body: Record<string, unknown> = {
    model: MODEL,
    messages,
    stream: opts.stream ?? false,
    ...(opts.max_tokens && { max_tokens: opts.max_tokens }),
    ...(opts.tools && { tools: opts.tools }),
  };
  if (!isK25) body.temperature = 0;
  return fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
}

// ─── Stats Helpers ──────────────────────────────────────

interface LatencyStats {
  min: number; max: number; mean: number;
  p50: number; p90: number; p99: number;
  samples: number;
}

function computeStats(values: number[]): LatencyStats {
  if (values.length === 0) return { min: 0, max: 0, mean: 0, p50: 0, p90: 0, p99: 0, samples: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    min: sorted[0],
    max: sorted[n - 1],
    mean: Math.round(sorted.reduce((a, b) => a + b, 0) / n),
    p50: sorted[Math.floor(n * 0.5)],
    p90: sorted[Math.floor(n * 0.9)],
    p99: sorted[Math.floor(n * 0.99)],
    samples: n,
  };
}

function fmtMs(ms: number): string { return `${ms}ms`; }
function fmtStats(s: LatencyStats): string {
  return `min=${fmtMs(s.min)} p50=${fmtMs(s.p50)} p90=${fmtMs(s.p90)} p99=${fmtMs(s.p99)} max=${fmtMs(s.max)} (n=${s.samples})`;
}

// ─── Bench 1: TTFT (Time To First Token) ────────────────

async function benchTTFT() {
  console.log('\n── TTFT (Time To First Token) ──────────────────');
  const prompt = 'Say "hello" and nothing else.';
  const ttfts: number[] = [];
  const totalTimes: number[] = [];
  const outputTokens: number[] = [];

  for (let i = 0; i < ROUNDS; i++) {
    const t0 = performance.now();
    let ttft = 0;
    let tokens = 0;

    const res = await chatRaw([{ role: 'user', content: prompt }], { stream: true, max_tokens: 100 });
    if (!res.ok) { console.log(`  ❌ Round ${i + 1}: ${res.status}`); continue; }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let firstToken = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') continue;
        try {
          const chunk = JSON.parse(trimmed.slice(6));
          const delta = chunk.choices?.[0]?.delta;
          if ((delta?.content || delta?.reasoning_content) && !firstToken) {
            ttft = Math.round(performance.now() - t0);
            firstToken = true;
          }
          if (delta?.content) tokens++;
          if (chunk.usage?.completion_tokens) tokens = chunk.usage.completion_tokens;
        } catch {}
      }
    }

    const total = Math.round(performance.now() - t0);
    if (ttft > 0) ttfts.push(ttft);
    totalTimes.push(total);
    outputTokens.push(tokens);
    console.log(`  Round ${i + 1}/${ROUNDS}: TTFT=${fmtMs(ttft)} Total=${fmtMs(total)} Tokens=${tokens}`);
  }

  console.log(`  TTFT:  ${fmtStats(computeStats(ttfts))}`);
  console.log(`  Total: ${fmtStats(computeStats(totalTimes))}`);
}

// ─── Bench 2: TPS (Tokens Per Second, 长输出) ──────────

async function benchTPS() {
  console.log('\n── TPS (Output Tokens/Second) ──────────────────');
  const prompt = 'Write a detailed 500-word essay about artificial intelligence history. Be thorough.';
  const tpsValues: number[] = [];

  for (let i = 0; i < ROUNDS; i++) {
    const t0 = performance.now();
    let firstTokenTime = 0;
    let tokenCount = 0;

    const res = await chatRaw([{ role: 'user', content: prompt }], { stream: true, max_tokens: 800 });
    if (!res.ok) { console.log(`  ❌ Round ${i + 1}: ${res.status}`); continue; }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') continue;
        try {
          const chunk = JSON.parse(trimmed.slice(6));
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            if (!firstTokenTime) firstTokenTime = performance.now();
            tokenCount++;
          }
          if (chunk.usage?.completion_tokens) tokenCount = chunk.usage.completion_tokens;
        } catch {}
      }
    }

    const total = performance.now() - t0;
    const genTime = firstTokenTime ? performance.now() - firstTokenTime : total;
    const tps = tokenCount > 0 ? Math.round(tokenCount / (genTime / 1000)) : 0;
    tpsValues.push(tps);
    console.log(`  Round ${i + 1}/${ROUNDS}: ${tokenCount} tokens in ${Math.round(genTime)}ms → ${tps} tok/s (total ${Math.round(total)}ms)`);
  }

  const stats = computeStats(tpsValues);
  console.log(`  TPS:   min=${stats.min} p50=${stats.p50} mean=${stats.mean} max=${stats.max} tok/s`);
}

// ─── Bench 3: E2E Latency (非流式) ─────────────────────

async function benchE2E() {
  console.log('\n── E2E Latency (Non-Streaming) ─────────────────');
  const prompt = 'What is 2+2? Reply with just the number.';
  const latencies: number[] = [];

  for (let i = 0; i < ROUNDS; i++) {
    const t0 = performance.now();
    const res = await chatRaw([{ role: 'user', content: prompt }], { max_tokens: 50 });
    const elapsed = Math.round(performance.now() - t0);

    if (!res.ok) { console.log(`  ❌ Round ${i + 1}: ${res.status}`); continue; }
    const json = await res.json();
    const tokens = json.usage?.completion_tokens ?? '?';
    latencies.push(elapsed);
    console.log(`  Round ${i + 1}/${ROUNDS}: ${fmtMs(elapsed)} (${tokens} output tokens)`);
  }

  console.log(`  E2E:   ${fmtStats(computeStats(latencies))}`);
}

// ─── Bench 4: Concurrency Ramp ──────────────────────────

async function benchConcurrency() {
  console.log('\n── Concurrency Ramp ────────────────────────────');
  console.log(`  Max target: ${MAX_CONCURRENCY} concurrent requests`);

  const prompt = 'Reply with "ok".';
  const levels = [1, 5, 10, 20, 50, 100, 200].filter(n => n <= MAX_CONCURRENCY);

  console.log(`  ${'Level'.padStart(6)} | ${'OK'.padStart(4)} | ${'Fail'.padStart(4)} | ${'429s'.padStart(4)} | ${'Wall'.padStart(8)} | ${'Avg'.padStart(8)} | ${'p90'.padStart(8)} | RPS`);
  console.log(`  ${'─'.repeat(6)} | ${'─'.repeat(4)} | ${'─'.repeat(4)} | ${'─'.repeat(4)} | ${'─'.repeat(8)} | ${'─'.repeat(8)} | ${'─'.repeat(8)} | ───`);

  for (const n of levels) {
    const t0 = performance.now();
    let ok = 0, fail = 0, rateLimited = 0;
    const latencies: number[] = [];

    const tasks = Array.from({ length: n }, async () => {
      const t = performance.now();
      try {
        const res = await chatRaw([{ role: 'user', content: prompt }], { max_tokens: 10 });
        const elapsed = Math.round(performance.now() - t);
        if (res.ok) {
          ok++;
          latencies.push(elapsed);
          await res.json(); // consume body
        } else {
          const status = res.status;
          if (status === 429) rateLimited++;
          else fail++;
          await res.text(); // consume body
        }
      } catch {
        fail++;
      }
    });

    await Promise.all(tasks);
    const wall = Math.round(performance.now() - t0);
    const stats = computeStats(latencies);
    const rps = ok > 0 ? (ok / (wall / 1000)).toFixed(1) : '0';

    console.log(`  ${String(n).padStart(6)} | ${String(ok).padStart(4)} | ${String(fail).padStart(4)} | ${String(rateLimited).padStart(4)} | ${fmtMs(wall).padStart(8)} | ${fmtMs(stats.mean).padStart(8)} | ${fmtMs(stats.p90).padStart(8)} | ${rps}`);

    // Stop ramping if too many failures
    if (rateLimited > n * 0.5) {
      console.log(`  ⚠ >50% rate-limited at concurrency=${n}, stopping ramp`);
      break;
    }
  }
}

// ─── Bench 5: Tool Call Overhead ────────────────────────

async function benchToolOverhead() {
  console.log('\n── Tool Call Overhead ───────────────────────────');
  const simplePrompt = 'What is the capital of France? One word.';
  const toolPrompt = "What's the weather in Paris right now?";
  const tools = [{
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description: 'Get current weather',
      parameters: { type: 'object', required: ['city'], properties: { city: { type: 'string' } } },
    },
  }];

  const noToolLatencies: number[] = [];
  const toolLatencies: number[] = [];

  for (let i = 0; i < ROUNDS; i++) {
    // Without tools
    let t0 = performance.now();
    let res = await chatRaw([{ role: 'user', content: simplePrompt }], { max_tokens: 20 });
    if (res.ok) { await res.json(); noToolLatencies.push(Math.round(performance.now() - t0)); }
    else await res.text();

    // With tools (first turn only — until model emits tool_calls)
    t0 = performance.now();
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: toolPrompt }],
        tools, tool_choice: 'auto',
        stream: false,
      }),
    });
    if (res.ok) { await res.json(); toolLatencies.push(Math.round(performance.now() - t0)); }
    else await res.text();
  }

  const noTool = computeStats(noToolLatencies);
  const withTool = computeStats(toolLatencies);
  console.log(`  No tools:   ${fmtStats(noTool)}`);
  console.log(`  With tools: ${fmtStats(withTool)}`);
  const overhead = withTool.mean > 0 && noTool.mean > 0
    ? `+${Math.round(((withTool.mean - noTool.mean) / noTool.mean) * 100)}%`
    : 'N/A';
  console.log(`  Overhead:   ${overhead} (mean)`);
}

// ─── Runner ─────────────────────────────────────────────

const ALL_BENCHES: Record<string, () => Promise<void>> = {
  ttft: benchTTFT,
  tps: benchTPS,
  e2e: benchE2E,
  concurrency: benchConcurrency,
  'tool-overhead': benchToolOverhead,
};

async function main() {
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║   Moonshot / Kimi K2.5 — Performance Benchmark     ║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log(`  Base URL:     ${BASE_URL}`);
  console.log(`  Model:        ${MODEL}`);
  console.log(`  Rounds:       ${ROUNDS}`);
  console.log(`  Max Concur:   ${MAX_CONCURRENCY}`);
  console.log(`  Official:     Concurrency=400 TPM=4M RPM=5000`);

  const t0 = performance.now();

  for (const [name, fn] of Object.entries(ALL_BENCHES)) {
    if (ONLY && !ONLY.includes(name)) continue;
    try {
      await fn();
    } catch (err) {
      console.log(`\n  ❌ ${name} crashed: ${err instanceof Error ? err.message : err}`);
    }
  }

  const totalSec = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`\n════════════════════════════════════════════════════`);
  console.log(`  Done in ${totalSec}s`);
  console.log(`════════════════════════════════════════════════════\n`);
}

main().catch(console.error);
