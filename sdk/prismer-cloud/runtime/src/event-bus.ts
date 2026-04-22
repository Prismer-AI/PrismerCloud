/**
 * Unified event envelope that wraps PARA events.
 * This aligns with the event-bus API while providing type safety.
 */

// AgentDescriptor type (from wire package)
export interface AgentDescriptor {
  id: string;
  adapter: string;
  version: string;
  tiersSupported: number[];
  capabilityTags: string[];
  workspace: string;
  workspaceGroup?: string;
}

// Local PARA event type definitions (from wire package, re-exported here)
export type ParaEvent = {
  'agent.register': { type: 'agent.register'; agent: AgentDescriptor };
  'agent.session.started': { type: 'agent.session.started'; session: string };
  'agent.session.ended': { type: 'agent.session.ended'; session: string };
  'agent.state': { type: 'agent.state'; status: string };
  'agent.skill.activated': { type: 'agent.skill.activated'; skill: string };
  'agent.skill.deactivated': { type: 'agent.skill.deactivated'; skill: string };
  'agent.approval.request': { type: 'agent.approval.request'; requestId: string };
  'agent.approval.result': { type: 'agent.approval.result'; approved: boolean };
  'agent.task.created': { type: 'agent.task.created'; taskId: string };
  'agent.task.completed': { type: 'agent.task.completed'; taskId: string };
  'agent.llm.pre': { type: 'agent.llm.pre'; requestId: string };
  'agent.llm.post': { type: 'agent.llm.post'; requestId: string };
};

export interface EventBusEnvelope<T = unknown> {
  topic: string;
  ts: number;
  payload: T;
  source?: string;
  requestId?: string;
}

/**
 * Unified subscription handler that accepts EventBusEnvelope.
 * This matches the EventBus API expectation.
 */
export type SubscriptionHandler<T = unknown> = (ev: EventBusEnvelope<T>) => void | Promise<void>;

export interface Subscription {
  id: string;
  pattern: string;
  unsubscribe(): void;
}

export interface EventBusOptions {
  onSubscriberError?: (err: unknown, sub: Subscription, ev: EventBusEnvelope) => void;
  queueWarnThreshold?: number;
}

// ============================================================
// Internal subscriber entry
// ============================================================

interface SubscriberEntry {
  handler: SubscriptionHandler;
  pattern: string;
  subscription: Subscription;
  queue: EventBusEnvelope[];
  draining: boolean;
}

// ============================================================
// Wildcard matching (mirrors EXP-31 semantics)
//
// pattern === '*'           matches any topic (receive-all)
// pattern.endsWith('.*')   prefix match: 'agent.tool.*' matches 'agent.tool.pre'
//                          but NOT 'agent.session.start'
// otherwise                exact match
// ============================================================

function matchesTopic(topic: string, pattern: string): boolean {
  if (pattern === '*') {
    return true;
  }
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1); // 'agent.tool.'
    return topic.startsWith(prefix);
  }
  return topic === pattern;
}

// ============================================================
// EventBus
// ============================================================

export class EventBus {
  private readonly _subscribers = new Map<string, SubscriberEntry>();
  private _monotonicTs = 0;
  private _totalPublished = 0;
  private readonly _onError: (err: unknown, sub: Subscription, ev: EventBusEnvelope) => void;
  private readonly _warnThreshold: number;

  constructor(opts?: EventBusOptions) {
    this._warnThreshold = opts?.queueWarnThreshold ?? 1000;
    this._onError = opts?.onSubscriberError ?? ((err) => {
      process.stderr.write(
        `[EventBus] Subscriber error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  }

  publish<T>(
    topic: string,
    payload: T,
    meta?: { source?: string; requestId?: string },
  ): void {
    const now = Date.now();
    this._monotonicTs = Math.max(this._monotonicTs + 1, now);

    const envelope: EventBusEnvelope<T> = { topic, ts: this._monotonicTs, payload };
    if (meta?.source !== undefined) (envelope as EventBusEnvelope<T>).source = meta.source;
    if (meta?.requestId !== undefined) (envelope as EventBusEnvelope<T>).requestId = meta.requestId;

    this._totalPublished++;

    for (const entry of this._subscribers.values()) {
      if (matchesTopic(topic, entry.pattern)) {
        entry.queue.push(envelope as EventBusEnvelope<T>);

        if (entry.queue.length >= this._warnThreshold) {
          process.stderr.write(
            `[EventBus] Subscriber '${entry.subscription.id}' backlog ${entry.queue.length} events\n`,
          );
        }
      }

      this._drain(entry);
    }
  }

  subscribe<T>(
    topic: string,
    handler: SubscriptionHandler<T>,
  ): Subscription {
    const id = `sub_${Math.random().toString(36).slice(2)}_${Date.now()}`;

    const subscription: Subscription = {
      id,
      pattern: topic,
      unsubscribe: () => {
        this._subscribers.delete(id);
      },
    };

    const entry: SubscriberEntry = {
      handler: handler as SubscriptionHandler<unknown>,
      pattern: topic,
      subscription,
      queue: [],
      draining: false,
    };

    this._subscribers.set(id, entry);
    return subscription;
  }

  unsubscribeAll(): void {
    this._subscribers.clear();
  }

  get subscriberCount(): number {
    return this._subscribers.size;
  }

  get totalPublished(): number {
    return this._totalPublished;
  }

  private _drain(entry: SubscriberEntry): void {
    if (entry.draining) {
      return;
    }

    entry.draining = true;

    const loop = async () => {
      while (entry.queue.length > 0) {
        const ev = entry.queue.shift()!;
        try {
          await entry.handler(ev);
        } catch (err: unknown) {
          this._onError(err, entry.subscription, ev);
        }
      }
      entry.draining = false;
    };

    loop().catch((err) => {
      process.stderr.write(`[EventBus] Drain error: ${err}\n`);
    });
  }
}
