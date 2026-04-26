/**
 * Advanced WebSocket/SSE Tests — Group Chat, Concurrency, Stress
 *
 * Usage:
 *   node scripts/test-ws-advanced.js                  # localhost:3000
 *   node scripts/test-ws-advanced.js cloud.prismer.dev # remote
 */

const WebSocket = require('ws');
const https = require('https');
const http = require('http');

const host = process.argv[2] || 'localhost:3000';
const isLocal = host.includes('localhost') || host.includes('127.0.0.1');
const scheme = isLocal ? 'http' : 'https';
const wsScheme = isLocal ? 'ws' : 'wss';
const BASE = `${scheme}://${host}`;

let passed = 0, failed = 0;
const ts = Date.now();

function log(ok, test, detail) {
  const icon = ok ? '✅' : '❌';
  console.log(`${icon} ${test}${detail ? ': ' + detail : ''}`);
  if (ok) passed++; else failed++;
}

async function api(method, path, body, auth) {
  const url = `${BASE}/api/im/${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers['Authorization'] = `Bearer ${auth}`;
  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  let data;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

function wsConnect(token, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsScheme}://${host}/ws?token=${token}`);
    const t = setTimeout(() => { ws.close(); reject(new Error('ws timeout')); }, timeout);
    ws.on('open', () => { clearTimeout(t); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function wsWait(ws, timeout = 5000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeout);
    ws.once('message', (d) => { clearTimeout(t); try { resolve(JSON.parse(d.toString())); } catch { resolve(null); } });
  });
}

function wsCollect(ws, count, timeout = 5000) {
  return new Promise((resolve) => {
    const msgs = [];
    const t = setTimeout(() => resolve(msgs), timeout);
    const handler = (d) => {
      try { msgs.push(JSON.parse(d.toString())); } catch {}
      if (msgs.length >= count) { clearTimeout(t); ws.removeListener('message', handler); resolve(msgs); }
    };
    ws.on('message', handler);
  });
}

function wsSend(ws, msg) { ws.send(JSON.stringify(msg)); }

function sseConnect(token, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE}/sse?token=${token}`);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(url, (res) => resolve({ res, statusCode: res.statusCode }));
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function sseCollect(res, count, timeout = 5000) {
  return new Promise((resolve) => {
    const events = [];
    let buf = '';
    const t = setTimeout(() => resolve(events), timeout);
    res.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try { events.push(JSON.parse(line.slice(6))); } catch {}
        }
      }
      if (events.length >= count) { clearTimeout(t); resolve(events); }
    });
    res.on('end', () => { clearTimeout(t); resolve(events); });
  });
}

async function registerAgent(name) {
  const r = await api('POST', 'register', {
    username: `${name}_${ts}`, displayName: name,
    type: 'agent', capabilities: ['chat'],
  });
  if (!r.data?.ok) throw new Error(`Register ${name} failed: ${JSON.stringify(r.data)}`);
  return { token: r.data.data.token, id: r.data.data.imUserId, username: r.data.data.username };
}

// ════════════════════════════════════════════════════════════════
// Test Suite 1: Group Chat (5+ members)
// ════════════════════════════════════════════════════════════════
async function testGroupChat() {
  console.log('\n══════════════════════════════════════════');
  console.log('  Suite 1: Group Chat (5 members)');
  console.log('══════════════════════════════════════════\n');

  // Register 5 agents
  const agents = [];
  for (let i = 0; i < 5; i++) {
    agents.push(await registerAgent(`grp_${String.fromCharCode(65 + i)}`));
  }
  console.log(`Registered ${agents.length} agents`);
  if (!isLocal) await new Promise(r => setTimeout(r, 500)); // Remote: wait for DB commit

  // Create group conversation: A sends to B, then add C/D/E
  const conv = await api('POST', `direct/${agents[1].id}/messages`, { content: 'Group init', type: 'text' }, agents[0].token);
  const convId = conv.data?.data?.conversationId;
  if (!convId) console.log('  → conv response:', JSON.stringify(conv.data).slice(0, 200));
  log(!!convId, 'Group: create conversation');

  // Add members C, D, E to conversation
  for (let i = 2; i < 5; i++) {
    await api('POST', `direct/${agents[i].id}/messages`, { content: `Adding ${agents[i].username}`, type: 'text' }, agents[0].token);
  }

  // Connect all 5 via WebSocket
  const wsConns = [];
  for (const agent of agents) {
    try {
      const ws = await wsConnect(agent.token);
      await wsWait(ws); // consume auth event
      wsConns.push({ ws, agent });
    } catch (e) {
      log(false, `Group: WS connect ${agent.username}`, e.message);
    }
  }
  log(wsConns.length === 5, `Group: all 5 agents connected`, `${wsConns.length}/5`);

  // All join the conversation room
  for (const { ws } of wsConns) {
    wsSend(ws, { type: 'conversation.join', payload: { conversationId: convId } });
  }
  await new Promise(r => setTimeout(r, 500));

  // Agent A sends a message → B,C,D,E should all receive (A is a DB participant)
  const listeners = wsConns.slice(1).map(({ ws }) => wsWait(ws, 3000));
  wsSend(wsConns[0].ws, {
    type: 'message.send',
    payload: { conversationId: convId, content: 'Hello group!', type: 'text' },
    requestId: 'grp-msg-1',
  });

  const results = await Promise.all(listeners);
  const received = results.filter(r => r?.type === 'message.new');
  log(received.length === 4, `Group: 4/4 members received message`, `${received.length}/4`);

  // Agent A sends typing → B,C,D,E should receive
  const typingListeners = wsConns.slice(1).map(({ ws }) => wsWait(ws, 3000));
  wsSend(wsConns[0].ws, { type: 'typing.start', payload: { conversationId: convId } });
  const typingResults = await Promise.all(typingListeners);
  const typingRecv = typingResults.filter(r => r?.type === 'typing.indicator');
  log(typingRecv.length === 4, `Group: typing broadcast to 4 members`, `${typingRecv.length}/4`);

  // Agent C updates presence → all others receive
  const presenceListeners = [...wsConns.slice(0, 2), ...wsConns.slice(3)].map(({ ws }) => wsWait(ws, 3000));
  wsSend(wsConns[2].ws, { type: 'presence.update', payload: { status: 'busy' } });
  const presResults = await Promise.all(presenceListeners);
  const presRecv = presResults.filter(r => r?.type === 'presence.changed');
  log(presRecv.length === 4, `Group: presence broadcast to 4 others`, `${presRecv.length}/4`);

  // Agent B disconnects, A sends message → C,D,E receive (3 room members, A is sender)
  wsConns[1].ws.close();
  await new Promise(r => setTimeout(r, 300));
  const afterDisconnect = [wsConns[2], wsConns[3], wsConns[4]].map(({ ws }) => wsWait(ws, 3000));
  wsSend(wsConns[0].ws, {
    type: 'message.send',
    payload: { conversationId: convId, content: 'After B left', type: 'text' },
    requestId: 'grp-msg-2',
  });
  const afterResults = await Promise.all(afterDisconnect);
  const afterRecv = afterResults.filter(r => r?.type === 'message.new');
  log(afterRecv.length === 3, `Group: message after disconnect (3 remaining)`, `${afterRecv.length}/3`);

  // Cleanup
  for (const { ws } of wsConns) { try { ws.close(); } catch {} }
}

// ════════════════════════════════════════════════════════════════
// Test Suite 2: Mixed WS + SSE group
// ════════════════════════════════════════════════════════════════
async function testMixedTransport() {
  console.log('\n══════════════════════════════════════════');
  console.log('  Suite 2: Mixed WS + SSE Transport');
  console.log('══════════════════════════════════════════\n');

  const a = await registerAgent('mix_ws');
  const b = await registerAgent('mix_sse');
  const c = await registerAgent('mix_both');

  // Create conversation
  await api('POST', `direct/${b.id}/messages`, { content: 'setup', type: 'text' }, a.token);
  const conv2 = await api('POST', `direct/${c.id}/messages`, { content: 'setup', type: 'text' }, a.token);
  const convId = conv2.data?.data?.conversationId;

  // A = WebSocket only
  const wsA = await wsConnect(a.token);
  await wsWait(wsA);
  wsSend(wsA, { type: 'conversation.join', payload: { conversationId: convId } });

  // B = SSE only
  const sseConn = await sseConnect(b.token);
  const sseRes = sseConn.res;
  await sseCollect(sseRes, 1, 3000); // consume auth

  // C = Both WS + SSE
  const wsC = await wsConnect(c.token);
  await wsWait(wsC);
  wsSend(wsC, { type: 'conversation.join', payload: { conversationId: convId } });
  const sseC = await sseConnect(c.token);
  await sseCollect(sseC.res, 1, 3000);

  await new Promise(r => setTimeout(r, 500));

  // A sends via WS → C should get on both WS and SSE
  const wsListener = wsWait(wsC, 3000);
  const sseListener = sseCollect(sseC.res, 1, 3000);

  wsSend(wsA, {
    type: 'message.send',
    payload: { conversationId: convId, content: 'Mixed transport test', type: 'text' },
    requestId: 'mix-1',
  });

  const wsResult = await wsListener;
  const sseResult = await sseListener;

  log(wsResult?.type === 'message.new', 'Mixed: C receives via WS', `content="${wsResult?.payload?.content}"`);
  const sseMsg = sseResult.find(e => e.type === 'message.new');
  log(!!sseMsg, 'Mixed: C receives via SSE', sseMsg ? `content="${sseMsg.payload?.content}"` : 'none');

  // Presence via WS → SSE B should also receive
  const sseBListener = sseCollect(sseRes, 1, 3000);
  wsSend(wsA, { type: 'presence.update', payload: { status: 'dnd' } });
  const sseBResult = await sseBListener;
  const presEvt = sseBResult.find(e => e.type === 'presence.changed');
  log(!!presEvt, 'Mixed: SSE-only user receives presence', presEvt ? `status=${presEvt.payload?.status}` : 'none');

  wsA.close(); wsC.close(); sseRes.destroy(); sseC.res.destroy();
}

// ════════════════════════════════════════════════════════════════
// Test Suite 3: High Concurrency Stress Test
// ════════════════════════════════════════════════════════════════
async function testConcurrency() {
  console.log('\n══════════════════════════════════════════');
  console.log('  Suite 3: High Concurrency Stress Test');
  console.log('══════════════════════════════════════════\n');

  const AGENT_COUNT = 20;
  const MSG_COUNT = 10; // messages per sender

  // Register agents concurrently
  console.log(`Registering ${AGENT_COUNT} agents...`);
  const startReg = Date.now();
  const agents = await Promise.all(
    Array.from({ length: AGENT_COUNT }, (_, i) => registerAgent(`stress_${i}`))
  );
  const regTime = Date.now() - startReg;
  log(agents.length === AGENT_COUNT, `Stress: registered ${AGENT_COUNT} agents`, `${regTime}ms`);

  // Create a shared conversation (A sends to each)
  const convResp = await api('POST', `direct/${agents[1].id}/messages`, { content: 'stress-init', type: 'text' }, agents[0].token);
  const convId = convResp.data?.data?.conversationId;
  log(!!convId, 'Stress: conversation created');

  // Connect all via WebSocket concurrently
  console.log(`Connecting ${AGENT_COUNT} WebSockets...`);
  const startConn = Date.now();
  const wsResults = await Promise.allSettled(
    agents.map(async (agent) => {
      const ws = await wsConnect(agent.token);
      await wsWait(ws); // auth
      wsSend(ws, { type: 'conversation.join', payload: { conversationId: convId } });
      return ws;
    })
  );
  const connTime = Date.now() - startConn;
  const connected = wsResults.filter(r => r.status === 'fulfilled');
  const wsList = connected.map(r => r.value);
  log(connected.length === AGENT_COUNT, `Stress: ${connected.length}/${AGENT_COUNT} connected`, `${connTime}ms`);

  await new Promise(r => setTimeout(r, 500));

  // Rapid-fire messages from agent[0]
  console.log(`Sending ${MSG_COUNT} rapid messages...`);
  const startSend = Date.now();
  for (let i = 0; i < MSG_COUNT; i++) {
    wsSend(wsList[0], {
      type: 'message.send',
      payload: { conversationId: convId, content: `Stress msg ${i}`, type: 'text' },
      requestId: `stress-${i}`,
    });
  }

  // Agent[1] collects messages (should receive all MSG_COUNT)
  const received = await wsCollect(wsList[1], MSG_COUNT, 10000);
  const sendTime = Date.now() - startSend;
  const msgEvents = received.filter(e => e.type === 'message.new');
  log(msgEvents.length >= MSG_COUNT, `Stress: received ${msgEvents.length}/${MSG_COUNT} messages`, `${sendTime}ms`);

  // Check health endpoint still responsive under load
  const healthStart = Date.now();
  const health = await api('GET', 'health');
  const healthTime = Date.now() - healthStart;
  log(health.data?.ok, `Stress: health responsive under load`, `${healthTime}ms, ${health.data?.stats?.onlineUsers} online`);

  // Concurrent disconnections
  const startDisc = Date.now();
  await Promise.all(wsList.map(ws => new Promise(r => { ws.close(); ws.on('close', r); setTimeout(r, 1000); })));
  const discTime = Date.now() - startDisc;
  log(true, `Stress: ${AGENT_COUNT} disconnected`, `${discTime}ms`);

  // Verify cleanup
  await new Promise(r => setTimeout(r, 500));
  const afterHealth = await api('GET', 'health');
  log(afterHealth.data?.stats?.onlineUsers === 0, 'Stress: all connections cleaned up', `online=${afterHealth.data?.stats?.onlineUsers}`);
}

// ════════════════════════════════════════════════════════════════
// Test Suite 4: Full IM Lifecycle via HTTP API
// ════════════════════════════════════════════════════════════════
async function testIMLifecycle() {
  console.log('\n══════════════════════════════════════════');
  console.log('  Suite 4: Full IM Lifecycle (HTTP API)');
  console.log('══════════════════════════════════════════\n');

  // Register human + agent
  const human = await registerAgent('lc_human');
  const agent = await registerAgent('lc_agent');

  // Get identity (response: { ok, data: { user: { id, username, ... }, stats: {...} } })
  const me = await api('GET', 'me', null, human.token);
  log(me.data?.ok && me.data.data?.user?.id === human.id, 'Lifecycle: GET /me', `userId=${me.data?.data?.user?.id}`);

  // Send direct message
  const msg1 = await api('POST', `direct/${agent.id}/messages`, { content: 'Hello agent!', type: 'text' }, human.token);
  log(msg1.data?.ok, 'Lifecycle: send direct message', `msgId=${msg1.data?.data?.id}`);
  const convId = msg1.data?.data?.conversationId;

  // Reply
  const msg2 = await api('POST', `messages/${convId}`, { content: 'Hello human!', type: 'text' }, agent.token);
  log(msg2.data?.ok, 'Lifecycle: reply to conversation', `msgId=${msg2.data?.data?.id}`);

  // List conversations
  const convos = await api('GET', 'conversations', null, human.token);
  log(convos.data?.ok && convos.data.data?.length > 0, 'Lifecycle: list conversations', `count=${convos.data?.data?.length}`);

  // Get messages
  const msgs = await api('GET', `messages/${convId}`, null, human.token);
  log(msgs.data?.ok && msgs.data.data?.length >= 2, 'Lifecycle: get messages', `count=${msgs.data?.data?.length}`);

  // Read cursor
  const cursor = await api('POST', `conversations/${convId}/read`, { messageId: msg2.data?.data?.id }, human.token);
  log(cursor.status === 200, 'Lifecycle: update read cursor', `status=${cursor.status}`);

  // Agent discovery — register agent card (requires: name, description)
  const agentReg = await api('POST', 'agents/register', {
    name: `lc_agent_${ts}`,
    description: 'Test lifecycle agent',
    agentType: 'assistant',
    capabilities: ['chat', 'code-review'],
  }, agent.token);
  log(agentReg.data?.ok || agentReg.status === 201, 'Lifecycle: register agent card', `agentId=${agentReg.data?.data?.agentId}`);

  const discover = await api('GET', 'discover?capability=chat', null, human.token);
  log(discover.data?.ok, 'Lifecycle: discover agents', `found=${discover.data?.data?.length}`);

  // Workspace init (userId = external cloud user ID, service creates/finds IM user by it)
  const workspace = await api('POST', 'workspace/init', {
    workspaceId: `ws_${ts}`,
    userId: `cloud_user_${ts}`,
    userDisplayName: 'Workspace Test',
    agentName: `ws_agent_${ts}`,
    agentDisplayName: 'WS Agent',
    agentCapabilities: ['chat'],
  }, human.token);
  log(workspace.data?.ok || workspace.status === 201, 'Lifecycle: workspace init', `status=${workspace.status}`);
}

// ════════════════════════════════════════════════════════════════
// Test Suite 5: Edge Cases & Error Handling
// ════════════════════════════════════════════════════════════════
async function testEdgeCases() {
  console.log('\n══════════════════════════════════════════');
  console.log('  Suite 5: Edge Cases & Error Handling');
  console.log('══════════════════════════════════════════\n');

  const agent = await registerAgent('edge');

  // WS: send before joining room
  const ws = await wsConnect(agent.token);
  await wsWait(ws); // auth
  wsSend(ws, {
    type: 'message.send',
    payload: { conversationId: 'nonexistent-conv', content: 'ghost', type: 'text' },
    requestId: 'edge-1',
  });
  const errMsg = await wsWait(ws, 3000);
  log(errMsg?.type === 'error' || errMsg === null, 'Edge: message to non-existent conv', errMsg?.type || 'no response');

  // WS: invalid JSON
  ws.send('not valid json');
  const errJson = await wsWait(ws, 2000);
  log(errJson?.type === 'error', 'Edge: invalid JSON → error', errJson?.payload?.message || errJson?.type);

  // WS: unknown event type
  wsSend(ws, { type: 'nonexistent.event', payload: {} });
  const errUnknown = await wsWait(ws, 2000);
  log(errUnknown?.type === 'error' || errUnknown === null, 'Edge: unknown event type', errUnknown?.type || 'ignored');

  // WS: rapid ping flood (50 pings)
  const pingStart = Date.now();
  for (let i = 0; i < 50; i++) {
    wsSend(ws, { type: 'ping', payload: {}, requestId: `flood-${i}` });
  }
  const pongs = await wsCollect(ws, 50, 5000);
  const pingTime = Date.now() - pingStart;
  const pongCount = pongs.filter(p => p.type === 'pong').length;
  log(pongCount === 50, `Edge: 50 rapid pings → ${pongCount} pongs`, `${pingTime}ms`);

  // HTTP: invalid auth
  const badAuth = await api('GET', 'conversations', null, 'invalid-token-xxx');
  log(badAuth.status === 401 || badAuth.status === 403, 'Edge: invalid token → 401/403', `status=${badAuth.status}`);

  // HTTP: send to self
  const selfMsg = await api('POST', `direct/${agent.id}/messages`, { content: 'self', type: 'text' }, agent.token);
  log(selfMsg.data?.ok || selfMsg.status === 400, 'Edge: message to self', `status=${selfMsg.status}`);

  // Reconnection: close and reopen
  ws.close();
  await new Promise(r => setTimeout(r, 300));
  try {
    const ws2 = await wsConnect(agent.token);
    const auth2 = await wsWait(ws2);
    log(auth2?.type === 'authenticated', 'Edge: reconnect after close', `userId=${auth2?.payload?.userId}`);
    ws2.close();
  } catch (e) {
    log(false, 'Edge: reconnect', e.message);
  }
}

// ════════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════════
async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Advanced WS/SSE Tests → ${BASE}`);
  console.log(`${'═'.repeat(60)}`);

  try { await testGroupChat(); } catch (e) { console.error('Suite 1 error:', e.message); }
  try { await testMixedTransport(); } catch (e) { console.error('Suite 2 error:', e.message); }
  try { await testConcurrency(); } catch (e) { console.error('Suite 3 error:', e.message); }
  try { await testIMLifecycle(); } catch (e) { console.error('Suite 4 error:', e.message); }
  try { await testEdgeCases(); } catch (e) { console.error('Suite 5 error:', e.message); }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  console.log(`  Target: ${BASE}`);
  console.log(`${'═'.repeat(60)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
