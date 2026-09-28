// recallStats — process-level recall observability counters (doc 18 §8).
//
// Surfaced verbatim on /healthz so the cloud `daemon-state` debug endpoint
// transparently透传 them. Additive: when nothing has fired the snapshot is all
// zeros / nulls, so older consumers see a stable shape.
//
// Counter semantics (doc 18 §8 v8.1 口径):
//   - toolRecallCount   agent-driven `memory_search`/`memory_load` calls (P0
//                       main path — "did the agent self-recall?")
//   - shadowFiredCount  pre_llm_call recall computed in SHADOW (照算不注入)
//   - coreInjectBytes   current byte size of the bounded core-inject body
//                       (MEMORY.md managed section) last written
//   - providerPath      which正门 is active: 'shadow' (A=hook observe) /
//                       'tools' (B recall-tools registered) / 'core' (C
//                       managed-section core-inject) / 'inject' (legacy真注入)
//
// In-process singleton (the daemon is single-process single-thread). Kept tiny
// and dependency-free so the hot recall path can bump a counter without I/O.

export type RecallProviderPath = 'inject' | 'shadow' | 'tools' | 'core';

export interface RecallStatsSnapshot {
  /** Agent-driven memory_search/memory_load tool calls (P0 main path). */
  toolRecallCount: number;
  /** ISO timestamp of the last agent tool recall, or null. */
  toolRecallLastAt: string | null;
  /** pre_llm_call recall computed in shadow (照算不注入). */
  shadowFiredCount: number;
  /** ISO timestamp of the last shadow recall, or null. */
  shadowLastAt: string | null;
  /** Byte size of the last core-inject managed-section body written. */
  coreInjectBytes: number;
  /** Active provider正门 path (doc 18 §4a). */
  providerPath: RecallProviderPath;
}

class RecallStats {
  private toolRecallCount = 0;
  private toolRecallLastAt: string | null = null;
  private shadowFiredCount = 0;
  private shadowLastAt: string | null = null;
  private coreInjectBytes = 0;
  private providerPath: RecallProviderPath = 'inject';

  /** Record an agent-driven recall tool call (memory_search / memory_load). */
  recordToolRecall(): void {
    this.toolRecallCount += 1;
    this.toolRecallLastAt = new Date().toISOString();
    // The first observed agent tool call proves the recall-tools正门 is live.
    if (this.providerPath === 'inject' || this.providerPath === 'shadow') {
      this.providerPath = 'tools';
    }
  }

  /** Record a shadow recall pass (computed, not injected). */
  recordShadowFired(): void {
    this.shadowFiredCount += 1;
    this.shadowLastAt = new Date().toISOString();
    if (this.providerPath === 'inject') this.providerPath = 'shadow';
  }

  /** Record the byte size of the latest core-inject managed-section write. */
  recordCoreInject(bytes: number): void {
    this.coreInjectBytes = Math.max(0, bytes);
    if (this.providerPath !== 'tools') this.providerPath = 'core';
  }

  /** Explicitly pin the active provider path (e.g. when the B provider registers). */
  setProviderPath(path: RecallProviderPath): void {
    this.providerPath = path;
  }

  snapshot(): RecallStatsSnapshot {
    return {
      toolRecallCount: this.toolRecallCount,
      toolRecallLastAt: this.toolRecallLastAt,
      shadowFiredCount: this.shadowFiredCount,
      shadowLastAt: this.shadowLastAt,
      coreInjectBytes: this.coreInjectBytes,
      providerPath: this.providerPath,
    };
  }

  /** Reset to zeros — test-only. */
  reset(): void {
    this.toolRecallCount = 0;
    this.toolRecallLastAt = null;
    this.shadowFiredCount = 0;
    this.shadowLastAt = null;
    this.coreInjectBytes = 0;
    this.providerPath = 'inject';
  }
}

let SINGLETON: RecallStats | null = null;

export function getRecallStats(): RecallStats {
  if (!SINGLETON) SINGLETON = new RecallStats();
  return SINGLETON;
}

/** Convenience snapshot for /healthz wiring. Always returns a stable shape. */
export function recallStatsSnapshot(): RecallStatsSnapshot {
  return getRecallStats().snapshot();
}
