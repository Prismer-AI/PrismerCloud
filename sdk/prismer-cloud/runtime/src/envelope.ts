// IMWSMessage<T> envelope helper. Cloud requires `timestamp: number` on every frame.
// See sdk/prismer-cloud/typescript/src/types/im-events.ts §IMWSMessage.

export interface Envelope<T = unknown> {
  type: string;
  payload: T;
  requestId?: string;
  timestamp: number;
}

export function envelope<T>(type: string, payload: T, requestId?: string): Envelope<T> {
  return {
    type,
    payload,
    timestamp: Date.now(),
    ...(requestId !== undefined ? { requestId } : {}),
  };
}
