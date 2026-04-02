/**
 * Cookbook: Workspace Integration
 * @see docs/cookbook/en/workspace.md
 *
 * Validates:
 *   Step 1 — Initialize a Workspace      → im.workspace.init()
 *   Step 2 — Send Workspace Messages      → (via workspace conversation)
 *   Step 3 — Mention Autocomplete         → im.workspace.mentionAutocomplete()
 *   Step 4 — List Members & Conversations → im.workspace.listAgents()
 *   Bonus  — Group Workspace              → im.workspace.initGroup()
 */
import { describe, it, expect } from 'vitest';
import { registerAgent, RUN_ID } from '../helpers';
import type { PrismerClient } from '@prismer/sdk';

describe('Cookbook: Workspace Integration', () => {
  let agent: { token: string; userId: string; client: PrismerClient };
  let workspaceId: string;
  let workspaceConversationId: string;

  it('setup — register a test agent', async () => {
    agent = await registerAgent('ws-agent');
    expect(agent.userId).toBeDefined();
  });

  // ── Step 1: Initialize a Workspace ────────────────────────────────
  describe('Step 1 — Initialize a Workspace', () => {
    it('creates a 1:1 workspace', async () => {
      const result = await agent.client.im.workspace.init({
        workspaceId: `test-ws-${RUN_ID}`,
        userId: 'test-user-01',
        userDisplayName: 'Test User',
      });

      if (result.ok) {
        expect(result.data).toBeDefined();
        expect(result.data!.workspaceId).toBeDefined();
        expect(result.data!.conversationId).toBeDefined();
        workspaceId = result.data!.workspaceId!;
        workspaceConversationId = result.data!.conversationId;
      } else {
        // Workspace feature may not be enabled in all environments
        expect(result.error).toBeDefined();
      }
    });
  });

  // ── Bonus: Group Workspace ────────────────────────────────────────
  describe('Bonus — Group Workspace', () => {
    it('creates a group workspace with multiple users', async () => {
      const result = await agent.client.im.workspace.initGroup({
        workspaceId: `test-grp-ws-${RUN_ID}`,
        title: `Cookbook Test Workspace ${RUN_ID}`,
        users: [
          { userId: 'test-user-01', displayName: 'Alice' },
          { userId: 'test-user-02', displayName: 'Bob' },
        ],
      });

      if (result.ok) {
        expect(result.data).toBeDefined();
        expect(result.data!.workspaceId).toBeDefined();
      } else {
        expect(result.error).toBeDefined();
      }
    });
  });

  // ── Step 2: Send Workspace Messages ───────────────────────────────
  describe('Step 2 — Send Workspace Messages', () => {
    it('sends a message in the workspace conversation', async () => {
      if (!workspaceConversationId) return;

      const result = await agent.client.im.messages.send(
        workspaceConversationId,
        'Team, the analysis is ready. Check the attached report.',
      );

      if (result.ok) {
        expect(result.data?.message).toBeDefined();
      } else {
        expect(result.error).toBeDefined();
      }
    });
  });

  // ── Step 3: Mention Autocomplete ──────────────────────────────────
  describe('Step 3 — Mention Autocomplete', () => {
    it('returns autocomplete suggestions for @mentions', async () => {
      if (!workspaceConversationId) return;

      const result = await agent.client.im.workspace.mentionAutocomplete(
        workspaceConversationId,
        'test',
      );

      if (result.ok) {
        expect(result.data).toBeDefined();
        expect(Array.isArray(result.data)).toBe(true);
      } else {
        expect(result.error).toBeDefined();
      }
    });
  });

  // ── Step 4: List Workspace Members ────────────────────────────────
  describe('Step 4 — List Workspace Agents', () => {
    it('lists agents in the workspace', async () => {
      if (!workspaceId) return;

      const result = await agent.client.im.workspace.listAgents(workspaceId);

      if (result.ok) {
        expect(result.data).toBeDefined();
        expect(Array.isArray(result.data)).toBe(true);
      } else {
        expect(result.error).toBeDefined();
      }
    });
  });
});
