import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    iMAsset: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
  calculateLLMCredits: vi.fn(() => ({ credits: 7 })),
}));

vi.mock('@/lib/prisma', () => ({ default: mocks.prisma, prisma: mocks.prisma }));
vi.mock('@/lib/llm-pricing', () => ({ calculateLLMCredits: mocks.calculateLLMCredits }));

import { describeVisionAux } from '../vision-aux';

const HASH = 'a'.repeat(64);
const NOW = new Date('2026-05-21T10:00:00.000Z');

describe('vision-aux service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv('VISION_AUX_MODELS', '');
    vi.stubEnv('VISION_AUX_MODEL', '');
    vi.stubEnv('VISION_AUX_BASE_URL', '');
    vi.stubEnv('NEWAPI_BASE_URL', '');
    vi.stubEnv('OPENAI_BASE_URL', '');
    vi.stubEnv('VISION_AUX_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('returns cached descriptions by contentHash without calling a model', async () => {
    mocks.prisma.iMAsset.findUnique.mockResolvedValue({
      id: 'asset-1',
      workspaceId: 'ws-1',
      contentHash: HASH,
      mime: 'image/png',
      metadata: null,
      deletedAt: null,
    });
    mocks.prisma.iMAsset.findMany.mockResolvedValue([
      {
        metadata: JSON.stringify({
          visionAux: {
            description: 'A dashboard screenshot',
            modelUsed: 'gpt-4o-mini',
            provider: 'openai-compatible',
            generatedAt: NOW.toISOString(),
            expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
            mime: 'image/png',
          },
        }),
      },
    ]);

    const result = await describeVisionAux({
      assetId: 'asset-1',
      contentHash: HASH,
      mime: 'image/png',
      source: { kind: 'url', url: 'https://example.com/screenshot.png' },
    });

    expect(result).toMatchObject({
      description: 'A dashboard screenshot',
      cached: true,
      tokenCost: { input: 0, output: 0, credits: 0 },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects non-image assets before model routing', async () => {
    mocks.prisma.iMAsset.findUnique.mockResolvedValue({
      id: 'asset-1',
      workspaceId: 'ws-1',
      contentHash: HASH,
      mime: 'application/pdf',
      metadata: null,
      deletedAt: null,
    });

    await expect(
      describeVisionAux({
        assetId: 'asset-1',
        contentHash: HASH,
        mime: 'application/pdf',
        source: { kind: 'url', url: 'https://example.com/file.pdf' },
      }),
    ).rejects.toMatchObject({
      code: 'unsupported_mime',
      status: 415,
      retryable: false,
    });
  });

  it('calls the configured fallback model and writes the contentHash cache', async () => {
    vi.stubEnv('VISION_AUX_MODEL', 'gpt-4o-mini');
    vi.stubEnv('VISION_AUX_BASE_URL', 'https://llm.example.test/v1');
    vi.stubEnv('VISION_AUX_API_KEY', 'sk-test');

    mocks.prisma.iMAsset.findUnique.mockResolvedValue({
      id: 'asset-1',
      workspaceId: 'ws-1',
      contentHash: HASH,
      mime: 'image/jpeg',
      metadata: null,
      deletedAt: null,
    });
    mocks.prisma.iMAsset.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'asset-1', metadata: JSON.stringify({ existing: true }) }]);
    mocks.prisma.iMAsset.update.mockResolvedValue({});
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'A mobile checkout screen.' } }],
        usage: { prompt_tokens: 120, completion_tokens: 24 },
      }),
    });

    const result = await describeVisionAux({
      assetId: 'asset-1',
      contentHash: HASH,
      mime: 'image/jpeg',
      source: { kind: 'url', url: 'https://example.com/photo.jpg' },
      maxTokens: 120,
    });

    expect(result).toMatchObject({
      description: 'A mobile checkout screen.',
      modelUsed: 'gpt-4o-mini',
      provider: 'openai-compatible',
      cached: false,
      tokenCost: { input: 120, output: 24, credits: 7 },
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://llm.example.test/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }),
      }),
    );
    expect(mocks.prisma.iMAsset.update).toHaveBeenCalledWith({
      where: { id: 'asset-1' },
      data: {
        metadata: expect.stringContaining('"visionAux"'),
      },
    });
  });
});
