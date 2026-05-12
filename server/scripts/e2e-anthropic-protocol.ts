// scripts/e2e-anthropic-protocol.ts
//
// Cloud 2.5 — Anthropic protocol proxy e2e.
// Asserts:
//   1. POST /api/v1/messages non-stream returns 200 with content[0].text + usage
//   2. POST /api/v1/messages stream:true emits message_start ... message_stop SSE events
//
// Usage: npx tsx scripts/e2e-anthropic-protocol.ts --env local|test|prod
//
// Requires PRISMER_API_KEY (prod) / PRISMER_API_KEY_TEST (test) / PRISMER_API_KEY_LOCAL (local).

import { argv } from 'node:process';

const ENVS = {
  local: 'http://localhost:3000',
  test: 'https://cloud.prismer.dev',
  prod: 'https://prismer.cloud',
} as const;
type EnvKey = keyof typeof ENVS;

function getArg(flag: string, fallback: string): string {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const env = getArg('--env', 'test') as EnvKey;
const base = ENVS[env];
if (!base) throw new Error(`unknown env: ${env}`);

const apiKey =
  env === 'prod'
    ? process.env.PRISMER_API_KEY
    : env === 'test'
      ? process.env.PRISMER_API_KEY_TEST
      : (process.env.PRISMER_API_KEY_LOCAL ?? process.env.PRISMER_API_KEY_TEST);
if (!apiKey) throw new Error('API key not set.');

const MODEL = process.env.ANTHROPIC_TEST_MODEL || 'claude-haiku-4-5';

async function step(label: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`[e2e-anthropic] ${label}... `);
  try {
    await fn();
    process.stdout.write('OK\n');
  } catch (e) {
    process.stdout.write(`FAIL: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

(async () => {
  await step('POST /v1/messages non-stream', async () => {
    const res = await fetch(`${base}/api/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Reply with exactly the word OK.' }],
      }),
    });
    if (res.status !== 200) {
      throw new Error(`status ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as {
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number };
    };
    if (!Array.isArray(body.content) || !body.content[0]?.text) {
      throw new Error(`missing content[0].text: ${JSON.stringify(body).slice(0, 200)}`);
    }
    if (typeof body.usage?.input_tokens !== 'number') {
      throw new Error(`usage missing: ${JSON.stringify(body.usage)}`);
    }
  });

  await step('POST /v1/messages stream:true', async () => {
    const res = await fetch(`${base}/api/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'Reply with exactly the word OK.' }],
      }),
    });
    if (res.status !== 200) throw new Error(`status ${res.status}: ${await res.text()}`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value);
    }
    if (!raw.includes('event: message_start')) {
      throw new Error(`no message_start in stream: ${raw.slice(0, 200)}`);
    }
    if (!raw.includes('event: message_stop')) {
      throw new Error(`no message_stop in stream: ${raw.slice(-200)}`);
    }
  });

  console.log('[e2e-anthropic] ALL PASS');
})();
