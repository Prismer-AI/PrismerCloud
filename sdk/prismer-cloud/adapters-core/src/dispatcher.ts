/**
 * dispatcher.ts — Thin event emitter that routes PARA events to a transport sink.
 *
 * The sink is provided by the adapter (stdout serialization for hook scripts,
 * WebSocket send for in-process adapters). EventDispatcher itself has no
 * knowledge of the transport — it only validates and routes.
 *
 * Validation failures invoke the error callback instead of throwing so
 * adapters don't crash on a schema bug — they log and drop.
 */

import type { ParaEvent } from '@prismer/wire';
import { ParaEventSchema } from '@prismer/wire';

/** A function that receives a validated ParaEvent and sends it somewhere. */
export type DispatchSink = (evt: ParaEvent) => void | Promise<void>;

const defaultErrorCb = (err: Error): void => {
  // eslint-disable-next-line no-console
  console.error('[adapters-core] dispatch error:', err.message);
};

export class EventDispatcher {
  private readonly sink: DispatchSink;
  private errorCb: (err: Error, evt: unknown) => void = defaultErrorCb;

  constructor(sink: DispatchSink) {
    this.sink = sink;
  }

  /**
   * Validate `evt` against ParaEventSchema, then call the sink.
   * If validation fails, the error callback is invoked and the sink is NOT called.
   * If the sink throws/rejects, the error callback is invoked with the sink error.
   */
  async emit(evt: ParaEvent): Promise<void> {
    let validated: ParaEvent;
    try {
      validated = ParaEventSchema.parse(evt);
    } catch (err) {
      this.errorCb(err instanceof Error ? err : new Error(String(err)), evt);
      return;
    }
    try {
      await this.sink(validated);
    } catch (err) {
      this.errorCb(err instanceof Error ? err : new Error(String(err)), validated);
    }
  }

  /** Register an error callback. Only the last registration is active. */
  onError(cb: (err: Error, evt: unknown) => void): void {
    this.errorCb = cb;
  }
}
