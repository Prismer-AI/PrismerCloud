import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { setupWebSocket } from '../ws/handler';

function makeDeps() {
  return {
    redis: {} as any,
    rooms: { setAckTracker: () => {} } as any,
    messageService: {} as any,
    conversationService: {} as any,
    presenceService: {} as any,
    agentService: {} as any,
    streamService: {} as any,
    taskService: {} as any,
  };
}

describe('ACP websocket deps', () => {
  it('fails fast when production websocket wiring omits taskService', () => {
    const wss = new WebSocketServer({ noServer: true });
    try {
      const deps = makeDeps();
      delete (deps as { taskService?: unknown }).taskService;
      expect(() => setupWebSocket(wss, deps as any)).toThrow(/taskService/);
    } finally {
      wss.close();
    }
  });

  it('accepts websocket deps when taskService is present', () => {
    const wss = new WebSocketServer({ noServer: true });
    try {
      expect(() => setupWebSocket(wss, makeDeps() as any)).not.toThrow();
    } finally {
      wss.close();
    }
  });
});
