import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { SOURCE_QUALIFIER_SYSTEM, getPromptForStrategy } from '@/lib/prompts';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { metrics } from '@/lib/metrics';
import { apiGuard } from '@/lib/api-guard';
import { openaiBreaker } from '@/lib/circuit-breaker';
import { checkRateLimit, rateLimitResponse, rateLimitHeaders } from '@/lib/rate-limit';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('Compress');

// Token limit configuration
// Most LLMs have 200k token context, we set 96k as input limit to leave room for output
const MAX_INPUT_TOKENS = 96000;
// Approximate characters per token (conservative estimate for mixed content)
// English ~4 chars/token, code ~2-3, Chinese ~1-2, using 3.5 as balanced average
const CHARS_PER_TOKEN = 3.5;
const MAX_CONTENT_CHARS = Math.floor(MAX_INPUT_TOKENS * CHARS_PER_TOKEN); // ~336,000 chars

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
 * Truncate content to fit within token limit
 * Uses character-based estimation for simplicity and performance
 */
function truncateContent(
  content: string,
  maxChars: number = MAX_CONTENT_CHARS,
): { content: string; truncated: boolean; originalLength: number } {
  const originalLength = content.length;

  if (content.length <= maxChars) {
    return { content, truncated: false, originalLength };
  }

  // Truncate at a reasonable boundary (paragraph or sentence)
  let truncatedContent = content.substring(0, maxChars);

  // Try to find a clean break point (paragraph, then sentence, then word)
  const lastParagraph = truncatedContent.lastIndexOf('\n\n');
  const lastSentence = Math.max(
    truncatedContent.lastIndexOf('. '),
    truncatedContent.lastIndexOf('。'),
    truncatedContent.lastIndexOf('! '),
    truncatedContent.lastIndexOf('? '),
  );
  const lastWord = truncatedContent.lastIndexOf(' ');

  // Prefer clean breaks if they're not too far back (within 10% of max length)
  const minAcceptableLength = maxChars * 0.9;

  if (lastParagraph > minAcceptableLength) {
    truncatedContent = truncatedContent.substring(0, lastParagraph);
  } else if (lastSentence > minAcceptableLength) {
    truncatedContent = truncatedContent.substring(0, lastSentence + 1);
  } else if (lastWord > minAcceptableLength) {
    truncatedContent = truncatedContent.substring(0, lastWord);
  }

  // Add truncation notice
  truncatedContent +=
    '\n\n[Content truncated due to length limit. Original content was ' +
    Math.round(originalLength / 1000) +
    'k characters, truncated to ' +
    Math.round(truncatedContent.length / 1000) +
    'k characters for processing.]';

  log.info(
    `Content truncated: ${originalLength} -> ${truncatedContent.length} chars (estimated ${Math.round(originalLength / CHARS_PER_TOKEN)}k -> ${Math.round(truncatedContent.length / CHARS_PER_TOKEN)}k tokens)`,
  );

  return { content: truncatedContent, truncated: true, originalLength };
}

/**
 * POST /api/compress
 *
 * Compress content using OpenAI API with strategy-specific prompts.
 * 认证: 必需 (API Key 或 JWT) — billable
 */
export async function POST(request: NextRequest) {
  const reqStart = Date.now();
  const guard = await apiGuard(request, { tier: 'billable', estimatedCost: 0.5 });
  if (!guard.ok) return guard.response;
  const rl = checkRateLimit(guard.auth.userId, 'compress');
  if (!rl.allowed) return rateLimitResponse(rl);
  try {
    // Ensure Nacos config is loaded before accessing env vars
    await initNacos();

    const config = getOpenAIConfig();

    if (!config.apiKey) {
      return NextResponse.json({ error: 'OpenAI API key not configured' }, { status: 500 });
    }

    const body = await request.json();
    const { content, url, title, strategy, imageLinks, stream } = body;

    if (!content) {
      return NextResponse.json({ error: 'Content is required' }, { status: 400 });
    }

    // Truncate content if it exceeds token limit (96k tokens ≈ 336k chars)
    const { content: processedContent, truncated, originalLength } = truncateContent(content);

    // Initialize OpenAI client with custom base URL if provided
    const openai = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL || undefined,
    });

    // Get the appropriate prompt template based on strategy
    const promptTemplate = getPromptForStrategy(strategy || 'auto');

    // Build image links section if available
    let imageSection = '';
    if (imageLinks && imageLinks.length > 0) {
      imageSection = `\n\n## AVAILABLE IMAGES:\nYou may include these images in your output using markdown syntax ![description](url):\n${imageLinks.map((img: string, i: number) => `${i + 1}. ${img}`).join('\n')}\n`;
    }

    // Fill in the template with truncated content
    const userPrompt = promptTemplate
      .replace('{url}', url || 'Unknown')
      .replace('{title}', title || 'Untitled')
      .replace('{content}', processedContent + imageSection);

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: SOURCE_QUALIFIER_SYSTEM,
      },
      {
        role: 'user',
        content: userPrompt,
      },
    ];

    // Streaming response
    if (stream) {
      const streamStart = Date.now();
      const streamResponse = await openaiBreaker.execute(() =>
        openai.chat.completions.create({
          model: config.model,
          messages,
          ...(config.temperature !== undefined && { temperature: config.temperature }),
          max_tokens: 4096,
          stream: true,
        }),
      );

      // Create a ReadableStream that emits SSE events
      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of streamResponse) {
              const content = chunk.choices[0]?.delta?.content || '';
              if (content) {
                // Send as SSE data
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content })}\n\n`));
              }
            }
            metrics.recordExternalApi('openai', Date.now() - streamStart, true);
            metrics.recordRequest('/api/compress', Date.now() - reqStart, 200);
            // Send done event with truncation info
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  done: true,
                  model: config.model,
                  truncated,
                  originalLength: truncated ? originalLength : undefined,
                })}\n\n`,
              ),
            );
            controller.close();
          } catch (error) {
            metrics.recordExternalApi('openai', Date.now() - streamStart, false);
            metrics.recordRequest('/api/compress', Date.now() - reqStart, 500);
            controller.error(error);
          }
        },
      });

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          ...rateLimitHeaders(rl),
        },
      });
    }

    // Non-streaming response (with circuit breaker)
    const llmStart = Date.now();
    const completion = await openaiBreaker.execute(() =>
      openai.chat.completions.create({
        model: config.model,
        messages,
        ...(config.temperature !== undefined && { temperature: config.temperature }),
        max_tokens: 4096,
      }),
    );
    metrics.recordExternalApi('openai', Date.now() - llmStart, true);
    metrics.recordRequest('/api/compress', Date.now() - reqStart, 200);

    const hqcc = completion.choices[0]?.message?.content || '';

    return NextResponse.json(
      {
        hqcc,
        model: config.model,
        usage: completion.usage,
        truncated,
        originalLength: truncated ? originalLength : undefined,
      },
      { headers: rateLimitHeaders(rl) },
    );
  } catch (error) {
    metrics.recordExternalApi('openai', 0, false);
    metrics.recordRequest('/api/compress', Date.now() - reqStart, 500);
    log.error({ err: error }, 'Compression error');
    return NextResponse.json(
      { error: 'Failed to compress content', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
