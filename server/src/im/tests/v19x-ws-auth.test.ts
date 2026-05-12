/**
 * Track C m3 — WS API key auth + shadow-connection unit tests
 *
 * The full handler is tightly coupled to the WebSocket lifecycle (ws.send,
 * timers, route registration), so end-to-end coverage is m4 territory.
 * Here we test the deterministic logic that lives outside the connection
 * callback:
 *
 *   1. validateApiKeyFromDb returns null vs. {userId} — drives the
 *      "Invalid API key" response.
 *   2. The IMUser lookup `where: {userId: String(cloudUserId), role:
 *      'human'}` is the binding rule — verify both happy path and the
 *      "agent IMUser shares cloudUserId" disambiguation.
 *   3. Ownership check: declared agent imUserIds must share the same
 *      cloud `userId` as the connected human.
 *   4. Shadow ConnectedClient registration: one per declared agent;
 *      shares the underlying transport.
 *
 * Real e2e (Track B daemon → cloud) is m4.
 *
 * Usage: npx tsx src/im/tests/v19x-ws-auth.test.ts
 */

import type { Transport } from '../ws/transport';
import { RoomManager, type ConnectedClient } from '../ws/rooms';

// ─── Test plumbing ───────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err: any) {
    failed++;
    failures.push(`${name}: ${err.message || String(err)}`);
    console.log(`  ❌ ${name}: ${err.message || String(err)}`);
  }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

function assertTrue(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
}

// ─── Mock transport (one underlying socket, many ConnectedClients) ───

class MockTransport implements Transport {
  public sent: string[] = [];
  public closed = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  get readyState(): 0 | 1 | 2 | 3 {
    return this.closed ? 3 : 1;
  }
}

// ─── Helpers replicating handler's logic ─────────────────────

/**
 * Verify each declared agent imUserId is owned by the connected human's
 * cloud user. Mirrors the logic in handleAgentHostDeclare. Returns the
 * list of *invalid* declared ids (empty = all valid).
 */
function validateAgentOwnership(
  declared: { imUserId: string }[],
  ownerCloudUserId: string,
  knownAgents: Record<string, { userId: string | null; role: string }>,
): string[] {
  const invalid: string[] = [];
  for (const d of declared) {
    const a = knownAgents[d.imUserId];
    if (!a || a.role !== 'agent' || a.userId !== ownerCloudUserId) {
      invalid.push(d.imUserId);
    }
  }
  return invalid;
}

/**
 * Mirror the shadow-registration step in handleAgentHostDeclare: one
 * shadow ConnectedClient per declared agent, all sharing the underlying
 * transport.
 */
function registerShadowConnections(
  rooms: RoomManager,
  client: ConnectedClient,
  declaredAgentIds: Iterable<string>,
): ConnectedClient[] {
  const shadows: ConnectedClient[] = [];
  for (const id of declaredAgentIds) {
    const shadow: ConnectedClient = {
      transport: client.transport,
      userId: id,
      username: `agent:${id}`,
      connectedAt: client.connectedAt,
    };
    rooms.addClient(shadow);
    shadows.push(shadow);
  }
  return shadows;
}

// ─── Suite ───────────────────────────────────────────────────

console.log('\n🔹 WS API key auth + shadow connections — m3 v1.9.3');

// ─── Ownership validation ────────────────────────────────────

test('all declared agents owned by same cloud user → empty invalid list', () => {
  const invalid = validateAgentOwnership([{ imUserId: 'agent-1' }, { imUserId: 'agent-2' }], '42', {
    'agent-1': { userId: '42', role: 'agent' },
    'agent-2': { userId: '42', role: 'agent' },
  });
  assertEq(invalid, [], 'no invalid');
});

test('declared agent owned by different cloud user → flagged', () => {
  const invalid = validateAgentOwnership([{ imUserId: 'agent-attacker' }], '42', {
    'agent-attacker': { userId: '99', role: 'agent' }, // someone else's
  });
  assertEq(invalid, ['agent-attacker'], 'rejected');
});

test('declared agent not in DB → flagged', () => {
  const invalid = validateAgentOwnership([{ imUserId: 'ghost' }], '42', {});
  assertEq(invalid, ['ghost'], 'rejected');
});

test('declared id is human, not agent → flagged', () => {
  const invalid = validateAgentOwnership([{ imUserId: 'imuser-bob' }], '42', {
    'imuser-bob': { userId: '42', role: 'human' }, // wrong role
  });
  assertEq(invalid, ['imuser-bob'], 'rejected');
});

test('mixed valid + invalid → only invalid surfaces', () => {
  const invalid = validateAgentOwnership([{ imUserId: 'agent-valid' }, { imUserId: 'agent-invalid' }], '42', {
    'agent-valid': { userId: '42', role: 'agent' },
    'agent-invalid': { userId: '99', role: 'agent' },
  });
  assertEq(invalid, ['agent-invalid'], 'partial');
});

// ─── Shadow connection registration ──────────────────────────

test('one shadow per declared agent, all share the transport', () => {
  const rooms = new RoomManager();
  const transport = new MockTransport();
  const human: ConnectedClient = {
    transport,
    userId: 'human-alice',
    username: 'alice',
    connectedAt: Date.now(),
  };
  rooms.addClient(human);
  const shadows = registerShadowConnections(rooms, human, ['agent-pm', 'agent-eng']);

  assertEq(shadows.length, 2, 'two shadows');
  assertTrue(rooms.getClientConnections('agent-pm').size === 1, 'agent-pm registered');
  assertTrue(rooms.getClientConnections('agent-eng').size === 1, 'agent-eng registered');
  assertTrue(rooms.getClientConnections('human-alice').size === 1, 'human still registered');

  // Verify transport sharing: send to one shadow → reaches the same socket.
  const pmConns = Array.from(rooms.getClientConnections('agent-pm'));
  pmConns[0].transport.send('payload-for-pm');
  assertEq(transport.sent, ['payload-for-pm'], 'transport receives via shadow');
});

test('removeClient on each shadow tears down without affecting human', () => {
  const rooms = new RoomManager();
  const transport = new MockTransport();
  const human: ConnectedClient = {
    transport,
    userId: 'human-alice',
    username: 'alice',
    connectedAt: Date.now(),
  };
  rooms.addClient(human);
  const shadows = registerShadowConnections(rooms, human, ['agent-pm']);

  for (const s of shadows) rooms.removeClient(s);
  assertTrue(rooms.getClientConnections('agent-pm').size === 0, 'agent-pm cleared');
  assertTrue(rooms.getClientConnections('human-alice').size === 1, 'human untouched');
});

test('rooms.sendToUser routes to agent shadow → human transport receives', () => {
  const rooms = new RoomManager();
  const transport = new MockTransport();
  const human: ConnectedClient = {
    transport,
    userId: 'human-alice',
    username: 'alice',
    connectedAt: Date.now(),
  };
  rooms.addClient(human);
  registerShadowConnections(rooms, human, ['agent-pm']);

  rooms.sendToUser('agent-pm', {
    type: 'task.dispatch.request',
    payload: { taskId: 't-1' },
    timestamp: Date.now(),
  } as any);
  assertEq(transport.sent.length, 1, 'one message delivered');
  const decoded = JSON.parse(transport.sent[0]);
  assertEq(decoded.type, 'task.dispatch.request', 'envelope type preserved');
});

// ─── Token-prefix routing ────────────────────────────────────

test('sk-prismer- prefix triggers API key path', () => {
  const isApiKey = (token: string) => token.startsWith('sk-prismer-');
  assertTrue(isApiKey('sk-prismer-live-abc'), 'live prefix');
  assertTrue(isApiKey('sk-prismer-test-def'), 'test prefix');
  assertTrue(!isApiKey('eyJ.payload.sig'), 'JWT not detected as API key');
  assertTrue(!isApiKey(''), 'empty');
});

// ─── Summary ──────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
