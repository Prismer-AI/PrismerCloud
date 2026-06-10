import prisma from '@/lib/prisma';
import { calculateLLMCredits, type LLMUsage } from '@/lib/llm-pricing';

const DEFAULT_TTL_SEC = 300;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 300;
const DEFAULT_MAX_DATA_URL_BYTES = 8 * 1024 * 1024;

export type VisionAuxSource =
  | { kind: 'url'; url: string }
  | { kind: 'data_url'; url: string };

export interface VisionAuxDescribeInput {
  assetId: string;
  contentHash: string;
  mime: string;
  source: VisionAuxSource;
  maxTokens?: number;
  instruction?: string;
}

export interface VisionAuxDescription {
  description: string;
  modelUsed: string;
  provider: string;
  tokenCost: {
    input: number;
    output: number;
    credits: number;
  };
  cached: boolean;
  cacheTtlSec: number;
}

export class VisionAuxError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'VisionAuxError';
  }
}

type VisionAuxModel = {
  id: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  priority?: number;
};

type AssetRow = {
  id: string;
  workspaceId: string;
  contentHash: string;
  mime: string | null;
  metadata: unknown;
  deletedAt?: Date | null;
};

type CachedVisionAux = {
  description: string;
  modelUsed: string;
  provider: string;
  generatedAt: string;
  expiresAt: string;
  mime: string;
};

export async function describeVisionAux(input: VisionAuxDescribeInput): Promise<VisionAuxDescription> {
  const asset = (await prisma.iMAsset.findUnique({
    where: { id: input.assetId },
    select: {
      id: true,
      workspaceId: true,
      contentHash: true,
      mime: true,
      metadata: true,
      deletedAt: true,
    },
  })) as AssetRow | null;
  if (!asset || asset.deletedAt) throw new VisionAuxError('asset_not_found', 'Asset not found', 404, false);
  if (asset.contentHash !== input.contentHash) {
    throw new VisionAuxError('content_hash_mismatch', 'contentHash does not match asset', 400, false);
  }

  const mime = input.mime || asset.mime || '';
  if (!mime.startsWith('image/')) {
    throw new VisionAuxError('unsupported_mime', `Unsupported MIME for vision-aux: ${mime || '<empty>'}`, 415, false);
  }
  if (input.source.kind === 'data_url' && input.source.url.length > getMaxDataUrlBytes()) {
    throw new VisionAuxError('image_too_large', 'Inline image exceeds vision-aux size limit', 413, false);
  }

  const cached = await readCachedDescription(asset.workspaceId, input.contentHash, mime);
  if (cached) return toDescription(cached, true);

  const models = loadVisionAuxModels();
  if (models.length === 0) {
    throw new VisionAuxError('vision_aux_unavailable', 'No vision-aux models configured', 503, true);
  }

  const errors: string[] = [];
  for (const model of models) {
    try {
      const result = await callVisionModel(model, input);
      await writeCachedDescription(asset.workspaceId, input.contentHash, mime, result);
      return {
        ...result,
        cached: false,
        cacheTtlSec: DEFAULT_TTL_SEC,
      };
    } catch (err) {
      errors.push(`${model.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new VisionAuxError('vision_aux_unavailable', errors.join('; ') || 'Vision model unavailable', 503, true);
}

async function readCachedDescription(
  workspaceId: string,
  contentHash: string,
  mime: string,
): Promise<CachedVisionAux | null> {
  const rows = (await prisma.iMAsset.findMany({
    where: { workspaceId, contentHash, deletedAt: null },
    select: { metadata: true },
    take: 50,
  })) as Array<{ metadata: unknown }>;

  const now = Date.now();
  for (const row of rows) {
    const cached = parseVisionAuxMetadata(row.metadata);
    if (!cached || cached.mime !== mime) continue;
    const expiresAt = Date.parse(cached.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > now) return cached;
  }
  return null;
}

async function writeCachedDescription(
  workspaceId: string,
  contentHash: string,
  mime: string,
  result: Omit<VisionAuxDescription, 'cached' | 'cacheTtlSec'>,
): Promise<void> {
  const now = new Date();
  const visionAux: CachedVisionAux = {
    description: result.description,
    modelUsed: result.modelUsed,
    provider: result.provider,
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DEFAULT_TTL_SEC * 1000).toISOString(),
    mime,
  };
  const rows = (await prisma.iMAsset.findMany({
    where: { workspaceId, contentHash, deletedAt: null },
    select: { id: true, metadata: true },
    take: 50,
  })) as Array<{ id: string; metadata: unknown }>;

  await Promise.all(
    rows.map((row) => {
      const metadata = parseMetadataObject(row.metadata);
      return prisma.iMAsset.update({
        where: { id: row.id },
        data: { metadata: JSON.stringify({ ...metadata, visionAux }) },
      });
    }),
  );
}

function parseVisionAuxMetadata(raw: unknown): CachedVisionAux | null {
  const metadata = parseMetadataObject(raw);
  const value = metadata.visionAux;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const description = readString(record.description);
  const modelUsed = readString(record.modelUsed);
  const provider = readString(record.provider);
  const generatedAt = readString(record.generatedAt);
  const expiresAt = readString(record.expiresAt);
  const mime = readString(record.mime);
  if (!description || !modelUsed || !provider || !generatedAt || !expiresAt || !mime) return null;
  return { description, modelUsed, provider, generatedAt, expiresAt, mime };
}

function toDescription(cached: CachedVisionAux, fromCache: boolean): VisionAuxDescription {
  const ttlMs = Math.max(0, Date.parse(cached.expiresAt) - Date.now());
  return {
    description: cached.description,
    modelUsed: cached.modelUsed,
    provider: cached.provider,
    tokenCost: { input: 0, output: 0, credits: 0 },
    cached: fromCache,
    cacheTtlSec: Math.ceil(ttlMs / 1000),
  };
}

function loadVisionAuxModels(): VisionAuxModel[] {
  const raw = process.env.VISION_AUX_MODELS;
  const parsed = raw ? parseJson(raw) : null;
  const configured = Array.isArray(parsed) ? parsed : [];
  const models = configured
    .map((item): VisionAuxModel | null => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      const id = readString(record.id);
      if (!id) return null;
      return {
        id,
        provider: readString(record.provider) ?? 'openai-compatible',
        baseUrl: readString(record.baseUrl) ?? undefined,
        apiKey: readString(record.apiKey) ?? undefined,
        apiKeyEnv: readString(record.apiKeyEnv) ?? undefined,
        priority: typeof record.priority === 'number' ? record.priority : 100,
      };
    })
    .filter((item): item is VisionAuxModel => Boolean(item));

  if (models.length > 0) return models.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

  const fallbackModel = process.env.VISION_AUX_MODEL;
  const fallbackBase = process.env.VISION_AUX_BASE_URL || process.env.NEWAPI_BASE_URL || process.env.OPENAI_BASE_URL;
  if (fallbackModel && fallbackBase) {
    return [{ id: fallbackModel, provider: 'openai-compatible', baseUrl: fallbackBase, priority: 100 }];
  }
  return [];
}

async function callVisionModel(
  model: VisionAuxModel,
  input: VisionAuxDescribeInput,
): Promise<Omit<VisionAuxDescription, 'cached' | 'cacheTtlSec'>> {
  const baseUrl = model.baseUrl || process.env.VISION_AUX_BASE_URL || process.env.NEWAPI_BASE_URL || process.env.OPENAI_BASE_URL;
  if (!baseUrl) throw new Error('baseUrl not configured');
  const apiKey = model.apiKey || process.env[model.apiKeyEnv || 'VISION_AUX_API_KEY'] || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('apiKey not configured');

  const instruction =
    input.instruction ||
    'Describe the image concisely for an AI agent. Include visible UI state, readable text, charts, and important spatial relationships.';
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model.id,
      max_tokens: input.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            { type: 'image_url', image_url: { url: input.source.url, detail: 'auto' } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(getTimeoutMs()),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  const description = extractDescription(json);
  if (!description) throw new Error('empty description');

  const usage = normalizeUsage(json.usage);
  const cost = usage ? calculateLLMCredits(model.id, usage) : null;
  return {
    description,
    modelUsed: model.id,
    provider: model.provider || 'openai-compatible',
    tokenCost: {
      input: usage?.prompt_tokens ?? 0,
      output: usage?.completion_tokens ?? 0,
      credits: cost?.credits ?? 0,
    },
  };
}

function extractDescription(json: Record<string, unknown>): string | null {
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const first = choices[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null;
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return '';
      const record = part as Record<string, unknown>;
      return readString(record.text) || '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
  return text || null;
}

function normalizeUsage(value: unknown): LLMUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const prompt = typeof record.prompt_tokens === 'number' ? record.prompt_tokens : 0;
  const completion = typeof record.completion_tokens === 'number' ? record.completion_tokens : 0;
  return { prompt_tokens: prompt, completion_tokens: completion };
}

function parseMetadataObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  const parsed = typeof raw === 'string' && raw.trim() ? parseJson(raw) : null;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getTimeoutMs(): number {
  const value = Number(process.env.VISION_AUX_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function getMaxDataUrlBytes(): number {
  const value = Number(process.env.VISION_AUX_MAX_DATA_URL_BYTES);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_DATA_URL_BYTES;
}
