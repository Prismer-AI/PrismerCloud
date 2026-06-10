/**
 * Prismer IM — InMemoryBackplane
 *
 * Spec: docs/release200/14-messaging-state-machine-reliability.md §4.5
 *
 * Single-process implementation — useful for:
 *   • dev workflow without Redis (`BACKPLANE=memory`)
 *   • unit tests that don't want a Redis dependency
 *   • CI smoke checks
 *
 * Pub/sub  → node:events EventEmitter (each "channel" is an emitter event).
 * Stream   → in-memory ring buffer + per-group consumer offset / pending set.
 *            Mimics Redis Streams semantics enough for E3 routing tests.
 *
 * NOT MEANT FOR PRODUCTION — see RedisBackplane for the durable path.
 */

import { EventEmitter } from 'node:events';
import { podStreamKey, type Backplane, type BackplaneEnqueueOpts, type BackplaneStreamMessage } from './backplane';

const log = (msg: string, ...args: unknown[]) => console.log(`[MemoryBackplane] ${msg}`, ...args);
const warn = (msg: string, ...args: unknown[]) => console.warn(`[MemoryBackplane] ${msg}`, ...args);

interface StreamEntry {
  id: string; // monotonic "n-0" for parity with Redis
  payload: string;
}

interface StreamGroupState {
  /** Index into entries[] — next entry to deliver to this group. */
  lastIndex: number;
  /** Entries delivered but not yet ACK'd, keyed by id. */
  pending: Map<string, StreamEntry>;
}

interface StreamState {
  entries: StreamEntry[];
  nextSeq: number;
  groups: Map<string, StreamGroupState>;
  /** Emitter signals "new entry" so consumer loops wake without polling. */
  emitter: EventEmitter;
}

interface ConsumerLoop {
  stop(): void;
}

export class InMemoryBackplane implements Backplane {
  private streams = new Map<string, StreamState>();
  private pubsub = new EventEmitter();
  private patterns: Array<{ regex: RegExp; raw: string; handlers: Array<(channel: string, payload: string) => void | Promise<void>> }> = [];
  private loops: ConsumerLoop[] = [];
  private closed = false;

  constructor() {
    // Avoid MaxListenersExceeded when many channels subscribe.
    this.pubsub.setMaxListeners(0);
    log('initialized');
  }

  async publish(channel: string, payload: string): Promise<void> {
    if (this.closed) return;
    this.pubsub.emit(channel, channel, payload);
    // Pattern matching — naive O(n_patterns); fine for dev.
    for (const p of this.patterns) {
      if (p.regex.test(channel)) {
        for (const h of p.handlers) {
          try {
            await h(channel, payload);
          } catch (err) {
            warn(`pattern handler ${p.raw} error:`, (err as Error).message);
          }
        }
      }
    }
  }

  async subscribe(
    channelPattern: string,
    handler: (channel: string, payload: string) => void | Promise<void>,
  ): Promise<void> {
    if (channelPattern.includes('*')) {
      const regex = patternToRegex(channelPattern);
      const existing = this.patterns.find((p) => p.raw === channelPattern);
      if (existing) {
        existing.handlers.push(handler);
      } else {
        this.patterns.push({ regex, raw: channelPattern, handlers: [handler] });
      }
      return;
    }
    this.pubsub.on(channelPattern, (channel: string, payload: string) => {
      Promise.resolve(handler(channel, payload)).catch((err) =>
        warn(`subscriber ${channelPattern} error:`, (err as Error).message),
      );
    });
  }

  async enqueue(stream: string, payload: string, opts?: BackplaneEnqueueOpts): Promise<string> {
    if (this.closed) throw new Error('backplane closed');
    const s = this.getOrCreateStream(stream);
    const id = `${++s.nextSeq}-0`;
    s.entries.push({ id, payload });
    const maxLen = opts?.maxLen ?? 10_000;
    if (s.entries.length > maxLen) {
      const drop = s.entries.length - maxLen;
      s.entries.splice(0, drop);
      // shift group offsets back so they don't point past start
      for (const g of s.groups.values()) {
        g.lastIndex = Math.max(0, g.lastIndex - drop);
      }
    }
    s.emitter.emit('new');
    return id;
  }

  async consume(
    stream: string,
    group: string,
    consumer: string,
    handler: (msg: BackplaneStreamMessage) => Promise<boolean>,
  ): Promise<void> {
    const s = this.getOrCreateStream(stream);
    if (!s.groups.has(group)) {
      s.groups.set(group, { lastIndex: s.entries.length, pending: new Map() });
    }
    const g = s.groups.get(group)!;

    let stopped = false;
    const loop = async () => {
      while (!stopped && !this.closed) {
        // Drain anything new since lastIndex
        while (g.lastIndex < s.entries.length) {
          const entry = s.entries[g.lastIndex++];
          g.pending.set(entry.id, entry);
          try {
            const ok = await handler({ id: entry.id, payload: entry.payload });
            if (ok) {
              g.pending.delete(entry.id);
            }
            // else leave in pending — caller can recover via XREADGROUP > '0'
            // equivalent (not implemented here; E3 unicast doesn't need it).
          } catch (err) {
            warn(`consumer ${consumer} handler error:`, (err as Error).message);
            // leave in pending
          }
        }
        // wait for next push
        await new Promise<void>((resolve) => {
          const onNew = () => {
            s.emitter.off('new', onNew);
            resolve();
          };
          s.emitter.once('new', onNew);
          // safety: max wait 5s so closed flag is observable
          setTimeout(() => {
            s.emitter.off('new', onNew);
            resolve();
          }, 5_000);
        });
      }
    };

    const handle: ConsumerLoop = {
      stop: () => {
        stopped = true;
      },
    };
    this.loops.push(handle);
    void loop();
    log(`consume started (memory): stream=${stream} group=${group} consumer=${consumer}`);
  }

  async sendToPod(podId: string, payload: string): Promise<void> {
    await this.enqueue(podStreamKey(podId), payload);
  }

  async registerPodChannel(podId: string, handler: (payload: string) => void | Promise<void>): Promise<void> {
    await this.consume(podStreamKey(podId), `pod-${podId}`, `${podId}-${process.pid}`, async (msg) => {
      try {
        await handler(msg.payload);
        return true;
      } catch (err) {
        warn(`pod channel handler error:`, (err as Error).message);
        return false;
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const l of this.loops) l.stop();
    this.loops = [];
    this.pubsub.removeAllListeners();
    this.patterns = [];
    log('closed');
  }

  private getOrCreateStream(name: string): StreamState {
    const existing = this.streams.get(name);
    if (existing) return existing;
    const state: StreamState = {
      entries: [],
      nextSeq: 0,
      groups: new Map(),
      emitter: new EventEmitter(),
    };
    state.emitter.setMaxListeners(0);
    this.streams.set(name, state);
    return state;
  }
}

function patternToRegex(pattern: string): RegExp {
  // Escape regex special chars except `*`, then map `*` → `.*`
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}
