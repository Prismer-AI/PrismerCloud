#!/usr/bin/env npx tsx
/**
 * Prismer IM — Stress Test Suite (v1.8.1)
 *
 * Three targeted stress scenarios against the IM server:
 *   T1: Concurrent WebSocket connections (up to N agents)
 *   T2: Message delivery + latency measurement (20 messages)
 *   T3: Offline -> sync recovery (5 messages)
 *
 * Usage:
 *   npx tsx scripts/test-im-stress.ts                       # test env, 50 connections
 *   npx tsx scripts/test-im-stress.ts --env prod             # prod env
 *   npx tsx scripts/test-im-stress.ts --connections 100      # 100 concurrent WS
 *   npx tsx scripts/test-im-stress.ts --env test --connections 30
 */

import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';

// ==============================================================================
// CLI Args
// ==============================================================================

const args = process.argv.slice(2);

function argValue(flag: string, fallback: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const ENV = argValue('--env', 'test');
const CONNECTIONS = parseInt(argValue('--connections', '50'), 10);

// ==============================================================================
// Configuration
// ==============================================================================

const BASE_URLS: Record<string, string> = {
  test: 'https://cloud.prismer.dev',
  prod: 'https://prismer.cloud',
};

const WS_URLS: Record<string, string> = {
  test: 'wss://cloud.prismer.dev/ws',
  prod: 'wss://prismer.cloud/ws',
};

const API_KEYS: Record<string, string> = {
  test: 'sk-prismer-live-REDACTED-SET-VIA-ENV',
  prod: 'sk-prismer-live-REDACTED-SET-VIA-ENV',
};

const BASE = BASE_URLS[ENV];
const WS_BASE = WS_URLS[ENV];
const API_KEY = API_KEYS[ENV];

if (!BASE || !WS_BASE || !API_KEY) {
  console.error(`[StressTest] Unknown environment: ${ENV}. Use --env test|prod`);
  process.exit(1);
}

// ==============================================================================
// Helpers
// ==============================================================================

const TS = Date.now();

interface ApiResult {
  status: number;
  data: any;
}

async function api(method: string, urlPath: string, body?: any, token?: string): Promise<ApiResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  headers['Authorization'] = `Bearer ${token || API_KEY}`;

  const url = `${BASE}${urlPath}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data: any;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

interface AgentInfo {
  imUserId: string;
  token: string;
  conversationId: string;
  agentUserId?: string;
  agentToken?: string;
}

/**
 * Initialize a workspace agent via POST /api/im/workspace/init.
 * Returns user token, agent token (if created), and conversationId.
 */
async function initAgent(index: number): Promise<AgentInfo> {
  const suffix = `${TS}-${index}`;
  const res = await api('POST', '/api/im/workspace/init', {
    workspaceId: `stress-ws-${suffix}`,
    userId: `stress-user-${suffix}`,
    userDisplayName: `Stress User ${index}`,
    agentName: `stress-agent-${suffix}`,
    agentDisplayName: `Stress Agent ${index}`,
    agentCapabilities: ['chat'],
  });

  if (res.status < 200 || res.status >= 300 || !res.data?.ok) {
    throw new Error(
      `workspace/init failed for agent ${index}: HTTP ${res.status} — ${JSON.stringify(res.data).slice(0, 300)}`,
    );
  }

  const d = res.data.data;
  return {
    imUserId: d.user.imUserId,
    token: d.user.token,
    conversationId: d.conversationId,
    agentUserId: d.agent?.agentUserId,
    agentToken: d.agent?.token,
  };
}

/**
 * Connect a WebSocket. Returns the ws instance once 'open' fires.
 */
function wsConnect(token: string, timeoutMs = 10000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}?token=${token}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('WS connect timeout'));
    }, timeoutMs);

    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Wait for a single WS message (JSON-parsed). Returns null on timeout.
 */
function wsWaitOne(ws: WebSocket, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const handler = (raw: WebSocket.Data) => {
      clearTimeout(timer);
      ws.removeListener('message', handler);
      try {
        resolve(JSON.parse(raw.toString()));
      } catch {
        resolve(null);
      }
    };
    ws.on('message', handler);
  });
}

/**
 * Collect up to `count` WS messages within `timeoutMs`.
 */
function wsCollect(ws: WebSocket, count: number, timeoutMs = 5000): Promise<any[]> {
  return new Promise((resolve) => {
    const msgs: any[] = [];
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(msgs);
    }, timeoutMs);

    function handler(raw: WebSocket.Data) {
      try {
        msgs.push(JSON.parse(raw.toString()));
      } catch {
        /* skip non-JSON */
      }
      if (msgs.length >= count) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msgs);
      }
    }

    ws.on('message', handler);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ==============================================================================
// Report Accumulator
// ==============================================================================

interface TestResult {
  test: string;
  status: 'PASS' | 'FAIL' | 'PARTIAL';
  metrics: Record<string, any>;
  errors?: string[];
}

const results: TestResult[] = [];

function logHeader(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'='.repeat(60)}\n`);
}

function logMetric(label: string, value: string | number) {
  console.log(`  ${label.padEnd(30)} ${value}`);
}

// ==============================================================================
// T1: Concurrent WS Connections
// ==============================================================================

async function testT1_ConcurrentWS(): Promise<TestResult> {
  logHeader(`T1: Concurrent WebSocket Connections (N=${CONNECTIONS})`);

  const errors: string[] = [];

  // Step 1: Init N agents via workspace/init
  console.log(`  [1/4] Initializing ${CONNECTIONS} agents...`);
  const initStart = Date.now();
  const agentPromises: Promise<AgentInfo | null>[] = [];

  // Init in batches of 10 to avoid overwhelming the server
  const BATCH_SIZE = 10;
  const agents: AgentInfo[] = [];
  for (let batch = 0; batch < CONNECTIONS; batch += BATCH_SIZE) {
    const batchEnd = Math.min(batch + BATCH_SIZE, CONNECTIONS);
    const batchPromises = [];
    for (let i = batch; i < batchEnd; i++) {
      batchPromises.push(
        initAgent(i).catch((err) => {
          errors.push(`init agent ${i}: ${err.message}`);
          return null;
        }),
      );
    }
    const batchResults = await Promise.all(batchPromises);
    for (const r of batchResults) {
      if (r) agents.push(r);
    }
  }
  const initTime = Date.now() - initStart;
  console.log(`  [1/4] Initialized ${agents.length}/${CONNECTIONS} agents (${initTime}ms)`);

  if (agents.length === 0) {
    console.log('  FAIL: No agents initialized, aborting T1');
    return { test: 'T1', status: 'FAIL', metrics: { initialized: 0 }, errors };
  }

  // Step 2: Connect all via WebSocket simultaneously
  console.log(`  [2/4] Connecting ${agents.length} WebSockets simultaneously...`);
  const connStart = Date.now();
  const wsResults = await Promise.allSettled(agents.map((agent) => wsConnect(agent.token, 15000)));
  const connTime = Date.now() - connStart;

  const connected: WebSocket[] = [];
  let connFailed = 0;
  for (const r of wsResults) {
    if (r.status === 'fulfilled') {
      connected.push(r.value);
    } else {
      connFailed++;
      errors.push(`ws connect: ${r.reason?.message || r.reason}`);
    }
  }

  console.log(`  [2/4] Connected: ${connected.length}, Failed: ${connFailed} (${connTime}ms)`);

  // Consume auth events
  await Promise.all(connected.map((ws) => wsWaitOne(ws, 3000)));

  // Step 3: Hold 5 seconds
  console.log('  [3/4] Holding connections for 5 seconds...');
  await sleep(5000);

  // Check how many are still open
  const stillOpen = connected.filter((ws) => ws.readyState === WebSocket.OPEN).length;
  console.log(`  [3/4] Still open after hold: ${stillOpen}/${connected.length}`);

  // Step 4: Close all
  console.log('  [4/4] Closing all connections...');
  const closeStart = Date.now();
  await Promise.all(
    connected.map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.once('close', () => resolve());
            ws.close();
            setTimeout(resolve, 2000); // fallback
          } else {
            resolve();
          }
        }),
    ),
  );
  const closeTime = Date.now() - closeStart;

  const rate = agents.length > 0 ? ((connected.length / agents.length) * 100).toFixed(1) : '0';

  logMetric('Agents initialized', `${agents.length}/${CONNECTIONS}`);
  logMetric('Connected', connected.length);
  logMetric('Failed', connFailed);
  logMetric('Still open after 5s hold', stillOpen);
  logMetric('Connection rate', `${rate}%`);
  logMetric('Init time', `${initTime}ms`);
  logMetric('Connect time', `${connTime}ms`);
  logMetric('Close time', `${closeTime}ms`);

  const status: TestResult['status'] =
    connFailed === 0 && stillOpen === connected.length ? 'PASS' : connected.length > 0 ? 'PARTIAL' : 'FAIL';

  console.log(`\n  Result: ${status}`);

  return {
    test: 'T1_ConcurrentWS',
    status,
    metrics: {
      targetConnections: CONNECTIONS,
      initialized: agents.length,
      connected: connected.length,
      failed: connFailed,
      stillOpenAfterHold: stillOpen,
      connectionRate: `${rate}%`,
      initTimeMs: initTime,
      connectTimeMs: connTime,
      closeTimeMs: closeTime,
    },
    errors: errors.length > 0 ? errors.slice(0, 20) : undefined,
  };
}

// ==============================================================================
// T2: Message Delivery + Latency
// ==============================================================================

async function testT2_MessageLatency(): Promise<TestResult> {
  logHeader('T2: Message Delivery + Latency (20 messages)');

  const errors: string[] = [];
  const MSG_COUNT = 20;

  // Step 1: Init workspace (creates user + agent + conversation)
  console.log('  [1/5] Initializing workspace (user + agent)...');
  let workspace: AgentInfo;
  try {
    workspace = await initAgent(9000);
  } catch (err: any) {
    console.log(`  FAIL: Could not init workspace: ${err.message}`);
    return { test: 'T2', status: 'FAIL', metrics: {}, errors: [err.message] };
  }

  const convId = workspace.conversationId;
  const senderToken = workspace.token; // user token — participant in the conversation
  const receiverToken = workspace.agentToken; // agent token — participant in the same conversation

  if (!receiverToken) {
    console.log('  FAIL: No agent token returned from workspace/init');
    return { test: 'T2', status: 'FAIL', metrics: {}, errors: ['No agent token from workspace/init'] };
  }

  // Step 2: Connect BOTH sender and receiver via WebSocket.
  // Auth: WS connections verify IM JWTs directly (no proxy re-wrapping),
  // so the workspace tokens correctly identify the conversation participants.
  console.log('  [2/5] Connecting sender + receiver via WebSocket...');
  let senderWs: WebSocket;
  let receiverWs: WebSocket;
  try {
    [senderWs, receiverWs] = await Promise.all([wsConnect(senderToken, 10000), wsConnect(receiverToken, 10000)]);
    // Consume auth events
    await Promise.all([wsWaitOne(senderWs, 3000), wsWaitOne(receiverWs, 3000)]);
  } catch (err: any) {
    console.log(`  FAIL: WS connect failed: ${err.message}`);
    return { test: 'T2', status: 'FAIL', metrics: {}, errors: [err.message] };
  }

  // Both join the conversation room
  const joinMsg = JSON.stringify({ type: 'conversation.join', payload: { conversationId: convId } });
  senderWs.send(joinMsg);
  receiverWs.send(joinMsg);
  await sleep(500);

  // Step 3: Start collecting messages on receiver, then sender sends via WS
  console.log(`  [3/5] Sending ${MSG_COUNT} messages via WebSocket...`);
  const collectPromise = wsCollect(receiverWs, MSG_COUNT, 15000);

  // Step 4: Sender sends 20 messages via WS message.send events
  const sendTimestamps: Record<string, number> = {};
  const sendStart = Date.now();
  let sent = 0;

  for (let i = 0; i < MSG_COUNT; i++) {
    const sentAt = Date.now();
    const msgContent = JSON.stringify({ idx: i, sentAt });
    sendTimestamps[String(i)] = sentAt;

    try {
      senderWs.send(
        JSON.stringify({
          type: 'message.send',
          payload: { conversationId: convId, content: msgContent, type: 'text' },
        }),
      );
      sent++;
    } catch (err: any) {
      errors.push(`send msg ${i}: ${err.message}`);
    }
  }
  const sendTime = Date.now() - sendStart;
  console.log(`  [3/5] Sent ${sent}/${MSG_COUNT} messages (${sendTime}ms)`);

  // Step 5: Wait for delivery
  console.log('  [4/5] Waiting up to 3 seconds for delivery...');
  await sleep(3000);

  // Resolve collected messages
  const collected = await collectPromise;

  // Filter for actual message events
  const messageEvents = collected.filter((m) => m.type === 'message.new' || m.type === 'new_message');

  // Calculate latencies
  const latencies: number[] = [];
  const receivedAt = Date.now();

  for (const evt of messageEvents) {
    const content = evt.payload?.content || evt.payload?.message?.content || '';
    try {
      const parsed = JSON.parse(content);
      if (parsed.sentAt && typeof parsed.sentAt === 'number') {
        const latency = receivedAt - parsed.sentAt;
        latencies.push(latency);
      }
    } catch {
      // Content may not be our JSON; skip
    }
  }

  const received = messageEvents.length;
  const deliveryRate = sent > 0 ? ((received / sent) * 100).toFixed(1) : '0';
  const avgLatency =
    latencies.length > 0 ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0) : 'N/A';
  const p95Latency = latencies.length > 0 ? percentile(latencies, 95) : 'N/A';

  // Close WS connections
  senderWs.close();
  receiverWs.close();

  console.log('  [5/5] Results:');
  logMetric('Sent', `${sent}/${MSG_COUNT}`);
  logMetric('Received via WS', received);
  logMetric('Delivery rate', `${deliveryRate}%`);
  logMetric('Avg latency', `${avgLatency}ms`);
  logMetric('P95 latency', `${p95Latency}ms`);
  logMetric('Send throughput', `${sendTime}ms total`);
  logMetric('All WS events collected', collected.length);

  if (errors.length > 0) {
    console.log(`  Errors (${errors.length}):`);
    for (const e of errors.slice(0, 5)) console.log(`    - ${e}`);
  }

  const status: TestResult['status'] = received >= sent * 0.8 ? 'PASS' : received > 0 ? 'PARTIAL' : 'FAIL';

  console.log(`\n  Result: ${status}`);

  return {
    test: 'T2_MessageLatency',
    status,
    metrics: {
      messageCount: MSG_COUNT,
      sent,
      receivedViaWS: received,
      deliveryRate: `${deliveryRate}%`,
      avgLatencyMs: avgLatency,
      p95LatencyMs: p95Latency,
      sendThroughputMs: sendTime,
      totalWsEvents: collected.length,
    },
    errors: errors.length > 0 ? errors.slice(0, 20) : undefined,
  };
}

// ==============================================================================
// T3: Offline -> Sync Recovery
// ==============================================================================

async function testT3_OfflineSync(): Promise<TestResult> {
  logHeader('T3: Offline -> Sync Recovery (5 messages)');

  const errors: string[] = [];
  const OFFLINE_MSG_COUNT = 5;

  // Step 1: Init workspace — agent will stay OFFLINE (no WS connection)
  console.log('  [1/4] Initializing workspace (agent will stay offline)...');
  let workspace: AgentInfo;
  try {
    workspace = await initAgent(8000);
  } catch (err: any) {
    console.log(`  FAIL: Could not init workspace: ${err.message}`);
    return { test: 'T3', status: 'FAIL', metrics: {}, errors: [err.message] };
  }

  const convId = workspace.conversationId;
  const workspaceId = `stress-ws-${TS}-8000`;
  const userToken = workspace.token; // user token — conversation participant
  const agentToken = workspace.agentToken; // agent token — conversation participant

  if (!agentToken) {
    console.log('  FAIL: No agent token returned from workspace/init');
    return { test: 'T3', status: 'FAIL', metrics: {}, errors: ['No agent token from workspace/init'] };
  }

  // Step 2: User connects via WS and sends messages while agent is offline.
  // WS auth uses IM JWT directly (no proxy re-wrapping), so the user token
  // correctly identifies the conversation participant.
  console.log(`  [2/4] User sends ${OFFLINE_MSG_COUNT} messages via WS while agent is offline...`);
  let senderWs: WebSocket;
  try {
    senderWs = await wsConnect(userToken, 10000);
    await wsWaitOne(senderWs, 3000); // consume auth event
  } catch (err: any) {
    console.log(`  FAIL: User WS connect failed: ${err.message}`);
    return { test: 'T3', status: 'FAIL', metrics: {}, errors: [err.message] };
  }

  // Join conversation room
  senderWs.send(JSON.stringify({ type: 'conversation.join', payload: { conversationId: convId } }));
  await sleep(300);

  let sentCount = 0;
  for (let i = 0; i < OFFLINE_MSG_COUNT; i++) {
    try {
      senderWs.send(
        JSON.stringify({
          type: 'message.send',
          payload: {
            conversationId: convId,
            content: `Offline message ${i} (ts=${Date.now()})`,
            type: 'text',
          },
        }),
      );
      sentCount++;
    } catch (err: any) {
      errors.push(`send offline msg ${i}: ${err.message}`);
    }
  }
  // Wait for messages to be persisted server-side
  await sleep(1500);
  senderWs.close();
  console.log(`  [2/4] Sent ${sentCount}/${OFFLINE_MSG_COUNT} messages`);

  // Step 3: Agent comes online — recover messages.
  // Use workspace messages endpoint (no per-user participation check) and
  // agent WS reconnect to verify delivery.
  console.log('  [3/4] Agent comes online — recovering messages...');

  // 3a: Fetch via workspace messages endpoint (API Key auth, no participation check)
  const wsMessagesRes = await api('GET', `/api/im/workspace/${workspaceId}/messages?limit=20`);
  const wsMessages = Array.isArray(wsMessagesRes.data?.data) ? wsMessagesRes.data.data : [];
  const wsMessagesOk = wsMessagesRes.data?.ok;
  console.log(`  [3/4] Workspace messages: ok=${wsMessagesOk}, count=${wsMessages.length}`);

  // 3b: Agent connects via WS and performs reconnect to receive missed events
  let agentRecoveredViaWs = 0;
  try {
    const agentWs = await wsConnect(agentToken, 10000);
    await wsWaitOne(agentWs, 3000); // consume auth event

    // Join conversation — may receive buffered events
    agentWs.send(JSON.stringify({ type: 'conversation.join', payload: { conversationId: convId } }));
    const reconnectMsgs = await wsCollect(agentWs, OFFLINE_MSG_COUNT, 3000);
    agentRecoveredViaWs = reconnectMsgs.filter((m: any) => m.type === 'message.new' || m.type === 'new_message').length;
    agentWs.close();
  } catch (err: any) {
    errors.push(`agent WS recovery: ${err.message}`);
  }

  // Step 4: Count how many offline messages were recovered
  const recoveredFromMessages = wsMessages.filter(
    (m: any) => typeof m.content === 'string' && m.content.startsWith('Offline message'),
  ).length;

  const totalRecovered = Math.max(recoveredFromMessages, agentRecoveredViaWs);

  console.log('  [4/4] Results:');
  logMetric('Sent while offline', sentCount);
  logMetric('Recovered via workspace/messages', recoveredFromMessages);
  logMetric('Recovered via agent WS reconnect', agentRecoveredViaWs);
  logMetric('Total recovered (best)', totalRecovered);
  logMetric('Recovery rate', sentCount > 0 ? `${((totalRecovered / sentCount) * 100).toFixed(1)}%` : 'N/A');

  if (errors.length > 0) {
    console.log(`  Errors (${errors.length}):`);
    for (const e of errors.slice(0, 5)) console.log(`    - ${e}`);
  }

  const status: TestResult['status'] = totalRecovered >= sentCount ? 'PASS' : totalRecovered > 0 ? 'PARTIAL' : 'FAIL';

  console.log(`\n  Result: ${status}`);

  return {
    test: 'T3_OfflineSync',
    status,
    metrics: {
      sentWhileOffline: sentCount,
      recoveredViaWorkspaceMessages: recoveredFromMessages,
      recoveredViaAgentWsReconnect: agentRecoveredViaWs,
      totalRecovered,
      recoveryRate: sentCount > 0 ? `${((totalRecovered / sentCount) * 100).toFixed(1)}%` : 'N/A',
    },
    errors: errors.length > 0 ? errors.slice(0, 20) : undefined,
  };
}

// ==============================================================================
// Main
// ==============================================================================

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Prismer IM Stress Test Suite`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  Environment:  ${ENV} (${BASE})`);
  console.log(`  WS endpoint:  ${WS_BASE}`);
  console.log(`  Connections:  ${CONNECTIONS}`);
  console.log(`  API Key:      ${API_KEY.slice(0, 20)}...`);
  console.log(`  Timestamp:    ${new Date().toISOString()}`);
  console.log(`${'='.repeat(60)}`);

  const suiteStart = Date.now();

  // T1: Concurrent WS Connections
  try {
    results.push(await testT1_ConcurrentWS());
  } catch (err: any) {
    console.error(`\n  T1 FATAL: ${err.message}`);
    results.push({
      test: 'T1_ConcurrentWS',
      status: 'FAIL',
      metrics: {},
      errors: [err.message],
    });
  }

  // T2: Message Delivery + Latency
  try {
    results.push(await testT2_MessageLatency());
  } catch (err: any) {
    console.error(`\n  T2 FATAL: ${err.message}`);
    results.push({
      test: 'T2_MessageLatency',
      status: 'FAIL',
      metrics: {},
      errors: [err.message],
    });
  }

  // T3: Offline -> Sync Recovery
  try {
    results.push(await testT3_OfflineSync());
  } catch (err: any) {
    console.error(`\n  T3 FATAL: ${err.message}`);
    results.push({
      test: 'T3_OfflineSync',
      status: 'FAIL',
      metrics: {},
      errors: [err.message],
    });
  }

  const suiteTime = Date.now() - suiteStart;

  // ==============================================================================
  // Summary
  // ==============================================================================

  logHeader('Summary');

  const passCount = results.filter((r) => r.status === 'PASS').length;
  const partialCount = results.filter((r) => r.status === 'PARTIAL').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;

  for (const r of results) {
    const icon = r.status === 'PASS' ? 'PASS' : r.status === 'PARTIAL' ? 'WARN' : 'FAIL';
    console.log(`  [${icon}] ${r.test}`);
  }

  console.log();
  logMetric('Total time', `${(suiteTime / 1000).toFixed(1)}s`);
  logMetric('Pass', passCount);
  logMetric('Partial', partialCount);
  logMetric('Fail', failCount);

  // ==============================================================================
  // Write JSON Report
  // ==============================================================================

  const report = {
    suite: 'im-stress-test',
    version: 'v1.8.1',
    environment: ENV,
    baseUrl: BASE,
    wsUrl: WS_BASE,
    connections: CONNECTIONS,
    timestamp: new Date().toISOString(),
    durationMs: suiteTime,
    summary: { pass: passCount, partial: partialCount, fail: failCount },
    results,
  };

  const reportPath = path.resolve(__dirname, '..', 'docs', `v181-im-stress-report-${ENV}.json`);

  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`\n  Report written to: ${reportPath}`);
  } catch (err: any) {
    console.error(`\n  Failed to write report: ${err.message}`);
  }

  console.log(`\n${'='.repeat(60)}\n`);

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[StressTest] Fatal error:', err);
  process.exit(1);
});
