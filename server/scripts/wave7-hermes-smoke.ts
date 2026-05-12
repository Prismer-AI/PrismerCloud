// Wave-7 Hermes UI smoke (operator-driven).
//
// Boots the full chain the operator will exercise in /workspace:
//   user JWT → register Hermes agent bound to local daemon →
//   open direct conversation → send message → watch task SSE for
//   thinking/executing events → wait for Hermes reply.
//
// This script does NOT touch UI. It validates the wire chain so when
// the operator opens the browser the same dispatch path is known good.
//
// Run:
//   PRISMER_TOKEN=eyJ... PRISMER_API_KEY=sk-prismer-live-... \
//   PRISMER_DAEMON_ID=daemon-... \
//   npx tsx scripts/wave7-hermes-smoke.ts

const CLOUD = process.env.PRISMER_CLOUD ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.PRISMER_TOKEN;
const API_KEY = process.env.PRISMER_API_KEY;
const DAEMON_ID = process.env.PRISMER_DAEMON_ID;

if (!TOKEN || !API_KEY || !DAEMON_ID) {
  console.error('missing PRISMER_TOKEN / PRISMER_API_KEY / PRISMER_DAEMON_ID env');
  process.exit(2);
}

const tag = Date.now().toString(36);
const username = `hermes-smoke-${tag}`.slice(0, 32);
const tokenSentinel = `SMOKE-${tag}`;

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${CLOUD}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: ApiEnvelope<T>;
  try {
    body = text ? (JSON.parse(text) as ApiEnvelope<T>) : { ok: res.ok };
  } catch {
    throw new Error(`${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok || body.ok === false) {
    throw new Error(
      `${path} HTTP ${res.status} ${body.error?.code ?? ''} ${body.error?.message ?? text.slice(0, 200)}`,
    );
  }
  return body.data as T;
}

async function getDefaultWorkspace(): Promise<string> {
  const list = await api<Array<{ id: string; isDefault?: boolean }>>('/api/im/workspaces');
  const ws = list.find((w) => w.isDefault) ?? list[0];
  if (!ws) throw new Error('no workspace');
  return ws.id;
}

async function getMe(): Promise<{ imUserId: string }> {
  const data = await api<{ user: { id: string } }>('/api/im/me');
  return { imUserId: data.user.id };
}

async function registerHermesAgent(workspaceId: string, daemonId: string): Promise<string> {
  const port = 44_000 + Math.floor(Math.random() * 10_000);
  const apiKey = `hermes-smoke-key-${tag}`;
  const reg = await api<{ imUserId: string }>('/api/im/register', {
    method: 'POST',
    body: JSON.stringify({
      type: 'agent',
      username,
      displayName: `Hermes Smoke ${tag}`,
      description: 'Wave-7 hermes UI smoke',
      agentType: 'orchestrator',
      workspaceId,
      adapter: 'hermes',
      daemonId,
    }),
  });
  // /api/im/agent_profiles is the canonical write that fires
  // ServerEvents.agentProfileChanged → daemon syncProfileFromCloud.
  await api('/api/im/agent_profiles', {
    method: 'POST',
    body: JSON.stringify({
      workspaceId,
      agentImUserId: reg.imUserId,
      adapterName: 'hermes',
      name: 'default',
      config: {
        systemPrompt: 'You are a smoke-test agent. Reply tersely.',
        hermesProfileName: `prismer-smoke-${tag}`,
        port,
        apiKey,
        autoStart: true,
        startupTimeoutMs: 30_000,
        configurePrismerProvider: true,
        model: 'us-kimi-k2.5',
        prismerProviderName: 'prismer',
      },
    }),
  });
  return reg.imUserId;
}

async function waitForLocalHostedAgent(agentImUserId: string, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:3210/agents', { signal: AbortSignal.timeout(2_000) });
      if (res.ok) {
        const body = (await res.json()) as { agents?: Array<{ imUserId: string; adapterName: string }> };
        if ((body.agents ?? []).some((a) => a.imUserId === agentImUserId)) return;
      }
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`daemon did not host agent ${agentImUserId} within ${budgetMs}ms`);
}

async function openDirectConversation(workspaceId: string, otherImUserId: string): Promise<string> {
  const data = await api<{ id: string }>('/api/im/conversations/direct', {
    method: 'POST',
    body: JSON.stringify({ workspaceId, otherUserId: otherImUserId }),
  });
  return data.id;
}

async function sendMessage(conversationId: string, content: string): Promise<void> {
  await api(`/api/im/messages/${conversationId}`, {
    method: 'POST',
    body: JSON.stringify({ content, type: 'text' }),
  });
}

interface SseEvent {
  type: string;
  ts: number;
  payload: Record<string, unknown>;
}

async function streamTasksSSE(conversationId: string, abort: AbortSignal): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const url = `${CLOUD}/api/im/tasks/events?token=${encodeURIComponent(TOKEN!)}`;
  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream' },
    signal: abort,
  });
  if (!res.ok || !res.body) throw new Error(`tasks SSE failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (!abort.aborted) {
    const { value, done } = await reader.read().catch((err) => {
      if (abort.aborted) return { value: undefined, done: true } as const;
      throw err;
    });
    if (done) break;
    if (!value) continue;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      const eventLine = frame.match(/^event: (.+)$/m);
      const dataLine = frame.match(/^data: (.+)$/m);
      if (!eventLine || !dataLine) continue;
      const type = eventLine[1]!;
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(dataLine[1]!);
      } catch {
        continue;
      }
      if (type === 'ping' || type === 'connected') continue;
      events.push({ type, ts: Date.now(), payload });
      // Console mirror so it's visible during runs.
      const cid = payload.conversationId ?? '<no-cid>';
      const status = payload.statusMessage ?? '';
      console.log(
        `  · ${type.padEnd(20)} cid=${String(cid).slice(-10)} ${status ? `msg="${String(status).slice(0, 80)}"` : ''}`,
      );
      if (type === 'task.completed' || type === 'task.failed' || type === 'task.cancelled') {
        if (payload.conversationId === conversationId) return events;
      }
    }
  }
  return events;
}

async function waitForReply(
  conversationId: string,
  agentImUserId: string,
  sentinel: string,
  budgetMs: number,
): Promise<string> {
  const deadline = Date.now() + budgetMs;
  let last = '';
  while (Date.now() < deadline) {
    type MsgList = Array<{ id: string; content: string; senderId: string; createdAt: string }>;
    const raw = await api<MsgList | { messages: MsgList }>(`/api/im/messages/${conversationId}?limit=20`);
    const messages: MsgList = Array.isArray(raw) ? raw : (raw?.messages ?? []);
    last = messages.map((m) => `${m.senderId.slice(-6)}:${m.content.slice(0, 40)}`).join(' | ');
    const hit = messages.find((m) => m.senderId === agentImUserId && m.content.includes(sentinel));
    if (hit) return hit.content;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`agent reply with sentinel ${sentinel} not seen within ${budgetMs}ms; last=${last}`);
}

async function main(): Promise<void> {
  console.log(`[smoke ${tag}] CLOUD=${CLOUD} DAEMON=${DAEMON_ID}`);
  const workspaceId = await getDefaultWorkspace();
  const me = await getMe();
  console.log(`[smoke ${tag}] workspace=${workspaceId} me=${me.imUserId}`);
  const agentImUserId = await registerHermesAgent(workspaceId, DAEMON_ID!);
  console.log(`[smoke ${tag}] hermes agent registered imUserId=${agentImUserId}`);
  await waitForLocalHostedAgent(agentImUserId, 30_000);
  console.log(`[smoke ${tag}] daemon hosts agent`);
  const conversationId = await openDirectConversation(workspaceId, agentImUserId);
  console.log(`[smoke ${tag}] direct conversation=${conversationId}`);

  const ctrl = new AbortController();
  const ssePromise = streamTasksSSE(conversationId, ctrl.signal).catch((err) => {
    if (!ctrl.signal.aborted) console.error(`[smoke ${tag}] SSE error: ${(err as Error).message}`);
    return [] as SseEvent[];
  });
  // Give SSE a moment to attach.
  await new Promise((r) => setTimeout(r, 500));

  const prompt = `Reply with exactly: ${tokenSentinel}`;
  console.log(`[smoke ${tag}] send: ${prompt}`);
  await sendMessage(conversationId, prompt);

  const reply = await Promise.race([
    waitForReply(conversationId, agentImUserId, tokenSentinel, 180_000),
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error('reply timeout 180s')), 180_000)),
  ]);
  console.log(`[smoke ${tag}] reply: ${reply.slice(0, 200)}`);

  // Allow ~3s post-reply for task.completed SSE to fan out before we close the stream.
  await new Promise((r) => setTimeout(r, 3_000));
  ctrl.abort();
  const events = await ssePromise;

  // Verdict.
  const ours = events.filter((e) => e.payload.conversationId === conversationId);
  const types = new Set(ours.map((e) => e.type));
  const expected = ['task.created', 'task.assigned', 'task.completed'];
  const missing = expected.filter((t) => !types.has(t));
  console.log(`\n[smoke ${tag}] events for conversation: ${ours.length}`);
  console.log(`[smoke ${tag}] types seen: ${[...types].join(', ')}`);
  if (missing.length) {
    console.error(`[smoke ${tag}] FAIL: missing event types ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!ours.every((e) => typeof e.payload.conversationId === 'string')) {
    console.error(`[smoke ${tag}] FAIL: some events missing conversationId`);
    process.exit(1);
  }
  console.log(`[smoke ${tag}] PASS: SSE typed events carry conversationId, reply contains ${tokenSentinel}`);
}

main().catch((err) => {
  console.error(`[smoke ${tag}] ERROR: ${(err as Error).message}`);
  process.exit(1);
});
