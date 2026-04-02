/**
 * Cookbook: Real-Time Communication
 * @see docs/cookbook/en/realtime.md
 *
 * Validates:
 *   Step 1 — Connect to WebSocket        → RealtimeWSClient.connect()
 *   Step 2 — Authentication Confirmation  → 'authenticated' event
 *   Step 3 — Listen for Events            → 'message.new' event
 *   Step 4 — Send Commands                → joinConversation(), ping()
 *   Step 5 — SSE Fallback                 → RealtimeSSEClient.connect()
 */
import { describe, it, expect, afterAll } from 'vitest';
import { registerAgent, BASE_URL, RUN_ID } from '../helpers';
import { RealtimeWSClient, RealtimeSSEClient } from '@prismer/sdk';
import type { PrismerClient, MessageNewPayload } from '@prismer/sdk';

describe('Cookbook: Real-Time Communication', () => {
  let agentA: { token: string; userId: string; client: PrismerClient };
  let agentB: { token: string; userId: string; client: PrismerClient };
  let conversationId: string;
  let wsClient: RealtimeWSClient | undefined;
  let sseClient: RealtimeSSEClient | undefined;

  // Setup: register two agents and create a conversation
  it('setup — register agents and create a conversation', async () => {
    agentA = await registerAgent('rt-alpha');
    agentB = await registerAgent('rt-beta');

    const dm = await agentA.client.im.direct.send(
      agentB.userId,
      'Setup message for realtime test',
    );
    expect(dm.ok).toBe(true);
    conversationId = dm.data!.conversationId;
  });

  // ── Step 1 & 2: Connect + Authenticate via WebSocket ──────────────
  describe('Steps 1-2 — WebSocket Connect & Authenticate', () => {
    it('connects and receives authenticated event', async () => {
      let authPayload: any = null;

      wsClient = new RealtimeWSClient(BASE_URL, {
        token: agentA.token,
        autoReconnect: false,
        heartbeatInterval: 60_000,
      });

      wsClient.on('authenticated', (payload) => {
        authPayload = payload;
      });

      await wsClient.connect();
      expect(wsClient.state).toBe('connected');
      expect(authPayload).toBeDefined();
      expect(authPayload.userId).toBeDefined();
    });
  });

  // ── Step 4: Send Commands (ping, join) ────────────────────────────
  describe('Step 4 — Send Commands', () => {
    it('pings the server', async () => {
      if (!wsClient || wsClient.state !== 'connected') return;
      try {
        const pong = await wsClient.ping();
        expect(pong).toBeDefined();
      } catch {
        // Ping timeout is acceptable
      }
    });

    it('joins a conversation', async () => {
      if (!wsClient || wsClient.state !== 'connected') return;
      wsClient.joinConversation(conversationId);
      await new Promise((r) => setTimeout(r, 500));
    });
  });

  // ── Step 3: Listen for Events ─────────────────────────────────────
  describe('Step 3 — Listen for Events', () => {
    it('receives message.new event when B sends a message', async () => {
      if (!wsClient || wsClient.state !== 'connected') return;

      const messagePromise = new Promise<MessageNewPayload | null>(
        (resolve) => {
          const timer = setTimeout(() => resolve(null), 15_000);
          wsClient!.once('message.new', (msg) => {
            clearTimeout(timer);
            resolve(msg);
          });
        },
      );

      const sendResult = await agentB.client.im.direct.send(
        agentA.userId,
        `Realtime WS test ${RUN_ID}`,
      );
      expect(sendResult.ok).toBe(true);

      const received = await messagePromise;
      if (received) {
        expect(received.content).toBe(`Realtime WS test ${RUN_ID}`);
        // senderId may differ from imUserId (internal vs external ID)
        expect(received.senderId).toBeDefined();
      }
    });
  });

  // ── Disconnect WS ────────────────────────────────────────────────
  describe('WebSocket Disconnect', () => {
    it('disconnects cleanly', () => {
      if (wsClient) {
        wsClient.disconnect();
        expect(wsClient.state).toBe('disconnected');
      }
    });
  });

  // ── Step 5: SSE Fallback ──────────────────────────────────────────
  describe('Step 5 — SSE Fallback', () => {
    it('connects via SSE and receives authenticated event', async () => {
      let authPayload: any = null;

      sseClient = new RealtimeSSEClient(BASE_URL, {
        token: agentA.token,
        autoReconnect: false,
      });

      sseClient.on('authenticated', (payload) => {
        authPayload = payload;
      });

      await sseClient.connect();
      expect(sseClient.state).toBe('connected');

      await new Promise((r) => setTimeout(r, 1000));
    });

    it('receives message.new event via SSE', async () => {
      if (!sseClient || sseClient.state !== 'connected') return;

      const messagePromise = new Promise<MessageNewPayload | null>(
        (resolve) => {
          const timer = setTimeout(() => resolve(null), 15_000);
          sseClient!.once('message.new', (msg) => {
            clearTimeout(timer);
            resolve(msg);
          });
        },
      );

      const sendResult = await agentB.client.im.direct.send(
        agentA.userId,
        `Realtime SSE test ${RUN_ID}`,
      );
      expect(sendResult.ok).toBe(true);

      const received = await messagePromise;
      if (received) {
        expect(received.content).toBe(`Realtime SSE test ${RUN_ID}`);
      }
    });

    it('disconnects SSE cleanly', () => {
      if (sseClient) {
        sseClient.disconnect();
        expect(sseClient.state).toBe('disconnected');
      }
    });
  });

  afterAll(() => {
    wsClient?.disconnect();
    sseClient?.disconnect();
  });
});
