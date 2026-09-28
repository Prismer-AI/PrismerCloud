/**
 * device-metrics/interval.ts — G2-R R-1 (docs/bugfix211/g2-terminal-and-monitor-spec.md §R-1).
 *
 * Sampling-interval resolution for the device-metrics plugin module.
 *
 * The interval is ConfigDelivery-able: cloud can hand the daemon
 * `PRISMER_DEVICE_METRICS_INTERVAL_MS` through the runtime env surface (pod
 * env / bundle env overlay). Resolution is pure so unit tests pin the
 * contract: default 10s, hard floor 2s (a misconfigured 100ms poll must not
 * turn telemetry into a self-inflicted DoS), garbage falls back to the
 * default instead of throwing.
 */

export const DEFAULT_DEVICE_METRICS_INTERVAL_MS = 10_000;
export const MIN_DEVICE_METRICS_INTERVAL_MS = 2_000;

export function resolveDeviceMetricsIntervalMs(raw?: unknown): number {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_DEVICE_METRICS_INTERVAL_MS;
  }
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return DEFAULT_DEVICE_METRICS_INTERVAL_MS;
  if (n < MIN_DEVICE_METRICS_INTERVAL_MS) return MIN_DEVICE_METRICS_INTERVAL_MS;
  return n;
}
