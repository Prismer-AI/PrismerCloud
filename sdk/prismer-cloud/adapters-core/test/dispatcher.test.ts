import { describe, it, expect, vi } from 'vitest';
import { EventDispatcher } from '../src/dispatcher.js';
import type { ParaEvent } from '@prismer/wire';

const validEvent: ParaEvent = {
  type: 'agent.state',
  status: 'idle',
};

describe('EventDispatcher', () => {
  it('emits a valid event to the sink', async () => {
    const sink = vi.fn();
    const dispatcher = new EventDispatcher(sink);
    await dispatcher.emit(validEvent);
    expect(sink).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledWith(validEvent);
  });

  it('does NOT call sink for an invalid event', async () => {
    const sink = vi.fn();
    const errCb = vi.fn();
    const dispatcher = new EventDispatcher(sink);
    dispatcher.onError(errCb);

    // Construct an intentionally invalid event (bad status value)
    const invalid = { type: 'agent.state', status: 'flying' } as unknown as ParaEvent;
    await dispatcher.emit(invalid);

    expect(sink).not.toHaveBeenCalled();
    expect(errCb).toHaveBeenCalledOnce();
  });

  it('calls onError callback when validation fails', async () => {
    const sink = vi.fn();
    let capturedErr: Error | null = null;
    let capturedEvt: unknown = null;

    const dispatcher = new EventDispatcher(sink);
    dispatcher.onError((err, evt) => {
      capturedErr = err;
      capturedEvt = evt;
    });

    const invalid = { type: 'not.a.real.event' } as unknown as ParaEvent;
    await dispatcher.emit(invalid);

    expect(capturedErr).toBeInstanceOf(Error);
    expect(capturedEvt).toEqual(invalid);
  });

  it('calls onError when the sink throws', async () => {
    const sink = vi.fn().mockRejectedValue(new Error('network down'));
    let capturedErr: Error | null = null;

    const dispatcher = new EventDispatcher(sink);
    dispatcher.onError((err) => { capturedErr = err; });

    await dispatcher.emit(validEvent);

    expect(sink).toHaveBeenCalledOnce();
    expect(capturedErr).not.toBeNull();
    expect(capturedErr!.message).toBe('network down');
  });

  it('handles sync sink (non-Promise) without error', async () => {
    const received: ParaEvent[] = [];
    const dispatcher = new EventDispatcher((evt) => { received.push(evt); });
    await dispatcher.emit(validEvent);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(validEvent);
  });

  it('emits multiple events sequentially', async () => {
    const received: ParaEvent[] = [];
    const dispatcher = new EventDispatcher((evt) => { received.push(evt); });

    const evt2: ParaEvent = {
      type: 'agent.session.started',
      sessionId: 'sess-1',
      scope: 'global',
    };

    await dispatcher.emit(validEvent);
    await dispatcher.emit(evt2);
    expect(received).toHaveLength(2);
  });

  it('last onError registration wins', async () => {
    const sink = vi.fn();
    const first = vi.fn();
    const second = vi.fn();

    const dispatcher = new EventDispatcher(sink);
    dispatcher.onError(first);
    dispatcher.onError(second);

    const invalid = { type: 'agent.state', status: 'invalid' } as unknown as ParaEvent;
    await dispatcher.emit(invalid);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
