/**
 * Track C m2 — pure unit tests for v1.9.x daemon protocol logic
 *
 * Covers the algorithms that don't need a real WS / DB:
 *   1. computeProfilesToSync — handshake reconciliation
 *   2. trimContextWindow — chat-history budgeting for task.dispatch.request
 *   3. buildTaskDispatchRequest — task → wire payload mapping
 *   4. mock-rooms emission — TaskService.emitDaemonDispatchRequest /
 *      emitDaemonCancel produce the right envelope shape
 *
 * Real e2e (mobile → cloud → daemon) is m4 territory.
 *
 * Usage: npx tsx src/im/tests/v19x-daemon-protocol.test.ts
 */

import {
  computeProfilesToSync,
  trimContextWindow,
  buildTaskDispatchRequest,
  type CloudProfileSnapshot,
} from '../ws/v19x-helpers';
import { ServerEvents } from '../ws/events';
import type { HostedAgentDeclaration, TaskDispatchContextEntry, WSMessage } from '../types/index';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
  try {
    const r = fn();
    if (r instanceof Promise) {
      r.then(
        () => {
          passed++;
          console.log(`  ✅ ${name}`);
        },
        (err: any) => {
          failed++;
          failures.push(`${name}: ${err.message || String(err)}`);
          console.log(`  ❌ ${name}: ${err.message || String(err)}`);
        },
      );
    } else {
      passed++;
      console.log(`  ✅ ${name}`);
    }
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

function assertArrEq(actual: string[], expected: string[], label: string): void {
  const a = [...actual].sort();
  const e = [...expected].sort();
  if (JSON.stringify(a) !== JSON.stringify(e)) {
    throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
  }
}

// ─── computeProfilesToSync ───────────────────────────────────

console.log('\n🔹 computeProfilesToSync');

test('cloud has profile daemon doesnt know about → marks for sync', () => {
  const declared: HostedAgentDeclaration[] = [
    {
      imUserId: 'agent-1',
      name: 'pm',
      adapterName: 'hermes',
      capabilities: [],
      profiles: [{ id: 'prof-known', version: 1 }],
    },
  ];
  const cloud: CloudProfileSnapshot[] = [
    { id: 'prof-known', agentImUserId: 'agent-1', version: 1 },
    { id: 'prof-new', agentImUserId: 'agent-1', version: 1 },
  ];
  assertArrEq(computeProfilesToSync(declared, cloud), ['prof-new'], 'profilesToSync');
});

test('daemon version older than cloud → marks for sync', () => {
  const declared: HostedAgentDeclaration[] = [
    {
      imUserId: 'agent-1',
      name: 'pm',
      adapterName: 'hermes',
      capabilities: [],
      profiles: [{ id: 'prof-1', version: 3 }],
    },
  ];
  const cloud: CloudProfileSnapshot[] = [{ id: 'prof-1', agentImUserId: 'agent-1', version: 5 }];
  assertArrEq(computeProfilesToSync(declared, cloud), ['prof-1'], 'profilesToSync');
});

test('daemon version equal to cloud → not marked', () => {
  const declared: HostedAgentDeclaration[] = [
    {
      imUserId: 'agent-1',
      name: 'pm',
      adapterName: 'hermes',
      capabilities: [],
      profiles: [{ id: 'prof-1', version: 5 }],
    },
  ];
  const cloud: CloudProfileSnapshot[] = [{ id: 'prof-1', agentImUserId: 'agent-1', version: 5 }];
  assertArrEq(computeProfilesToSync(declared, cloud), [], 'profilesToSync');
});

test('daemon version newer than cloud → not marked (sync_queue handles push)', () => {
  const declared: HostedAgentDeclaration[] = [
    {
      imUserId: 'agent-1',
      name: 'pm',
      adapterName: 'hermes',
      capabilities: [],
      profiles: [{ id: 'prof-1', version: 10 }],
    },
  ];
  const cloud: CloudProfileSnapshot[] = [{ id: 'prof-1', agentImUserId: 'agent-1', version: 5 }];
  assertArrEq(computeProfilesToSync(declared, cloud), [], 'profilesToSync');
});

test('multi-agent multi-profile mix', () => {
  const declared: HostedAgentDeclaration[] = [
    {
      imUserId: 'agent-1',
      name: 'pm',
      adapterName: 'hermes',
      capabilities: [],
      profiles: [
        { id: 'p1-a', version: 5 },
        { id: 'p1-b', version: 1 },
      ],
    },
    {
      imUserId: 'agent-2',
      name: 'eng',
      adapterName: 'claude-code',
      capabilities: [],
      profiles: [{ id: 'p2-a', version: 1 }],
    },
  ];
  const cloud: CloudProfileSnapshot[] = [
    { id: 'p1-a', agentImUserId: 'agent-1', version: 5 }, // equal — skip
    { id: 'p1-b', agentImUserId: 'agent-1', version: 3 }, // newer — sync
    { id: 'p1-c', agentImUserId: 'agent-1', version: 1 }, // unknown — sync
    { id: 'p2-a', agentImUserId: 'agent-2', version: 1 }, // equal — skip
    { id: 'p2-b', agentImUserId: 'agent-2', version: 7 }, // unknown — sync
  ];
  assertArrEq(computeProfilesToSync(declared, cloud), ['p1-b', 'p1-c', 'p2-b'], 'profilesToSync');
});

// ─── trimContextWindow ────────────────────────────────────────

console.log('\n🔹 trimContextWindow');

const mkEntry = (i: number, content: string): TaskDispatchContextEntry => ({
  sender: `u${i}`,
  senderRole: 'human',
  content,
  createdAt: new Date(2026, 4, 2, 10, i).toISOString(),
});

test('trims oldest first when over cap', () => {
  const entries = [mkEntry(1, 'a'.repeat(50)), mkEntry(2, 'b'.repeat(50)), mkEntry(3, 'c'.repeat(50))];
  const result = trimContextWindow(entries, 100);
  // Total starts at 150, trim oldest until ≤ 100.
  assertEq(result.length, 2, 'length');
  assertEq(result[0].sender, 'u2', 'kept entries');
  assertEq(result[1].sender, 'u3', 'kept entries');
});

test('keeps single entry even if it exceeds cap', () => {
  const entries = [mkEntry(1, 'x'.repeat(500))];
  const result = trimContextWindow(entries, 100);
  assertEq(result.length, 1, 'length');
});

test('no-op when under cap', () => {
  const entries = [mkEntry(1, 'short'), mkEntry(2, 'short')];
  const result = trimContextWindow(entries, 1000);
  assertEq(result.length, 2, 'length');
  assertEq(result, entries, 'unchanged');
});

test('empty input returns empty', () => {
  const result = trimContextWindow([], 100);
  assertEq(result, [], 'empty');
});

// ─── buildTaskDispatchRequest ────────────────────────────────

console.log('\n🔹 buildTaskDispatchRequest');

test('mention-driven task: profileId + context lifted from metadata', () => {
  const task = {
    id: 't-1',
    title: '[@eng] implement the snake game',
    capability: 'chat',
    input: JSON.stringify({ prompt: 'implement the snake game' }),
    metadata: JSON.stringify({
      kind: 'agent_run',
      profileId: 'prof-eng-1',
      triggerKind: 'mention',
      context: [{ sender: 'alice', senderRole: 'human', content: 'go', createdAt: '2026-05-02T10:00:00Z' }],
    }),
    timeoutMs: 1800000,
    conversationId: 'conv-1',
  };
  const payload = buildTaskDispatchRequest(task, 'agent-eng');
  assertEq(payload.taskId, 't-1', 'taskId');
  assertEq(payload.agentImUserId, 'agent-eng', 'agentImUserId');
  assertEq(payload.profileId, 'prof-eng-1', 'profileId');
  assertEq(payload.capability, 'chat', 'capability');
  assertEq(payload.prompt, 'implement the snake game', 'prompt');
  assertEq(payload.timeoutMs, 1800000, 'timeoutMs');
  assertEq(payload.conversationId, 'conv-1', 'conversationId');
  assertEq(payload.context?.length, 1, 'context length');
  // metadata should retain triggerKind but strip profileId/context.
  assertEq(payload.metadata?.kind, 'agent_run', 'metadata.kind');
  assertEq(payload.metadata?.triggerKind, 'mention', 'metadata.triggerKind');
  if ((payload.metadata as any)?.profileId !== undefined) {
    throw new Error('metadata.profileId should be stripped');
  }
  if ((payload.metadata as any)?.context !== undefined) {
    throw new Error('metadata.context should be stripped');
  }
});

test('shell task: routes to target daemon without requiring agent target', () => {
  const task = {
    id: 't-2',
    title: 'do it',
    capability: 'shell',
    input: JSON.stringify({ prompt: 'echo hello' }),
    metadata: JSON.stringify({
      execution: {
        kind: 'shell',
        command: 'echo hello',
        targetDaemonId: 'daemon-local-1',
      },
    }),
    timeoutMs: null,
    conversationId: null,
    runtimeRoute: 'shell',
  };
  const payload = buildTaskDispatchRequest(task, '');
  assertEq(payload.agentImUserId, undefined, 'agentImUserId omitted');
  assertEq(payload.targetDaemonId, 'daemon-local-1', 'targetDaemonId');
  assertEq(payload.profileId, '', 'profileId is empty string');
  assertEq(payload.runtimeRoute, 'shell', 'runtimeRoute');
  assertEq((payload.metadata?.execution as any)?.targetDaemonId, 'daemon-local-1', 'metadata execution retained');
  assertEq(payload.context, undefined, 'no context');
  assertEq(payload.timeoutMs, undefined, 'no timeout');
  assertEq(payload.conversationId, undefined, 'no conversation');
});

test('falls back to title when input has no prompt', () => {
  const task = {
    id: 't-3',
    title: 'just the title',
    capability: 'chat',
    input: '{}',
    metadata: '{}',
  };
  const payload = buildTaskDispatchRequest(task, 'agent-1');
  assertEq(payload.prompt, 'just the title', 'prompt');
});

test('description-collapse: task.description outranks legacy input.prompt', () => {
  // Post-collapse precedence (see v19x-helpers.ts): description is the single
  // source of truth; input.prompt is a legacy tail only consulted when
  // description is empty/missing. This locks in the ordering so a future
  // change that re-introduces input.prompt-first behaviour fails loudly.
  const task = {
    id: 't-3b',
    title: 'fallback title',
    description: 'description body — the agent should see THIS',
    capability: 'chat',
    input: JSON.stringify({ prompt: 'legacy prompt — should be ignored' }),
    metadata: '{}',
  };
  const payload = buildTaskDispatchRequest(task, 'agent-1');
  assertEq(payload.prompt, 'description body — the agent should see THIS', 'description wins over input.prompt');
});

test('description-collapse: legacy input.prompt is still honored when description is empty', () => {
  // Backwards-compat tail: rows created before the collapse only populated
  // input.prompt. Until a backfill migrates them into description, the
  // daemon must still surface the prompt text instead of bare title.
  const task = {
    id: 't-3c',
    title: 'fallback title',
    description: null,
    capability: 'chat',
    input: JSON.stringify({ prompt: 'old wave-9 row, still readable' }),
    metadata: '{}',
  };
  const payload = buildTaskDispatchRequest(task, 'agent-1');
  assertEq(payload.prompt, 'old wave-9 row, still readable', 'legacy input.prompt tail');
});

test('drops `delivery` metadata key (server-side concern)', () => {
  const task = {
    id: 't-4',
    title: 'x',
    capability: 'chat',
    input: '{}',
    metadata: JSON.stringify({ delivery: 'message', profileId: 'p1', userTag: 'keep-me' }),
  };
  const payload = buildTaskDispatchRequest(task, 'agent-1');
  if ((payload.metadata as any)?.delivery !== undefined) {
    throw new Error('delivery should be stripped');
  }
  assertEq(payload.metadata?.userTag, 'keep-me', 'userTag preserved');
});

test('survives malformed JSON in input/metadata', () => {
  const task = {
    id: 't-5',
    title: 'fallback',
    capability: 'chat',
    input: 'not json',
    metadata: '{broken}',
  };
  const payload = buildTaskDispatchRequest(task, 'agent-1');
  assertEq(payload.prompt, 'fallback', 'falls back to title');
  assertEq(payload.profileId, '', 'empty profileId');
});

// ─── mock-rooms emission flow ─────────────────────────────────

console.log('\n🔹 ServerEvents emission via mock RoomManager');

interface CapturedSend {
  userId: string;
  message: WSMessage<unknown>;
}

class MockRooms {
  public sent: CapturedSend[] = [];
  sendToUser(userId: string, message: WSMessage<unknown>): void {
    this.sent.push({ userId, message });
  }
}

test('ServerEvents.taskDispatchRequest end-to-end via mock rooms', () => {
  const mock = new MockRooms();
  const payload = buildTaskDispatchRequest(
    {
      id: 't-99',
      title: 'do thing',
      capability: 'chat',
      input: JSON.stringify({ prompt: 'do thing' }),
      metadata: JSON.stringify({ profileId: 'prof-1' }),
    },
    'agent-1',
  );

  mock.sendToUser('agent-1', ServerEvents.taskDispatchRequest(payload, 't-99'));
  assertEq(mock.sent.length, 1, 'one envelope emitted');
  assertEq(mock.sent[0].userId, 'agent-1', 'routed to agent imUserId');
  assertEq(mock.sent[0].message.type, 'task.dispatch.request', 'envelope type');
  assertEq((mock.sent[0].message as any).requestId, 't-99', 'requestId echoes taskId');
  assertEq((mock.sent[0].message.payload as any).profileId, 'prof-1', 'payload.profileId');
});

test('ServerEvents.taskDispatchRequest routes shell work to daemon shadow key', () => {
  const mock = new MockRooms();
  const payload = buildTaskDispatchRequest(
    {
      id: 't-shell',
      title: 'pwd',
      capability: 'shell',
      input: JSON.stringify({ prompt: 'pwd' }),
      metadata: JSON.stringify({ execution: { kind: 'shell', command: 'pwd', targetDaemonId: 'daemon-local-1' } }),
      runtimeRoute: 'shell',
    },
    '',
  );

  mock.sendToUser('daemon:daemon-local-1', ServerEvents.taskDispatchRequest(payload, 't-shell'));
  assertEq(mock.sent.length, 1, 'one envelope emitted');
  assertEq(mock.sent[0].userId, 'daemon:daemon-local-1', 'routed to daemon shadow key');
  assertEq((mock.sent[0].message.payload as any).agentImUserId, undefined, 'no agent target');
  assertEq((mock.sent[0].message.payload as any).targetDaemonId, 'daemon-local-1', 'daemon target');
  assertEq((mock.sent[0].message.payload as any).runtimeRoute, 'shell', 'runtimeRoute');
});

test('ServerEvents.taskCancel end-to-end via mock rooms', () => {
  const mock = new MockRooms();
  mock.sendToUser('agent-1', ServerEvents.taskCancel({ taskId: 't-99', reason: 'user cancel' }));
  assertEq(mock.sent.length, 1, 'one envelope emitted');
  assertEq(mock.sent[0].message.type, 'task.cancel', 'envelope type');
  assertEq((mock.sent[0].message.payload as any).taskId, 't-99', 'payload.taskId');
  assertEq((mock.sent[0].message.payload as any).reason, 'user cancel', 'payload.reason');
});

test('mention dispatch routes to agent.id (not human imUserId)', () => {
  // Regression check for the routing rule in 11-multi-agent-collab.md §三:
  // "rooms.sendToUser(agent.id, ...)" — daemon's WS connection registers
  // under the IMAgent's imUserId, not the human owner's.
  const mock = new MockRooms();
  const humanImUserId = 'human-alice';
  const agentImUserId = 'agent-pm';
  mock.sendToUser(
    agentImUserId,
    ServerEvents.taskDispatchRequest(
      {
        taskId: 't-1',
        agentImUserId,
        profileId: 'prof-1',
        capability: 'chat',
        prompt: 'hi',
      },
      't-1',
    ),
  );
  if (mock.sent[0].userId === humanImUserId) {
    throw new Error('dispatch incorrectly routed to human owner');
  }
  assertEq(mock.sent[0].userId, agentImUserId, 'routed to agent');
});

// ─── Summary ──────────────────────────────────────────────────

setImmediate(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
});
