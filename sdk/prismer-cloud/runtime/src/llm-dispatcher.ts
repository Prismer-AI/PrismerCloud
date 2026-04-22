// T9 — LLM Dispatcher: routes complete() calls across multiple providers
// with priority/fallback/cost/latency policies.

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  maxCostUsd?: number;
  maxLatencyMs?: number;
  capabilities?: string[];
}

export interface LLMResponse {
  content: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  provider: string;
  model: string;
  latencyMs: number;
  costUsd?: number;
}

export interface LLMProvider {
  name: string;
  model: string;
  priority: number;
  capabilities?: string[];
  pricing?: { inputPer1kUsd: number; outputPer1kUsd: number };
  invoke: (req: LLMRequest, signal: AbortSignal) => Promise<Omit<LLMResponse, 'provider' | 'model' | 'latencyMs'>>;
  healthCheck?: () => Promise<boolean>;
}

export interface RoutingPolicy {
  strategy: 'priority' | 'cheapest' | 'fastest' | 'round-robin';
  retryOnFailure?: boolean;
  maxRetries?: number;
  healthCheckIntervalMs?: number;
  timeoutMs?: number;
}

export interface ProviderStats {
  invocations: number;
  successes: number;
  failures: number;
  p50Ms: number;
  p95Ms: number;
  avgCostUsd: number;
}

export class AllProvidersFailedError extends Error {
  attempts: Array<{ provider: string; error: string }>;

  constructor(attempts: AllProvidersFailedError['attempts']) {
    super(`All ${attempts.length} providers failed`);
    this.name = 'AllProvidersFailedError';
    this.attempts = attempts;
  }
}

// Circular buffer for rolling window of last N values.
class RollingBuffer {
  private buf: number[];
  private pos = 0;
  private len = 0;
  private readonly cap: number;

  constructor(capacity: number) {
    this.cap = capacity;
    this.buf = new Array<number>(capacity).fill(0);
  }

  push(val: number): void {
    this.buf[this.pos] = val;
    this.pos = (this.pos + 1) % this.cap;
    if (this.len < this.cap) this.len++;
  }

  get count(): number {
    return this.len;
  }

  sorted(): number[] {
    return this.buf.slice(0, this.len).sort((a, b) => a - b);
  }

  sum(): number {
    return this.buf.slice(0, this.len).reduce((a, b) => a + b, 0);
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

const ROLLING_WINDOW = 100;
const COST_HEURISTIC_MAX_TOKENS = 1024;
const DEFAULT_HEALTH_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;

function applyPolicyDefaults(policy: RoutingPolicy): Required<RoutingPolicy> {
  return {
    strategy: policy.strategy,
    retryOnFailure: policy.retryOnFailure !== undefined ? policy.retryOnFailure : true,
    maxRetries: policy.maxRetries !== undefined ? policy.maxRetries : DEFAULT_MAX_RETRIES,
    healthCheckIntervalMs: policy.healthCheckIntervalMs !== undefined ? policy.healthCheckIntervalMs : DEFAULT_HEALTH_INTERVAL_MS,
    timeoutMs: policy.timeoutMs !== undefined ? policy.timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

interface ProviderState {
  manualDown: boolean;
  healthDown: boolean;
  healthDownUntil: number; // timestamp; 0 = not set
  latencies: RollingBuffer;
  costs: RollingBuffer;
  invocations: number;
  successes: number;
  failures: number;
}

export class LLMDispatcher {
  private readonly providers: LLMProvider[];
  private policy: Required<RoutingPolicy>;
  private readonly state: Map<string, ProviderState> = new Map();
  private rrCounter = 0;
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(providers: LLMProvider[], policy?: RoutingPolicy) {
    this.providers = providers.slice();
    this.policy = applyPolicyDefaults(policy ?? { strategy: 'priority' });

    for (const p of this.providers) {
      this.state.set(p.name, {
        manualDown: false,
        healthDown: false,
        healthDownUntil: 0,
        latencies: new RollingBuffer(ROLLING_WINDOW),
        costs: new RollingBuffer(ROLLING_WINDOW),
        invocations: 0,
        successes: 0,
        failures: 0,
      });
    }

    this.startHealthChecks();
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const ordered = this.selectProviders(req);

    if (ordered.length === 0) {
      throw new AllProvidersFailedError([]);
    }

    const shouldRetry = this.policy.retryOnFailure !== false;
    const maxAttempts = shouldRetry ? 1 + (this.policy.maxRetries ?? DEFAULT_MAX_RETRIES) : 1;
    const attempts: Array<{ provider: string; error: string }> = [];
    const timeoutMs = this.policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    for (let i = 0; i < ordered.length && attempts.length < maxAttempts; i++) {
      const provider = ordered[i];
      const st = this.state.get(provider.name)!;
      st.invocations++;

      const ac = new AbortController();
      const t0 = performance.now();

      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          const t = setTimeout(() => {
            ac.abort();
            reject(new Error(`provider timeout after ${timeoutMs}ms`));
          }, timeoutMs);
          // Allow the timer to be cleaned up if invoke resolves first.
          if (t.unref) t.unref();
        });

        const partial = await Promise.race([provider.invoke(req, ac.signal), timeoutPromise]);
        const latencyMs = Math.round(performance.now() - t0);

        const costUsd = computeCost(provider, partial.usage);
        st.latencies.push(latencyMs);
        if (costUsd !== undefined) st.costs.push(costUsd);
        st.successes++;

        if (this.policy.strategy === 'round-robin') {
          this.rrCounter++;
        }

        return {
          ...partial,
          provider: provider.name,
          model: provider.model,
          latencyMs,
          costUsd,
        };
      } catch (err: unknown) {
        st.failures++;
        const msg = err instanceof Error ? err.message : String(err);
        attempts.push({ provider: provider.name, error: msg });

        if (!shouldRetry) break;
      }
    }

    throw new AllProvidersFailedError(attempts);
  }

  get stats(): Record<string, ProviderStats> {
    const result: Record<string, ProviderStats> = {};
    for (const p of this.providers) {
      const st = this.state.get(p.name)!;
      const sortedLat = st.latencies.sorted();
      const sortedCost = st.costs.sorted();
      result[p.name] = {
        invocations: st.invocations,
        successes: st.successes,
        failures: st.failures,
        p50Ms: percentile(sortedLat, 50),
        p95Ms: percentile(sortedLat, 95),
        avgCostUsd: st.costs.count > 0 ? st.costs.sum() / st.costs.count : 0,
      };
    }
    return result;
  }

  setPolicy(policy: RoutingPolicy): void {
    this.policy = applyPolicyDefaults(policy);
    // Reset round-robin counter when strategy changes.
    this.rrCounter = 0;
    // Restart health checks with potentially new interval.
    this.stopHealthChecks();
    this.startHealthChecks();
  }

  markProviderDown(name: string): void {
    const st = this.state.get(name);
    if (st) st.manualDown = true;
  }

  markProviderUp(name: string): void {
    const st = this.state.get(name);
    if (st) {
      st.manualDown = false;
      st.healthDown = false;
      st.healthDownUntil = 0;
    }
  }

  stopHealthChecks(): void {
    if (this.healthTimer !== null) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private startHealthChecks(): void {
    const interval = this.policy.healthCheckIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
    const providersWithCheck = this.providers.filter((p) => p.healthCheck !== undefined);
    if (providersWithCheck.length === 0) return;

    this.healthTimer = setInterval(() => {
      void this.runHealthChecks(interval);
    }, interval);

    // Do not hold the event loop open for health checks.
    if (this.healthTimer.unref) {
      this.healthTimer.unref();
    }
  }

  private async runHealthChecks(intervalMs: number): Promise<void> {
    for (const p of this.providers) {
      if (!p.healthCheck) continue;
      const st = this.state.get(p.name)!;

      // If previously health-down, check if TTL expired (auto-recover probe).
      if (st.healthDown && st.healthDownUntil > 0 && Date.now() >= st.healthDownUntil) {
        st.healthDown = false;
        st.healthDownUntil = 0;
      }

      try {
        const healthy = await p.healthCheck();
        if (!healthy) {
          st.healthDown = true;
          st.healthDownUntil = Date.now() + intervalMs;
        } else {
          st.healthDown = false;
          st.healthDownUntil = 0;
        }
      } catch {
        st.healthDown = true;
        st.healthDownUntil = Date.now() + intervalMs;
      }
    }
  }

  // Trigger a health check round immediately (used in tests with fake timers).
  async _runHealthChecksNow(): Promise<void> {
    await this.runHealthChecks(this.policy.healthCheckIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS);
  }

  private isDown(name: string): boolean {
    const st = this.state.get(name);
    if (!st) return true;
    if (st.manualDown) return true;
    if (st.healthDown) {
      // Auto-recover if TTL has passed.
      if (st.healthDownUntil > 0 && Date.now() >= st.healthDownUntil) {
        st.healthDown = false;
        st.healthDownUntil = 0;
        return false;
      }
      return true;
    }
    return false;
  }

  private estimateCostUsd(provider: LLMProvider, req: LLMRequest): number | undefined {
    if (!provider.pricing) return undefined;
    // Rough prompt token heuristic: sum of chars / 4.
    const promptChars = req.messages.reduce((s, m) => s + m.content.length, 0);
    const promptTokens = Math.ceil(promptChars / 4);
    const completionTokens = req.maxTokens ?? COST_HEURISTIC_MAX_TOKENS;
    return (
      (promptTokens / 1000) * provider.pricing.inputPer1kUsd +
      (completionTokens / 1000) * provider.pricing.outputPer1kUsd
    );
  }

  private selectProviders(req: LLMRequest): LLMProvider[] {
    let candidates = this.providers.filter((p) => !this.isDown(p.name));

    // Capability filter.
    if (req.capabilities && req.capabilities.length > 0) {
      candidates = candidates.filter((p) => {
        const caps = p.capabilities ?? [];
        return req.capabilities!.every((c) => caps.includes(c));
      });
    }

    // Cost filter.
    if (req.maxCostUsd !== undefined) {
      candidates = candidates.filter((p) => {
        const est = this.estimateCostUsd(p, req);
        if (est === undefined) return true; // no pricing info — allow through
        return est <= req.maxCostUsd!;
      });
    }

    // Latency filter.
    if (req.maxLatencyMs !== undefined) {
      candidates = candidates.filter((p) => {
        const st = this.state.get(p.name)!;
        if (st.latencies.count === 0) return true; // no data yet — allow through
        const sortedLat = st.latencies.sorted();
        return percentile(sortedLat, 95) <= req.maxLatencyMs!;
      });
    }

    // Sort by strategy.
    switch (this.policy.strategy) {
      case 'priority':
        candidates.sort((a, b) => b.priority - a.priority);
        break;

      case 'cheapest':
        candidates.sort((a, b) => {
          const ca = this.estimateCostUsd(a, req) ?? 0;
          const cb = this.estimateCostUsd(b, req) ?? 0;
          return ca !== cb ? ca - cb : b.priority - a.priority;
        });
        break;

      case 'fastest': {
        candidates.sort((a, b) => {
          const sta = this.state.get(a.name)!;
          const stb = this.state.get(b.name)!;
          const pa50 = sta.latencies.count > 0 ? percentile(sta.latencies.sorted(), 50) : Infinity;
          const pb50 = stb.latencies.count > 0 ? percentile(stb.latencies.sorted(), 50) : Infinity;
          return pa50 !== pb50 ? pa50 - pb50 : b.priority - a.priority;
        });
        break;
      }

      case 'round-robin': {
        if (candidates.length === 0) break;
        // Rotate the start index by rrCounter mod count.
        const start = this.rrCounter % candidates.length;
        candidates = [...candidates.slice(start), ...candidates.slice(0, start)];
        break;
      }
    }

    return candidates;
  }
}

function computeCost(
  provider: LLMProvider,
  usage: { promptTokens: number; completionTokens: number },
): number | undefined {
  if (!provider.pricing) return undefined;
  return (
    (usage.promptTokens / 1000) * provider.pricing.inputPer1kUsd +
    (usage.completionTokens / 1000) * provider.pricing.outputPer1kUsd
  );
}
