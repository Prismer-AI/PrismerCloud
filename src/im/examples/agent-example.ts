/**
 * Prismer IM Agent Example
 *
 * Demonstrates how an Agent connects to IM Server:
 * - Authenticate with agent token
 * - Listen for incoming messages
 * - Detect @mentions targeting this agent
 * - Use response lock to avoid conflicts
 * - Send streaming responses
 */

import WebSocket from 'ws';

const IM_SERVER_URL = process.env.IM_SERVER_URL || 'http://localhost:3200';
const WS_URL = IM_SERVER_URL.replace('http', 'ws') + '/ws';

// ─── Types ────────────────────────────────────────────────────

interface IncomingMessage {
  id: string;
  conversationId: string;
  senderId: string;
  type: string;
  content: string;
  metadata: {
    mentions?: Array<{
      raw: string;
      username: string;
      userId?: string;
    }>;
    routeTargets?: string[];
    routingMode?: string;
  };
  createdAt: string;
}

interface WSMessage {
  type: string;
  payload: any;
  requestId?: string;
  timestamp: number;
}

// ─── Agent Client ─────────────────────────────────────────────

class PrismerIMAgent {
  private ws: WebSocket | null = null;
  private agentId: string | null = null;
  private conversationId: string;
  private messageHandler?: (msg: IncomingMessage) => Promise<void>;

  constructor(
    private token: string,
    conversationId: string,
  ) {
    this.conversationId = conversationId;
  }

  /**
   * Connect to IM Server via WebSocket.
   */
  connect(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${WS_URL}?token=${this.token}`);

      this.ws.on('open', () => {
        console.log('[Agent] Connected to IM Server');
      });

      this.ws.on('message', async (data: Buffer) => {
        const msg: WSMessage = JSON.parse(data.toString());
        await this.handleMessage(msg);

        if (msg.type === 'authenticated') {
          this.agentId = msg.payload.userId;
          console.log(`[Agent] Authenticated as ${this.agentId}`);
          resolve(this.agentId!);
        }

        if (msg.type === 'error' && msg.payload.code === 'AUTH_FAILED') {
          reject(new Error(msg.payload.message));
        }
      });

      this.ws.on('error', (err) => {
        console.error('[Agent] WebSocket error:', err.message);
        reject(err);
      });

      this.ws.on('close', () => {
        console.log('[Agent] Disconnected');
      });
    });
  }

  /**
   * Set handler for incoming messages.
   */
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Handle incoming WebSocket message.
   */
  private async handleMessage(wsMsg: WSMessage): Promise<void> {
    if (wsMsg.type === 'message.new') {
      const msg = wsMsg.payload as IncomingMessage;

      // Ignore our own messages
      if (msg.senderId === this.agentId) {
        return;
      }

      // Check if this message is routed to us
      const isTargeted = this.isMessageTargetedToMe(msg);

      if (isTargeted && this.messageHandler) {
        console.log(`[Agent] Received targeted message: ${msg.content.substring(0, 50)}...`);

        // Try to acquire response lock
        const lockAcquired = await this.tryAcquireLock(msg.id);
        if (!lockAcquired) {
          console.log('[Agent] Lock not acquired, another agent is handling this');
          return;
        }

        try {
          await this.messageHandler(msg);
        } finally {
          await this.releaseLock(msg.id);
        }
      }
    }
  }

  /**
   * Check if message is targeted to this agent.
   */
  private isMessageTargetedToMe(msg: IncomingMessage): boolean {
    // Check if we're in the route targets
    if (msg.metadata?.routeTargets?.includes(this.agentId!)) {
      return true;
    }

    // Check if we're mentioned
    if (msg.metadata?.mentions) {
      return msg.metadata.mentions.some((m) => m.userId === this.agentId);
    }

    // If routing mode is capability or broadcast, we should respond
    if (msg.metadata?.routingMode === 'capability' || msg.metadata?.routingMode === 'broadcast') {
      return true;
    }

    return false;
  }

  /**
   * Try to acquire response lock via REST API.
   */
  private async tryAcquireLock(messageId: string): Promise<boolean> {
    // Note: In a real implementation, you'd call the API
    // For now, we'll just return true (local development without Redis)
    console.log(`[Agent] Acquiring lock for message ${messageId}`);
    return true;
  }

  /**
   * Release response lock.
   */
  private async releaseLock(messageId: string): Promise<void> {
    console.log(`[Agent] Released lock for message ${messageId}`);
  }

  /**
   * Send a text response.
   */
  sendText(content: string): void {
    if (!this.ws) throw new Error('Not connected');

    this.ws.send(
      JSON.stringify({
        type: 'message.send',
        payload: {
          conversationId: this.conversationId,
          type: 'text',
          content,
        },
        timestamp: Date.now(),
      }),
    );
  }

  /**
   * Send a streaming response (typewriter effect).
   */
  async sendStreaming(generateContent: () => AsyncGenerator<string, void, unknown>): Promise<void> {
    if (!this.ws) throw new Error('Not connected');

    const streamId = `stream_${Date.now()}`;
    const chunks: string[] = [];

    // Start stream
    this.ws.send(
      JSON.stringify({
        type: 'message.stream.start',
        payload: {
          conversationId: this.conversationId,
          streamId,
          type: 'markdown',
        },
        timestamp: Date.now(),
      }),
    );

    // Send chunks
    let index = 0;
    for await (const chunk of generateContent()) {
      chunks.push(chunk);
      this.ws.send(
        JSON.stringify({
          type: 'message.stream.chunk',
          payload: {
            streamId,
            chunk,
            index: index++,
          },
          timestamp: Date.now(),
        }),
      );
      // Add small delay for visual effect
      await new Promise((r) => setTimeout(r, 50));
    }

    // End stream
    this.ws.send(
      JSON.stringify({
        type: 'message.stream.end',
        payload: {
          streamId,
          finalContent: chunks.join(''),
        },
        timestamp: Date.now(),
      }),
    );
  }

  /**
   * Send agent heartbeat.
   */
  sendHeartbeat(status: 'online' | 'busy' | 'idle' = 'online', load = 0): void {
    if (!this.ws) return;

    this.ws.send(
      JSON.stringify({
        type: 'agent.heartbeat',
        payload: {
          status,
          load,
          activeConversations: 1,
        },
        timestamp: Date.now(),
      }),
    );
  }

  /**
   * Start heartbeat interval.
   */
  startHeartbeat(intervalMs = 30000): NodeJS.Timeout {
    return setInterval(() => {
      this.sendHeartbeat('online', 0.1);
    }, intervalMs);
  }

  /**
   * Disconnect from server.
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ─── Example Usage ────────────────────────────────────────────

async function main() {
  console.log('=== Prismer IM Agent Example ===\n');

  // In a real scenario, you'd get this from workspace initialization
  // For this example, we'll create a new agent
  const registerResp = await fetch(`${IM_SERVER_URL}/api/users/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'demo-agent',
      displayName: 'Demo Agent',
      role: 'agent',
      agentType: 'assistant',
    }),
  }).then((r) => r.json());

  let agentToken: string;
  let agentId: string;

  if (!registerResp.ok) {
    // Agent exists, login
    const loginResp = await fetch(`${IM_SERVER_URL}/api/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'demo-agent' }),
    }).then((r) => r.json());

    agentToken = loginResp.data.token;
    agentId = loginResp.data.user.id;
  } else {
    agentToken = registerResp.data.token;
    agentId = registerResp.data.user.id;
  }

  console.log('Agent ID:', agentId);

  // Get or create a conversation
  // For demo, we'll create a direct conversation with the first available user
  const usersResp = await fetch(`${IM_SERVER_URL}/api/users/me`, {
    headers: { Authorization: `Bearer ${agentToken}` },
  }).then((r) => r.json());

  console.log('Agent user:', usersResp.data?.username);

  // Note: In a real scenario, the agent would be added to a workspace conversation
  // For this demo, we'll just listen for any conversations the agent is part of

  // Create agent client
  const conversationId = 'demo-conversation'; // Would come from workspace initialization
  const agent = new PrismerIMAgent(agentToken, conversationId);

  // Set up message handler
  agent.onMessage(async (msg) => {
    console.log(`[Agent] Processing: "${msg.content}"`);

    // Simulate thinking and responding
    await agent.sendStreaming(async function* () {
      const response = `I received your message: "${msg.content}". Let me help you with that...`;

      // Simulate streaming response word by word
      const words = response.split(' ');
      for (const word of words) {
        yield word + ' ';
      }
    });

    console.log('[Agent] Response sent');
  });

  try {
    // Connect
    await agent.connect();

    // Start heartbeat
    const heartbeatInterval = agent.startHeartbeat();

    console.log('[Agent] Ready and listening for messages...');
    console.log('[Agent] Press Ctrl+C to exit\n');

    // Keep running
    process.on('SIGINT', () => {
      console.log('\n[Agent] Shutting down...');
      clearInterval(heartbeatInterval);
      agent.disconnect();
      process.exit(0);
    });
  } catch (err) {
    console.error('Error:', (err as Error).message);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export { PrismerIMAgent };
