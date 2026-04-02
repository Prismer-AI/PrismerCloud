/**
 * Cookbook: 5-Minute Quick Start
 * @see docs/cookbook/en/quickstart.md
 *
 * Validates:
 *   Step 1 — Register an Agent          → im.account.register()
 *   Step 2 — Send a Direct Message       → im.direct.send()
 *   Step 3 — Fetch Messages              → im.messages.getHistory()
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerAgent, apiClient, RUN_ID } from '../helpers';
import type { PrismerClient } from '@prismer/sdk';

describe('Cookbook: Quick Start', () => {
  let agentA: { token: string; userId: string; client: PrismerClient };
  let agentB: { token: string; userId: string; client: PrismerClient };
  let conversationId: string;

  // ── Step 1: Register an Agent ─────────────────────────────────────
  describe('Step 1 — Register an Agent', () => {
    it('registers agent A and returns userId + token', async () => {
      agentA = await registerAgent('qs-alpha');
      expect(agentA.token).toBeDefined();
      expect(agentA.userId).toBeDefined();
      expect(typeof agentA.token).toBe('string');
    });

    it('registers agent B as the message target', async () => {
      agentB = await registerAgent('qs-beta');
      expect(agentB.userId).toBeDefined();
    });

    it('me() returns the agent profile', async () => {
      const me = await agentA.client.im.account.me();
      expect(me.ok).toBe(true);
      expect(me.data?.user).toBeDefined();
      expect(me.data?.user.username).toBeDefined();
      expect(typeof me.data?.user.username).toBe('string');
    });
  });

  // ── Step 2: Send a Direct Message ─────────────────────────────────
  describe('Step 2 — Send a Direct Message', () => {
    it('agent A sends a DM to agent B', async () => {
      const result = await agentA.client.im.direct.send(
        agentB.userId,
        'Hello from my-agent!',
      );
      expect(result.ok).toBe(true);
      expect(result.data?.message).toBeDefined();
      expect(result.data?.message.id).toBeDefined();
      expect(result.data?.conversationId).toBeDefined();
      conversationId = result.data!.conversationId;
    });
  });

  // ── Step 3: Fetch Messages ────────────────────────────────────────
  describe('Step 3 — Fetch Messages', () => {
    it('retrieves messages from the conversation', async () => {
      const result = await agentA.client.im.messages.getHistory(
        conversationId,
        { limit: 20 },
      );
      expect(result.ok).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data!.length).toBeGreaterThanOrEqual(1);

      const found = result.data!.find(
        (m: any) => m.content === 'Hello from my-agent!',
      );
      expect(found).toBeDefined();
    });
  });
});
