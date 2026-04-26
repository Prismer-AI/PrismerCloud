import { NextRequest } from 'next/server';
import OpenAI from 'openai';
import { SOURCE_QUALIFIER_SYSTEM, getPromptForStrategy } from '@/lib/prompts';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { apiGuard } from '@/lib/api-guard';
import { openaiBreaker } from '@/lib/circuit-breaker';
import { metrics } from '@/lib/metrics';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('CompressStream');

// Initialize Nacos config on module load (singleton pattern)
let nacosInitialized = false;
const initNacos = async () => {
  if (!nacosInitialized) {
    await ensureNacosConfig();
    nacosInitialized = true;
  }
};

// Get config values with Nacos support
function getOpenAIConfig() {
  const tempStr = process.env.COMPRESS_TEMPERATURE;
  return {
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_API_BASE_URL,
    model: process.env.DEFAULT_MODEL || 'openai/gpt-oss-120b',
    temperature: tempStr !== undefined && tempStr !== '' ? parseFloat(tempStr) : undefined,
  };
}

/**
 * POST /api/compress/stream
 *
 * Stream compressed content using OpenAI API with Server-Sent Events.
 * 认证: 必需 (API Key 或 JWT) — billable
 */
export async function POST(request: NextRequest) {
  const reqStart = Date.now();
  const guard = await apiGuard(request, { tier: 'billable', estimatedCost: 0.5 });
  if (!guard.ok) return guard.response;
  const rl = checkRateLimit(guard.auth.userId, 'compress/stream');
  if (!rl.allowed) return rateLimitResponse(rl);
  try {
    // Ensure Nacos config is loaded before accessing env vars
    await initNacos();

    const config = getOpenAIConfig();

    if (!config.apiKey) {
      return new Response(JSON.stringify({ error: 'OpenAI API key not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await request.json();
    const { content, url, title, strategy, imageLinks } = body;

    if (!content) {
      return new Response(JSON.stringify({ error: 'Content is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Initialize OpenAI client
    const openai = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL || undefined,
    });

    // Get the appropriate prompt template
    const promptTemplate = getPromptForStrategy(strategy || 'auto');

    // Build image links section
    let imageSection = '';
    if (imageLinks && imageLinks.length > 0) {
      imageSection = `\n\n## AVAILABLE IMAGES:\nYou may include these images in your output using markdown syntax ![description](url):\n${imageLinks.map((img: string, i: number) => `${i + 1}. ${img}`).join('\n')}\n`;
    }

    // Fill in the template
    const userPrompt = promptTemplate
      .replace('{url}', url || 'Unknown')
      .replace('{title}', title || 'Untitled')
      .replace('{content}', content + imageSection);

    // Create streaming response (circuit breaker wraps the initial API call)
    const streamStart = Date.now();
    const stream = await openaiBreaker.execute(() =>
      openai.chat.completions.create({
        model: config.model,
        messages: [
          { role: 'system', content: SOURCE_QUALIFIER_SYSTEM },
          { role: 'user', content: userPrompt },
        ],
        ...(config.temperature !== undefined && { temperature: config.temperature }),
        max_tokens: 4096,
        stream: true,
      }),
    );

    // Create a readable stream for SSE
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || '';
            if (content) {
              // Send as SSE format
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content })}\n\n`));
            }
          }
          // Send done event
          metrics.recordExternalApi('openai', Date.now() - streamStart, true);
          metrics.recordRequest('/api/compress/stream', Date.now() - reqStart, 200);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, model: config.model })}\n\n`));
          controller.close();
        } catch (error) {
          metrics.recordExternalApi('openai', Date.now() - streamStart, false);
          metrics.recordRequest('/api/compress/stream', Date.now() - reqStart, 500);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: 'Stream error' })}\n\n`));
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    metrics.recordRequest('/api/compress/stream', Date.now() - reqStart, 500);
    log.error({ err: error }, 'Streaming compression error');
    return new Response(
      JSON.stringify({
        error: 'Failed to stream content',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
