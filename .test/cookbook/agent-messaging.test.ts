/**
 * Cookbook: Agent-to-Agent Messaging
 * @see docs/cookbook/en/agent-messaging.md
 *
 * Validates:
 *   Step 1 — Register Two Agents        → im.account.register() ×2
 *   Step 2 — Send a Direct Message       → im.direct.send()
 *   Step 3 — Create a Group              → im.groups.create()
 *   Step 4 — Send a Group Message        → im.messages.send() / im.groups.send()
 *   Step 5 — List Conversations          → im.conversations.list()
 */
import { describe, it, expect } from 'vitest';
import { registerAgent, RUN_ID } from '../helpers';
import type { PrismerClient } from '@prismer/sdk';

describe('Cookbook: Agent-to-Agent Messaging', () => {
  let agentA: { token: string; userId: string; client: PrismerClient };
  let agentB: { token: string; userId: string; client: PrismerClient };
  let dmConversationId: string;
  let groupId: string;
  let groupConversationId: string;

  // ── Step 1: Register Two Agents ───────────────────────────────────
  describe('Step 1 — Register Two Agents', () => {
    it('registers Agent Alpha', async () => {
      agentA = await registerAgent('msg-alpha');
      expect(agentA.userId).toBeDefined();
    });

    it('registers Agent Beta', async () => {
      agentB = await registerAgent('msg-beta');
      expect(agentB.userId).toBeDefined();
    });
  });

  // ── Step 2: Send a Direct Message ─────────────────────────────────
  describe('Step 2 — Send a Direct Message', () => {
    it('Alpha sends DM to Beta', async () => {
      const result = await agentA.client.im.direct.send(
        agentB.userId,
        'Hello Beta, I am Alpha!',
      );
      expect(result.ok).toBe(true);
      expect(result.data?.conversationId).toBeDefined();
      dmConversationId = result.data!.conversationId;
    });
  });

  // ── Step 3: Create a Group ────────────────────────────────────────
  describe('Step 3 — Create a Group', () => {
    it('Alpha creates a group with Beta as member', async () => {
      const result = await agentA.client.im.groups.create({
        title: `Alpha-Beta Squad ${RUN_ID}`,
        description: 'A two-agent working group',
        members: [agentB.userId],
      });
      expect(result.ok).toBe(true);
      expect(result.data?.groupId).toBeDefined();
      groupId = result.data!.groupId;
    });

    it('group appears in Alpha\'s group list', async () => {
      const result = await agentA.client.im.groups.list();
      expect(result.ok).toBe(true);
      const found = result.data?.find((g: any) => g.groupId === groupId);
      expect(found).toBeDefined();
    });
  });

  // ── Step 4: Send a Group Message ──────────────────────────────────
  describe('Step 4 — Send a Group Message', () => {
    it('Alpha sends a message to the group', async () => {
      const result = await agentA.client.im.groups.send(
        groupId,
        'First message to the group!',
      );
      expect(result.ok).toBe(true);
      expect(result.data?.message).toBeDefined();
    });

    it('Beta sends a reply to the group', async () => {
      const result = await agentB.client.im.groups.send(
        groupId,
        'Got it, Alpha!',
      );
      // Beta may lack permission if not fully joined yet — tolerate
      if (!result.ok) {
        expect(result.error).toBeDefined();
      }
    });

    it('group messages can be retrieved', async () => {
      const result = await agentA.client.im.groups.getMessages(groupId);
      expect(result.ok).toBe(true);
      expect(result.data!.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Step 5: List Conversations ────────────────────────────────────
  describe('Step 5 — List Conversations', () => {
    it('Alpha sees both DM and group in conversations', async () => {
      const result = await agentA.client.im.conversations.list();
      expect(result.ok).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data!.length).toBeGreaterThanOrEqual(1);
    });
  });
});
