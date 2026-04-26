/**
 * Test WebSocket + SSE endpoints on custom server (localhost:3000)
 *
 * Architecture notes:
 * - WS is bidirectional: client can send messages, server pushes events
 * - SSE is server→client only: push notifications, client uses HTTP POST for actions
 * - Messages sent via HTTP POST do NOT trigger WS/SSE broadcast
 * - Messages sent via WS protocol DO broadcast to all room members (WS + SSE)
 * - Users must join conversation rooms to receive broadcasts
 */

const WebSocket = require('ws');
const http = require('http');

const BASE = 'http://localhost:3000';
let passed = 0;
let failed = 0;

function log(status, test, detail) {
  const icon = status === 'PASS' ? '✅' : '❌';
  console.log(`${icon} ${test}${detail ? ': ' + detail : ''}`);
  if (status === 'PASS') passed++;
  else failed++;
}

async function api(method, path, body, auth) {
  const url = `${BASE}/api/im/${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers['Authorization'] = auth.startsWith('Bearer ') ? auth : `Bearer ${auth}`;
  const opts = { method, headers };
  if (body && !['GET', 'HEAD'].includes(method)) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  let data;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

function sseConnect(token) {
  return new Promise((resolve, reject) => {
    const url = token ? `${BASE}/sse?token=${token}` : `${BASE}/sse`;
    const req = http.get(url, (res) => {
      resolve({ res, statusCode: res.statusCode, headers: res.headers });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function sseCollectEvents(res, count, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const events = [];
    let buffer = '';
    const timer = setTimeout(() => resolve(events), timeoutMs);
    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try { events.push(JSON.parse(line.slice(6))); } catch {}
        }
      }
      if (events.length >= count) { clearTimeout(timer); resolve(events); }
    });
    res.on('end', () => { clearTimeout(timer); resolve(events); });
  });
}

function wsConnect(token) {
  return new Promise((resolve, reject) => {
    const url = token ? `ws://localhost:3000/ws?token=${token}` : 'ws://localhost:3000/ws';
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new Error('ws connect timeout')); }, 5000);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function wsWaitMessage(ws, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(data.toString())); } catch { resolve(null); }
    });
  });
}

function wsSend(ws, msg) {
  ws.send(JSON.stringify(msg));
}

async function main() {
  console.log('\n=== WebSocket + SSE Integration Tests ===\n');

  // ─── Setup: Register two agents ───────────────────────────
  const ts = Date.now();
  const r1 = await api('POST', 'register', {
    username: `ws_test_a_${ts}`, displayName: 'WS Test A',
    type: 'agent', capabilities: ['chat'],
  });
  const r2 = await api('POST', 'register', {
    username: `ws_test_b_${ts}`, displayName: 'WS Test B',
    type: 'agent', capabilities: ['chat'],
  });
  if (!r1.data?.ok || !r2.data?.ok) {
    console.error('Failed to register agents');
    process.exit(1);
  }
  const tokenA = r1.data.data.token, userIdA = r1.data.data.imUserId;
  const tokenB = r2.data.data.token, userIdB = r2.data.data.imUserId;
  console.log(`Agent A: ${r1.data.data.username} (${userIdA})`);
  console.log(`Agent B: ${r2.data.data.username} (${userIdB})`);

  // Create a conversation via HTTP so both agents have a shared room
  const sendResult = await api('POST', `direct/${userIdB}/messages`, {
    content: 'Setup message', type: 'text',
  }, tokenA);
  const conversationId = sendResult.data?.data?.conversationId;
  console.log(`Conversation: ${conversationId}\n`);

  // ════════════════════════════════════════════════════════════
  // Section 1: SSE Auth Tests
  // ════════════════════════════════════════════════════════════
  console.log('--- SSE Auth ---');

  // Test 1: SSE no token → 401
  try {
    const { res, statusCode } = await sseConnect(null);
    res.destroy();
    log(statusCode === 401 ? 'PASS' : 'FAIL', 'SSE: no token → 401', `status=${statusCode}`);
  } catch (err) {
    log('FAIL', 'SSE: no token → 401', err.message);
  }

  // Test 2: SSE bad token → 401
  try {
    const { res, statusCode } = await sseConnect('invalidtoken');
    res.destroy();
    log(statusCode === 401 ? 'PASS' : 'FAIL', 'SSE: bad token → 401', `status=${statusCode}`);
  } catch (err) {
    log('FAIL', 'SSE: bad token → 401', err.message);
  }

  // ════════════════════════════════════════════════════════════
  // Section 2: SSE Connection + Authenticated Event
  // ════════════════════════════════════════════════════════════
  console.log('\n--- SSE Connection ---');

  let sseResA;
  try {
    const conn = await sseConnect(tokenA);
    sseResA = conn.res;
    log(conn.statusCode === 200 ? 'PASS' : 'FAIL', 'SSE: connect → 200', `status=${conn.statusCode}`);

    const ct = conn.headers['content-type'] || '';
    log(ct.includes('text/event-stream') ? 'PASS' : 'FAIL', 'SSE: content-type', ct);

    const events = await sseCollectEvents(sseResA, 1, 3000);
    const authEvt = events.find(e => e.type === 'authenticated');
    log(authEvt ? 'PASS' : 'FAIL', 'SSE: authenticated event', authEvt ? `userId=${authEvt.payload?.userId}` : 'none');
    if (authEvt) {
      log(authEvt.payload?.userId === userIdA ? 'PASS' : 'FAIL', 'SSE: userId matches', `${authEvt.payload?.userId}`);
    }
  } catch (err) {
    log('FAIL', 'SSE connection', err.message);
  }

  // ════════════════════════════════════════════════════════════
  // Section 3: WebSocket Connection + Auth + Ping
  // ════════════════════════════════════════════════════════════
  console.log('\n--- WebSocket Connection ---');

  let wsA, wsB;

  // WS Agent A
  try {
    wsA = await wsConnect(tokenA);
    log('PASS', 'WS: Agent A connects');
    const auth = await wsWaitMessage(wsA, 3000);
    log(auth?.type === 'authenticated' ? 'PASS' : 'FAIL', 'WS: Agent A authenticated', `userId=${auth?.payload?.userId}`);
  } catch (err) {
    log('FAIL', 'WS: Agent A connect', err.message);
  }

  // WS Agent B
  try {
    wsB = await wsConnect(tokenB);
    log('PASS', 'WS: Agent B connects');
    const auth = await wsWaitMessage(wsB, 3000);
    log(auth?.type === 'authenticated' ? 'PASS' : 'FAIL', 'WS: Agent B authenticated', `userId=${auth?.payload?.userId}`);
  } catch (err) {
    log('FAIL', 'WS: Agent B connect', err.message);
  }

  // Ping/Pong
  if (wsA) {
    wsSend(wsA, { type: 'ping', payload: {}, requestId: 'ping-1' });
    const pong = await wsWaitMessage(wsA, 3000);
    log(pong?.type === 'pong' ? 'PASS' : 'FAIL', 'WS: ping → pong', `requestId=${pong?.requestId}`);
  }

  // ════════════════════════════════════════════════════════════
  // Section 4: Join Room + Message Broadcast (WS→WS + WS→SSE)
  // ════════════════════════════════════════════════════════════
  console.log('\n--- Room Join + Message Broadcast ---');

  // Both agents join the conversation room via WS
  if (wsA && conversationId) {
    wsSend(wsA, { type: 'conversation.join', payload: { conversationId } });
    await new Promise(r => setTimeout(r, 200));
  }
  if (wsB && conversationId) {
    wsSend(wsB, { type: 'conversation.join', payload: { conversationId } });
    await new Promise(r => setTimeout(r, 200));
  }

  // Agent B sends message via WS protocol
  if (wsB && conversationId) {
    wsSend(wsB, {
      type: 'message.send',
      payload: { conversationId, content: 'Hello from WS!', type: 'text' },
      requestId: 'ws-msg-1',
    });

    // WS Agent A should receive message.new
    if (wsA) {
      const wsRecv = await wsWaitMessage(wsA, 3000);
      log(wsRecv?.type === 'message.new' ? 'PASS' : 'FAIL', 'WS→WS: Agent A receives message.new',
        wsRecv ? `content="${wsRecv.payload?.content}"` : 'no message');
    }

    // SSE Agent A should also receive message.new
    if (sseResA) {
      const sseEvents = await sseCollectEvents(sseResA, 1, 3000);
      const newMsg = sseEvents.find(e => e.type === 'message.new');
      log(newMsg ? 'PASS' : 'FAIL', 'WS→SSE: Agent A receives message.new via SSE',
        newMsg ? `content="${newMsg.payload?.content}"` : `${sseEvents.length} events`);
    }
  }

  // Agent A sends message via WS protocol
  if (wsA && conversationId) {
    wsSend(wsA, {
      type: 'message.send',
      payload: { conversationId, content: 'Reply from A via WS!', type: 'text' },
      requestId: 'ws-msg-2',
    });

    // WS Agent B should receive it
    if (wsB) {
      const wsRecv = await wsWaitMessage(wsB, 3000);
      log(wsRecv?.type === 'message.new' ? 'PASS' : 'FAIL', 'WS→WS: Agent B receives message.new',
        wsRecv ? `content="${wsRecv.payload?.content}"` : 'no message');
    }
  }

  // ════════════════════════════════════════════════════════════
  // Section 5: Typing Indicator
  // ════════════════════════════════════════════════════════════
  console.log('\n--- Typing Indicator ---');

  if (wsB && conversationId) {
    wsSend(wsB, { type: 'typing.start', payload: { conversationId } });

    if (wsA) {
      const typing = await wsWaitMessage(wsA, 3000);
      log(typing?.type === 'typing.indicator' ? 'PASS' : 'FAIL', 'WS: typing.start broadcast',
        typing ? `isTyping=${typing.payload?.isTyping}, userId=${typing.payload?.userId}` : 'no event');
    }
  }

  if (wsB && conversationId) {
    wsSend(wsB, { type: 'typing.stop', payload: { conversationId } });

    if (wsA) {
      const typing = await wsWaitMessage(wsA, 3000);
      log(typing?.type === 'typing.indicator' ? 'PASS' : 'FAIL', 'WS: typing.stop broadcast',
        typing ? `isTyping=${typing.payload?.isTyping}` : 'no event');
    }
  }

  // ════════════════════════════════════════════════════════════
  // Section 6: Presence (Global Broadcast)
  // ════════════════════════════════════════════════════════════
  console.log('\n--- Presence ---');

  if (wsB) {
    wsSend(wsB, { type: 'presence.update', payload: { status: 'away' } });

    // WS Agent A should receive (global broadcast)
    if (wsA) {
      const presence = await wsWaitMessage(wsA, 3000);
      log(presence?.type === 'presence.changed' ? 'PASS' : 'FAIL', 'WS: presence.changed (global)',
        presence ? `status=${presence.payload?.status}` : 'no event');
    }

    // SSE Agent A should also receive (global broadcast)
    if (sseResA) {
      const sseEvents = await sseCollectEvents(sseResA, 1, 3000);
      const presEvt = sseEvents.find(e => e.type === 'presence.changed');
      log(presEvt ? 'PASS' : 'FAIL', 'SSE: presence.changed (global)',
        presEvt ? `status=${presEvt.payload?.status}` : `${sseEvents.length} events`);
    }
  }

  // ════════════════════════════════════════════════════════════
  // Section 7: Multiple SSE Connections (same user)
  // ════════════════════════════════════════════════════════════
  console.log('\n--- Multiple Connections ---');

  try {
    const conn2 = await sseConnect(tokenA);
    const events = await sseCollectEvents(conn2.res, 1, 3000);
    const auth = events.find(e => e.type === 'authenticated');
    log(auth ? 'PASS' : 'FAIL', 'SSE: second connection receives auth', auth ? 'ok' : 'no event');
    conn2.res.destroy();
  } catch (err) {
    log('FAIL', 'SSE: second connection', err.message);
  }

  // ════════════════════════════════════════════════════════════
  // Section 8: Health Check (HTTP still works alongside WS/SSE)
  // ════════════════════════════════════════════════════════════
  console.log('\n--- HTTP Coexistence ---');

  const health = await api('GET', 'health');
  log(health.data?.ok ? 'PASS' : 'FAIL', 'HTTP: /api/im/health works alongside WS/SSE',
    `onlineUsers=${health.data?.stats?.onlineUsers}, connections=${health.data?.stats?.totalConnections}`);

  // ─── Cleanup ───────────────────────────────────────────────
  if (wsA) wsA.close();
  if (wsB) wsB.close();
  if (sseResA) sseResA.destroy();

  // ─── Summary ───────────────────────────────────────────────
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  console.log(`${'='.repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
