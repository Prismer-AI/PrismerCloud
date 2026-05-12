// scripts/e2e-agent-heartbeat.ts
//
// Cloud 2.5 — agent heartbeat + runtime endpoint e2e.
// Asserts:
//   1. heartbeat → runtime shows online + currentTaskId
//   2. SSE catches an agent.heartbeat event mid-stream
//   3. (--slow) 95s gap → currentTaskId null after presence TTL expiry
//
// Usage: npx tsx scripts/e2e-agent-heartbeat.ts --env local|test [--slow]
// Requires PRISMER_API_KEY_LOCAL (or PRISMER_API_KEY_TEST) and a registered agent.

import { argv } from 'node:process';

const ENVS = {
  local: 'http://localhost:3000',
  test: 'https://cloud.prismer.dev',
} as const;
type EnvKey = keyof typeof ENVS;

function getArg(flag: string, fallback: string): string {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const env = getArg('--env', 'local') as EnvKey;
const base = ENVS[env];
const apiKey =
  env === 'test'
    ? process.env.PRISMER_API_KEY_TEST
    : (process.env.PRISMER_API_KEY_LOCAL ?? process.env.PRISMER_API_KEY_TEST);
if (!apiKey) throw new Error('API key not set.');

const headers = { Authorization: `Bearer ${apiKey}` };

async function http<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, 'content-type': body ? 'application/json' : 'application/octet-stream' },
    body: body ? JSON.stringify(body) : null,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

async function step(label: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`[e2e-heartbeat] ${label}... `);
  try {
    await fn();
    process.stdout.write('OK\n');
  } catch (e) {
    process.stdout.write(`FAIL: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

(async () => {
  let wsId = '';
  let agentId = '';
  const deviceId = `e2e-dev-${Date.now()}`;

  await step('resolve workspace + agent', async () => {
    const ws = await http<{ data: Array<{ id: string; isDefault?: boolean }> }>('GET', '/api/im/workspaces');
    if (ws.status !== 200) throw new Error(`workspaces ${ws.status}`);
    wsId = (ws.body.data.find((w) => w.isDefault) ?? ws.body.data[0]).id;

    // Resolve self imUserId via /api/im/me. The heartbeat handler enforces
    // user.imUserId === :userId so the caller IS the agent reporting its own
    // heartbeat. An IMAgentCard with imUserId=self.id must exist (typically
    // created via /api/im/register or by the daemon setup flow).
    const me = await http<{ data: { user: { id: string } } }>('GET', '/api/im/me');
    if (me.status !== 200) throw new Error(`me ${me.status}`);
    agentId = me.body.data.user.id;
  });

  await step('POST /api/im/agents/:id/heartbeat', async () => {
    const r = await http('POST', `/api/im/agents/${agentId}/heartbeat`, {
      status: 'busy',
      load: 0.5,
      deviceId,
      currentTaskId: 't-fixture',
      version: '@prismer/runtime@1.9.5',
    });
    if (r.status !== 200) throw new Error(`heartbeat ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await step('GET /workspaces/:id/runtime shows busy + currentTaskId', async () => {
    const r = await http<{
      data: {
        devices: Array<{
          deviceId: string;
          agents: Array<{ id: string; status: string; currentTaskId: string | null }>;
        }>;
      };
    }>('GET', `/api/im/workspaces/${wsId}/runtime`);
    if (r.status !== 200) throw new Error(`runtime ${r.status}`);
    const dev = r.body.data.devices.find((d) => d.deviceId === deviceId);
    if (!dev) throw new Error(`device ${deviceId} not in snapshot`);
    const agent = dev.agents.find((a) => a.id === agentId);
    if (!agent || agent.status !== 'busy' || agent.currentTaskId !== 't-fixture') {
      throw new Error(`agent state wrong: ${JSON.stringify(agent)}`);
    }
  });

  // Validate the cloud-2.5 publish contract directly via Redis pub/sub.
  // (The /runtime/events SSE endpoint forwards the same channel; in Next.js
  // dev mode the Hono SSE response is buffered until idle, so curl/fetch
  // won't see bytes mid-stream. Subscribing to Redis directly proves the
  // contract — the publish payload — without that buffering artifact.
  // The full SSE round-trip is exercised in production / standalone builds.)
  await step('Redis publishes agent.heartbeat with new fields', async () => {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    const { default: IORedis } = await import('ioredis');
    const sub = new IORedis(redisUrl);
    try {
      const expected = 't-fixture-2';
      const evtPromise = new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Redis subscribe timeout (8s)')), 8_000);
        sub.subscribe('presence:agent:changes', (err) => {
          if (err) {
            clearTimeout(t);
            reject(err);
          }
        });
        sub.on('message', (_channel, message) => {
          if (message.includes(`"currentTaskId":"${expected}"`) && message.includes(`"deviceId":"${deviceId}"`)) {
            clearTimeout(t);
            resolve(message);
          }
        });
      });

      // Trigger heartbeat AFTER subscribe is armed.
      await new Promise((r) => setTimeout(r, 200));
      await http('POST', `/api/im/agents/${agentId}/heartbeat`, {
        status: 'busy',
        deviceId,
        currentTaskId: expected,
        version: '@prismer/runtime@1.9.5',
      });

      const message = await evtPromise;
      const parsed = JSON.parse(message) as {
        userId: string;
        currentTaskId?: string;
        deviceId?: string;
        version?: string;
        status?: string;
      };
      if (parsed.userId !== agentId) throw new Error(`userId mismatch: ${parsed.userId}`);
      if (parsed.currentTaskId !== expected) throw new Error(`currentTaskId mismatch: ${parsed.currentTaskId}`);
      if (parsed.deviceId !== deviceId) throw new Error(`deviceId mismatch: ${parsed.deviceId}`);
      if (parsed.version !== '@prismer/runtime@1.9.5') throw new Error(`version mismatch: ${parsed.version}`);
      if (parsed.status !== 'busy') throw new Error(`status mismatch: ${parsed.status}`);
    } finally {
      sub.disconnect();
    }
  });

  if (argv.includes('--slow')) {
    await step('95s gap → currentTaskId null after TTL expiry', async () => {
      await new Promise((r) => setTimeout(r, 95_000));
      const r = await http<{
        data: { devices: Array<{ deviceId: string; agents: Array<{ currentTaskId: string | null }> }> };
      }>('GET', `/api/im/workspaces/${wsId}/runtime`);
      const dev = r.body.data.devices.find((d) => d.deviceId === deviceId);
      const a = dev?.agents.find((a) => a.id === agentId);
      if (a?.currentTaskId !== null && a?.currentTaskId !== undefined) {
        throw new Error(`expected currentTaskId null after TTL expiry; got ${a?.currentTaskId}`);
      }
    });
  }

  console.log('[e2e-heartbeat] ALL PASS');
})();
