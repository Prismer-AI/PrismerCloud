/**
 * Track C v1.9.x event types — pure unit test (no HTTP, no DB)
 *
 * Verifies that all 11 v1.9.x event types serialize and deserialize round-trip
 * without losing fields, and that the cloud-side ServerEvents factories
 * produce envelopes that match the wire shape consumers expect.
 *
 * Usage: npx tsx src/im/tests/v19x-events.test.ts
 */

import { ServerEvents } from '../ws/events';
import type {
  AgentHostDeclarePayload,
  HostAckedPayload,
  AgentStatusChangedPayload,
  TaskDispatchRequestPayload,
  TaskDispatchProgressPayload,
  TaskDispatchReplyPayload,
  TaskCancelPayload,
  // Day 3-4: Track A schema-derived broadcasts
  AgentChangedPayload,
  WorkspaceChangedPayload,
  AgentProfileChangedPayload,
  WorkspaceFileChangedPayload,
  WSMessage,
} from '../types/index';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void) {
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

function assertEnvelope<T>(msg: WSMessage<T>, type: string, requestId?: string): void {
  if (msg.type !== type) throw new Error(`type mismatch: expected ${type}, got ${msg.type}`);
  if (typeof msg.timestamp !== 'number') throw new Error(`timestamp must be number, got ${typeof msg.timestamp}`);
  if (requestId !== undefined && msg.requestId !== requestId) {
    throw new Error(`requestId mismatch: expected ${requestId}, got ${msg.requestId}`);
  }
}

function roundTrip<T>(payload: T): T {
  // The wire is JSON; this is what daemon and cloud actually exchange.
  return JSON.parse(JSON.stringify(payload)) as T;
}

console.log('\n🔹 Track C v1.9.x event types — m1 (all 11 types)');

// ─── Client-direction (daemon → cloud) payloads ──────────────

test('agent.host.declare — round-trip preserves all fields', () => {
  const payload: AgentHostDeclarePayload = {
    daemonId: 'daemon-abc123',
    daemonVersion: '0.1.0',
    platform: 'darwin',
    agents: [
      {
        imUserId: 'agent-1',
        name: 'pm-bot',
        adapterName: 'hermes',
        capabilities: ['code', 'shell'],
        profiles: [
          { id: 'prof-1', version: 1 },
          { id: 'prof-2', version: 5 },
        ],
      },
    ],
  };
  assertEq(roundTrip(payload), payload, 'AgentHostDeclarePayload');
});

test('agent.status.changed (busy with running tasks) — round-trip', () => {
  const payload: AgentStatusChangedPayload = {
    agentImUserId: 'agent-1',
    status: 'busy',
    activeProfileId: 'prof-1',
    runningTaskIds: ['t-1', 't-2'],
  };
  assertEq(roundTrip(payload), payload, 'AgentStatusChangedPayload (busy)');
});

test('agent.status.changed (offline, no optional fields) — round-trip', () => {
  const payload: AgentStatusChangedPayload = {
    agentImUserId: 'agent-1',
    status: 'offline',
  };
  assertEq(roundTrip(payload), payload, 'AgentStatusChangedPayload (offline)');
});

test('task.dispatch.progress — round-trip', () => {
  const payload: TaskDispatchProgressPayload = {
    taskId: 't-99',
    progress: 0.42,
    message: 'compiling',
    detail: { step: 3, total: 7 },
  };
  assertEq(roundTrip(payload), payload, 'TaskDispatchProgressPayload');
});

test('task.dispatch.reply (ok=true with assets) — round-trip', () => {
  const payload: TaskDispatchReplyPayload = {
    taskId: 't-99',
    ok: true,
    output: 'done',
    assetIds: ['ast-1', 'ast-2'],
    metrics: { tokensUsed: 1024, durationMs: 5400 },
  };
  assertEq(roundTrip(payload), payload, 'TaskDispatchReplyPayload (ok)');
});

test('task.dispatch.reply (ok=false with error code) — round-trip', () => {
  const payload: TaskDispatchReplyPayload = {
    taskId: 't-99',
    ok: false,
    error: { code: 'task_cancelled', message: 'user cancelled' },
  };
  assertEq(roundTrip(payload), payload, 'TaskDispatchReplyPayload (fail)');
});

// ─── Server-direction factory functions ──────────────────────

test('ServerEvents.hostAcked — envelope shape + requestId echo', () => {
  const data: HostAckedPayload = {
    workspaceId: 'ws-1',
    syncCursor: { workspaces: 100, agent_profiles: 200 },
    profilesToSync: ['prof-1'],
  };
  const envelope = ServerEvents.hostAcked(data, 'req-declare-1');
  assertEnvelope(envelope, 'host.acked', 'req-declare-1');
  assertEq(envelope.payload, data, 'hostAcked.payload');
});

test('ServerEvents.taskDispatchRequest — envelope + requestId is required', () => {
  const data: TaskDispatchRequestPayload = {
    taskId: 't-1',
    agentImUserId: 'agent-1',
    profileId: 'prof-1',
    capability: 'code',
    prompt: 'write a snake game',
    timeoutMs: 30 * 60 * 1000,
  };
  const envelope = ServerEvents.taskDispatchRequest(data, 'req-dispatch-1');
  assertEnvelope(envelope, 'task.dispatch.request', 'req-dispatch-1');
  assertEq(envelope.payload, data, 'taskDispatchRequest.payload');
});

test('ServerEvents.taskCancel — envelope (no requestId expected)', () => {
  const data: TaskCancelPayload = { taskId: 't-1', reason: 'user_cancelled' };
  const envelope = ServerEvents.taskCancel(data);
  assertEnvelope(envelope, 'task.cancel');
  if (envelope.requestId !== undefined) throw new Error('taskCancel should not set requestId');
  assertEq(envelope.payload, data, 'taskCancel.payload');
});

test('ServerEvents.agentStatusChanged — envelope', () => {
  const data: AgentStatusChangedPayload = {
    agentImUserId: 'agent-1',
    status: 'idle',
  };
  const envelope = ServerEvents.agentStatusChanged(data);
  assertEnvelope(envelope, 'agent.status.changed');
  assertEq(envelope.payload, data, 'agentStatusChanged.payload');
});

// ─── Wire envelope round-trip ────────────────────────────────

test('full WS envelope round-trip preserves type, payload, requestId, timestamp', () => {
  const original = ServerEvents.taskDispatchRequest(
    {
      taskId: 't-1',
      agentImUserId: 'agent-1',
      profileId: 'prof-1',
      capability: 'code',
      prompt: 'hello',
    },
    'req-1',
  );
  const wire = JSON.parse(JSON.stringify(original));
  if (wire.type !== 'task.dispatch.request') throw new Error('type lost');
  if (wire.requestId !== 'req-1') throw new Error('requestId lost');
  if (typeof wire.timestamp !== 'number') throw new Error('timestamp lost');
  if (wire.payload.prompt !== 'hello') throw new Error('payload.prompt lost');
});

// ─── m1 Day 3-4: schema-derived broadcasts ───────────────────

test('ServerEvents.agentChanged — rename payload (Track A wire shape)', () => {
  const data: AgentChangedPayload = {
    agentImUserId: 'agent-1',
    fields: { displayName: 'Renamed Agent' },
  };
  const envelope = ServerEvents.agentChanged(data);
  assertEnvelope(envelope, 'agent.changed');
  assertEq(envelope.payload, data, 'agentChanged.payload (rename)');
});

test('ServerEvents.agentChanged — capability change with both fields', () => {
  const data: AgentChangedPayload = {
    agentImUserId: 'agent-1',
    fields: {
      displayName: 'New Name',
      capabilities: ['code', 'shell', 'mcp'],
    },
  };
  const envelope = ServerEvents.agentChanged(data);
  assertEq(envelope.payload, data, 'agentChanged.payload (full)');
});

test('ServerEvents.workspaceChanged — uses updatedAt (no version column)', () => {
  const data: WorkspaceChangedPayload = {
    workspaceId: 'ws-cuid-1',
    updatedAt: '2026-05-02T12:34:56.789Z',
  };
  const envelope = ServerEvents.workspaceChanged(data);
  assertEnvelope(envelope, 'workspace.changed');
  assertEq(envelope.payload, data, 'workspaceChanged.payload');
});

test('ServerEvents.agentProfileChanged — version is the optimistic-lock counter', () => {
  const data: AgentProfileChangedPayload = {
    profileId: 'prof-cuid-1',
    version: 5,
  };
  const envelope = ServerEvents.agentProfileChanged(data);
  assertEnvelope(envelope, 'agent_profile.changed');
  assertEq(envelope.payload, data, 'agentProfileChanged.payload');
});

test('ServerEvents.workspaceFileChanged — create with assetId + contentHash', () => {
  const data: WorkspaceFileChangedPayload = {
    workspaceId: 'ws-1',
    path: 'docs/snake-prd.md',
    operation: 'create',
    assetId: 'ast-1',
    contentHash: 'a'.repeat(64),
    version: 1,
  };
  const envelope = ServerEvents.workspaceFileChanged(data);
  assertEnvelope(envelope, 'workspace_file.changed');
  assertEq(envelope.payload, data, 'workspaceFileChanged.payload (create)');
});

test('ServerEvents.workspaceFileChanged — delete omits asset fields', () => {
  const data: WorkspaceFileChangedPayload = {
    workspaceId: 'ws-1',
    path: 'docs/old.md',
    operation: 'delete',
    version: 3,
  };
  const envelope = ServerEvents.workspaceFileChanged(data);
  assertEq(envelope.payload, data, 'workspaceFileChanged.payload (delete)');
});

test('task.dispatch.request with mention context — round-trip', () => {
  const data: TaskDispatchRequestPayload = {
    taskId: 't-mention-1',
    agentImUserId: 'agent-eng',
    profileId: 'prof-eng-1',
    capability: 'chat',
    prompt: 'implement the PRD',
    conversationId: 'conv-grp-1',
    context: [
      { sender: 'alice', senderRole: 'human', content: '@eng implement', createdAt: '2026-05-02T10:00:00Z' },
      { sender: 'pm-agent', senderRole: 'agent', content: 'see prismer://...', createdAt: '2026-05-02T10:00:30Z' },
    ],
  };
  assertEq(roundTrip(data), data, 'TaskDispatchRequestPayload (with context)');
});

// ─── Summary ─────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
