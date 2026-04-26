/**
 * Prismer IM Full Performance Benchmark — Production (prismer.cloud, 4 instances)
 *
 * B1  注册吞吐 (100 agents, c=20)
 * B2  Session 管理 (/me + refresh + 异常 token)
 * B3  消息发送并发 (200 msgs, c=30)
 * B4  消息历史查询 (并发读)
 * B5  消息编辑 & 删除
 * B6  线程回复 (parentId)
 * B7  群组全链路 (create + send + history)
 * B8  会话 & 联系人 & 发现 & 积分
 * B9  WebSocket 连接 + 实时消息投递延迟
 * B10 SSE 流事件投递
 * B11 数据一致性 (跨实例写读 50 条)
 * B12 极限压测 (500 ops 混合读写, c=80)
 *
 * Usage: npx tsx scripts/benchmark-im.ts
 */

import WebSocket from 'ws';

const BASE = process.env.PRISMER_BENCHMARK_URL || 'https://prismer.cloud';
const API_KEY =
  process.env.PRISMER_API_KEY || (process.env.PRISMER_API_KEY || process.env.PRISMER_API_KEY_TEST || '');

interface M {
  name: string;
  total: number;
  success: number;
  failed: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  rps: number;
  dur: number;
  errors: string[];
  extra?: Record<string, any>;
}

function pct(s: number[], p: number) {
  return s.length ? s[Math.min(Math.ceil((p / 100) * s.length) - 1, s.length - 1)] : 0;
}
function m(name: string, l: number[], e: string[], dur: number, extra?: Record<string, any>): M {
  const s = [...l].sort((a, b) => a - b);
  return {
    name,
    total: l.length + e.length,
    success: l.length,
    failed: e.length,
    avg: s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : 0,
    p50: pct(s, 50),
    p95: pct(s, 95),
    p99: pct(s, 99),
    min: s[0] ?? 0,
    max: s.at(-1) ?? 0,
    rps: Math.round((l.length / dur) * 1000 * 100) / 100,
    dur: Math.round(dur),
    errors: [...new Set(e)].slice(0, 5),
    extra,
  };
}
function show(r: M) {
  const ok = r.failed === 0 ? '✅' : r.failed < r.total * 0.05 ? '⚠️' : '❌';
  console.log(`  ${ok} ${r.name}`);
  console.log(
    `     ${r.success}/${r.total} | Avg ${r.avg}ms | P50 ${r.p50}ms | P95 ${r.p95}ms | P99 ${r.p99}ms | Min ${r.min}ms | Max ${r.max}ms | ${r.rps} rps`,
  );
  if (r.errors.length) console.log(`     Errors: ${r.errors.join('; ')}`);
  if (r.extra) {
    for (const [k, v] of Object.entries(r.extra)) console.log(`     ${k}: ${v}`);
  }
}

async function http(method: string, path: string, body?: any, token?: string) {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  const t0 = performance.now();
  const r = await fetch(`${BASE}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ms = Math.round(performance.now() - t0);
  const txt = await r.text();
  let d: any;
  try {
    d = JSON.parse(txt);
  } catch {
    d = { _raw: txt, _status: r.status };
  }
  return { d, ms, ok: r.ok && d.ok !== false, status: r.status };
}

async function pool<T>(tasks: (() => Promise<T>)[], c: number): Promise<T[]> {
  const res: T[] = [];
  let i = 0;
  const run = async () => {
    while (i < tasks.length) {
      const idx = i++;
      res[idx] = await tasks[idx]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(c, tasks.length) }, () => run()));
  return res;
}

async function setup(n: number) {
  const ts = Date.now();
  const agents: { token: string; id: string; user: string }[] = [];
  await pool(
    Array.from({ length: n }, (_, i) => async () => {
      const r = await http('POST', '/api/im/register', {
        type: 'agent',
        username: `b${ts}-${i}`,
        displayName: `B${i}`,
        agentType: 'assistant',
        capabilities: ['benchmark'],
      });
      if (r.ok) agents.push({ token: r.d.data.token, id: r.d.data.imUserId, user: `b${ts}-${i}` });
    }),
    10,
  );
  return agents;
}

// ═══════════════════════════════════════════════════════
// B1: 注册吞吐
// ═══════════════════════════════════════════════════════
async function b1(): Promise<M> {
  console.log('\n── B1: 注册吞吐 ──');
  const N = 100,
    l: number[] = [],
    e: string[] = [],
    ts = Date.now();
  const t0 = performance.now();
  await pool(
    Array.from({ length: N }, (_, i) => async () => {
      const r = await http('POST', '/api/im/register', {
        type: 'agent',
        username: `r${ts}-${i}`,
        displayName: `R${i}`,
      });
      r.ok ? l.push(r.ms) : e.push(String(r.d?.error || '').slice(0, 60));
    }),
    20,
  );
  const r = m(`B1 注册吞吐 (${N} agents, c=20)`, l, e, performance.now() - t0);
  show(r);
  return r;
}

// ═══════════════════════════════════════════════════════
// B2: Session 管理
// ═══════════════════════════════════════════════════════
async function b2(agents: any[]): Promise<M> {
  console.log('\n── B2: Session 管理 ──');
  const l: number[] = [],
    e: string[] = [],
    tasks: (() => Promise<void>)[] = [];
  // /me × all agents
  for (const a of agents)
    tasks.push(async () => {
      const r = await http('GET', '/api/im/me', undefined, a.token);
      r.ok ? l.push(r.ms) : e.push('me');
    });
  // token/refresh × all
  for (const a of agents)
    tasks.push(async () => {
      const r = await http('POST', '/api/im/token/refresh', undefined, a.token);
      r.ok ? l.push(r.ms) : e.push('refresh');
    });
  // 无效 token
  for (let i = 0; i < 10; i++)
    tasks.push(async () => {
      const r = await http('GET', '/api/im/me', undefined, 'invalid-token-' + i);
      !r.ok ? l.push(r.ms) : e.push('should_reject');
    });
  // 伪造 JWT
  tasks.push(async () => {
    const r = await http(
      'GET',
      '/api/im/me',
      undefined,
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlIiwiaWF0IjoxfQ.fake',
    );
    !r.ok ? l.push(r.ms) : e.push('should_reject_fake');
  });
  // 空 Authorization
  tasks.push(async () => {
    const r = await http('GET', '/api/im/me');
    !r.ok ? l.push(r.ms) : e.push('should_reject_empty');
  });

  const t0 = performance.now();
  await pool(tasks, 20);
  const r = m(
    `B2 Session (/me×${agents.length} + refresh×${agents.length} + 异常token×12, c=20)`,
    l,
    e,
    performance.now() - t0,
  );
  show(r);
  return r;
}

// ═══════════════════════════════════════════════════════
// B3: 消息发送并发
// ═══════════════════════════════════════════════════════
async function b3(agents: any[]): Promise<M> {
  console.log('\n── B3: 消息发送并发 ──');
  const N = 200,
    l: number[] = [],
    e: string[] = [];
  const pairs = Math.min(Math.floor(agents.length / 2), 20);
  const perPair = Math.ceil(N / pairs);
  const tasks: (() => Promise<void>)[] = [];
  for (let p = 0; p < pairs; p++) {
    for (let i = 0; i < perPair; i++) {
      const s = agents[p * 2],
        rv = agents[p * 2 + 1];
      tasks.push(async () => {
        const r = await http(
          'POST',
          `/api/im/direct/${rv.id}/messages`,
          { content: `M${p}-${i} ${Date.now()}` },
          s.token,
        );
        r.ok ? l.push(r.ms) : e.push(typeof r.d?.error === 'string' ? r.d.error.slice(0, 50) : 'fail');
      });
    }
  }
  const t0 = performance.now();
  await pool(tasks, 30);
  const r = m(`B3 消息并发 (${tasks.length} msgs, ${pairs} pairs, c=30)`, l, e, performance.now() - t0);
  show(r);
  return r;
}

// ═══════════════════════════════════════════════════════
// B4: 消息历史查询
// ═══════════════════════════════════════════════════════
async function b4(agents: any[]): Promise<M> {
  console.log('\n── B4: 消息历史查询 ──');
  const l: number[] = [],
    e: string[] = [],
    tasks: (() => Promise<void>)[] = [];
  const pairs = Math.min(Math.floor(agents.length / 2), 15);
  // 每对查 3 次（不同 limit）
  for (let p = 0; p < pairs; p++) {
    for (const limit of [10, 50, 100]) {
      tasks.push(async () => {
        const r = await http(
          'GET',
          `/api/im/direct/${agents[p * 2 + 1].id}/messages?limit=${limit}`,
          undefined,
          agents[p * 2].token,
        );
        r.ok ? l.push(r.ms) : e.push('history');
      });
    }
  }
  const t0 = performance.now();
  await pool(tasks, 20);
  const r = m(`B4 消息历史 (${tasks.length} queries, limit=10/50/100, c=20)`, l, e, performance.now() - t0);
  show(r);
  return r;
}

// ═══════════════════════════════════════════════════════
// B5: 消息编辑 & 删除
// ═══════════════════════════════════════════════════════
async function b5(agents: any[]): Promise<M> {
  console.log('\n── B5: 消息编辑 & 删除 ──');
  const l: number[] = [],
    e: string[] = [];
  const sender = agents[0],
    recv = agents[1];
  const t0 = performance.now();

  // 先发 20 条消息
  const msgIds: string[] = [],
    convId: string[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await http('POST', `/api/im/direct/${recv.id}/messages`, { content: `EditTest #${i}` }, sender.token);
    if (r.ok) {
      l.push(r.ms);
      msgIds.push(r.d.data.message.id);
      if (!convId.length) convId.push(r.d.data.conversationId);
    } else e.push('send');
  }

  // 编辑前 10 条
  if (convId.length) {
    await pool(
      msgIds.slice(0, 10).map((mid, i) => async () => {
        const r = await http(
          'PATCH',
          `/api/im/messages/${convId[0]}/${mid}`,
          { content: `Edited #${i} @ ${Date.now()}` },
          sender.token,
        );
        r.ok ? l.push(r.ms) : e.push('edit');
      }),
      10,
    );
  }

  // 删除后 5 条
  if (convId.length) {
    await pool(
      msgIds.slice(15).map((mid) => async () => {
        const r = await http('DELETE', `/api/im/messages/${convId[0]}/${mid}`, undefined, sender.token);
        r.ok ? l.push(r.ms) : e.push('delete');
      }),
      5,
    );
  }

  const r = m(`B5 消息编辑&删除 (send×20 + edit×10 + delete×5)`, l, e, performance.now() - t0);
  show(r);
  return r;
}

// ═══════════════════════════════════════════════════════
// B6: 线程回复
// ═══════════════════════════════════════════════════════
async function b6(agents: any[]): Promise<M> {
  console.log('\n── B6: 线程回复 ──');
  const l: number[] = [],
    e: string[] = [];
  const sender = agents[0],
    recv = agents[1];
  const t0 = performance.now();

  // 发一条根消息
  const root = await http(
    'POST',
    `/api/im/direct/${recv.id}/messages`,
    { content: 'Thread root message' },
    sender.token,
  );
  if (!root.ok) {
    e.push('root');
    const r = m('B6 线程回复', l, e, 1);
    show(r);
    return r;
  }
  l.push(root.ms);
  const rootId = root.d.data.message.id;
  const convId = root.d.data.conversationId;

  // 10 条线程回复（parentId）
  await pool(
    Array.from({ length: 10 }, (_, i) => async () => {
      const r = await http(
        'POST',
        `/api/im/messages/${convId}`,
        { content: `Reply #${i}`, parentId: rootId },
        sender.token,
      );
      r.ok ? l.push(r.ms) : e.push('reply');
    }),
    5,
  );

  // 对方也回复 5 条
  await pool(
    Array.from({ length: 5 }, (_, i) => async () => {
      const r = await http(
        'POST',
        `/api/im/messages/${convId}`,
        { content: `Counter-reply #${i}`, parentId: rootId },
        recv.token,
      );
      r.ok ? l.push(r.ms) : e.push('counter_reply');
    }),
    5,
  );

  const r = m(`B6 线程回复 (root×1 + reply×10 + counter×5)`, l, e, performance.now() - t0);
  show(r);
  return r;
}

// ═══════════════════════════════════════════════════════
// B7: 群组全链路
// ═══════════════════════════════════════════════════════
async function b7(agents: any[]): Promise<M> {
  console.log('\n── B7: 群组全链路 ──');
  const l: number[] = [],
    e: string[] = [],
    ts = Date.now();
  const t0 = performance.now();

  // 创建 10 个群组
  const gids: string[] = [];
  await pool(
    Array.from({ length: 10 }, (_, i) => async () => {
      const members = agents.slice(1, 3 + (i % 5)).map((a) => a.id);
      const r = await http('POST', '/api/im/groups', { title: `G${ts}-${i}`, members }, agents[0].token);
      if (r.ok && r.d?.data?.groupId) {
        l.push(r.ms);
        gids.push(r.d.data.groupId);
      } else e.push('create');
    }),
    5,
  );

  // 每个群发 10 条消息（并发）
  const sendTasks: (() => Promise<void>)[] = [];
  for (const gid of gids) {
    for (let i = 0; i < 10; i++) {
      sendTasks.push(async () => {
        const r = await http(
          'POST',
          `/api/im/groups/${gid}/messages`,
          { content: `GM${i} ${Date.now()}` },
          agents[i % agents.length].token,
        );
        r.ok ? l.push(r.ms) : e.push('send');
      });
    }
  }
  await pool(sendTasks, 20);

  // 查询每个群的消息
  await pool(
    gids.map((gid) => async () => {
      const r = await http('GET', `/api/im/groups/${gid}/messages?limit=20`, undefined, agents[0].token);
      r.ok ? l.push(r.ms) : e.push('history');
    }),
    10,
  );

  // 列群
  const listR = await http('GET', '/api/im/groups', undefined, agents[0].token);
  listR.ok ? l.push(listR.ms) : e.push('list');

  const r = m(
    `B7 群组 (create×10 + send×${gids.length * 10} + history×${gids.length} + list×1)`,
    l,
    e,
    performance.now() - t0,
  );
  show(r);
  return r;
}

// ═══════════════════════════════════════════════════════
// B8: 查询操作合集
// ═══════════════════════════════════════════════════════
async function b8(agents: any[]): Promise<M> {
  console.log('\n── B8: 查询操作合集 ──');
  const l: number[] = [],
    e: string[] = [],
    tasks: (() => Promise<void>)[] = [];

  for (const a of agents)
    tasks.push(async () => {
      const r = await http('GET', '/api/im/conversations', undefined, a.token);
      r.ok ? l.push(r.ms) : e.push('conv');
    });
  for (let i = 0; i < 20; i++)
    tasks.push(async () => {
      const r = await http('GET', '/api/im/discover', undefined, agents[i % agents.length].token);
      r.ok ? l.push(r.ms) : e.push('disc');
    });
  for (const a of agents)
    tasks.push(async () => {
      const r = await http('GET', '/api/im/contacts', undefined, a.token);
      r.ok ? l.push(r.ms) : e.push('ctc');
    });
  for (const a of agents)
    tasks.push(async () => {
      const r = await http('GET', '/api/im/credits', undefined, a.token);
      r.ok ? l.push(r.ms) : e.push('cred');
    });
  for (let i = 0; i < 10; i++)
    tasks.push(async () => {
      const r = await http('GET', '/api/im/credits/transactions?limit=20', undefined, agents[i % agents.length].token);
      r.ok ? l.push(r.ms) : e.push('txn');
    });

  const t0 = performance.now();
  await pool(tasks, 30);
  const r = m(
    `B8 查询合集 (conv×${agents.length} + discover×20 + contacts×${agents.length} + credits×${agents.length} + txn×10, c=30)`,
    l,
    e,
    performance.now() - t0,
  );
  show(r);
  return r;
}

// ═══════════════════════════════════════════════════════
// B9: WebSocket 实时消息投递
// ═══════════════════════════════════════════════════════
async function b9(agents: any[]): Promise<M> {
  console.log('\n── B9: WebSocket 实时消息投递 ──');
  const l: number[] = [],
    e: string[] = [];
  const receiver = agents[0],
    sender = agents[1];
  const t0 = performance.now();

  const wsUrl = BASE.replace('https://', 'wss://').replace('http://', 'ws://') + `/ws?token=${receiver.token}`;

  return new Promise<M>((resolve) => {
    let connectLatency = 0;
    const deliveryLatencies: number[] = [];
    let msgsSent = 0;
    const MSG_COUNT = 10;
    const sentTimestamps: Map<string, number> = new Map();

    const wsStart = performance.now();
    const ws = new WebSocket(wsUrl);

    const timeout = setTimeout(() => {
      ws.close();
      const r = m(
        `B9 WebSocket (connect + ${deliveryLatencies.length}/${MSG_COUNT} events)`,
        [...l, ...deliveryLatencies],
        e,
        performance.now() - t0,
        {
          连接延迟: `${connectLatency}ms`,
          '投递延迟 avg': deliveryLatencies.length
            ? `${Math.round(deliveryLatencies.reduce((a, b) => a + b, 0) / deliveryLatencies.length)}ms`
            : 'N/A',
          事件接收: `${deliveryLatencies.length}/${MSG_COUNT}`,
        },
      );
      show(r);
      resolve(r);
    }, 20000);

    ws.on('open', () => {
      connectLatency = Math.round(performance.now() - wsStart);
      l.push(connectLatency);
      console.log(`     WS 连接: ${connectLatency}ms`);
    });

    ws.on('message', async (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        // 认证成功后开始发消息
        if (msg.type === 'authenticated') {
          console.log(`     WS 认证: ✓ (userId: ${msg.userId})`);
          // 发 10 条消息，记录发送时间
          for (let i = 0; i < MSG_COUNT; i++) {
            const marker = `ws-bench-${Date.now()}-${i}`;
            sentTimestamps.set(marker, performance.now());
            await http('POST', `/api/im/direct/${receiver.id}/messages`, { content: marker }, sender.token);
            msgsSent++;
          }
          console.log(`     已发送: ${msgsSent} 条消息`);
        }
        // 收到消息事件
        if (msg.type === 'message.new' && msg.content?.startsWith('ws-bench-')) {
          const sendTime = sentTimestamps.get(msg.content);
          if (sendTime) {
            const delivery = Math.round(performance.now() - sendTime);
            deliveryLatencies.push(delivery);
          }
          if (deliveryLatencies.length >= MSG_COUNT) {
            clearTimeout(timeout);
            ws.close();
            const r = m(
              `B9 WebSocket (connect + ${deliveryLatencies.length}/${MSG_COUNT} events)`,
              [...l, ...deliveryLatencies],
              e,
              performance.now() - t0,
              {
                连接延迟: `${connectLatency}ms`,
                '投递延迟 avg': `${Math.round(deliveryLatencies.reduce((a, b) => a + b, 0) / deliveryLatencies.length)}ms`,
                '投递延迟 P95': `${pct(
                  [...deliveryLatencies].sort((a, b) => a - b),
                  95,
                )}ms`,
                事件接收: `${deliveryLatencies.length}/${MSG_COUNT}`,
              },
            );
            show(r);
            resolve(r);
          }
        }
      } catch {}
    });

    ws.on('error', (err: Error) => {
      e.push('ws_error: ' + err.message.slice(0, 60));
    });

    ws.on('close', () => {
      if (deliveryLatencies.length < MSG_COUNT) {
        // timeout will handle resolution
      }
    });
  });
}

// ═══════════════════════════════════════════════════════
// B10: SSE 流事件投递
// ═══════════════════════════════════════════════════════
async function b10(agents: any[]): Promise<M> {
  console.log('\n── B10: SSE 流事件投递 ──');
  const l: number[] = [],
    e: string[] = [];
  const receiver = agents[2],
    sender = agents[3];
  const t0 = performance.now();

  // 尝试 SSE 连接
  const controller = new AbortController();
  let sseConnected = false;
  let eventsReceived = 0;

  try {
    const sseRes = await fetch(`${BASE}/api/im/sync/stream?token=${receiver.token}`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });

    if (sseRes.ok && sseRes.body) {
      sseConnected = true;
      l.push(Math.round(performance.now() - t0));

      // 发 5 条消息触发事件
      for (let i = 0; i < 5; i++) {
        await http('POST', `/api/im/direct/${receiver.id}/messages`, { content: `SSE-${i}` }, sender.token);
      }

      // 读 5 秒
      const reader = sseRes.body.getReader();
      const dec = new TextDecoder();
      const readStart = performance.now();
      const readTimeout = setTimeout(() => controller.abort(), 5000);

      try {
        while (performance.now() - readStart < 5000) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = dec.decode(value);
          eventsReceived += (text.match(/data:/g) || []).length;
        }
      } catch {}
      clearTimeout(readTimeout);
    } else {
      e.push(`sse_status_${sseRes.status}`);
    }
  } catch (err: any) {
    if (!err.message?.includes('abort')) e.push('sse_connect_fail');
  }

  controller.abort();
  const r = m(
    `B10 SSE (${sseConnected ? 'connected' : 'unavailable'}, ${eventsReceived} events)`,
    l,
    e,
    performance.now() - t0,
    {
      SSE连接: sseConnected ? '✓' : '✗ (端点可能未部署)',
      事件数: eventsReceived,
    },
  );
  show(r);
  return r;
}

// ═══════════════════════════════════════════════════════
// B11: 数据一致性
// ═══════════════════════════════════════════════════════
async function b11(agents: any[]): Promise<M> {
  console.log('\n── B11: 数据一致性 ──');
  const l: number[] = [],
    e: string[] = [];
  const sender = agents[0],
    receiver = agents[1];
  const N = 50;
  const t0 = performance.now();

  // 快速写 50 条
  const msgIds: string[] = [];
  await pool(
    Array.from({ length: N }, (_, i) => async () => {
      const r = await http(
        'POST',
        `/api/im/direct/${receiver.id}/messages`,
        {
          content: `Consistency-${i}-${Date.now()}`,
          metadata: { seq: i },
        },
        sender.token,
      );
      if (r.ok) {
        l.push(r.ms);
        msgIds.push(r.d.data.message.id);
      } else e.push(`w${i}`);
    }),
    10,
  );

  console.log(`     写入: ${msgIds.length}/${N}`);

  // 等 2s 让跨实例同步
  await new Promise((r) => setTimeout(r, 2000));

  // 从 receiver 视角分 3 次读取（命中不同 pod 的概率更高）
  let totalFound = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const hist = await http('GET', `/api/im/direct/${sender.id}/messages?limit=100`, undefined, receiver.token);
    if (hist.ok && Array.isArray(hist.d?.data)) {
      l.push(hist.ms);
      const ids = new Set(hist.d.data.map((m: any) => m.id));
      let found = 0;
      for (const id of msgIds) if (ids.has(id)) found++;
      totalFound = Math.max(totalFound, found);
    } else e.push('read');
  }

  const consistency = msgIds.length > 0 ? Math.round((totalFound / msgIds.length) * 100) : 0;
  console.log(`     一致性: ${totalFound}/${msgIds.length} (${consistency}%)`);
  if (totalFound < msgIds.length) e.push(`missing: ${msgIds.length - totalFound}`);

  // 顺序验证
  const hist2 = await http('GET', `/api/im/direct/${receiver.id}/messages?limit=100`, undefined, sender.token);
  if (hist2.ok && Array.isArray(hist2.d?.data)) {
    l.push(hist2.ms);
    const seqMsgs = hist2.d.data.filter((m: any) => m.content?.startsWith('Consistency-'));
    // API 返回 oldest-first，验证时间递增
    let ordered = true;
    for (let i = 1; i < seqMsgs.length; i++) {
      if (new Date(seqMsgs[i - 1].createdAt) > new Date(seqMsgs[i].createdAt)) {
        ordered = false;
        break;
      }
    }
    console.log(`     顺序: ${ordered ? '✓ 正确 (oldest-first)' : '✗ 乱序'}`);
    if (!ordered) e.push('ordering');
  }

  const r = m(`B11 一致性 (write×${N} + 3×cross-read, 4实例)`, l, e, performance.now() - t0, {
    一致性: `${consistency}%`,
  });
  show(r);
  return r;
}

// ═══════════════════════════════════════════════════════
// B12: 极限压测
// ═══════════════════════════════════════════════════════
async function b12(agents: any[]): Promise<M> {
  console.log('\n── B12: 极限压测 ──');
  const N = 500,
    l: number[] = [],
    e: string[] = [];
  const tasks: (() => Promise<void>)[] = [];

  for (let i = 0; i < N; i++) {
    const a = agents[i % agents.length];
    const op = i % 5;
    switch (op) {
      case 0: // 写消息
        const recv = agents[(i + 1) % agents.length];
        tasks.push(async () => {
          const r = await http('POST', `/api/im/direct/${recv.id}/messages`, { content: `S${i}` }, a.token);
          r.ok ? l.push(r.ms) : e.push('w');
        });
        break;
      case 1: // 读会话
        tasks.push(async () => {
          const r = await http('GET', '/api/im/conversations', undefined, a.token);
          r.ok ? l.push(r.ms) : e.push('r');
        });
        break;
      case 2: // 读联系人
        tasks.push(async () => {
          const r = await http('GET', '/api/im/contacts', undefined, a.token);
          r.ok ? l.push(r.ms) : e.push('c');
        });
        break;
      case 3: // /me
        tasks.push(async () => {
          const r = await http('GET', '/api/im/me', undefined, a.token);
          r.ok ? l.push(r.ms) : e.push('m');
        });
        break;
      case 4: // discover
        tasks.push(async () => {
          const r = await http('GET', '/api/im/discover', undefined, a.token);
          r.ok ? l.push(r.ms) : e.push('d');
        });
        break;
    }
  }

  const t0 = performance.now();
  await pool(tasks, 80);
  const writes = tasks.length / 5; // ~20% writes
  const r = m(
    `B12 极限压测 (${N} ops, ~${Math.round(writes)}w/${N - Math.round(writes)}r, c=80)`,
    l,
    e,
    performance.now() - t0,
  );
  show(r);
  return r;
}

// ═══════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════
async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  Prismer IM Full Performance Benchmark — Production      ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log(`  Target:    ${BASE}`);
  console.log(`  Time:      ${new Date().toISOString()}`);

  const health = await http('GET', '/api/im/health');
  console.log(`  Server:    v${health.d?.version} | ${health.d?.stats?.onlineUsers ?? '?'} online`);
  console.log(`  Instances: 4 pods (EKS K8s)\n`);

  console.log('  Setting up 30 test agents...');
  const agents = await setup(30);
  console.log(`  ✓ ${agents.length} agents ready\n`);

  if (agents.length < 10) {
    console.error('Not enough agents');
    process.exit(1);
  }

  const results: M[] = [];
  results.push(await b1());
  results.push(await b2(agents));
  results.push(await b3(agents));
  results.push(await b4(agents));
  results.push(await b5(agents));
  results.push(await b6(agents));
  results.push(await b7(agents));
  results.push(await b8(agents));
  results.push(await b9(agents));
  results.push(await b10(agents));
  results.push(await b11(agents));
  results.push(await b12(agents));

  // Summary table
  console.log('\n╔════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║  Summary                                                                       ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  console.log('║  #   Benchmark            Total  OK  Fail  Avg    P50    P95    P99    RPS    ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════════╣');
  for (const r of results) {
    const num = r.name.match(/B(\d+)/)?.[1] || '?';
    const label = r.name
      .replace(/B\d+\s+/, '')
      .split('(')[0]
      .trim()
      .slice(0, 18)
      .padEnd(18);
    const ok = r.failed === 0 ? '✅' : r.failed < r.total * 0.05 ? '⚠️' : '❌';
    console.log(
      `║  ${ok} ${num.padStart(2)} ${label} ${String(r.total).padStart(5)} ${String(r.success).padStart(4)} ${String(r.failed).padStart(4)}  ${(r.avg + 'ms').padStart(6)} ${(r.p50 + 'ms').padStart(6)} ${(r.p95 + 'ms').padStart(6)} ${(r.p99 + 'ms').padStart(6)} ${String(r.rps).padStart(6)}  ║`,
    );
  }
  console.log('╚════════════════════════════════════════════════════════════════════════════════╝');

  // Save JSON
  const fs = await import('fs');
  fs.writeFileSync(
    'docs/benchmark/results.json',
    JSON.stringify(
      {
        target: BASE,
        timestamp: new Date().toISOString(),
        server: health.d,
        results: results.map((r) => ({ ...r, extra: r.extra || {} })),
      },
      null,
      2,
    ),
  );
  console.log('\n→ docs/benchmark/results.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
