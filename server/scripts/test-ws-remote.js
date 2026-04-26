/**
 * Test WebSocket + SSE on remote environment (cloud.prismer.dev or localhost)
 *
 * Usage:
 *   node scripts/test-ws-remote.js                     # default: cloud.prismer.dev
 *   node scripts/test-ws-remote.js localhost:3000       # local dev
 *   node scripts/test-ws-remote.js prismer.cloud        # production
 */

const WebSocket = require('ws');
const https = require('https');
const http = require('http');

const host = process.argv[2] || 'cloud.prismer.dev';
const isLocal = host.includes('localhost') || host.includes('127.0.0.1');
const scheme = isLocal ? 'http' : 'https';
const wsScheme = isLocal ? 'ws' : 'wss';
const BASE = `${scheme}://${host}`;

let passed = 0, failed = 0;

function log(ok, test, detail) {
  const icon = ok ? '✅' : '❌';
  console.log(`${icon} ${test}${detail ? ': ' + detail : ''}`);
  if (ok) passed++; else failed++;
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

function wsConnect(token, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const url = `${wsScheme}://${host}/ws?token=${token}`;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new Error('ws connect timeout')); }, timeoutMs);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function wsWait(ws, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(data.toString())); } catch { resolve(null); }
    });
  });
}

function wsSend(ws, msg) { ws.send(JSON.stringify(msg)); }

function sseConnect(token, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE}/sse?token=${token}`);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(url, (res) => {
      resolve({ res, statusCode: res.statusCode, headers: res.headers });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('sse timeout')); });
  });
}

function sseCollect(res, count, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const events = [];
    let buf = '';
    const timer = setTimeout(() => resolve(events), timeoutMs);
    res.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
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

async function main() {
  console.log(`\n=== WebSocket + SSE Remote Tests → ${BASE} ===\n`);

  // ─── Health ──────────────────────────────────────────────────
  console.log('--- Health ---');
  const health = await api('GET', 'health');
  log(health.data?.ok, 'HTTP health', `v${health.data?.version}`);

  // ─── Register agents ─────────────────────────────────────────
  console.log('\n--- Setup ---');
  const ts = Date.now();
  const r1 = await api('POST', 'register', {
    username: `ws_remote_a_${ts}`, displayName: 'Remote A',
    type: 'agent', capabilities: ['chat'],
  });
  const r2 = await api('POST', 'register', {
    username: `ws_remote_b_${ts}`, displayName: 'Remote B',
    type: 'agent', capabilities: ['chat'],
  });
  if (!r1.data?.ok || !r2.data?.ok) {
    console.error('Register failed:', r1.data, r2.data);
    process.exit(1);
  }
  const tokenA = r1.data.data.token, idA = r1.data.data.imUserId;
  const tokenB = r2.data.data.token, idB = r2.data.data.imUserId;
  console.log(`Agent A: ${idA}`);
  console.log(`Agent B: ${idB}`);

  // Create conversation
  const send = await api('POST', `direct/${idB}/messages`, { content: 'setup', type: 'text' }, tokenA);
  const convId = send.data?.data?.conversationId;
  log(!!convId, 'Conversation created', convId);

  // ─── WebSocket ────────────────────────────────────────────────
  console.log('\n--- WebSocket ---');

  let wsA, wsB;
  try {
    wsA = await wsConnect(tokenA);
    const authA = await wsWait(wsA);
    log(authA?.type === 'authenticated', 'WS A: connect + auth', `userId=${authA?.payload?.userId}`);
  } catch (e) {
    log(false, 'WS A: connect', e.message);
  }

  try {
    wsB = await wsConnect(tokenB);
    const authB = await wsWait(wsB);
    log(authB?.type === 'authenticated', 'WS B: connect + auth', `userId=${authB?.payload?.userId}`);
  } catch (e) {
    log(false, 'WS B: connect', e.message);
  }

  // Ping
  if (wsA) {
    wsSend(wsA, { type: 'ping', payload: {}, requestId: 'p1' });
    const pong = await wsWait(wsA);
    log(pong?.type === 'pong', 'WS: ping → pong', `requestId=${pong?.requestId}`);
  }

  // Join rooms + message broadcast
  if (wsA && wsB && convId) {
    wsSend(wsA, { type: 'conversation.join', payload: { conversationId: convId } });
    wsSend(wsB, { type: 'conversation.join', payload: { conversationId: convId } });
    await new Promise(r => setTimeout(r, 300));

    wsSend(wsB, {
      type: 'message.send',
      payload: { conversationId: convId, content: 'Hello via WS!', type: 'text' },
      requestId: 'msg-1',
    });
    const recv = await wsWait(wsA);
    log(recv?.type === 'message.new', 'WS→WS: A receives message', `content="${recv?.payload?.content}"`);

    // Typing
    wsSend(wsB, { type: 'typing.start', payload: { conversationId: convId } });
    const typing = await wsWait(wsA);
    log(typing?.type === 'typing.indicator', 'WS: typing broadcast', `isTyping=${typing?.payload?.isTyping}`);

    // Presence
    wsSend(wsB, { type: 'presence.update', payload: { status: 'away' } });
    const presence = await wsWait(wsA);
    log(presence?.type === 'presence.changed', 'WS: presence broadcast', `status=${presence?.payload?.status}`);
  }

  // ─── SSE ──────────────────────────────────────────────────────
  console.log('\n--- SSE ---');

  // No token → 401
  try {
    const conn = await sseConnect('');
    conn.res.destroy();
    log(conn.statusCode === 401, 'SSE: no token → 401', `status=${conn.statusCode}`);
  } catch (e) {
    log(false, 'SSE: no token → 401', e.message);
  }

  // Valid token → authenticated event
  let sseRes;
  try {
    const conn = await sseConnect(tokenA);
    sseRes = conn.res;
    log(conn.statusCode === 200, 'SSE: connect → 200', `status=${conn.statusCode}`);

    const events = await sseCollect(sseRes, 1, 5000);
    const auth = events.find(e => e.type === 'authenticated');
    log(!!auth, 'SSE: authenticated event', auth ? `userId=${auth.payload?.userId}` : 'none');
  } catch (e) {
    log(false, 'SSE: connect', e.message);
  }

  // WS message → SSE receives
  if (wsB && sseRes && convId) {
    wsSend(wsB, {
      type: 'message.send',
      payload: { conversationId: convId, content: 'SSE test msg', type: 'text' },
      requestId: 'msg-sse-1',
    });
    const events = await sseCollect(sseRes, 1, 5000);
    const msg = events.find(e => e.type === 'message.new');
    log(!!msg, 'WS→SSE: message push', msg ? `content="${msg.payload?.content}"` : `${events.length} events`);
  }

  // ─── Cleanup ──────────────────────────────────────────────────
  if (wsA) wsA.close();
  if (wsB) wsB.close();
  if (sseRes) sseRes.destroy();

  // ─── Summary ──────────────────────────────────────────────────
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  console.log(`Target: ${BASE}`);
  console.log(`${'='.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
