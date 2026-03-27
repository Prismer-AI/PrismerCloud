/**
 * Prismer IM — Transport abstraction
 *
 * Unifies WebSocket and SSE connections behind a common interface
 * so RoomManager can broadcast to both without knowing the transport type.
 */

import type { WebSocket } from 'ws';
import type { ServerResponse } from 'node:http';

export interface Transport {
  readonly type: 'websocket' | 'sse';
  readonly readyState: number; // 1 = OPEN
  send(data: string): void;
  close(): void;
}

/**
 * Wraps a ws.WebSocket as a Transport.
 */
export class WebSocketTransport implements Transport {
  readonly type = 'websocket' as const;

  constructor(private ws: WebSocket) {}

  get readyState(): number {
    return this.ws.readyState;
  }

  send(data: string): void {
    this.ws.send(data);
  }

  close(): void {
    this.ws.close();
  }
}

/**
 * Wraps an HTTP ServerResponse as an SSE Transport.
 *
 * SSE is server→client only. The `send()` method writes SSE `data:` lines.
 * Client→server communication goes through regular HTTP POST endpoints.
 */
export class SSETransport implements Transport {
  readonly type = 'sse' as const;
  private closed = false;

  constructor(private res: ServerResponse) {
    res.on('close', () => {
      this.closed = true;
    });
  }

  get readyState(): number {
    return this.closed ? 3 : 1; // 3 = CLOSED, 1 = OPEN
  }

  send(data: string): void {
    if (!this.closed) {
      this.res.write(`data: ${data}\n\n`);
    }
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.res.end();
    }
  }
}
