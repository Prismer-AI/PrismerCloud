/**
 * Prismer IM — Backplane abstraction
 *
 * Spec: docs/release200/14-messaging-state-machine-reliability.md §4.5
 *
 * Replaces the ad-hoc Redis pub/sub usage scattered across rooms.ts /
 * sync.service / event-bus with a single typed surface that has two
 * implementations:
 *
 *   • RedisBackplane   — Redis pub/sub + Redis Streams (XADD/XREADGROUP/XACK)
 *                        + per-Pod stream `pod-<podId>:queue` for unicast.
 *                        Used in prod / multi-instance dev.
 *
 *   • InMemoryBackplane — node:events EventEmitter + Map-backed streams.
 *                        Used by single-process dev (`BACKPLANE=memory`) and
 *                        unit tests that don't want a Redis dependency.
 *
 * Selector: `getBackplane()` reads env `BACKPLANE` (default `redis`).
 *
 * NOTE: This file *only* defines the interface + shared types.
 * Implementations live in `redis-backplane.ts` / `memory-backplane.ts`.
 */

/** Message envelope yielded by `consume()` handlers. */
export interface BackplaneStreamMessage {
  /** Stream-assigned message id (Redis: `1700000000000-0`; memory: incrementing). */
  id: string;
  /** Raw payload as published. JSON-encoded by callers; backplane is payload-agnostic. */
  payload: string;
}

export interface BackplaneEnqueueOpts {
  /**
   * Cap the stream length on XADD so memory usage doesn't grow unbounded.
   * Redis uses `~` (approximate trimming) for efficiency.
   */
  maxLen?: number;
}

/**
 * Common interface that the IM layer codes against. All methods are async
 * and idempotent w.r.t. caller — they may resolve before delivery in the
 * Redis case (fire-and-forget pub/sub semantics) and synchronously in
 * the InMemory case.
 */
export interface Backplane {
  /** Pub/sub broadcast — every connected subscriber gets the payload. */
  publish(channel: string, payload: string): Promise<void>;

  /** Pub/sub subscribe — `channelPattern` supports `*` glob (Redis PSUBSCRIBE). */
  subscribe(
    channelPattern: string,
    handler: (channel: string, payload: string) => void | Promise<void>,
  ): Promise<void>;

  /**
   * Append a message to a durable stream. Returns stream-assigned msgId.
   * Multiple consumers in the same `group` see each message exactly once
   * (via `consume()`).
   */
  enqueue(stream: string, payload: string, opts?: BackplaneEnqueueOpts): Promise<string>;

  /**
   * Start a consumer that pulls messages from `stream` for `group` (creates
   * the group if it doesn't exist). The handler MUST return `true` for the
   * message to be ACK'd (XACK); returning `false` (or throwing) leaves it
   * pending so it can be re-delivered to another consumer in the group.
   *
   * `consume()` is non-blocking — it spawns a long-running polling loop
   * internally and resolves once the loop is started. Call `close()` to
   * stop it.
   */
  consume(
    stream: string,
    group: string,
    consumer: string,
    handler: (msg: BackplaneStreamMessage) => Promise<boolean>,
  ): Promise<void>;

  /**
   * Unicast — push `payload` to a specific Pod's queue. Implemented on top
   * of `enqueue()`/`consume()` with a per-Pod stream name
   * (`pod-<podId>:queue`).
   */
  sendToPod(podId: string, payload: string): Promise<void>;

  /**
   * Register the local Pod as a consumer of its own pod stream. Should be
   * called once at startup with `podId = ME`. The handler receives raw
   * payloads (JSON-encoded by the sender, typically
   * `{targetUserId, payload}`).
   */
  registerPodChannel(podId: string, handler: (payload: string) => void | Promise<void>): Promise<void>;

  /** Graceful shutdown — stop all consume loops + close subscribers. */
  close(): Promise<void>;
}

/**
 * Single source of truth for the Pod ID. Used by RoomManager + WS handler
 * to:
 *   • register a per-Pod backplane channel (so other Pods can unicast TO us)
 *   • record `im:user:<userId>:pods` membership on ws.connect/disconnect
 *   • skip self-delivery when fanning out
 *
 * Override via env `POD_ID` (k8s downward API) so the same node process
 * starting twice in a 2-pod integration test gets distinct ids.
 */
export function getPodId(): string {
  return process.env.POD_ID || process.env.HOSTNAME || `pod-${process.pid}`;
}

/**
 * Per-user Pod-membership key. Wave-4 E3 uses Redis SADD/SREM on this key
 * so any Pod can answer "which Pods host user X?" without a broadcast.
 */
export function userPodsKey(userId: string): string {
  return `im:user:${userId}:pods`;
}

/** Per-Pod unicast stream name. Used by sendToPod / registerPodChannel. */
export function podStreamKey(podId: string): string {
  return `pod-${podId}:queue`;
}
