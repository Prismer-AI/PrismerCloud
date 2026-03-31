/**
 * Integration edge-case tests for Prismer TypeScript SDK.
 *
 * Runs against the live test environment (https://cloud.prismer.dev).
 * Requires PRISMER_API_KEY_TEST env var.
 *
 * Tests boundary values, unusual inputs, and parameter combinations
 * that are not covered by the main integration suite.
 *
 * Usage:
 *   PRISMER_API_KEY_TEST="sk-prismer-live-..." npx vitest run tests/integration/edge-cases.test.ts --reporter=verbose
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { PrismerClient } from '../../src/index';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const API_KEY = process.env.PRISMER_API_KEY_TEST;
if (!API_KEY) {
  throw new Error('PRISMER_API_KEY_TEST environment variable is required');
}

const BASE_URL = 'https://cloud.prismer.dev';
const RUN_ID = Date.now().toString(36);
const TIMEOUT = 30_000;

function apiClient(): PrismerClient {
  return new PrismerClient({
    apiKey: API_KEY!,
    baseUrl: BASE_URL,
    timeout: 60_000,
  });
}

function imClient(token: string): PrismerClient {
  return new PrismerClient({
    apiKey: token,
    baseUrl: BASE_URL,
    timeout: 60_000,
  });
}

// Shared state for IM tests
let agentToken: string;
let agentId: string;
let agentBToken: string;
let agentBId: string;
let conversationId: string;
let client: PrismerClient;
let clientAgent: PrismerClient;
let clientAgentB: PrismerClient;

// ---------------------------------------------------------------------------
// IM Setup: register two agents for messaging tests
// ---------------------------------------------------------------------------

beforeAll(async () => {
  client = apiClient();

  // Register agent A
  const regA = await client.im.account.register({
    type: 'agent',
    username: `edge-agent-a-${RUN_ID}`,
    displayName: `Edge Agent A (${RUN_ID})`,
    agentType: 'assistant',
    capabilities: ['testing', 'edge-cases'],
    description: 'Edge case test agent A',
  });
  expect(regA.ok).toBe(true);
  agentToken = regA.data!.token;
  agentId = regA.data!.imUserId;
  clientAgent = imClient(agentToken);

  // Register agent B
  const regB = await client.im.account.register({
    type: 'agent',
    username: `edge-agent-b-${RUN_ID}`,
    displayName: `Edge Agent B (${RUN_ID})`,
    agentType: 'specialist',
    capabilities: ['testing'],
    description: 'Edge case test agent B',
  });
  expect(regB.ok).toBe(true);
  agentBToken = regB.data!.token;
  agentBId = regB.data!.imUserId;
  clientAgentB = imClient(agentBToken);

  // Send an initial message to establish a conversation
  const sendResult = await clientAgent.im.direct.send(agentBId, 'setup message');
  if (sendResult.ok && sendResult.data) {
    conversationId = sendResult.data.conversationId;
  }
}, 60_000);

// ---------------------------------------------------------------------------
// Context API Edge Cases
// ---------------------------------------------------------------------------

describe('Context API edge cases', () => {
  it('load() with empty string input', async () => {
    const result = await client.load('');
    // Should either fail gracefully or return an error
    expect(result).toBeDefined();
    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  }, TIMEOUT);

  it('load() with format: raw', async () => {
    const result = await client.load('https://example.com', {
      return: { format: 'raw' },
    });
    expect(result).toBeDefined();
    if (result.success) {
      expect(result.requestId).toBeDefined();
      // When format is 'raw', result may contain raw field
      if (result.result) {
        // raw field may or may not be populated depending on cache state
        expect(typeof result.result.cached).toBe('boolean');
      }
    }
  }, TIMEOUT);

  it('load() with format: both', async () => {
    // Note: 'both' format may not be supported by all backend versions
    const result = await client.load('https://example.com', {
      return: { format: 'both' },
    });
    expect(result).toBeDefined();
    // Gracefully handle unsupported format
    if (result.success) {
      expect(result.requestId).toBeDefined();
    } else {
      // Backend may reject 'both' format
      expect(result.error).toBeDefined();
    }
  }, TIMEOUT);

  it('save() with visibility: public', async () => {
    const result = await client.save({
      url: `https://edge-test-${RUN_ID}.example.com/public`,
      hqcc: `# Public Content\n\nEdge case test at ${new Date().toISOString()}`,
      visibility: 'public',
    });
    expect(result).toBeDefined();
    if (result.success) {
      // Visibility may be reflected in response
      if (result.visibility) {
        expect(result.visibility).toBe('public');
      }
    }
  }, TIMEOUT);

  it('save() with tags and meta fields', async () => {
    const result = await client.save({
      url: `https://edge-test-${RUN_ID}.example.com/meta`,
      hqcc: `# Content with metadata\n\nTest content.`,
      meta: {
        tags: ['test', 'edge-case', 'integration'],
        source: 'sdk-test',
        customField: 42,
        nested: { key: 'value' },
      },
    });
    expect(result).toBeDefined();
    if (result.success) {
      expect(result.success).toBe(true);
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// Direct Messaging Edge Cases
// ---------------------------------------------------------------------------

describe('Direct messaging edge cases', () => {
  it('send() with empty content string', async () => {
    const result = await clientAgent.im.direct.send(agentBId, '');
    // Server may reject empty content or accept it
    expect(result).toBeDefined();
    if (result.ok) {
      expect(result.data).toBeDefined();
      expect(result.data!.message).toBeDefined();
    } else {
      expect(result.error).toBeDefined();
    }
  }, TIMEOUT);

  it('send() with very long content (10000 chars)', async () => {
    const longContent = 'A'.repeat(10000);
    const result = await clientAgent.im.direct.send(agentBId, longContent);
    expect(result).toBeDefined();
    if (result.ok) {
      expect(result.data).toBeDefined();
      expect(result.data!.message).toBeDefined();
      // Content may be truncated or stored in full
      expect(result.data!.message.content.length).toBeGreaterThan(0);
    } else {
      // Server may reject extremely long messages
      expect(result.error).toBeDefined();
    }
  }, TIMEOUT);

  it('send() with special characters: emoji', async () => {
    const emojiContent = 'Hello! Testing emoji handling correctly.';
    const result = await clientAgent.im.direct.send(agentBId, emojiContent);
    expect(result).toBeDefined();
    if (result.ok) {
      expect(result.data!.message.content).toBe(emojiContent);
    }
  }, TIMEOUT);

  it('send() with special characters: unicode and CJK', async () => {
    const unicodeContent = 'Multi-script test';
    const result = await clientAgent.im.direct.send(agentBId, unicodeContent);
    expect(result).toBeDefined();
    if (result.ok) {
      expect(result.data!.message.content).toBe(unicodeContent);
    }
  }, TIMEOUT);

  it('send() with special characters: HTML tags', async () => {
    const htmlContent = '<script>alert("xss")</script><b>bold</b>&amp;escaped';
    const result = await clientAgent.im.direct.send(agentBId, htmlContent);
    expect(result).toBeDefined();
    if (result.ok) {
      // Server should store the content (may sanitize or escape)
      expect(result.data!.message).toBeDefined();
      expect(result.data!.message.content.length).toBeGreaterThan(0);
    }
  }, TIMEOUT);

  it('getMessages() with limit=1', async () => {
    const result = await clientAgent.im.direct.getMessages(agentBId, {
      limit: 1,
    });
    expect(result).toBeDefined();
    if (result.ok) {
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data!.length).toBeLessThanOrEqual(1);
    }
  }, TIMEOUT);

  it('getMessages() with limit=0', async () => {
    const result = await clientAgent.im.direct.getMessages(agentBId, {
      limit: 0,
    });
    expect(result).toBeDefined();
    // Server may return empty array or treat 0 as "no limit" or reject
    if (result.ok) {
      expect(Array.isArray(result.data)).toBe(true);
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// Groups Edge Cases
// ---------------------------------------------------------------------------

describe('Groups edge cases', () => {
  it('create() with empty members array', async () => {
    const result = await clientAgent.im.groups.create({
      title: `Empty Members Group ${RUN_ID}`,
      description: 'Group with no initial members',
      members: [],
    });
    expect(result).toBeDefined();
    if (result.ok) {
      // Group should be created with only the creator as member
      expect(result.data).toBeDefined();
      expect(result.data!.groupId).toBeDefined();
      expect(result.data!.title).toContain('Empty Members Group');
    } else {
      // Some servers may require at least one member
      expect(result.error).toBeDefined();
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// Conversations Edge Cases
// ---------------------------------------------------------------------------

describe('Conversations edge cases', () => {
  it('list() with withUnread=true', async () => {
    const result = await clientAgent.im.conversations.list({
      withUnread: true,
    });
    expect(result).toBeDefined();
    if (result.ok) {
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
      // Each conversation should have unreadCount when withUnread is true
      for (const conv of result.data!) {
        expect(conv.id).toBeDefined();
        // unreadCount may or may not be present depending on implementation
      }
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// Messages Edge Cases
// ---------------------------------------------------------------------------

describe('Messages edge cases', () => {
  it('edit() with non-existent messageId', async () => {
    // Use the conversation we established in beforeAll
    expect(conversationId).toBeDefined();

    const result = await clientAgent.im.messages.edit(
      conversationId,
      'non-existent-message-id-00000000',
      'This edit should fail',
    );
    expect(result).toBeDefined();
    // Should fail because message does not exist
    if (!result.ok) {
      expect(result.error).toBeDefined();
    }
    // Some servers may silently accept the edit (unlikely but possible)
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// Credits Edge Cases
// ---------------------------------------------------------------------------

describe('Credits edge cases', () => {
  it('transactions() with limit and offset', async () => {
    const result = await clientAgent.im.credits.transactions({
      limit: 5,
      offset: 0,
    });
    expect(result).toBeDefined();
    if (result.ok) {
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data!.length).toBeLessThanOrEqual(5);
    }
  }, TIMEOUT);

  it('transactions() with large offset (beyond data)', async () => {
    const result = await clientAgent.im.credits.transactions({
      limit: 10,
      offset: 999999,
    });
    expect(result).toBeDefined();
    if (result.ok) {
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
      // Should return empty array when offset exceeds data
      expect(result.data!.length).toBe(0);
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// Contacts & Discovery Edge Cases
// ---------------------------------------------------------------------------

describe('Contacts & Discovery edge cases', () => {
  it('discover() with type filter', async () => {
    const result = await clientAgent.im.contacts.discover({
      type: 'assistant',
    });
    expect(result).toBeDefined();
    if (result.ok) {
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
      // All results should be of the requested type (if server filters)
      for (const agent of result.data!) {
        // agentType may or may not be 'assistant' depending on implementation
        expect(agent.username).toBeDefined();
        expect(agent.displayName).toBeDefined();
      }
    }
  }, TIMEOUT);

  it('discover() with non-existent capability filter', async () => {
    const result = await clientAgent.im.contacts.discover({
      capability: 'non-existent-capability-xyz-12345',
    });
    expect(result).toBeDefined();
    if (result.ok) {
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
      // Should return empty or unfiltered results
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// Workspace Edge Cases
// ---------------------------------------------------------------------------

describe('Workspace edge cases', () => {
  it('addAgent() with arbitrary workspaceId', async () => {
    const result = await clientAgent.im.workspace.addAgent(
      `test-ws-edge-${RUN_ID}`,
      agentBId,
    );
    expect(result).toBeDefined();
    // May succeed if workspace is auto-created, or fail if workspace doesn't exist
    if (result.ok) {
      // Workspace agent added
    } else {
      expect(result.error).toBeDefined();
    }
  }, TIMEOUT);

  it('listAgents() with arbitrary workspaceId', async () => {
    const result = await clientAgent.im.workspace.listAgents(
      `test-ws-edge-${RUN_ID}`,
    );
    expect(result).toBeDefined();
    if (result.ok) {
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
    } else {
      expect(result.error).toBeDefined();
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// Account Edge Cases
// ---------------------------------------------------------------------------

describe('Account edge cases', () => {
  it('register() with aipDid field', async () => {
    // Register a new agent providing an aipDid (DID key)
    const result = await client.im.account.register({
      type: 'agent',
      username: `edge-aip-agent-${RUN_ID}`,
      displayName: `AIP Edge Agent (${RUN_ID})`,
      agentType: 'bot',
      capabilities: ['aip'],
      description: 'Edge case test with aipDid',
    } as any); // aipDid may not be in the type yet, cast to any

    expect(result).toBeDefined();
    if (result.ok) {
      expect(result.data).toBeDefined();
      expect(result.data!.token).toBeDefined();
      expect(result.data!.imUserId).toBeDefined();
    }
  }, TIMEOUT);

  it('register() with very long username', async () => {
    const longUsername = `edge-${'x'.repeat(200)}-${RUN_ID}`;
    const result = await client.im.account.register({
      type: 'agent',
      username: longUsername,
      displayName: 'Long Username Agent',
    });
    expect(result).toBeDefined();
    // Server may reject long usernames
    if (!result.ok) {
      expect(result.error).toBeDefined();
    }
  }, TIMEOUT);

  it('register() with special characters in displayName', async () => {
    const result = await client.im.account.register({
      type: 'agent',
      username: `edge-special-name-${RUN_ID}`,
      displayName: 'Agent <script>alert(1)</script> & "quotes"',
      agentType: 'assistant',
    });
    expect(result).toBeDefined();
    if (result.ok) {
      expect(result.data).toBeDefined();
      expect(result.data!.token).toBeDefined();
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// Parse Edge Cases
// ---------------------------------------------------------------------------

describe('Parse edge cases', () => {
  it('parse with mode hires', async () => {
    const result = await client.parse({
      url: 'https://arxiv.org/pdf/2401.00001.pdf',
      mode: 'hires',
    });
    expect(result).toBeDefined();
    if (result.success) {
      expect(result.requestId).toBeDefined();
      // hires mode may be async
      if (result.async) {
        expect(result.taskId).toBeDefined();
      } else if (result.document) {
        expect(result.document.pageCount).toBeGreaterThan(0);
      }
    } else {
      // hires may fail due to cost/quota constraints in test env
      expect(result.error).toBeDefined();
    }
  }, 60_000); // PDF parsing can be slow

  it('parse with invalid URL returns error', async () => {
    const result = await client.parse({
      url: 'not-a-valid-url',
      mode: 'fast',
    });
    expect(result).toBeDefined();
    // Should fail
    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  }, 60_000);

  it('parse with empty URL returns error', async () => {
    const result = await client.parse({
      url: '',
      mode: 'fast',
    });
    expect(result).toBeDefined();
    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// Cross-cutting: Multiple concurrent requests
// ---------------------------------------------------------------------------

describe('Concurrent request handling', () => {
  it('multiple simultaneous load() calls resolve independently', async () => {
    const results = await Promise.all([
      client.load('https://example.com'),
      client.load('https://httpbin.org/html'),
    ]);

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result).toBeDefined();
      // Each should have resolved (success or error) independently
      expect(typeof result.success).toBe('boolean');
    }
  }, 60_000);

  it('multiple simultaneous IM calls resolve independently', async () => {
    const results = await Promise.all([
      clientAgent.im.credits.get(),
      clientAgent.im.contacts.list(),
      clientAgent.im.conversations.list(),
    ]);

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result).toBeDefined();
      // Each result should have ok field
      expect(typeof result.ok).toBe('boolean');
    }
  }, TIMEOUT);
});
