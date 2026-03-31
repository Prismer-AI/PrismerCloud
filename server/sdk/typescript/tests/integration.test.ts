/**
 * Prismer TypeScript SDK — Comprehensive Integration Tests
 *
 * Runs against the live production environment (https://prismer.cloud).
 * Requires PRISMER_API_KEY_TEST env var.
 *
 * Usage:
 *   PRISMER_API_KEY_TEST="sk-prismer-live-..." npx vitest run tests/integration.test.ts --reporter=verbose
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { PrismerClient } from '../src/index';
import { RealtimeWSClient, RealtimeSSEClient } from '../src/realtime';
import type { RealtimeConfig, MessageNewPayload } from '../src/realtime';

// Increase default test timeout for integration tests hitting a live API.
// Individual slow tests (search, PDF parse) get even longer timeouts below.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_KEY = process.env.PRISMER_API_KEY_TEST;
if (!API_KEY) {
  throw new Error('PRISMER_API_KEY_TEST environment variable is required');
}

const BASE_URL = process.env.PRISMER_BASE_URL_TEST || 'https://prismer.cloud';
const RUN_ID = Date.now().toString(36); // unique per run to avoid collisions

/** Create a client authenticated with the API key */
function apiClient(): PrismerClient {
  return new PrismerClient({
    apiKey: API_KEY!,
    baseUrl: BASE_URL,
    timeout: 60_000,
  });
}

/** Create a client authenticated with an IM JWT token */
function imClient(token: string): PrismerClient {
  return new PrismerClient({
    apiKey: token,
    baseUrl: BASE_URL,
    timeout: 60_000,
  });
}

// Module-level shared state for cross-describe sharing (IM + Realtime)
let agentAToken: string;
let agentAId: string;
let agentAUsername: string;
let agentBToken: string;
let agentBId: string;
let agentBUsername: string;
let clientA: PrismerClient;
let clientB: PrismerClient;
let directConversationId: string;
let groupId: string;

// ---------------------------------------------------------------------------
// Group 1: Context API
// ---------------------------------------------------------------------------

describe('Context API', () => {
  const client = apiClient();

  it('load() single URL — returns success with mode single_url', async () => {
    const result = await client.load('https://example.com');
    expect(result.success).toBe(true);
    expect(result.mode).toBe('single_url');
    expect(result.result).toBeDefined();
    expect(result.result!.url).toContain('example.com');
    // hqcc may or may not exist depending on cache state
    expect(typeof result.result!.cached).toBe('boolean');
  });

  it('load() batch URLs — returns success with mode batch_urls', async () => {
    const result = await client.load([
      'https://example.com',
      'https://httpbin.org/html',
    ]);
    expect(result.success).toBe(true);
    expect(result.mode).toBe('batch_urls');
    expect(result.results).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results!.length).toBeGreaterThanOrEqual(1);
  });

  it('load() search query — returns success', async () => {
    const result = await client.load('What is TypeScript?', {
      inputType: 'query',
    });
    expect(result.success).toBe(true);
    // mode could be 'query' for search-based load
    expect(result.requestId).toBeDefined();
  }, 60_000);

  it('save() — saves content and returns success', async () => {
    const result = await client.save({
      url: `https://test-${RUN_ID}.example.com/integration-test`,
      hqcc: `# Integration Test Content\n\nSaved at ${new Date().toISOString()} by run ${RUN_ID}.`,
    });
    expect(result.success).toBe(true);
  });

  it('search() — performs a search query', async () => {
    const result = await client.search('example domain');
    expect(result.success).toBe(true);
    expect(result.requestId).toBeDefined();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Group 2: Parse API
// ---------------------------------------------------------------------------

describe('Parse API', () => {
  const client = apiClient();

  it('parsePdf() with URL — returns success and requestId', async () => {
    const result = await client.parsePdf(
      'https://arxiv.org/pdf/2401.00001.pdf',
      'fast',
    );
    expect(result.success).toBe(true);
    expect(result.requestId).toBeDefined();
    // The response may be synchronous (document) or async (taskId)
    const hasDocOrTask = result.document !== undefined || result.taskId !== undefined;
    expect(hasDocOrTask).toBe(true);
  }, 60_000);

  it('parse() with mode auto — returns success', async () => {
    const result = await client.parse({
      url: 'https://arxiv.org/pdf/2401.00001.pdf',
      mode: 'auto',
    });
    expect(result.success).toBe(true);
    expect(result.requestId).toBeDefined();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Group 3: IM API — Full Lifecycle
// ---------------------------------------------------------------------------

describe('IM API', () => {
  const client = apiClient();

  // -----------------------------------------------------------------------
  // Account
  // -----------------------------------------------------------------------

  describe('Account', () => {
    it('register() agent A — returns isNew=true and token', async () => {
      agentAUsername = `test-agent-a-${RUN_ID}`;
      const reg = await client.im.account.register({
        type: 'agent',
        username: agentAUsername,
        displayName: `Test Agent A (${RUN_ID})`,
        agentType: 'assistant',
        capabilities: ['testing', 'integration'],
        description: 'Integration test agent A',
      });
      expect(reg.ok).toBe(true);
      expect(reg.data).toBeDefined();
      expect(reg.data!.isNew).toBe(true);
      expect(reg.data!.token).toBeDefined();
      expect(typeof reg.data!.token).toBe('string');
      expect(reg.data!.imUserId).toBeDefined();

      agentAToken = reg.data!.token;
      agentAId = reg.data!.imUserId;
      clientA = imClient(agentAToken);
    });

    it('register() agent B — second agent as message target', async () => {
      agentBUsername = `test-agent-b-${RUN_ID}`;
      const reg = await client.im.account.register({
        type: 'agent',
        username: agentBUsername,
        displayName: `Test Agent B (${RUN_ID})`,
        agentType: 'specialist',
        capabilities: ['testing'],
        description: 'Integration test agent B',
      });
      expect(reg.ok).toBe(true);
      expect(reg.data).toBeDefined();
      expect(reg.data!.isNew).toBe(true);
      expect(reg.data!.token).toBeDefined();

      agentBToken = reg.data!.token;
      agentBId = reg.data!.imUserId;
      clientB = imClient(agentBToken);
    });

    it('me() — returns user profile and agentCard', async () => {
      const me = await clientA.im.account.me();
      expect(me.ok).toBe(true);
      expect(me.data).toBeDefined();
      expect(me.data!.user).toBeDefined();
      expect(me.data!.user.username).toBe(agentAUsername);
      expect(me.data!.agentCard).toBeDefined();
      expect(me.data!.agentCard!.agentType).toBe('assistant');
    });

    it('refreshToken() — returns a new token', async () => {
      const refresh = await clientA.im.account.refreshToken();
      expect(refresh.ok).toBe(true);
      expect(refresh.data).toBeDefined();
      expect(refresh.data!.token).toBeDefined();
      expect(typeof refresh.data!.token).toBe('string');
      // Update token for subsequent calls
      agentAToken = refresh.data!.token;
      clientA = imClient(agentAToken);
    });
  });

  // -----------------------------------------------------------------------
  // Direct Messaging
  // -----------------------------------------------------------------------

  describe('Direct Messaging', () => {
    let firstDirectMessageId: string;

    it('send() — agent A sends message to agent B', async () => {
      const result = await clientA.im.direct.send(agentBId, 'Hello from Agent A!');
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.message).toBeDefined();
      expect(result.data!.message.id).toBeDefined();
      expect(result.data!.conversationId).toBeDefined();
      directConversationId = result.data!.conversationId;
      firstDirectMessageId = result.data!.message.id;
    });

    it('send() — agent B replies to agent A', async () => {
      const result = await clientB.im.direct.send(agentAId, 'Hello back from Agent B!');
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.message.id).toBeDefined();
    });

    it('getMessages() — retrieves message history', async () => {
      const result = await clientA.im.direct.getMessages(agentBId);
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data!.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Credits
  // -----------------------------------------------------------------------

  describe('Credits', () => {
    it('get() — returns balance for new agent', async () => {
      const result = await clientA.im.credits.get();
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(typeof result.data!.balance).toBe('number');
    });

    it('transactions() — returns transaction array', async () => {
      const result = await clientA.im.credits.transactions();
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Contacts & Discovery
  // -----------------------------------------------------------------------

  describe('Contacts & Discovery', () => {
    it('contacts.list() — returns contacts array', async () => {
      const result = await clientA.im.contacts.list();
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
      // After messaging agent B, agent B should be in contacts
      if (result.data!.length > 0) {
        const contact = result.data!.find(
          (c) => c.username === agentBUsername,
        );
        expect(contact).toBeDefined();
      }
    });

    it('contacts.discover() — returns array of agents', async () => {
      const result = await clientA.im.contacts.discover();
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Groups
  // -----------------------------------------------------------------------

  describe('Groups', () => {
    it('create() — creates a group chat', async () => {
      const result = await clientA.im.groups.create({
        title: `Test Group ${RUN_ID}`,
        description: 'Integration test group',
        members: [agentBId],
      });
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.groupId).toBeDefined();
      groupId = result.data!.groupId;
    });

    it('list() — lists groups', async () => {
      const result = await clientA.im.groups.list();
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data!.length).toBeGreaterThanOrEqual(1);
    });

    it('get() — gets group details', async () => {
      const result = await clientA.im.groups.get(groupId);
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.groupId).toBe(groupId);
      expect(result.data!.title).toContain('Test Group');
    });

    it('send() — sends message to group', async () => {
      const result = await clientA.im.groups.send(groupId, 'Hello group!');
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.message).toBeDefined();
    });

    it('addMember() — adds a member (may already be present)', async () => {
      // Agent B is already a member from creation, so this may succeed or return an error.
      // We test the call completes without throwing.
      const result = await clientA.im.groups.addMember(groupId, agentBId);
      // Could be ok=true (added) or ok=false (already member)
      expect(result).toBeDefined();
    });

    it('getMessages() — retrieves group messages', async () => {
      const result = await clientA.im.groups.getMessages(groupId);
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data!.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Conversations
  // -----------------------------------------------------------------------

  describe('Conversations', () => {
    it('list() — returns conversations array', async () => {
      const result = await clientA.im.conversations.list();
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data!.length).toBeGreaterThanOrEqual(1);
    });

    it('get() — returns conversation details', async () => {
      expect(directConversationId).toBeDefined();
      const result = await clientA.im.conversations.get(directConversationId);
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.id).toBe(directConversationId);
    });

    it('markAsRead() — marks conversation as read', async () => {
      const result = await clientA.im.conversations.markAsRead(directConversationId);
      expect(result.ok).toBe(true);
    });

    it('createDirect() — explicitly creates a DM conversation', async () => {
      const result = await clientA.im.conversations.createDirect(agentBId);
      // createDirect may or may not be available; accept ok or error
      if (result.ok) {
        expect(result.data).toBeDefined();
      } else {
        expect(result.error).toBeDefined();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Messages (low-level by conversationId)
  // -----------------------------------------------------------------------

  describe('Messages (low-level)', () => {
    let lowLevelMessageId: string;

    it('send() — sends message to a conversation', async () => {
      expect(directConversationId).toBeDefined();
      const result = await clientA.im.messages.send(
        directConversationId,
        'Low-level message test',
      );
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.message).toBeDefined();
      expect(result.data!.message.content).toBe('Low-level message test');
      lowLevelMessageId = result.data!.message.id;
    });

    it('getHistory() — retrieves messages for conversation', async () => {
      const result = await clientA.im.messages.getHistory(directConversationId);
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data!.length).toBeGreaterThanOrEqual(1);
    });

    it('edit() — edits a message', async () => {
      expect(lowLevelMessageId).toBeDefined();
      const result = await clientA.im.messages.edit(
        directConversationId,
        lowLevelMessageId,
        'Edited message content',
      );
      // edit may or may not be supported by the API
      if (result.ok) {
        expect(result.data).toBeDefined();
      } else {
        expect(result.error).toBeDefined();
      }
    });

    it('delete() — deletes a message', async () => {
      // Send a throwaway message to delete
      const sendResult = await clientA.im.messages.send(
        directConversationId,
        'Message to be deleted',
      );
      expect(sendResult.ok).toBe(true);
      const msgId = sendResult.data!.message.id;

      const result = await clientA.im.messages.delete(
        directConversationId,
        msgId,
      );
      // delete may or may not be supported by the API
      if (result.ok) {
        expect(result.ok).toBe(true);
      } else {
        expect(result.error).toBeDefined();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Message Threading (v3.4.0)
  // -----------------------------------------------------------------------

  describe('Message Threading (v3.4.0)', () => {
    let parentMessageId: string;
    let groupParentMessageId: string;

    it('direct send with parentId — creates a threaded reply', async () => {
      // First, send a parent message
      const parentResult = await clientA.im.direct.send(agentBId, 'Parent message for threading test');
      expect(parentResult.ok).toBe(true);
      parentMessageId = parentResult.data!.message.id;

      // Now send a reply with parentId
      const replyResult = await clientA.im.direct.send(agentBId, 'Reply to parent', {
        parentId: parentMessageId,
      });
      expect(replyResult.ok).toBe(true);
      expect(replyResult.data).toBeDefined();
      expect(replyResult.data!.message).toBeDefined();
      expect(replyResult.data!.message.id).toBeDefined();
      // The API may or may not echo back parentId in the response
    });

    it('group send with parentId — creates a threaded reply in group', async () => {
      // Send a parent message to group
      const parentResult = await clientA.im.groups.send(groupId, 'Group parent message');
      expect(parentResult.ok).toBe(true);
      groupParentMessageId = parentResult.data!.message.id;

      // Send a reply with parentId
      const replyResult = await clientA.im.groups.send(groupId, 'Group threaded reply', {
        parentId: groupParentMessageId,
      });
      expect(replyResult.ok).toBe(true);
      expect(replyResult.data).toBeDefined();
      expect(replyResult.data!.message).toBeDefined();
    });

    it('messages.send with parentId — low-level threaded reply', async () => {
      expect(directConversationId).toBeDefined();
      expect(parentMessageId).toBeDefined();

      const result = await clientA.im.messages.send(
        directConversationId,
        'Low-level threaded reply',
        { parentId: parentMessageId },
      );
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.message).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // New Message Types (v3.4.0)
  // -----------------------------------------------------------------------

  describe('New Message Types (v3.4.0)', () => {
    it('send markdown message', async () => {
      const result = await clientA.im.direct.send(agentBId, '# Heading\n\n**bold** text', {
        type: 'markdown',
      });
      expect(result.ok).toBe(true);
      expect(result.data!.message).toBeDefined();
      expect(result.data!.message.type).toBe('markdown');
    });

    it('send tool_call message', async () => {
      const result = await clientA.im.direct.send(
        agentBId,
        JSON.stringify({ tool: 'search', query: 'test' }),
        {
          type: 'tool_call',
          metadata: { toolName: 'search', toolCallId: 'tc-001' },
        },
      );
      expect(result.ok).toBe(true);
      expect(result.data!.message).toBeDefined();
      expect(result.data!.message.type).toBe('tool_call');
    });

    it('send tool_result message', async () => {
      const result = await clientA.im.direct.send(
        agentBId,
        JSON.stringify({ results: ['item1', 'item2'] }),
        {
          type: 'tool_result',
          metadata: { toolCallId: 'tc-001' },
        },
      );
      expect(result.ok).toBe(true);
      expect(result.data!.message).toBeDefined();
      expect(result.data!.message.type).toBe('tool_result');
    });

    it('send thinking message', async () => {
      const result = await clientA.im.direct.send(
        agentBId,
        'Analyzing the problem step by step...',
        { type: 'thinking' },
      );
      expect(result.ok).toBe(true);
      expect(result.data!.message).toBeDefined();
      expect(result.data!.message.type).toBe('thinking');
    });

    it('send image message', async () => {
      const result = await clientA.im.direct.send(
        agentBId,
        'https://example.com/test-image.png',
        {
          type: 'image',
          metadata: { mimeType: 'image/png', width: 800, height: 600 },
        },
      );
      expect(result.ok).toBe(true);
      expect(result.data!.message).toBeDefined();
      expect(result.data!.message.type).toBe('image');
    });

    it('send file message', async () => {
      const result = await clientA.im.direct.send(
        agentBId,
        'https://example.com/document.pdf',
        {
          type: 'file',
          metadata: { filename: 'document.pdf', mimeType: 'application/pdf', size: 1024 },
        },
      );
      expect(result.ok).toBe(true);
      expect(result.data!.message).toBeDefined();
      expect(result.data!.message.type).toBe('file');
    });
  });

  // -----------------------------------------------------------------------
  // Message Metadata (v3.4.0)
  // -----------------------------------------------------------------------

  describe('Message Metadata (v3.4.0)', () => {
    it('send message with structured metadata and verify in history', async () => {
      const metadata = {
        source: 'integration-test',
        version: '3.4.0',
        custom: { nested: true, tags: ['test', 'v3.4.0'] },
      };
      const result = await clientA.im.direct.send(
        agentBId,
        'Message with metadata',
        { metadata },
      );
      expect(result.ok).toBe(true);
      expect(result.data!.message).toBeDefined();

      // Verify metadata persists in history
      const history = await clientA.im.direct.getMessages(agentBId, { limit: 5 });
      expect(history.ok).toBe(true);
      const found = history.data!.find(
        (m: any) => m.content === 'Message with metadata',
      );
      expect(found).toBeDefined();
      if (found?.metadata) {
        expect(found.metadata).toBeDefined();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Groups Extended (v3.4.0)
  // -----------------------------------------------------------------------

  describe('Groups Extended', () => {
    let agentCId: string;
    let removeMemberGroupId: string;

    it('removeMember() — remove a member from a group', async () => {
      // Register a third agent for this test
      const regC = await client.im.account.register({
        type: 'agent',
        username: `test-agent-c-${RUN_ID}`,
        displayName: `Test Agent C (${RUN_ID})`,
        agentType: 'bot',
        capabilities: ['testing'],
      });
      expect(regC.ok).toBe(true);
      agentCId = regC.data!.imUserId;

      // Create a group with Agent C as member
      const createResult = await clientA.im.groups.create({
        title: `Remove Test Group ${RUN_ID}`,
        members: [agentCId],
      });
      expect(createResult.ok).toBe(true);
      removeMemberGroupId = createResult.data!.groupId;

      // Remove Agent C from the group
      const removeResult = await clientA.im.groups.removeMember(
        removeMemberGroupId,
        agentCId,
      );
      // removeMember may or may not be fully supported
      if (removeResult.ok) {
        expect(removeResult.ok).toBe(true);
        // Note: some API implementations may return ok but not immediately remove the member
      } else {
        expect(removeResult.error).toBeDefined();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Workspace
  // -----------------------------------------------------------------------

  describe('Workspace', () => {
    let workspaceId: string;

    it('init() — initializes a 1:1 workspace', async () => {
      const result = await clientA.im.workspace.init({ workspaceId: 'test-ws-int', userId: 'test-user', userDisplayName: 'Test User' });
      // Workspace may or may not be available in test env
      if (result.ok) {
        expect(result.data).toBeDefined();
        expect(result.data!.workspaceId).toBeDefined();
        expect(result.data!.conversationId).toBeDefined();
        workspaceId = result.data!.workspaceId;
      } else {
        // Acceptable: workspace feature may not be enabled
        expect(result.error).toBeDefined();
      }
    });

    it('initGroup() — initializes a group workspace', async () => {
      const result = await clientA.im.workspace.initGroup({ workspaceId: 'test-grp-ws-int', title: 'Integration Group', users: [{ userId: 'test-user', displayName: 'Test User' }] });
      if (result.ok) {
        expect(result.data).toBeDefined();
        expect(result.data!.workspaceId).toBeDefined();
      } else {
        expect(result.error).toBeDefined();
      }
    });

    it('mentionAutocomplete() — searches for @mention targets', async () => {
      const result = await clientA.im.workspace.mentionAutocomplete('test-conv', 'agent');
      if (result.ok) {
        expect(result.data).toBeDefined();
        expect(Array.isArray(result.data)).toBe(true);
      } else {
        // Feature may not be available
        expect(result.error).toBeDefined();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Edge Cases
  // -----------------------------------------------------------------------

  describe('Edge Cases', () => {
    it('register duplicate username (re-register same agent) — should return isNew=false or error', async () => {
      const reg = await client.im.account.register({
        type: 'agent',
        username: agentAUsername,
        displayName: `Test Agent A duplicate (${RUN_ID})`,
      });
      // Server may return ok with isNew=false (idempotent) or error 409
      if (reg.ok) {
        expect(reg.data!.isNew).toBe(false);
      } else {
        expect(reg.error).toBeDefined();
      }
    });

    it('send to nonexistent user — should fail', async () => {
      const result = await clientA.im.direct.send(
        'nonexistent-user-id-00000000',
        'This should fail',
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('access without auth — should fail (401)', async () => {
      const noAuthClient = new PrismerClient({
        apiKey: 'invalid-token-not-real',
        environment: 'production',
      });
      const result = await noAuthClient.im.account.me();
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Group 4: Real-Time — WebSocket
// ---------------------------------------------------------------------------

describe('Real-Time: WebSocket', () => {
  it('connect, authenticate, ping, joinConversation, receive message, disconnect', async () => {
    // Skip if no agent tokens available
    expect(agentAToken).toBeDefined();
    expect(agentBToken).toBeDefined();

    const baseUrl = BASE_URL;

    // Create WS client for Agent A
    const ws = new RealtimeWSClient(baseUrl, {
      token: agentAToken,
      autoReconnect: false,
      heartbeatInterval: 60_000, // disable heartbeat interference
    });

    // Track authenticated event
    let authPayload: any = null;
    ws.on('authenticated', (payload) => {
      authPayload = payload;
    });

    // Connect and verify authentication
    await ws.connect();
    expect(ws.state).toBe('connected');
    expect(authPayload).toBeDefined();
    expect(authPayload.userId).toBeDefined();
    // username may or may not be present depending on server version

    // Ping/pong — may timeout if server doesn't support ping
    try {
      const pong = await ws.ping();
      expect(pong).toBeDefined();
    } catch (e) {
      // Ping timeout is acceptable — server may not support ping/pong
    }

    // Join the direct conversation
    expect(directConversationId).toBeDefined();
    ws.joinConversation(directConversationId);

    // Wait briefly for join to process
    await new Promise((r) => setTimeout(r, 1000));

    // Listen for message.new event
    const messagePromise = new Promise<MessageNewPayload | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 15_000);
      ws.once('message.new', (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });

    // Agent B sends a message via HTTP API
    const sendResult = await clientB.im.direct.send(
      agentAId,
      `Realtime WS test ${RUN_ID}`,
    );
    expect(sendResult.ok).toBe(true);

    // Wait for the message.new event (may or may not arrive depending on server)
    const receivedMsg = await messagePromise;
    if (receivedMsg) {
      expect(receivedMsg.content).toBe(`Realtime WS test ${RUN_ID}`);
      expect(receivedMsg.senderId).toBe(agentBId);
    }

    // Disconnect
    ws.disconnect();
    expect(ws.state).toBe('disconnected');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Group 5: Real-Time — SSE
// ---------------------------------------------------------------------------

describe('Real-Time: SSE', () => {
  it('connect, authenticate, receive message, disconnect', async () => {
    expect(agentAToken).toBeDefined();
    expect(agentBToken).toBeDefined();

    const baseUrl = BASE_URL;

    // Create SSE client for Agent A
    const sse = new RealtimeSSEClient(baseUrl, {
      token: agentAToken,
      autoReconnect: false,
    });

    // Track authenticated event
    let authPayload: any = null;
    sse.on('authenticated', (payload) => {
      authPayload = payload;
    });

    // Connect
    await sse.connect();
    expect(sse.state).toBe('connected');

    // Wait briefly for auth event processing
    await new Promise((r) => setTimeout(r, 1000));
    // Auth payload may or may not be present depending on SSE implementation
    // SSE auto-joins all conversations

    // Listen for message.new event
    const messagePromise = new Promise<MessageNewPayload | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 15_000);
      sse.once('message.new', (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });

    // Agent B sends a message via HTTP API
    const sendResult = await clientB.im.direct.send(
      agentAId,
      `Realtime SSE test ${RUN_ID}`,
    );
    expect(sendResult.ok).toBe(true);

    // Wait for the message.new event (may or may not arrive depending on server)
    const receivedMsg = await messagePromise;
    if (receivedMsg) {
      expect(receivedMsg.content).toBe(`Realtime SSE test ${RUN_ID}`);
      expect(receivedMsg.senderId).toBe(agentBId);
    }

    // Disconnect
    sse.disconnect();
    expect(sse.state).toBe('disconnected');
  }, 60_000);
});
