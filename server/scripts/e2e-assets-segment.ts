// scripts/e2e-assets-segment.ts
//
// Cloud 2.5 — Asset upload e2e for photo-memory-segment metadata convention.
// Round-trip: workspace → upload segment → list → detail → DELETE → 410.
// Usage: npx tsx scripts/e2e-assets-segment.ts --env local|test|prod

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

const env = getArg('--env', 'local') as EnvKey;
const base = ENVS[env];
if (!base) throw new Error(`unknown env: ${env}`);

const apiKey =
  env === 'prod'
    ? process.env.PRISMER_API_KEY
    : env === 'test'
      ? process.env.PRISMER_API_KEY_TEST
      : (process.env.PRISMER_API_KEY_LOCAL ?? process.env.PRISMER_API_KEY_TEST);
if (!apiKey) throw new Error('missing API key for env (set PRISMER_API_KEY*).');

const headers = { Authorization: `Bearer ${apiKey}` };

async function http(
  method: string,
  path: string,
  body?: BodyInit,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...extraHeaders }, body });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

async function step(label: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`[e2e-assets] ${label}... `);
  try {
    await fn();
    process.stdout.write('OK\n');
  } catch (err) {
    process.stdout.write(`FAIL\n  ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

(async () => {
  let workspaceId = '';
  await step('resolve default workspace', async () => {
    const r = await http('GET', '/api/im/workspaces');
    if (r.status !== 200) throw new Error(`workspaces ${r.status}: ${JSON.stringify(r.body)}`);
    const data = (r.body as { data: Array<{ id: string; isDefault?: boolean }> }).data;
    const def = data.find((w) => w.isDefault) ?? data[0];
    if (!def) throw new Error('no workspace');
    workspaceId = def.id;
  });

  let assetId = '';
  let contentHash = '';
  const segmentBody = `# Photo Memory Segment ${Date.now()}\n\nE2E fixture content. ${Math.random().toString(36).slice(2)}\n`;
  const segmentMeta = {
    kind: 'photo-memory-segment',
    segmentId: `seg-e2e-${Date.now()}`,
    dateRangeStart: '2026-04-01T00:00:00Z',
    dateRangeEnd: '2026-04-30T23:59:59Z',
    photoCount: 100,
    photoRefs: [{ localId: 'PHAsset-fixture-1', sourceHash: 'sha256-fixture' }],
    bidirectional: true,
  };
  await step('POST /api/im/assets (segment)', async () => {
    const form = new FormData();
    form.append('workspaceId', workspaceId);
    form.append('kind', 'photo-memory-segment');
    form.append('metadata', JSON.stringify(segmentMeta));
    form.append('file', new Blob([segmentBody], { type: 'text/markdown' }), 'segment.md');
    const r = await http('POST', '/api/im/assets', form);
    if (r.status !== 200 && r.status !== 201) {
      throw new Error(`upload ${r.status}: ${JSON.stringify(r.body)}`);
    }
    const data = (r.body as { data: { id: string; contentHash: string } }).data;
    assetId = data.id;
    contentHash = data.contentHash;
  });

  await step('GET list filtered by kind', async () => {
    const r = await http('GET', `/api/im/assets?workspaceId=${workspaceId}&kind=photo-memory-segment`);
    if (r.status !== 200) throw new Error(`list ${r.status}: ${JSON.stringify(r.body)}`);
    const items = (r.body as { data: Array<{ id: string }> }).data;
    if (!items.find((it) => it.id === assetId)) throw new Error('uploaded asset missing from list');
  });

  await step('GET /:id/detail', async () => {
    const r = await http('GET', `/api/im/assets/${assetId}/detail`);
    if (r.status !== 200) throw new Error(`detail ${r.status}: ${JSON.stringify(r.body)}`);
    const data = (r.body as { data: { photoRefs: unknown[] | null; contentHash: string } }).data;
    if (!Array.isArray(data.photoRefs) || data.photoRefs.length !== 1) {
      throw new Error(`photoRefs missing: ${JSON.stringify(data.photoRefs)}`);
    }
    if (data.contentHash !== contentHash) throw new Error('hash mismatch');
  });

  await step('DELETE /:id', async () => {
    const r = await http('DELETE', `/api/im/assets/${assetId}`);
    if (r.status !== 200) throw new Error(`delete ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await step('GET /:id/detail after DELETE → 410', async () => {
    const r = await http('GET', `/api/im/assets/${assetId}/detail`);
    if (r.status !== 410 && r.status !== 404) {
      throw new Error(`expected 410/404, got ${r.status}: ${JSON.stringify(r.body)}`);
    }
  });

  await step('GET list excludes soft-deleted', async () => {
    const r = await http('GET', `/api/im/assets?workspaceId=${workspaceId}&kind=photo-memory-segment`);
    if (r.status !== 200) throw new Error(`list ${r.status}`);
    const items = (r.body as { data: Array<{ id: string }> }).data;
    if (items.find((it) => it.id === assetId)) throw new Error('soft-deleted asset still in list');
  });

  console.log('[e2e-assets] ALL PASS');
})();
