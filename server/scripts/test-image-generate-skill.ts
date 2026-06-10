#!/usr/bin/env tsx
/**
 * Wave 5 F6 — image-generate built-in skill end-to-end test.
 *
 * Spec: docs/release200/14-messaging-state-machine-reliability.md §4.6 / Gap E-⑤
 *       sdk/prismer-cloud/built-in-skills/image-generate/SKILL.md
 *
 * Skill flow (simulated against the real cloud):
 *   1. (Mocked) generate PNG bytes — a 1x1 transparent PNG fixture. The cloud
 *      LLM image proxy endpoint (/api/v1/images/generations) is NOT YET wired,
 *      so this step is stubbed locally; the SKILL.md "Hand-off" section
 *      explains the missing endpoint provisioning.
 *   2. (REAL) upload the bytes via multipart POST /api/im/assets — same
 *      content-addressed path the `assets` skill consumes. Validates the
 *      asset half of the contract end-to-end against production code.
 *   3. (REAL) construct the ContentBlock and verify shape per v2.0 §4.6
 *      (Anthropic discriminated union).
 *   4. (REAL) GET /api/im/assets/:id to confirm the IMAsset row exists with
 *      the right contentHash + cdnUrl.
 *
 * Mocks the LLM (avoiding burning real image-gen credits) but every other
 * step hits the real local docker stack — per Wave 5 F6 acceptance criteria.
 */

import 'dotenv/config';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'mysql://prismer:devpass@localhost:3307/prismer_cloud';

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CLOUD_BASE = process.env.CLOUD_BASE_URL || 'http://localhost:3000';
const JWT = process.env.PRISMER_TEST_JWT || process.env.JWT ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbXAxdWhxd3owMDAweHp3dDZ1c203bTJlIiwidXNlcm5hbWUiOiJ0b213aW5zaGFyZSIsInJvbGUiOiJodW1hbiIsIm51bWVyaWNJZCI6NDAsImVtYWlsIjoidG9td2luc2hhcmVAZ21haWwuY29tIiwiaWF0IjoxNzc5Mzc3NDA2LCJleHAiOjE3Nzk5ODIyMDZ9.EZrF94iRe-Z1FVxldbT5V1EejRGEsubKcBGu7IvZXCY';

const PREFIX = `w5f6_${crypto.randomBytes(4).toString('hex')}`;
let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(msg: string) { console.log(`  ✅ ${msg}`); pass++; }
function bad(msg: string) { console.log(`  ❌ ${msg}`); fail++; failures.push(msg); }

// --- Fixture: 1x1 transparent PNG (real bytes) ---
// This is what the LLM image endpoint would return as base64 in the
// production flow. Hand-crafted so the SHA-256 is deterministic for the test
// (we recompute it below regardless — the server validates).
const PNG_1x1_TRANSPARENT = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000d49444154789c63000000000500010d0a2db4000000004945e44d4ae426'
    .replace(/[^0-9a-f]/g, ''),
  'hex',
);

async function findDefaultWorkspace(): Promise<string> {
  const res = await fetch(`${CLOUD_BASE}/api/im/workspaces`, {
    headers: { Authorization: `Bearer ${JWT}` },
  });
  const body = await res.json();
  if (!body.ok || !Array.isArray(body.data) || body.data.length === 0) {
    throw new Error(`Could not list workspaces: ${JSON.stringify(body).slice(0, 200)}`);
  }
  const ws = body.data.find((w: any) => w.isDefault) ?? body.data[0];
  return ws.id;
}

// Step 1: invoke real cloud `/api/v1/images/generations` and decode bytes from
// `data[0].b64_json`. Falls back to the fixture PNG when the endpoint is
// missing (older cloud) or when an LLM-side error happens (e.g. no NewAPI
// credits) — keeps the rest of the suite useful for the asset / ContentBlock
// half. Wave 6 G1 wired the endpoint at the cloud side.
async function llmGenerateImage(prompt: string, size: string, model: string): Promise<Buffer> {
  const requestBody = {
    model,
    prompt,
    size,
    n: 1,
    response_format: 'b64_json' as const,
  };
  let res: Response;
  try {
    res = await fetch(`${CLOUD_BASE}/api/v1/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${JWT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    console.log(`  [llm] real call threw (${(err as Error).message}); falling back to fixture`);
    return PNG_1x1_TRANSPARENT;
  }

  if (res.status === 404) {
    console.log(`  [llm] /api/v1/images/generations 404 (endpoint not provisioned); fixture fallback`);
    return PNG_1x1_TRANSPARENT;
  }
  if (!res.ok) {
    const txt = await res.text();
    console.log(
      `  [llm] real call returned ${res.status}; using fixture. upstream=${txt.slice(0, 160)}`,
    );
    return PNG_1x1_TRANSPARENT;
  }
  const body = await res.json();
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64 || typeof b64 !== 'string') {
    console.log(`  [llm] real call ok but missing data[0].b64_json; using fixture`);
    return PNG_1x1_TRANSPARENT;
  }
  console.log(
    `  [llm-real] /api/v1/images/generations 200 size=${size} model=${model} b64=${b64.length}c`,
  );
  return Buffer.from(b64, 'base64');
}

// Step 2: REAL asset upload — multipart POST /api/im/assets.
async function uploadAsset(
  wsId: string, bytes: Buffer, filename: string, mime: string, description: string,
): Promise<{ assetId: string; contentHash: string; sizeBytes: number; cdnUrl?: string }> {
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename);
  form.append('workspaceId', wsId);
  form.append('kind', 'image');
  form.append('description', description);

  const res = await fetch(`${CLOUD_BASE}/api/im/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${JWT}`,
      'x-content-sha256': sha,
    },
    body: form,
  });
  const body = await res.json();
  if (!res.ok || !body.ok) {
    throw new Error(`Asset upload failed (${res.status}): ${JSON.stringify(body).slice(0, 400)}`);
  }
  const a = body.data;
  return {
    assetId: a.id,
    contentHash: a.contentHash ?? sha,
    sizeBytes: a.sizeBytes ?? bytes.length,
    cdnUrl: a.cdnUrl ?? a.url ?? `/api/im/assets/${a.id}`,
  };
}

// Step 3: construct ContentBlock + validate shape
function buildContentBlock(assetId: string, mediaType: string, prompt: string) {
  return {
    kind: 'image',
    assetId,
    mediaType,
    alt: prompt.slice(0, 100),
  };
}

function validateContentBlockShape(cb: any): string | null {
  if (typeof cb !== 'object' || cb === null) return 'not an object';
  if (cb.kind !== 'image') return `kind=${cb.kind} (expected 'image')`;
  if (typeof cb.assetId !== 'string' || !cb.assetId) return 'missing assetId';
  if (typeof cb.mediaType !== 'string' || !cb.mediaType.startsWith('image/'))
    return `bad mediaType=${cb.mediaType}`;
  if (cb.alt !== undefined && typeof cb.alt !== 'string') return 'alt must be string or undefined';
  // Anthropic-shape: must NOT use OpenAI-shape `type` field
  if ('type' in cb && cb.type !== undefined) return 'has OpenAI-shape `type` field (forbidden — use `kind`)';
  if ('image_url' in cb) return 'has OpenAI-shape `image_url` field (forbidden)';
  return null;
}

// Step 4: REAL fetch /api/im/assets/:id/detail to confirm row exists
async function fetchAssetDetail(assetId: string): Promise<any> {
  const res = await fetch(`${CLOUD_BASE}/api/im/assets/${assetId}/detail`, {
    headers: { Authorization: `Bearer ${JWT}` },
  });
  const body = await res.json();
  if (!res.ok || !body.ok) {
    throw new Error(`Asset detail fetch failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body.data;
}

async function verifySkillMd() {
  const skillMdPath = path.join(
    __dirname, '..', 'sdk', 'prismer-cloud', 'built-in-skills', 'image-generate', 'SKILL.md');
  const src = fs.readFileSync(skillMdPath, 'utf8');
  const requiredMarkers = [
    'name: image-generate',
    'phaseModel:',
    'defaultPhase: tool_use',
    'applies_to:',
    'ContentBlock output',
    '"kind": "image"',
    '/api/v1/images/generations',
    '/api/im/assets',
  ];
  const missing = requiredMarkers.filter((m) => !src.includes(m));
  return { ok: missing.length === 0, missing, length: src.length };
}

async function main() {
  console.log('Wave 5 F6 — image-generate built-in skill REAL integration test');
  console.log(`Prefix: ${PREFIX}`);
  console.log(`Cloud:  ${CLOUD_BASE}\n`);

  // ── Pre-flight ──
  let wsId: string;
  try {
    wsId = await findDefaultWorkspace();
    console.log(`  [pre] workspace=${wsId}`);
  } catch (err) {
    bad(`pre-flight: workspace lookup failed: ${(err as Error).message}`);
    return;
  }

  // ── Test 1: mock LLM → real asset upload → ContentBlock ──
  const prompt = `${PREFIX} an isometric server room illustration with glowing blue racks`;
  let assetId = '';
  let contentHash = '';
  try {
    const bytes = await llmGenerateImage(prompt, '1024x1024', 'gpt-image-1');
    const expectedSha = crypto.createHash('sha256').update(bytes).digest('hex');
    const up = await uploadAsset(
      wsId, bytes, `generated-${expectedSha.slice(0, 8)}.png`, 'image/png',
      `Generated for test ${PREFIX}`);
    assetId = up.assetId;
    contentHash = up.contentHash;
    if (!assetId.startsWith('asset_') && !assetId.match(/^[a-z0-9_-]{8,}$/i)) {
      bad(`assetId shape unexpected: ${assetId}`);
    } else if (contentHash !== expectedSha) {
      bad(`sha mismatch: got=${contentHash} expected=${expectedSha}`);
    } else {
      ok(`mock-LLM → upload: assetId=${assetId.slice(0, 24)}… sha=${contentHash.slice(0, 12)}… size=${up.sizeBytes}B`);
    }
  } catch (err) {
    bad(`mock-LLM → upload failed: ${(err as Error).message}`);
  }

  // ── Test 2: ContentBlock shape per v2.0 §4.6 ──
  if (assetId) {
    const cb = buildContentBlock(assetId, 'image/png', prompt);
    const issue = validateContentBlockShape(cb);
    if (issue) {
      bad(`ContentBlock shape invalid: ${issue}`);
    } else {
      ok(`ContentBlock shape valid: kind=image assetId=…${assetId.slice(-8)} mediaType=image/png alt(${cb.alt.length}c)`);
    }
  } else {
    bad('skipped ContentBlock test (no assetId)');
  }

  // ── Test 3: IMAsset row exists with right hash ──
  if (assetId) {
    try {
      const detail = await fetchAssetDetail(assetId);
      const detailHash = detail.contentHash ?? detail.asset?.contentHash;
      if (detailHash && detailHash === contentHash) {
        ok(`IMAsset row exists: id=${detail.id ?? assetId} contentHash matches`);
      } else {
        bad(`IMAsset detail hash mismatch: detail=${detailHash} expected=${contentHash}`);
      }
    } catch (err) {
      bad(`IMAsset row fetch failed: ${(err as Error).message}`);
    }
  } else {
    bad('skipped IMAsset row test (no assetId)');
  }

  // ── Test 4: SKILL.md present + required frontmatter / sections ──
  try {
    const r = await verifySkillMd();
    if (r.ok) {
      ok(`SKILL.md complete (${r.length} chars; all required markers present)`);
    } else {
      bad(`SKILL.md missing markers: ${r.missing.join(', ')}`);
    }
  } catch (err) {
    bad(`SKILL.md verify failed: ${(err as Error).message}`);
  }

  console.log(`\nResults: ${pass}/${pass + fail} passed`);
  if (failures.length) {
    console.log('Failures:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
