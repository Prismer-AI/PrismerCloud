import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LLMDispatcher,
  AllProvidersFailedError,
} from '../src/llm-dispatcher.js';
import type { LLMProvider, LLMRequest, RoutingPolicy } from '../src/llm-dispatcher.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

function makeProvider(overrides: Partial<LLMProvider> & Pick<LLMProvider, 'name' | 'invoke'>): LLMProvider {
  return {
    model: `${overrides.name}-model`,
    priority: 1,
    ...overrides,
  };
}

function okInvoke(content = 'ok', delayMs = 0) {
  return async (_req: LLMRequest, signal: AbortSignal) => {
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
      });
    }
    return {
      content,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    };
  };
}

function failInvoke() {
  return async (_req: LLMRequest, _signal: AbortSignal): Promise<never> => {
    throw new Error('provider error');
  };
}

function hangInvoke() {
  return (_req: LLMRequest, _signal: AbortSignal): Promise<never> => new Promise(() => {});
}

const BASE_POLICY: RoutingPolicy = {
  strategy: 'priority',
  retryOnFailure: true,
  maxRetries: 3,
  timeoutMs: 500,
  healthCheckIntervalMs: 60_000,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LLMDispatcher', () => {
  // ---- 1. Priority routing ------------------------------------------------
  it('priority routing: higher-priority provider called first on success', async () => {
    const called: string[] = [];

    const high = makeProvider({
      name: 'high',
      priority: 10,
      invoke: async (req, signal) => {
        called.push('high');
        return okInvoke('from-high')(req, signal);
      },
    });
    const low = makeProvider({
      name: 'low',
      priority: 1,
      invoke: async (req, signal) => {
        called.push('low');
        return okInvoke('from-low')(req, signal);
      },
    });

    const d = new LLMDispatcher([high, low], BASE_POLICY);
    const res = await d.complete(makeReq());
    d.stopHealthChecks();

    expect(res.provider).toBe('high');
    expect(res.content).toBe('from-high');
    expect(called).toEqual(['high']);
  });

  // ---- 2. Fallback on failure ---------------------------------------------
  it('fallback on failure: primary throws, secondary succeeds', async () => {
    const primary = makeProvider({
      name: 'primary',
      priority: 10,
      invoke: failInvoke(),
    });
    const secondary = makeProvider({
      name: 'secondary',
      priority: 5,
      invoke: okInvoke('secondary-content'),
    });

    const d = new LLMDispatcher([primary, secondary], BASE_POLICY);
    const res = await d.complete(makeReq());
    d.stopHealthChecks();

    expect(res.provider).toBe('secondary');
    expect(res.content).toBe('secondary-content');
  });

  // ---- 3. All fail -> AllProvidersFailedError ------------------------------
  it('all providers fail: throws AllProvidersFailedError with attempt list', async () => {
    const a = makeProvider({ name: 'a', priority: 3, invoke: failInvoke() });
    const b = makeProvider({ name: 'b', priority: 2, invoke: failInvoke() });
    const c = makeProvider({ name: 'c', priority: 1, invoke: failInvoke() });

    const d = new LLMDispatcher([a, b, c], { ...BASE_POLICY, maxRetries: 10 });

    await expect(d.complete(makeReq())).rejects.toSatisfy((e: unknown) => {
      d.stopHealthChecks();
      if (!(e instanceof AllProvidersFailedError)) return false;
      expect(e.attempts.length).toBe(3);
      expect(e.attempts.map((a) => a.provider)).toContain('a');
      expect(e.attempts.map((a) => a.provider)).toContain('b');
      expect(e.attempts.map((a) => a.provider)).toContain('c');
      return true;
    });

    d.stopHealthChecks();
  });

  // ---- 4. Timeout ----------------------------------------------------------
  it('timeout: hanging provider times out and fallback succeeds within window', async () => {
    const slow = makeProvider({
      name: 'slow',
      priority: 10,
      invoke: hangInvoke(),
    });
    const fast = makeProvider({
      name: 'fast',
      priority: 5,
      invoke: okInvoke('fast-response'),
    });

    const d = new LLMDispatcher([slow, fast], {
      ...BASE_POLICY,
      timeoutMs: 50,
    });

    const t0 = Date.now();
    const res = await d.complete(makeReq());
    const elapsed = Date.now() - t0;
    d.stopHealthChecks();

    expect(res.provider).toBe('fast');
    expect(res.content).toBe('fast-response');
    // Should have finished well within 500ms (50ms timeout + fast provider)
    expect(elapsed).toBeLessThan(500);
  });

  // ---- 5. Cost filter ------------------------------------------------------
  it('cost filter: expensive providers skipped when maxCostUsd is set', async () => {
    const called: string[] = [];

    // pricing: $1.00 per 1k input, $2.00 per 1k output — very expensive
    const expensive = makeProvider({
      name: 'expensive',
      priority: 10,
      pricing: { inputPer1kUsd: 1.0, outputPer1kUsd: 2.0 },
      invoke: async (req, signal) => { called.push('expensive'); return okInvoke()(req, signal); },
    });
    // pricing: $0.0001 per 1k — cheap
    const cheap = makeProvider({
      name: 'cheap',
      priority: 5,
      pricing: { inputPer1kUsd: 0.0001, outputPer1kUsd: 0.0001 },
      invoke: async (req, signal) => { called.push('cheap'); return okInvoke()(req, signal); },
    });

    const d = new LLMDispatcher([expensive, cheap], BASE_POLICY);
    // maxCostUsd very low: expensive provider estimated cost >> 0.001
    const res = await d.complete(makeReq({ maxCostUsd: 0.001, maxTokens: 100 }));
    d.stopHealthChecks();

    expect(called).not.toContain('expensive');
    expect(res.provider).toBe('cheap');
  });

  // ---- 6. Latency filter ---------------------------------------------------
  it('latency filter: provider with p95 > maxLatencyMs is skipped', async () => {
    const called: string[] = [];

    const slowProvider = makeProvider({
      name: 'slow-p',
      priority: 10,
      invoke: async (req, signal) => { called.push('slow-p'); return okInvoke()(req, signal); },
    });
    const fastProvider = makeProvider({
      name: 'fast-p',
      priority: 5,
      invoke: async (req, signal) => { called.push('fast-p'); return okInvoke()(req, signal); },
    });

    const d = new LLMDispatcher([slowProvider, fastProvider], BASE_POLICY);

    // Artificially populate slow-p's latency buffer with high values.
    // We do this by calling _runHealthChecksNow indirectly — but the simplest
    // approach is to make enough real invocations. Instead, use the internal
    // stats to verify, and seed via repeated calls against a delay provider.
    // Build a separate dispatcher to seed stats for slow-p.
    const seeder = makeProvider({
      name: 'slow-p',
      priority: 10,
      invoke: okInvoke('seed', 200), // 200ms each
    });
    const seedDispatcher = new LLMDispatcher([seeder], { ...BASE_POLICY, timeoutMs: 5000 });
    // Run 5 invocations to populate the rolling buffer with ~200ms latencies.
    for (let i = 0; i < 5; i++) {
      await seedDispatcher.complete(makeReq());
    }
    seedDispatcher.stopHealthChecks();

    // Now build a fresh dispatcher where slow-p has populated latency data.
    // We simulate this by creating a provider whose stats are pre-seeded via
    // the actual slow-p that takes 200ms — use the same name so stats are tracked.
    const slowSeeded = makeProvider({
      name: 'slow-p',
      priority: 10,
      invoke: okInvoke('from-slow', 200),
    });
    const fast2 = makeProvider({
      name: 'fast-p',
      priority: 5,
      invoke: async (req, signal) => { called.push('fast-p'); return okInvoke()(req, signal); },
    });
    const d2 = new LLMDispatcher([slowSeeded, fast2], { ...BASE_POLICY, timeoutMs: 5000 });
    // Seed slow-p's latency buffer within d2.
    for (let i = 0; i < 5; i++) {
      await d2.complete(makeReq());
    }
    called.length = 0; // clear call log

    // Now make a request with maxLatencyMs = 50ms — slow-p p95 should be >> 50ms.
    const res = await d2.complete(makeReq({ maxLatencyMs: 50 }));
    d2.stopHealthChecks();

    expect(res.provider).toBe('fast-p');
    expect(called).not.toContain('slow-p');
  });

  // ---- 7. Capability filter ------------------------------------------------
  it('capability filter: only providers with required capabilities are tried', async () => {
    const called: string[] = [];

    const noVision = makeProvider({
      name: 'no-vision',
      priority: 10,
      capabilities: ['text'],
      invoke: async (req, signal) => { called.push('no-vision'); return okInvoke()(req, signal); },
    });
    const withVision = makeProvider({
      name: 'with-vision',
      priority: 5,
      capabilities: ['text', 'vision'],
      invoke: async (req, signal) => { called.push('with-vision'); return okInvoke()(req, signal); },
    });

    const d = new LLMDispatcher([noVision, withVision], BASE_POLICY);
    const res = await d.complete(makeReq({ capabilities: ['vision'] }));
    d.stopHealthChecks();

    expect(called).not.toContain('no-vision');
    expect(res.provider).toBe('with-vision');
  });

  // ---- 8. Round-robin ------------------------------------------------------
  it('round-robin: 3 calls with 2 providers → each called at least once', async () => {
    const counts: Record<string, number> = { rr1: 0, rr2: 0 };

    const p1 = makeProvider({
      name: 'rr1',
      priority: 5,
      invoke: async (req, signal) => { counts.rr1++; return okInvoke()(req, signal); },
    });
    const p2 = makeProvider({
      name: 'rr2',
      priority: 5,
      invoke: async (req, signal) => { counts.rr2++; return okInvoke()(req, signal); },
    });

    const d = new LLMDispatcher([p1, p2], { ...BASE_POLICY, strategy: 'round-robin' });
    await d.complete(makeReq());
    await d.complete(makeReq());
    await d.complete(makeReq());
    d.stopHealthChecks();

    expect(counts.rr1 + counts.rr2).toBe(3);
    expect(counts.rr1).toBeGreaterThanOrEqual(1);
    expect(counts.rr2).toBeGreaterThanOrEqual(1);
  });

  // ---- 9. Cheapest strategy ------------------------------------------------
  it('cheapest strategy: lower-priced provider chosen despite lower priority', async () => {
    const called: string[] = [];

    const pricey = makeProvider({
      name: 'pricey',
      priority: 10,
      pricing: { inputPer1kUsd: 1.0, outputPer1kUsd: 2.0 },
      invoke: async (req, signal) => { called.push('pricey'); return okInvoke()(req, signal); },
    });
    const budget = makeProvider({
      name: 'budget',
      priority: 1,
      pricing: { inputPer1kUsd: 0.001, outputPer1kUsd: 0.002 },
      invoke: async (req, signal) => { called.push('budget'); return okInvoke()(req, signal); },
    });

    const d = new LLMDispatcher([pricey, budget], { ...BASE_POLICY, strategy: 'cheapest' });
    const res = await d.complete(makeReq());
    d.stopHealthChecks();

    expect(res.provider).toBe('budget');
    expect(called[0]).toBe('budget');
  });

  // ---- 10. Fastest strategy ------------------------------------------------
  it('fastest strategy: provider with lower p50 chosen after stats populated', async () => {
    const fasterProvider = makeProvider({
      name: 'faster',
      priority: 1,
      invoke: okInvoke('fast', 5),
    });
    const slowerProvider = makeProvider({
      name: 'slower',
      priority: 10,
      invoke: okInvoke('slow', 100),
    });

    const d = new LLMDispatcher([fasterProvider, slowerProvider], {
      ...BASE_POLICY,
      strategy: 'priority',
      timeoutMs: 5000,
    });
    // Seed stats: run both providers enough to establish p50 difference.
    // Start with priority strategy so both get called.
    await d.complete(makeReq()); // calls 'slower' (higher priority)
    // Force 'faster' to run by temporarily marking 'slower' down.
    d.markProviderDown('slower');
    await d.complete(makeReq());
    await d.complete(makeReq());
    await d.complete(makeReq());
    d.markProviderUp('slower');

    // Switch to fastest strategy.
    d.setPolicy({ ...BASE_POLICY, strategy: 'fastest', timeoutMs: 5000 });

    const res = await d.complete(makeReq());
    d.stopHealthChecks();

    expect(res.provider).toBe('faster');
  });

  // ---- 11. Manual circuit break -------------------------------------------
  it('markProviderDown skips that provider; markProviderUp restores it', async () => {
    const called: string[] = [];

    const p1 = makeProvider({
      name: 'p1',
      priority: 10,
      invoke: async (req, signal) => { called.push('p1'); return okInvoke()(req, signal); },
    });
    const p2 = makeProvider({
      name: 'p2',
      priority: 5,
      invoke: async (req, signal) => { called.push('p2'); return okInvoke()(req, signal); },
    });

    const d = new LLMDispatcher([p1, p2], BASE_POLICY);

    // p1 is marked down — only p2 should be tried.
    d.markProviderDown('p1');
    const res1 = await d.complete(makeReq());
    expect(res1.provider).toBe('p2');
    expect(called).not.toContain('p1');

    // Restore p1 — now it should be preferred again (higher priority).
    d.markProviderUp('p1');
    called.length = 0;
    const res2 = await d.complete(makeReq());
    d.stopHealthChecks();

    expect(res2.provider).toBe('p1');
  });

  // ---- 12. Health check integration ---------------------------------------
  it('health check: provider returning false is skipped until recovered', async () => {
    let healthy = false;
    const called: string[] = [];

    const unhealthy = makeProvider({
      name: 'unhealthy',
      priority: 10,
      invoke: async (req, signal) => { called.push('unhealthy'); return okInvoke()(req, signal); },
      healthCheck: async () => healthy,
    });
    const backup = makeProvider({
      name: 'backup',
      priority: 5,
      invoke: async (req, signal) => { called.push('backup'); return okInvoke()(req, signal); },
    });

    const d = new LLMDispatcher([unhealthy, backup], { ...BASE_POLICY, healthCheckIntervalMs: 100 });

    // Run a health check cycle — unhealthy provider returns false.
    await d._runHealthChecksNow();

    const res1 = await d.complete(makeReq());
    expect(res1.provider).toBe('backup');
    expect(called).not.toContain('unhealthy');

    // Now the provider becomes healthy.
    healthy = true;
    await d._runHealthChecksNow();
    called.length = 0;

    const res2 = await d.complete(makeReq());
    d.stopHealthChecks();
    expect(res2.provider).toBe('unhealthy');
  });

  // ---- 13. Stats tracking --------------------------------------------------
  it('stats tracking: invocations, successes, failures increment correctly', async () => {
    const good = makeProvider({ name: 'good', priority: 5, invoke: okInvoke() });
    const bad = makeProvider({ name: 'bad', priority: 10, invoke: failInvoke() });

    const d = new LLMDispatcher([good, bad], { ...BASE_POLICY, maxRetries: 5 });

    // Each call: bad is tried first (higher priority), fails, then good succeeds.
    await d.complete(makeReq());
    await d.complete(makeReq());
    await d.complete(makeReq());
    d.stopHealthChecks();

    const s = d.stats;
    expect(s['bad'].invocations).toBe(3);
    expect(s['bad'].failures).toBe(3);
    expect(s['bad'].successes).toBe(0);
    expect(s['good'].invocations).toBe(3);
    expect(s['good'].successes).toBe(3);
    expect(s['good'].failures).toBe(0);
  });

  // ---- 14. stopHealthChecks -----------------------------------------------
  it('stopHealthChecks: health interval no longer probes providers after call', async () => {
    let probeCount = 0;

    const p = makeProvider({
      name: 'watched',
      priority: 10,
      invoke: okInvoke(),
      healthCheck: async () => { probeCount++; return true; },
    });

    const d = new LLMDispatcher([p], { ...BASE_POLICY, healthCheckIntervalMs: 50 });

    // Wait one interval to let the timer fire at least once.
    await new Promise<void>((r) => setTimeout(r, 80));
    const countBefore = probeCount;

    d.stopHealthChecks();

    // Wait another interval — timer should NOT fire anymore.
    await new Promise<void>((r) => setTimeout(r, 100));
    const countAfter = probeCount;

    // After stop, no additional probes.
    expect(countAfter).toBe(countBefore);
  });

  // ---- 15. No providers pass filters -> AllProvidersFailedError with 0 attempts ----
  it('empty candidate list after filters throws AllProvidersFailedError with 0 attempts', async () => {
    const p = makeProvider({
      name: 'vision-only',
      priority: 10,
      capabilities: ['vision'],
      invoke: okInvoke(),
    });

    const d = new LLMDispatcher([p], BASE_POLICY);
    await expect(d.complete(makeReq({ capabilities: ['audio'] }))).rejects.toBeInstanceOf(AllProvidersFailedError);
    d.stopHealthChecks();
  });

  // ---- 16. retryOnFailure: false stops after first failure ----------------
  it('retryOnFailure false: stops after first failure even with more providers', async () => {
    const called: string[] = [];

    const p1 = makeProvider({
      name: 'p1',
      priority: 10,
      invoke: async (_req, _sig) => { called.push('p1'); throw new Error('fail'); },
    });
    const p2 = makeProvider({
      name: 'p2',
      priority: 5,
      invoke: async (req, sig) => { called.push('p2'); return okInvoke()(req, sig); },
    });

    const d = new LLMDispatcher([p1, p2], { ...BASE_POLICY, retryOnFailure: false });

    await expect(d.complete(makeReq())).rejects.toBeInstanceOf(AllProvidersFailedError);
    d.stopHealthChecks();

    expect(called).toEqual(['p1']);
    expect(called).not.toContain('p2');
  });

  // ---- 17. LLMResponse shape includes provider, model, latencyMs, costUsd ----
  it('successful response includes provider, model, latencyMs and optional costUsd', async () => {
    const p = makeProvider({
      name: 'shaped',
      priority: 10,
      model: 'shaped-model-v1',
      pricing: { inputPer1kUsd: 0.001, outputPer1kUsd: 0.002 },
      invoke: okInvoke('hello world'),
    });

    const d = new LLMDispatcher([p], BASE_POLICY);
    const res = await d.complete(makeReq());
    d.stopHealthChecks();

    expect(res.provider).toBe('shaped');
    expect(res.model).toBe('shaped-model-v1');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof res.costUsd).toBe('number');
    expect(res.usage.totalTokens).toBe(30);
  });

  // ---- 18. setPolicy resets round-robin counter ---------------------------
  it('setPolicy resets round-robin counter so rotation restarts', async () => {
    const calls: string[] = [];

    const rr1 = makeProvider({ name: 'rr1', priority: 5, invoke: async (req, sig) => { calls.push('rr1'); return okInvoke()(req, sig); } });
    const rr2 = makeProvider({ name: 'rr2', priority: 5, invoke: async (req, sig) => { calls.push('rr2'); return okInvoke()(req, sig); } });

    const d = new LLMDispatcher([rr1, rr2], { ...BASE_POLICY, strategy: 'round-robin' });
    await d.complete(makeReq()); // rrCounter=0 → rr1 first
    await d.complete(makeReq()); // rrCounter=1 → rr2 first

    d.setPolicy({ ...BASE_POLICY, strategy: 'round-robin' }); // resets counter
    calls.length = 0;
    await d.complete(makeReq()); // rrCounter=0 again → rr1 first
    d.stopHealthChecks();

    expect(calls[0]).toBe('rr1');
  });
});
