/**
 * Prismer IM — Webhook Integration Tests
 *
 * Tests webhook dispatch when messages are sent to conversations with agent endpoints.
 *
 * Prerequisites:
 *   - IM server running: DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/start.ts
 *   - Or via: npm run im:start (if DATABASE_URL is set)
 *
 * Usage: npx tsx src/im/tests/webhook.test.ts
 */

import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { createHmac } from 'crypto';

// Standalone IM server runs on port 3200, API routes at /api/*
const BASE = process.env.IM_BASE_URL || 'http://localhost:3200';
const TS = String(Date.now()).slice(-8);

// ─── Test Infrastructure ────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err: unknown) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name}: ${msg}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data: any;
  try {
    data = await res.json();
  } catch {
    data = { ok: res.ok };
  }
  return { status: res.status, data };
}

// ─── Webhook Receiver Mock Server ───────────────────────────
interface WebhookPayload {
  source: string;
  event: string;
  timestamp: number;
  message: {
    id: string;
    type: string;
    content: string;
    senderId: string;
    conversationId: string;
    parentId: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  };
  sender: {
    id: string;
    username: string;
    displayName: string | null;
    role: string;
  };
  conversation: {
    id: string;
    type: string;
    title: string | null;
  };
}

interface ReceivedWebhook {
  payload: WebhookPayload;
  signature: string;
  event: string;
  userAgent: string;
}

let mockServer: Server | null = null;
let receivedWebhooks: ReceivedWebhook[] = [];

function startMockServer(port: number, secret: string): Promise<void> {
  return new Promise((resolve) => {
    mockServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST' && req.url === '/webhook') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          const signature = (req.headers['x-prismer-signature'] as string) || '';
          const event = (req.headers['x-prismer-event'] as string) || '';
          const userAgent = (req.headers['user-agent'] as string) || '';

          // Verify HMAC signature
          const expectedSig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
          const isValid = signature === expectedSig;

          if (isValid) {
            const payload = JSON.parse(body) as WebhookPayload;
            receivedWebhooks.push({ payload, signature, event, userAgent });
            console.log(`  [MockServer] Received webhook: ${event}, msg="${payload.message.content}"`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } else {
            console.error(`  [MockServer] Invalid signature: got ${signature}, expected ${expectedSig}`);
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid signature' }));
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    mockServer.listen(port, () => {
      console.log(`[MockServer] Listening on http://localhost:${port}\n`);
      resolve();
    });
  });
}

function stopMockServer(): Promise<void> {
  return new Promise((resolve) => {
    if (mockServer) {
      mockServer.close(() => {
        console.log('[MockServer] Stopped');
        resolve();
      });
    } else {
      resolve();
    }
  });
}

// ─── Test State ─────────────────────────────────────────────
let userToken: string;
let userId: string;
let agentToken: string;
let agentId: string;
let conversationId: string;

const WEBHOOK_PORT = 8765;
const WEBHOOK_SECRET = `test-secret-${TS}`;
const WEBHOOK_URL = `http://localhost:${WEBHOOK_PORT}/webhook`;

// ─── Tests ──────────────────────────────────────────────────
async function main() {
  console.log('🧪 Prismer IM — Webhook Integration Tests');
  console.log(`   Base URL: ${BASE}`);
  console.log(`   Webhook receiver: ${WEBHOOK_URL}\n`);

  // Start mock webhook receiver
  await startMockServer(WEBHOOK_PORT, WEBHOOK_SECRET);

  try {
    // ── Phase 1: Setup ──────────────────────────────────────
    console.log('🔹 Setup');

    await test('Register human user', async () => {
      const res = await api('POST', '/register', {
        type: 'human',
        username: `wh_user_${TS}`,
        displayName: `Webhook Test User ${TS}`,
      });
      assert(res.data.ok === true, `Registration failed: ${JSON.stringify(res.data)}`);
      assert(res.data.data?.token, 'No token returned');
      userToken = res.data.data.token;
      userId = res.data.data.imUserId;
      console.log(`    → userId: ${userId}`);
    });

    await test('Register agent with webhook endpoint', async () => {
      const res = await api('POST', '/register', {
        type: 'agent',
        username: `wh_agent_${TS}`,
        displayName: `Webhook Test Agent ${TS}`,
        capabilities: ['chat', 'webhook-test'],
        endpoint: WEBHOOK_URL,
        webhookSecret: WEBHOOK_SECRET,
      });
      assert(res.data.ok === true, `Registration failed: ${JSON.stringify(res.data)}`);
      assert(res.data.data?.token, 'No token returned');
      agentToken = res.data.data.token;
      agentId = res.data.data.imUserId;
      console.log(`    → agentId: ${agentId}`);
    });

    // ── Phase 2: Send message & verify webhook ──────────────
    console.log('\n🔹 Webhook Dispatch');

    await test('Send direct message from user to agent', async () => {
      const res = await api(
        'POST',
        `/direct/${agentId}/messages`,
        { content: 'Hello agent, testing webhook dispatch' },
        userToken
      );
      assert(res.data.ok === true, `Send failed: ${JSON.stringify(res.data)}`);
      conversationId = res.data.data.conversationId;
      console.log(`    → conversationId: ${conversationId}`);
    });

    await test('Wait for webhook delivery', async () => {
      // Webhook is fire-and-forget — wait up to 3 seconds
      for (let i = 0; i < 30; i++) {
        if (receivedWebhooks.length > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert(receivedWebhooks.length > 0, 'No webhook received within 3s');
    });

    await test('Webhook payload has correct structure', () => {
      const wh = receivedWebhooks[0];
      assert(wh.payload.source === 'prismer_im', `source: ${wh.payload.source}`);
      assert(wh.payload.event === 'message.new', `event: ${wh.payload.event}`);
      assert(typeof wh.payload.timestamp === 'number', `timestamp: ${wh.payload.timestamp}`);
      assert(typeof wh.payload.message === 'object', 'missing message');
      assert(typeof wh.payload.sender === 'object', 'missing sender');
      assert(typeof wh.payload.conversation === 'object', 'missing conversation');
    });

    await test('Webhook X-Prismer-Event header matches', () => {
      const wh = receivedWebhooks[0];
      assert(wh.event === 'message.new', `X-Prismer-Event: ${wh.event}`);
    });

    await test('Webhook User-Agent is Prismer-IM', () => {
      const wh = receivedWebhooks[0];
      assert(wh.userAgent.includes('Prismer-IM'), `User-Agent: ${wh.userAgent}`);
    });

    await test('Webhook HMAC signature is valid', () => {
      const wh = receivedWebhooks[0];
      // If we got here, the mock server already verified the signature
      assert(wh.signature.startsWith('sha256='), `sig: ${wh.signature}`);
    });

    await test('Webhook message content matches sent message', () => {
      const wh = receivedWebhooks[0];
      assert(wh.payload.message.type === 'text', `type: ${wh.payload.message.type}`);
      assert(
        wh.payload.message.content === 'Hello agent, testing webhook dispatch',
        `content: ${wh.payload.message.content}`
      );
    });

    await test('Webhook senderId matches user', () => {
      const wh = receivedWebhooks[0];
      assert(wh.payload.message.senderId === userId, `senderId: ${wh.payload.message.senderId}`);
      assert(wh.payload.sender.id === userId, `sender.id: ${wh.payload.sender.id}`);
      assert(wh.payload.sender.username === `wh_user_${TS}`, `sender.username: ${wh.payload.sender.username}`);
      assert(wh.payload.sender.role === 'human', `sender.role: ${wh.payload.sender.role}`);
    });

    await test('Webhook conversation info is correct', () => {
      const wh = receivedWebhooks[0];
      assert(wh.payload.conversation.id === conversationId, 'conversation.id mismatch');
      assert(wh.payload.conversation.type === 'direct', `type: ${wh.payload.conversation.type}`);
    });

    // ── Phase 3: Multiple messages & self-send exclusion ─────
    console.log('\n🔹 Multiple Messages & Self-Send Exclusion');

    receivedWebhooks = []; // Reset

    await test('User sends second message → triggers webhook', async () => {
      const res = await api(
        'POST',
        `/messages/${conversationId}`,
        { content: 'Second message from user' },
        userToken
      );
      assert(res.data.ok === true, `Send failed: ${JSON.stringify(res.data)}`);
    });

    await test('Agent sends message → should NOT trigger webhook to itself', async () => {
      const res = await api(
        'POST',
        `/messages/${conversationId}`,
        { content: 'Agent reply' },
        agentToken
      );
      assert(res.data.ok === true, `Send failed: ${JSON.stringify(res.data)}`);
    });

    await test('Verify: only 1 webhook received (user msg, not agent self-msg)', async () => {
      // Wait for any pending webhooks
      await new Promise((r) => setTimeout(r, 2000));
      assert(
        receivedWebhooks.length === 1,
        `Expected 1 webhook, got ${receivedWebhooks.length}`
      );
      assert(
        receivedWebhooks[0].payload.message.content === 'Second message from user',
        `content: ${receivedWebhooks[0]?.payload?.message?.content}`
      );
    });

    // ── Phase 4: Cleanup ─────────────────────────────────────
    console.log('\n🔹 Cleanup');

    await test('Delete conversation', async () => {
      const res = await api('DELETE', `/conversations/${conversationId}`, undefined, userToken);
      // Accept 200 or 204 or even 404 (if conversation auto-cleanup)
      assert(res.status < 500, `Unexpected status: ${res.status}`);
    });
  } finally {
    await stopMockServer();
  }

  // ─── Results ────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failures.length > 0) {
    console.log('\n❌ Failures:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  stopMockServer().then(() => process.exit(1));
});
