import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/event-bus.js';

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('EventBus', () => {
  it('basic publish -> subscribe -> receive', async () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.subscribe('test.*', (ev) => { received.push(ev.payload); });

    bus.publish('test.hello', { msg: 'world' });
    await tick();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ msg: 'world' });
  });

  it('wildcard agent.* matches agent.register but not tool.pre', async () => {
    const bus = new EventBus();
    const agentEvents: string[] = [];
    const allEvents: string[] = [];

    bus.subscribe('agent.*', (ev) => { agentEvents.push(ev.topic); });
    bus.subscribe('*', (ev) => { allEvents.push(ev.topic); });

    bus.publish('agent.register', {});
    bus.publish('agent.heartbeat', {});
    bus.publish('tool.pre', {});
    await tick();

    expect(agentEvents).toContain('agent.register');
    expect(agentEvents).toContain('agent.heartbeat');
    expect(agentEvents).not.toContain('tool.pre');
    expect(allEvents).toHaveLength(3);
  });

  it('multiple subscribers all receive the same event', async () => {
    const bus = new EventBus();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const c: unknown[] = [];

    bus.subscribe('*', (ev) => { a.push(ev.payload); });
    bus.subscribe('*', (ev) => { b.push(ev.payload); });
    bus.subscribe('*', (ev) => { c.push(ev.payload); });

    bus.publish('any.event', 42);
    await tick();

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(c).toHaveLength(1);
  });

  it('unsubscribe stops delivery', async () => {
    const bus = new EventBus();
    const received: number[] = [];

    const sub = bus.subscribe('*', (ev) => { received.push(ev.payload as number); });

    bus.publish('e', 1);
    await tick();
    expect(received).toHaveLength(1);

    sub.unsubscribe();
    bus.publish('e', 2);
    await tick();
    expect(received).toHaveLength(1);
  });

  it('subscriber throwing does not affect others; onSubscriberError is called', async () => {
    const errors: unknown[] = [];
    const bus = new EventBus({
      onSubscriberError: (err) => { errors.push(err); },
    });

    const bReceived: unknown[] = [];

    bus.subscribe('*', () => { throw new Error('A explodes'); });
    bus.subscribe('*', (ev) => { bReceived.push(ev.payload); });

    bus.publish('iso.test', 'payload');
    await tick();

    expect(errors).toHaveLength(1);
    expect(bReceived).toHaveLength(1);
  });

  it('publish order is preserved per subscriber', async () => {
    const bus = new EventBus();
    const seq: number[] = [];
    bus.subscribe('*', (ev) => { seq.push(ev.payload as number); });

    bus.publish('e', 1);
    bus.publish('e', 2);
    bus.publish('e', 3);
    await tick();

    expect(seq).toEqual([1, 2, 3]);
  });

  it('unsubscribeAll() drops all subscribers', async () => {
    const bus = new EventBus();
    const received: unknown[] = [];

    bus.subscribe('*', (ev) => { received.push(ev.payload); });
    bus.subscribe('*', (ev) => { received.push(ev.payload); });

    bus.publish('e', 1);
    await tick();
    expect(received).toHaveLength(2);

    bus.unsubscribeAll();
    expect(bus.subscriberCount).toBe(0);

    bus.publish('e', 2);
    await tick();
    expect(received).toHaveLength(2);
  });

  it('totalPublished counts correctly', () => {
    const bus = new EventBus();
    expect(bus.totalPublished).toBe(0);
    bus.publish('a', 1);
    bus.publish('b', 2);
    bus.publish('c', 3);
    expect(bus.totalPublished).toBe(3);
  });

  it('subscriberCount reflects subscribe and unsubscribe', () => {
    const bus = new EventBus();
    expect(bus.subscriberCount).toBe(0);

    const s1 = bus.subscribe('*', () => {});
    expect(bus.subscriberCount).toBe(1);

    const s2 = bus.subscribe('*', () => {});
    expect(bus.subscriberCount).toBe(2);

    s1.unsubscribe();
    expect(bus.subscriberCount).toBe(1);

    s2.unsubscribe();
    expect(bus.subscriberCount).toBe(0);
  });

  it('bus injects monotonic timestamps that are strictly increasing', async () => {
    const bus = new EventBus();
    const timestamps: number[] = [];
    bus.subscribe('*', (ev) => { timestamps.push(ev.ts); });

    bus.publish('e', 1);
    bus.publish('e', 2);
    bus.publish('e', 3);
    await tick();

    expect(timestamps).toHaveLength(3);
    expect(timestamps.every((ts) => typeof ts === 'number')).toBe(true);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]);
    }
  });

  it('backpressure: slow subscriber does not block fast subscriber', async () => {
    const bus = new EventBus();
    const fastReceived: unknown[] = [];
    const slowReceived: unknown[] = [];

    bus.subscribe('*', (ev) => { fastReceived.push(ev.payload); });
    bus.subscribe('*', async (ev) => {
      await sleep(50);
      slowReceived.push(ev.payload);
    });

    const N = 5;
    for (let i = 0; i < N; i++) {
      bus.publish('bp', i);
    }

    await tick();
    expect(fastReceived).toHaveLength(N);

    await sleep(350);
    expect(slowReceived).toHaveLength(N);
  });

  it('high throughput: 10000 events x 3 subscribers completes < 500ms', async () => {
    const bus = new EventBus({ queueWarnThreshold: 20_000 });
    const N = 10_000;
    const counts = { a: 0, b: 0, c: 0 };

    bus.subscribe('*', () => { counts.a++; });
    bus.subscribe('*', () => { counts.b++; });
    bus.subscribe('*', () => { counts.c++; });

    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      bus.publish('throughput', i);
    }
    await tick();
    const elapsed = performance.now() - t0;

    expect(counts.a).toBe(N);
    expect(counts.b).toBe(N);
    expect(counts.c).toBe(N);
    expect(elapsed).toBeLessThan(500);
  });

  it('wildcard filter: agent.tool.* matches .pre .post .result but not session.*', async () => {
    const bus = new EventBus();
    const toolEvents: string[] = [];

    bus.subscribe('agent.tool.*', (ev) => { toolEvents.push(ev.topic); });

    bus.publish('agent.tool.pre', {});
    bus.publish('agent.tool.post', {});
    bus.publish('agent.tool.result', {});
    bus.publish('agent.session.start', {});
    bus.publish('memory.write', {});
    await tick();

    expect(toolEvents).toHaveLength(3);
    expect(toolEvents.every((t) => t.startsWith('agent.tool.'))).toBe(true);
  });

  it('exact topic match works alongside wildcard subscribers', async () => {
    const bus = new EventBus();
    const exactReceived: string[] = [];
    const wildcardReceived: string[] = [];

    bus.subscribe('daemon.reloaded', (ev) => { exactReceived.push(ev.topic); });
    bus.subscribe('daemon.*', (ev) => { wildcardReceived.push(ev.topic); });

    bus.publish('daemon.reloaded', {});
    bus.publish('daemon.started', {});
    await tick();

    expect(exactReceived).toEqual(['daemon.reloaded']);
    expect(wildcardReceived).toEqual(['daemon.reloaded', 'daemon.started']);
  });

  it('unsubscribing inside a handler does not affect other subscribers of same event', async () => {
    const bus = new EventBus();
    const bReceived: number[] = [];
    const aReceived: number[] = [];
    let sub: ReturnType<typeof bus.subscribe>;

    sub = bus.subscribe('*', (ev) => {
      aReceived.push(ev.payload as number);
      sub.unsubscribe();
    });
    bus.subscribe('*', (ev) => { bReceived.push(ev.payload as number); });

    bus.publish('e', 1);
    bus.publish('e', 2);
    await tick();

    expect(aReceived).toEqual([1]);
    expect(bReceived).toEqual([1, 2]);
  });
});
