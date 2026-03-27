/**
 * Prismer IM Client Example
 *
 * Demonstrates how to use the IM Server API:
 * - Workspace initialization
 * - User/Agent authentication
 * - Sending messages with @mentions
 * - WebSocket real-time communication
 */

import WebSocket from 'ws';

const IM_SERVER_URL = process.env.IM_SERVER_URL || 'http://localhost:3200';
const WS_URL = IM_SERVER_URL.replace('http', 'ws') + '/ws';

// ─── Types ────────────────────────────────────────────────────

interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface WorkspaceInitResult {
  conversationId: string;
  user: {
    imUserId: string;
    token: string;
  };
  agent?: {
    token: string;
    agentUserId: string;
    conversationId: string;
  };
}

interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  type: string;
  content: string;
  metadata: string;
  createdAt: string;
}

interface RoutingInfo {
  mode: 'explicit' | 'capability' | 'broadcast';
  targets: Array<{
    userId: string;
    username: string;
    displayName: string;
  }>;
}

// ─── API Client ───────────────────────────────────────────────

class PrismerIMClient {
  private token: string | null = null;
  private ws: WebSocket | null = null;
  private messageHandlers: Array<(msg: any) => void> = [];

  async initWorkspace(params: {
    workspaceId: string;
    userId: string;
    userDisplayName: string;
    agentName?: string;
    agentDisplayName?: string;
    agentCapabilities?: string[];
  }): Promise<WorkspaceInitResult> {
    // First, we need to register or login a user to get a token for the API call
    const authResp = await this.registerOrLogin('admin', 'Admin User');
    this.token = authResp.token;

    const resp = await fetch(`${IM_SERVER_URL}/api/workspace/init`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify(params),
    });

    const data: ApiResponse<WorkspaceInitResult> = await resp.json();
    if (!data.ok) throw new Error(data.error);

    // Use the new user token
    this.token = data.data!.user.token;
    return data.data!;
  }

  async registerOrLogin(username: string, displayName: string): Promise<{ token: string; userId: string }> {
    // Try to register first
    let resp = await fetch(`${IM_SERVER_URL}/api/users/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, displayName }),
    });

    let data: ApiResponse<{ user: { id: string }; token: string }> = await resp.json();

    if (!data.ok && data.error?.includes('already taken')) {
      // User exists, try login
      resp = await fetch(`${IM_SERVER_URL}/api/users/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      data = await resp.json();
    }

    if (!data.ok) throw new Error(data.error);
    return { token: data.data!.token, userId: data.data!.user.id };
  }

  async sendMessage(
    conversationId: string,
    content: string,
    type = 'text'
  ): Promise<{ message: Message; routing?: RoutingInfo }> {
    if (!this.token) throw new Error('Not authenticated');

    const resp = await fetch(`${IM_SERVER_URL}/api/messages/${conversationId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify({ content, type }),
    });

    const data: ApiResponse<{ message: Message; routing?: RoutingInfo }> = await resp.json();
    if (!data.ok) throw new Error(data.error);
    return data.data!;
  }

  async getMentionSuggestions(conversationId: string, query: string): Promise<any[]> {
    if (!this.token) throw new Error('Not authenticated');

    const resp = await fetch(
      `${IM_SERVER_URL}/api/workspace/mentions/autocomplete?conversationId=${conversationId}&query=${query}`,
      {
        headers: { 'Authorization': `Bearer ${this.token}` },
      }
    );

    const data: ApiResponse<any[]> = await resp.json();
    if (!data.ok) throw new Error(data.error);
    return data.data!;
  }

  // ─── WebSocket ────────────────────────────────────────────────

  connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.token) {
        reject(new Error('Not authenticated'));
        return;
      }

      this.ws = new WebSocket(`${WS_URL}?token=${this.token}`);

      this.ws.on('open', () => {
        console.log('[WS] Connected');
      });

      this.ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'authenticated') {
          console.log('[WS] Authenticated as', msg.payload.userId);
          resolve();
        }

        if (msg.type === 'error') {
          console.error('[WS] Error:', msg.payload.message);
          if (msg.payload.code === 'AUTH_FAILED') {
            reject(new Error(msg.payload.message));
          }
        }

        // Notify handlers
        for (const handler of this.messageHandlers) {
          handler(msg);
        }
      });

      this.ws.on('error', (err) => {
        console.error('[WS] Error:', err.message);
        reject(err);
      });

      this.ws.on('close', () => {
        console.log('[WS] Disconnected');
      });
    });
  }

  onMessage(handler: (msg: any) => void): void {
    this.messageHandlers.push(handler);
  }

  sendWsMessage(type: string, payload: any): void {
    if (!this.ws) throw new Error('Not connected');
    this.ws.send(JSON.stringify({
      type,
      payload,
      timestamp: Date.now(),
    }));
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ─── Example Usage ────────────────────────────────────────────

async function main() {
  console.log('=== Prismer IM Client Example ===\n');

  const client = new PrismerIMClient();

  try {
    // 1. Initialize workspace with user and agent
    console.log('1. Initializing workspace...');
    const workspace = await client.initWorkspace({
      workspaceId: 'example-workspace-001',
      userId: 'example-user-001',
      userDisplayName: 'Example User',
      agentName: 'code-assistant',
      agentDisplayName: 'Code Assistant',
      agentCapabilities: ['code_review', 'code_generation'],
    });

    console.log('   Conversation ID:', workspace.conversationId);
    console.log('   User ID:', workspace.user.imUserId);
    if (workspace.agent) {
      console.log('   Agent ID:', workspace.agent.agentUserId);
    }
    console.log();

    // 2. Send a message with @mention
    console.log('2. Sending message with @mention...');
    const result1 = await client.sendMessage(
      workspace.conversationId,
      '@code-assistant 请帮我审查这段代码',
      'text'
    );
    console.log('   Message ID:', result1.message.id);
    console.log('   Routing mode:', result1.routing?.mode);
    console.log('   Targets:', result1.routing?.targets.map(t => t.username).join(', '));
    console.log();

    // 3. Send a question (capability-based routing)
    console.log('3. Sending question (capability routing)...');
    const result2 = await client.sendMessage(
      workspace.conversationId,
      '如何优化这段代码的性能?',
      'text'
    );
    console.log('   Message ID:', result2.message.id);
    console.log('   Routing mode:', result2.routing?.mode);
    console.log();

    // 4. Get mention autocomplete suggestions
    console.log('4. Getting mention suggestions for "code"...');
    const suggestions = await client.getMentionSuggestions(workspace.conversationId, 'code');
    console.log('   Suggestions:', suggestions.map(s => `@${s.username}`).join(', '));
    console.log();

    // 5. Connect via WebSocket
    console.log('5. Connecting via WebSocket...');
    await client.connectWebSocket();

    // Listen for new messages
    client.onMessage((msg) => {
      if (msg.type === 'message.new') {
        console.log(`   [New Message] ${msg.payload.senderId}: ${msg.payload.content}`);
      }
    });

    // Send a message via WebSocket
    console.log('6. Sending message via WebSocket...');
    client.sendWsMessage('message.send', {
      conversationId: workspace.conversationId,
      content: 'Hello from WebSocket!',
      type: 'text',
    });

    // Wait a bit to receive messages
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Disconnect
    client.disconnect();
    console.log('\nDone!');

  } catch (err) {
    console.error('Error:', (err as Error).message);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export { PrismerIMClient };
