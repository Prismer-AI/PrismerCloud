/**
 * Prismer IM — RedisBackplane
 *
 * Spec: docs/release200/14-messaging-state-machine-reliability.md §4.5
 *
 * pub/sub  → ioredis PUBLISH / SUBSCRIBE
 * stream   → XADD MAXLEN ~ ... + XGROUP CREATE / XREADGROUP / XACK
 * sendToPod / registerPodChannel → unicast stream `pod-<podId>:queue`
 *
 * Failure semantics
 * -----------------
 * publish — if redis is down, errors are swallowed (sync.service.publishRetries
 *           pattern). Caller can't block on a non-critical fan-out.
 * enqueue — same. The persisted sync_event in MySQL is the SOT, not the stream.
 * consume — loop catches errors, logs, sleeps 1s, retries. The consumer group
 *           guarantees at-least-once even if a handler crashes mid-loop.
 */

import type Redis from 'ioredis';
import { podStreamKey, type Backplane, type BackplaneEnqueueOpts, type BackplaneStreamMessage } from './backplane';

const log = (msg: string, ...args: unknown[]) => console.log(`[RedisBackplane] ${msg}`, ...args);
const warn = (msg: string, ...args: unknown[]) => console.warn(`[RedisBackplane] ${msg}`, ...args);

/** Default stream cap if caller doesn't specify maxLen. */
const DEFAULT_STREAM_MAXLEN = 10_000;
/** XREADGROUP BLOCK ms — long-poll so we don't burn CPU. */
const STREAM_BLOCK_MS = 5_000;
/** Per-read batch size. */
const STREAM_BATCH = 32;
/** Sleep after a handler error to avoid hot-loop. */
const ERROR_SLEEP_MS = 1_000;

interface ConsumerLoop {
  stop(): void;
  promise: Promise<void>;
}

export class RedisBackplane implements Backplane {
  private subscriber: Redis;
  private pSubscriber: Redis;
  private streamConsumer: Redis;
  private consumeLoops: ConsumerLoop[] = [];
  private patternHandlers = new Map<string, Array<(channel: string, payload: string) => void | Promise<void>>>();
  private channelHandlers = new Map<string, Array<(channel: string, payload: string) => void | Promise<void>>>();
  private closed = false;

  /**
   * @param redis  primary client (used for publish + XADD only)
   *               Caller is responsible for connecting it.
   */
  constructor(private redis: Redis) {
    // Duplicate connections — Redis pub/sub + XREADGROUP BLOCK both
    // exclusively occupy a connection.
    this.subscriber = redis.duplicate();
    this.pSubscriber = redis.duplicate();
    this.streamConsumer = redis.duplicate();

    this.subscriber.on('message', (channel: string, payload: string) => {
      const handlers = this.channelHandlers.get(channel);
      if (!handlers) return;
      for (const h of handlers) {
        Promise.resolve(h(channel, payload)).catch((err) =>
          warn(`Subscriber handler error on ${channel}:`, (err as Error).message),
        );
      }
    });

    this.pSubscriber.on('pmessage', (pattern: string, channel: string, payload: string) => {
      const handlers = this.patternHandlers.get(pattern);
      if (!handlers) return;
      for (const h of handlers) {
        Promise.resolve(h(channel, payload)).catch((err) =>
          warn(`PSub handler error on ${pattern}:`, (err as Error).message),
        );
      }
    });

    log('initialized');
  }

  async publish(channel: string, payload: string): Promise<void> {
    if (this.closed) return;
    try {
      await this.redis.publish(channel, payload);
    } catch (err) {
      warn(`publish ${channel} failed (non-fatal):`, (err as Error).message);
    }
  }

  async subscribe(
    channelPattern: string,
    handler: (channel: string, payload: string) => void | Promise<void>,
  ): Promise<void> {
    if (channelPattern.includes('*')) {
      const existing = this.patternHandlers.get(channelPattern);
      if (existing) {
        existing.push(handler);
        return;
      }
      this.patternHandlers.set(channelPattern, [handler]);
      await this.pSubscriber.psubscribe(channelPattern);
      log(`psubscribed to ${channelPattern}`);
    } else {
      const existing = this.channelHandlers.get(channelPattern);
      if (existing) {
        existing.push(handler);
        return;
      }
      this.channelHandlers.set(channelPattern, [handler]);
      await this.subscriber.subscribe(channelPattern);
      log(`subscribed to ${channelPattern}`);
    }
  }

  async enqueue(stream: string, payload: string, opts?: BackplaneEnqueueOpts): Promise<string> {
    if (this.closed) throw new Error('backplane closed');
    const maxLen = opts?.maxLen ?? DEFAULT_STREAM_MAXLEN;
    try {
      // XADD <stream> MAXLEN ~ <maxLen> * payload <payload>
      const id = await this.redis.xadd(stream, 'MAXLEN', '~', String(maxLen), '*', 'payload', payload);
      return id as string;
    } catch (err) {
      warn(`enqueue ${stream} failed:`, (err as Error).message);
      throw err;
    }
  }

  async consume(
    stream: string,
    group: string,
    consumer: string,
    handler: (msg: BackplaneStreamMessage) => Promise<boolean>,
  ): Promise<void> {
    // Ensure consumer group exists; MKSTREAM creates the stream if missing.
    try {
      await this.redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
    } catch (err) {
      // BUSYGROUP — already exists, fine.
      const msg = (err as Error).message;
      if (!msg.includes('BUSYGROUP')) {
        warn(`xgroup CREATE ${stream}/${group} unexpected error:`, msg);
      }
    }

    let stopped = false;
    const stop = () => {
      stopped = true;
    };

    const loop = (async () => {
      while (!stopped && !this.closed) {
        try {
          // XREADGROUP GROUP <group> <consumer> COUNT <n> BLOCK <ms> STREAMS <stream> >
          const res = await (this.streamConsumer as any).xreadgroup(
            'GROUP',
            group,
            consumer,
            'COUNT',
            STREAM_BATCH,
            'BLOCK',
            STREAM_BLOCK_MS,
            'STREAMS',
            stream,
            '>',
          );

          if (!res) continue; // timed out — loop

          // res shape: [[stream, [[id, [field, value, ...]], ...]]]
          for (const [, entries] of res as Array<[string, Array<[string, string[]]>]>) {
            for (const [id, fields] of entries) {
              // fields = ['payload', '<value>', ...]
              let payload = '';
              for (let i = 0; i < fields.length; i += 2) {
                if (fields[i] === 'payload') payload = fields[i + 1] ?? '';
              }
              try {
                const ok = await handler({ id, payload });
                if (ok) {
                  await this.streamConsumer.xack(stream, group, id);
                }
              } catch (err) {
                warn(`consumer handler error on ${stream}/${id}:`, (err as Error).message);
                // leave pending — another consumer (or retry) picks it up
              }
            }
          }
        } catch (err) {
          if (stopped || this.closed) break;
          warn(`consume loop error on ${stream}:`, (err as Error).message);
          await sleep(ERROR_SLEEP_MS);
        }
      }
    })();

    this.consumeLoops.push({ stop, promise: loop });
    log(`consume started: stream=${stream} group=${group} consumer=${consumer}`);
  }

  async sendToPod(podId: string, payload: string): Promise<void> {
    await this.enqueue(podStreamKey(podId), payload);
  }

  async registerPodChannel(podId: string, handler: (payload: string) => void | Promise<void>): Promise<void> {
    const stream = podStreamKey(podId);
    const group = `pod-${podId}`;
    const consumer = `${podId}-${process.pid}`;
    await this.consume(stream, group, consumer, async (msg) => {
      try {
        await handler(msg.payload);
        return true;
      } catch (err) {
        warn(`pod channel handler error:`, (err as Error).message);
        return false; // leave pending so we retry
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const loop of this.consumeLoops) loop.stop();
    await Promise.all(this.consumeLoops.map((l) => l.promise.catch(() => undefined)));
    this.consumeLoops = [];
    try {
      await this.subscriber.quit();
    } catch {
      /* ignore */
    }
    try {
      await this.pSubscriber.quit();
    } catch {
      /* ignore */
    }
    try {
      await this.streamConsumer.quit();
    } catch {
      /* ignore */
    }
    log('closed');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
