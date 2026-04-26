/**
 * Moonshot / Kimi K2.5 API — 独立测试脚本
 *
 * 验证功能：
 *   1. 模型列表 (GET /v1/models)
 *   2. 单轮对话 (POST /v1/chat/completions)
 *   3. 流式输出 (stream: true)
 *   4. Tool Calling (function calling)
 *   5. 文件上传 + 引用 (POST /v1/files → chat)
 *
 * 用法：
 *   MOONSHOT_API_KEY=sk-xxx npx tsx scripts/test-moonshot-api.ts
 *   npx tsx scripts/test-moonshot-api.ts --only chat,stream,tools
 *
 * 参考文档：
 *   https://platform.moonshot.ai/docs/guide/kimi-k2-5-quickstart
 *   https://platform.moonshot.ai/docs/api/chat
 *   https://platform.moonshot.ai/docs/api/tool-use
 *   https://platform.moonshot.ai/docs/api/files
 */

// ─── Config ─────────────────────────────────────────────

const API_KEY = process.env.MOONSHOT_API_KEY || 'sk-REDACTED';
const BASE_URL = process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.ai/v1';
const MODEL = process.env.MOONSHOT_MODEL || 'kimi-k2.5';

// ─── Abstract Client ────────────────────────────────────

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoning_content?: string | null;  // K2.5 thinking model: chain-of-thought
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ChatCompletionOptions {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: ToolDef[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

class MoonshotClient {
  constructor(
    private apiKey: string,
    private baseUrl: string,
    private defaultModel: string,
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  /** GET /v1/models */
  async listModels(): Promise<{ id: string; object: string }[]> {
    const res = await fetch(`${this.baseUrl}/models`, { headers: this.headers() });
    if (!res.ok) throw new Error(`listModels failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return json.data;
  }

  /** POST /v1/chat/completions (non-stream) */
  async chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResponse> {
    const model = opts.model || this.defaultModel;
    // kimi-k2.5 only allows temperature=1
    const isK25 = model.includes('k2.5') || model.includes('k2-5');
    const body: Record<string, unknown> = {
      model,
      messages: opts.messages,
      stream: false,
      ...(opts.max_tokens && { max_tokens: opts.max_tokens }),
      ...(opts.tools && { tools: opts.tools }),
      ...(opts.tool_choice && { tool_choice: opts.tool_choice }),
    };
    if (!isK25) body.temperature = opts.temperature ?? 0.7;

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`chatCompletion failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  /** POST /v1/chat/completions (stream) — yields content deltas */
  async *chatStream(opts: ChatCompletionOptions): AsyncGenerator<{
    type: 'content' | 'tool_call' | 'done';
    content?: string;
    tool_calls?: ToolCall[];
    finish_reason?: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }> {
    const model = opts.model || this.defaultModel;
    const isK25 = model.includes('k2.5') || model.includes('k2-5');
    const body: Record<string, unknown> = {
      model,
      messages: opts.messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(opts.max_tokens && { max_tokens: opts.max_tokens }),
      ...(opts.tools && { tools: opts.tools }),
      ...(opts.tool_choice && { tool_choice: opts.tool_choice }),
    };
    if (!isK25) body.temperature = opts.temperature ?? 0.7;

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`chatStream failed: ${res.status} ${await res.text()}`);

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          yield { type: 'done' };
          return;
        }

        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          const finishReason = chunk.choices?.[0]?.finish_reason;

          // K2.5 thinking model: content may arrive as reasoning_content first, then content
          if (delta?.content) {
            yield { type: 'content', content: delta.content };
          } else if (delta?.reasoning_content) {
            // thinking tokens — emit as content for visibility
            yield { type: 'content', content: delta.reasoning_content };
          }
          if (delta?.tool_calls) {
            yield { type: 'tool_call', tool_calls: delta.tool_calls };
          }
          if (finishReason) {
            yield { type: 'done', finish_reason: finishReason, usage: chunk.usage };
          }
        } catch { /* skip malformed chunks */ }
      }
    }
  }

  /** POST /v1/files — upload file for content extraction */
  async uploadFile(filename: string, content: Buffer | string, purpose: string = 'file-extract'): Promise<{
    id: string;
    filename: string;
    bytes: number;
    purpose: string;
  }> {
    const boundary = '----MoonshotBoundary' + Date.now();
    const contentBuf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;

    // Build multipart body manually
    const parts: Buffer[] = [];
    // file part
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    ));
    parts.push(contentBuf);
    parts.push(Buffer.from('\r\n'));
    // purpose part
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\n${purpose}\r\n`
    ));
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const res = await fetch(`${this.baseUrl}/files`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    if (!res.ok) throw new Error(`uploadFile failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  /** GET /v1/files/{file_id}/content — get extracted text */
  async getFileContent(fileId: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/files/${fileId}/content`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`getFileContent failed: ${res.status} ${await res.text()}`);
    return res.text();
  }

  /** DELETE /v1/files/{file_id} */
  async deleteFile(fileId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/files/${fileId}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`deleteFile failed: ${res.status} ${await res.text()}`);
  }
}

// ─── Test Helpers ───────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;

function log(tag: string, ...args: unknown[]) {
  console.log(`  [${tag}]`, ...args);
}

async function runTest(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    const ms = Date.now() - start;
    console.log(`  ✅ ${name} (${ms}ms)`);
    passed++;
  } catch (err: unknown) {
    const ms = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ❌ ${name} (${ms}ms): ${msg}`);
    failed++;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

// ─── Test Cases ─────────────────────────────────────────

const client = new MoonshotClient(API_KEY, BASE_URL, MODEL);

/** Test 1: 模型列表 */
async function testModels() {
  const models = await client.listModels();
  assert(Array.isArray(models), 'models should be array');
  assert(models.length > 0, 'models should not be empty');
  log('models', `Found ${models.length} models:`);
  for (const m of models.slice(0, 10)) {
    log('models', `  - ${m.id}`);
  }
  // Check if our target model is available
  const hasTarget = models.some(m => m.id === MODEL || m.id.includes('k2'));
  log('models', `Target model "${MODEL}" ${hasTarget ? 'found' : 'not found (may still work)'}`);
}

/** Test 2: 单轮对话 */
async function testChat() {
  const res = await client.chatCompletion({
    messages: [
      { role: 'system', content: 'You are a helpful assistant. Answer concisely.' },
      { role: 'user', content: 'What is 2+3? Reply with just the number.' },
    ],
    temperature: 0,
    max_tokens: 50,
  });

  assert(res.id !== undefined, 'response should have id');
  assert(res.choices.length > 0, 'should have at least one choice');
  const msg = res.choices[0].message;
  const content = msg.content || '';
  const reasoning = msg.reasoning_content || '';
  assert(content.includes('5') || reasoning.includes('5'), `answer should contain "5", got content: "${content}", reasoning: "${reasoning.slice(0, 100)}"`);
  log('chat', `Model: ${res.model}`);
  log('chat', `Reply: "${content.trim()}"`);
  if (reasoning) log('chat', `Reasoning: "${reasoning.trim().slice(0, 80)}..."`);
  log('chat', `Usage: ${res.usage?.prompt_tokens}→${res.usage?.completion_tokens} tokens`);
  log('chat', `Finish: ${res.choices[0].finish_reason}`);
}

/** Test 3: 流式输出 */
async function testStream() {
  let fullContent = '';
  let chunkCount = 0;
  let usage: Record<string, number> | undefined;

  for await (const chunk of client.chatStream({
    messages: [
      { role: 'user', content: 'Count from 1 to 5, separated by commas.' },
    ],
    temperature: 0,
    max_tokens: 50,
  })) {
    if (chunk.type === 'content' && chunk.content) {
      fullContent += chunk.content;
      chunkCount++;
    }
    if (chunk.type === 'done' && chunk.usage) {
      usage = chunk.usage;
    }
  }

  assert(chunkCount > 1, `should receive multiple chunks, got ${chunkCount}`);
  assert(fullContent.includes('1'), `stream content should include "1", got: "${fullContent}"`);
  log('stream', `Received ${chunkCount} chunks`);
  log('stream', `Content: "${fullContent.trim()}"`);
  if (usage) {
    log('stream', `Usage: ${usage.prompt_tokens}→${usage.completion_tokens} tokens`);
  }
}

/** Test 4: Tool Calling */
async function testToolCalling() {
  const tools: ToolDef[] = [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get current weather for a given city',
        parameters: {
          type: 'object',
          required: ['city'],
          properties: {
            city: { type: 'string', description: 'City name, e.g. "Beijing"' },
            unit: { type: 'string', enum: ['celsius', 'fahrenheit'], description: 'Temperature unit' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_web',
        description: 'Search the web for information',
        parameters: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: 'Search query' },
          },
        },
      },
    },
  ];

  // Step 1: Send user message with tools
  const res1 = await client.chatCompletion({
    messages: [
      { role: 'user', content: "What's the weather like in Beijing today?" },
    ],
    tools,
    tool_choice: 'auto',
    temperature: 0,
  });

  const msg1 = res1.choices[0].message;
  assert(msg1.tool_calls !== undefined && msg1.tool_calls.length > 0, 'model should make a tool call');
  const toolCall = msg1.tool_calls![0];
  assert(toolCall.function.name === 'get_weather', `should call get_weather, got: ${toolCall.function.name}`);

  const args = JSON.parse(toolCall.function.arguments);
  log('tools', `Tool call: ${toolCall.function.name}(${JSON.stringify(args)})`);
  log('tools', `Tool call ID: ${toolCall.id}`);

  // Step 2: Send tool result back
  // K2.5 thinking model requires reasoning_content in assistant message
  const assistantMsg: ChatMessage = {
    role: 'assistant',
    content: msg1.content ?? null,
    tool_calls: msg1.tool_calls,
  };
  if (msg1.reasoning_content) {
    assistantMsg.reasoning_content = msg1.reasoning_content;
  }

  const res2 = await client.chatCompletion({
    messages: [
      { role: 'user', content: "What's the weather like in Beijing today?" },
      assistantMsg,
      {
        role: 'tool',
        content: JSON.stringify({ temperature: 28, condition: 'sunny', humidity: 45 }),
        tool_call_id: toolCall.id,
      },
    ],
    tools,
  });

  const finalMsg = res2.choices[0].message.content || '';
  assert(finalMsg.length > 10, `final response should be meaningful, got: "${finalMsg}"`);
  assert(finalMsg.includes('28') || finalMsg.includes('sunny') || finalMsg.toLowerCase().includes('beijing'),
    `response should reference weather data`);
  log('tools', `Final: "${finalMsg.slice(0, 120)}..."`);
  log('tools', `Finish: ${res2.choices[0].finish_reason}`);
}

/** Test 5: 文件上传 + 内容提取 + 对话引用 */
async function testFileUpload() {
  // Upload a small text file
  const testContent = `# Prismer Evolution Engine — Summary

The Evolution Engine uses Thompson Sampling with hierarchical Bayesian priors
for multi-agent online skill evolution. Key concepts:

- SignalTag: hierarchical labels (type, provider, stage, severity)
- Gene: reusable strategy patterns (repair/optimize/innovate)
- Edge: routing weight between (signal, gene) pairs
- Bimodality Index: detects misleading edge confidence

Architecture: two-layer separation — routing layer (coarse signal→gene candidates)
vs execution layer (gene receives full context, makes adaptive decisions).
`;

  let fileId: string | undefined;

  try {
    // Upload
    const uploadRes = await client.uploadFile('evolution-summary.txt', testContent);
    fileId = uploadRes.id;
    assert(fileId !== undefined, 'upload should return file id');
    log('file', `Uploaded: ${uploadRes.filename} (${uploadRes.bytes} bytes) → ${fileId}`);

    // Get extracted content
    const extracted = await client.getFileContent(fileId);
    assert(extracted.length > 0, 'extracted content should not be empty');
    log('file', `Extracted ${extracted.length} chars`);

    // Use file in chat (reference via fileid in system message)
    const chatRes = await client.chatCompletion({
      messages: [
        {
          role: 'system',
          content: `You have access to the following file content:\n\n${extracted}\n\nAnswer questions based on this content.`,
        },
        { role: 'user', content: 'What algorithm does the Evolution Engine use for gene selection? Answer in one sentence.' },
      ],
      temperature: 0,
      max_tokens: 100,
    });

    const msg = chatRes.choices[0].message;
    const answer = msg.content || msg.reasoning_content || '';
    assert(answer.toLowerCase().includes('thompson') || answer.toLowerCase().includes('bayesian') || answer.toLowerCase().includes('sampling'),
      `answer should mention Thompson Sampling, got: "${answer.slice(0, 200)}"`);
    log('file', `Chat with file: "${(msg.content || '').trim().slice(0, 120) || '(in reasoning_content)'}"`);
  } finally {
    // Cleanup
    if (fileId) {
      try {
        await client.deleteFile(fileId);
        log('file', `Cleaned up file ${fileId}`);
      } catch (e) {
        log('file', `Cleanup warning: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}

/** Test 6: Multi-tool parallel calling (if supported) */
async function testParallelToolCalls() {
  const tools: ToolDef[] = [
    {
      type: 'function',
      function: {
        name: 'get_stock_price',
        description: 'Get current stock price',
        parameters: {
          type: 'object',
          required: ['symbol'],
          properties: {
            symbol: { type: 'string', description: 'Stock ticker symbol' },
          },
        },
      },
    },
  ];

  const res = await client.chatCompletion({
    messages: [
      { role: 'user', content: 'Compare the stock prices of AAPL and GOOGL right now.' },
    ],
    tools,
    tool_choice: 'auto',
    temperature: 0,
  });

  const msg = res.choices[0].message;
  const calls = msg.tool_calls || [];
  log('parallel', `Got ${calls.length} tool call(s)`);

  if (calls.length >= 2) {
    log('parallel', `Parallel tool calls supported!`);
    for (const c of calls) {
      log('parallel', `  ${c.function.name}(${c.function.arguments})`);
    }
  } else if (calls.length === 1) {
    log('parallel', `Single tool call (model may chain sequentially): ${calls[0].function.name}(${calls[0].function.arguments})`);
  }
  assert(calls.length >= 1, 'should make at least one tool call');
}

/** Test 7: Streaming + Tool Calling combined */
async function testStreamToolCalling() {
  const tools: ToolDef[] = [
    {
      type: 'function',
      function: {
        name: 'calculate',
        description: 'Evaluate a math expression',
        parameters: {
          type: 'object',
          required: ['expression'],
          properties: {
            expression: { type: 'string', description: 'Math expression like "2+3*4"' },
          },
        },
      },
    },
  ];

  const toolCallParts: Map<number, { id: string; name: string; args: string }> = new Map();

  for await (const chunk of client.chatStream({
    messages: [
      { role: 'user', content: 'What is 17 * 23? Use the calculate tool.' },
    ],
    tools,
    tool_choice: 'auto',
    temperature: 0,
  })) {
    if (chunk.type === 'tool_call' && chunk.tool_calls) {
      for (const tc of chunk.tool_calls) {
        const idx = (tc as unknown as { index: number }).index ?? 0;
        const existing = toolCallParts.get(idx) || { id: '', name: '', args: '' };
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.name = tc.function.name;
        if (tc.function?.arguments) existing.args += tc.function.arguments;
        toolCallParts.set(idx, existing);
      }
    }
  }

  assert(toolCallParts.size > 0, 'stream should produce tool calls');
  for (const [idx, tc] of toolCallParts) {
    log('stream-tool', `[${idx}] ${tc.name}(${tc.args}) id=${tc.id}`);
  }
}

// ─── Runner ─────────────────────────────────────────────

const ALL_TESTS: Record<string, () => Promise<void>> = {
  models: testModels,
  chat: testChat,
  stream: testStream,
  tools: testToolCalling,
  file: testFileUpload,
  parallel: testParallelToolCalls,
  'stream-tool': testStreamToolCalling,
};

async function main() {
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║   Moonshot / Kimi K2.5 API Test Suite          ║');
  console.log('╚════════════════════════════════════════════════╝\n');
  console.log(`  Base URL:  ${BASE_URL}`);
  console.log(`  Model:     ${MODEL}`);
  console.log(`  API Key:   ${API_KEY.slice(0, 8)}...${API_KEY.slice(-4)}`);
  console.log();

  // Parse --only flag
  const onlyArg = process.argv.find(a => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.split('=')[1].split(',') : null;

  for (const [name, fn] of Object.entries(ALL_TESTS)) {
    if (only && !only.includes(name)) {
      console.log(`  ⏭  ${name} (skipped)`);
      skipped++;
      continue;
    }
    await runTest(name, fn);
  }

  console.log('\n────────────────────────────────────────────────');
  console.log(`  Total: ${passed + failed + skipped}  ✅ ${passed}  ❌ ${failed}  ⏭ ${skipped}`);
  console.log('────────────────────────────────────────────────\n');

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('\n💥 Unexpected error:', err);
  process.exit(1);
});
