#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ALLOWED_SIZES = new Set(['256x256', '512x512', '1024x1024', '1792x1024', '1024x1792']);
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

function usage() {
  return [
    'Usage: node scripts/generate-and-deliver.mjs --prompt <text> [options]',
    '',
    'Options:',
    '  --size <WxH>       Default: 1024x1024',
    '  --model <id>       Default: IMAGE_GEN_MODEL or deployment priority',
    '  --output <path>    Default: $PRISMER_ARTIFACTS_DIR/generated-<sha8>.<ext> (or cwd)',
    '  --base-url <url>   Default: Prismer runtime env/config',
    '  --help',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { size: '1024x1024' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--prompt') out.prompt = argv[++i];
    else if (arg === '--size') out.size = argv[++i];
    else if (arg === '--model') out.model = argv[++i];
    else if (arg === '--output') out.output = argv[++i];
    else if (arg === '--base-url') out.baseUrl = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.help && (typeof out.prompt !== 'string' || out.prompt.trim().length === 0)) {
    throw new Error('--prompt is required');
  }
  if (!out.help && out.prompt.length > 4000) throw new Error('--prompt must be at most 4000 characters');
  if (!out.help && !ALLOWED_SIZES.has(out.size)) throw new Error(`Unsupported --size: ${out.size}`);
  return out;
}

async function readRuntimeConfig() {
  const root = process.env.PRISMER_HOME || join(homedir(), '.prismer');
  try {
    const raw = await readFile(join(root, 'config.toml'), 'utf8');
    const value = (keys) => {
      for (const key of keys) {
        const match = raw.match(new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']`, 'm'));
        if (match?.[1]) return match[1];
      }
      return undefined;
    };
    return {
      baseUrl: value(['cloud_api_base', 'base_url']),
      apiKey: value(['api_key']),
    };
  } catch {
    return {};
  }
}

async function resolveAuth(args) {
  const config = await readRuntimeConfig();
  const baseUrl =
    args.baseUrl ||
    process.env.PRISMER_CLOUD_BASE ||
    process.env.PRISMER_BASE_URL ||
    process.env.CLOUD_API_BASE ||
    process.env.PRISMER_CLOUD_API_BASE ||
    config.baseUrl;
  const apiKey = process.env.PRISMER_API_KEY || config.apiKey;
  if (!baseUrl) throw new Error('Missing Prismer cloud base URL (set PRISMER_CLOUD_BASE or configure cloud_api_base)');
  if (!apiKey) throw new Error('Missing PRISMER_API_KEY and no api_key was found in config.toml');
  const target = new URL(baseUrl);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash || target.pathname !== '/') {
    throw new Error('Cloud base URL must be a plain HTTP(S) origin');
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), apiKey };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Cloud returned non-JSON status=${response.status}: ${text.slice(0, 200)}`);
  }
}

function errorDetail(status, body) {
  const error = body?.error;
  const code = typeof error?.code === 'string' ? error.code : typeof error?.type === 'string' ? error.type : '';
  const message = typeof error?.message === 'string' ? error.message : typeof error === 'string' ? error : `HTTP ${status}`;
  return { status, code, message };
}

function canFallback(error) {
  if (error.status === 402) return false;
  return (
    error.status === 404 ||
    error.status === 429 ||
    error.status >= 500 ||
    ['model_not_found', 'rate_limit', 'rate_limit_exceeded', 'insufficient_quota'].includes(error.code)
  );
}

function normalizeModel(model) {
  return {
    id: model.id,
    sizes: Array.isArray(model.sizes) ? model.sizes.filter((size) => typeof size === 'string') : null,
  };
}

function supportsSize(model, size) {
  return model.sizes === null || model.sizes.length === 0 || model.sizes.includes(size);
}

async function discoverModels(auth, preferred, size) {
  const response = await fetch(`${auth.baseUrl}/api/v1/image-models`, {
    headers: { Authorization: `Bearer ${auth.apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await readJson(response);
  if (!response.ok || !Array.isArray(body.data)) {
    const detail = errorDetail(response.status, body);
    if (preferred) return [{ id: preferred, sizes: null }];
    throw new Error(`Image model discovery failed: ${detail.status} ${detail.code} ${detail.message}`.trim());
  }
  const discovered = body.data
    .filter((model) => model && typeof model.id === 'string')
    .sort((a, b) => Number(a.priority ?? 999) - Number(b.priority ?? 999))
    .map(normalizeModel);
  const preferredModel = preferred ? discovered.find((model) => model.id === preferred) : undefined;
  const candidates = [
    ...(preferred && !preferredModel ? [{ id: preferred, sizes: null }] : []),
    ...(preferredModel ? [preferredModel] : []),
    ...discovered,
  ].filter((model) => supportsSize(model, size));
  const unique = candidates.filter((model, index) => candidates.findIndex((item) => item.id === model.id) === index);
  if (unique.length === 0) {
    const available = discovered
      .map((model) => `${model.id}=[${model.sizes?.join(',') || 'unknown'}]`)
      .join(', ');
    throw new Error(`No image model supports size=${size}; available: ${available || 'none'}`);
  }
  return unique;
}

async function generate(auth, args, models) {
  const failures = [];
  for (const candidate of models) {
    const model = candidate.id;
    const response = await fetch(`${auth.baseUrl}/api/v1/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: args.prompt,
        model,
        size: args.size,
        n: 1,
        response_format: 'b64_json',
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = await readJson(response);
    if (!response.ok) {
      const detail = { model, ...errorDetail(response.status, body) };
      failures.push(detail);
      if (canFallback(detail)) {
        process.stderr.write(`[image-generate] model=${model} failed (${detail.status} ${detail.code || 'error'}); trying fallback\n`);
        continue;
      }
      throw new Error(`Image generation failed: model=${model} status=${detail.status} code=${detail.code || '-'} message=${detail.message}`);
    }
    const item = body?.data?.[0];
    if (typeof item?.b64_json === 'string' && item.b64_json.length > 0) {
      if (item.b64_json.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('Image exceeds 32 MiB');
      return { bytes: Buffer.from(item.b64_json, 'base64'), model };
    }
    if (typeof item?.url === 'string' && item.url.length > 0) {
      return { bytes: await downloadImage(item.url), model };
    }
    throw new Error(`Image generation returned no bytes or URL for model=${model}`);
  }
  throw new Error(
    `All image models failed: ${failures.map((failure) => `${failure.model}:${failure.status}/${failure.code || 'error'}`).join(', ')}`,
  );
}

async function downloadImage(url) {
  if (url.startsWith('data:')) {
    const match = url.match(/^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error('Unsupported image data URL');
    if (match[1].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('Image exceeds 32 MiB');
    return Buffer.from(match[1], 'base64');
  }
  const target = new URL(url);
  const allowed = new Set((process.env.PRISMER_IMAGE_DOWNLOAD_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
  if (target.protocol !== 'https:' || target.username || target.password || !allowed.has(target.origin)) {
    throw new Error('Image URL origin is not explicitly allowed by PRISMER_IMAGE_DOWNLOAD_ORIGINS; prefer b64_json');
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Generated image download failed: HTTP ${response.status}`);
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('image/')) throw new Error('Expected image Content-Type');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) throw new Error('Image exceeds 32 MiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function detectImage(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { extension: '.png', mediaType: 'image/png' };
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return { extension: '.jpg', mediaType: 'image/jpeg' };
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { extension: '.webp', mediaType: 'image/webp' };
  }
  throw new Error('Generated bytes are not a supported PNG, JPEG, or WebP image');
}

async function saveImage(args, bytes) {
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Image exceeds 32 MiB');
  const detected = detectImage(bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const generatedName = `generated-${sha.slice(0, 8)}${detected.extension}`;
  const output = args.output
    ? resolve(args.output)
    : resolve(process.env.PRISMER_ARTIFACTS_DIR || process.cwd(), generatedName);
  if (args.output && extname(output).toLowerCase() !== detected.extension) {
    throw new Error(`--output extension must match generated ${detected.mediaType} bytes (${detected.extension})`);
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bytes);
  return { output, sha, mediaType: detected.mediaType };
}

async function deliver(output) {
  const cloudBin = process.env.PRISMER_CLOUD_BIN || 'cloud';
  let stdout;
  try {
    ({ stdout } = await execFileAsync(cloudBin, ['deliver', output, '--json'], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    const detail = typeof error?.stderr === 'string' ? error.stderr.trim() : error.message;
    throw new Error(`cloud deliver failed: ${detail}`);
  }
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(`cloud deliver returned non-JSON output: ${stdout.slice(0, 200)}`);
  }
  if (result?.ok !== true) throw new Error(`cloud deliver rejected the image: ${result?.error || 'unknown error'}`);
  if (result.status === 202 || result.queued === true) return { status: 'queued', receipt: result };
  if (typeof result.assetId !== 'string' || result.assetId.length === 0) {
    throw new Error('cloud deliver returned ok without an assetId or queued receipt');
  }
  if (result.ridesReply === false) return { status: 'uploaded-unattached', receipt: result };
  return { status: 'delivered', receipt: result };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const auth = await resolveAuth(args);
  const preferred = args.model || process.env.IMAGE_GEN_MODEL;
  const models = await discoverModels(auth, preferred, args.size);
  if (models.length === 0) throw new Error('No image generation models are available');
  const generated = await generate(auth, args, models);
  const saved = await saveImage(args, generated.bytes);
  const delivery = await deliver(saved.output);
  if (delivery.status === 'queued') {
    process.stdout.write(
      `[image-generate] queued file=${saved.output} model=${generated.model} size=${args.size} sha=${saved.sha.slice(0, 12)}; upload pending reconnect\n`,
    );
    return;
  }
  if (delivery.status === 'uploaded-unattached') {
    process.stdout.write(
      `[image-generate] uploaded-unattached file=${saved.output} assetId=${delivery.receipt.assetId} model=${generated.model} size=${args.size} sha=${saved.sha.slice(0, 12)}; no reply dispatch was available\n`,
    );
    return;
  }
  process.stdout.write(
    `[image-generate] delivered file=${saved.output} assetId=${delivery.receipt.assetId} model=${generated.model} size=${args.size} sha=${saved.sha.slice(0, 12)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`[image-generate] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
