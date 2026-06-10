/**
 * Responses ↔ Chat Completions bridge (release202/03 §3.1 方案 A).
 *
 * Why: Codex (>= v0.133) speaks ONLY the OpenAI Responses API, but our curated
 * models (us-kimi-k2.6 / gemini / deepseek) sit on newapi channels whose
 * Responses implementation is incomplete (e.g. ark rejects Codex's
 * `type:"namespace"` tools — codex-rs/tools/src/tool_spec.rs:14-21). Rather than
 * depend on per-channel Responses support, this bridge accepts Codex's Responses
 * request, translates it to a Chat Completions request (flattening namespace
 * tools to plain function tools, dropping reasoning/store/include), forwards via
 * the normal chat proxy, then synthesizes a Codex-correct Responses event stream
 * from the chat response.
 *
 * This keeps everything in our control: one sk-prismer key + our gateway drives
 * any chat model from Codex.
 */

import { randomUUID } from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Request: Responses → Chat Completions
// ─────────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

interface ResponsesTool {
  type: string;
  name?: string;
  description?: string;
  parameters?: unknown;
  strict?: boolean;
  tools?: ResponsesTool[]; // namespace wrapper carries inner function tools
}

/** Flatten a Responses `tools` array into Chat `tools` (function only). */
function toChatTools(tools: unknown): Json[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: Json[] = [];
  const pushFn = (t: ResponsesTool) => {
    if (!t?.name) return;
    out.push({
      type: 'function',
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.parameters ?? { type: 'object', properties: {} },
      },
    });
  };
  for (const raw of tools as ResponsesTool[]) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.type === 'function') pushFn(raw);
    // codex namespace tool = grouped MCP function tools; flatten inner functions
    else if (raw.type === 'namespace' && Array.isArray(raw.tools)) {
      for (const inner of raw.tools) if (inner?.type === 'function') pushFn(inner);
    }
    // drop web_search / image_generation / tool_search / custom (no chat equiv)
  }
  return out.length ? out : undefined;
}

/** Extract text from a Responses content part array or string. */
function partsToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => {
      if (typeof p === 'string') return p;
      const o = p as Json;
      if (o.type === 'input_text' || o.type === 'output_text' || o.type === 'text') {
        return typeof o.text === 'string' ? o.text : '';
      }
      return '';
    })
    .join('');
}

/** Translate Responses `input` (string | item[]) + instructions → chat messages. */
function toChatMessages(body: Json): Json[] {
  const messages: Json[] = [];
  if (typeof body.instructions === 'string' && body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }
  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Json;
    const type = item.type;
    if (type === 'message' || type === undefined) {
      // Codex uses the OpenAI `developer` role; chat-completions upstreams
      // (kimi/moonshot) reject unknown roles ("tokenization failed") → map to system.
      const rawRole = (item.role as string) || 'user';
      const role = rawRole === 'developer' ? 'system' : rawRole;
      messages.push({ role, content: partsToText(item.content) });
    } else if (type === 'function_call') {
      // assistant tool call. `reasoning_content:''` keeps thinking models
      // (e.g. kimi-k2.6) happy on continuation turns — they reject an assistant
      // tool-call message with no reasoning_content ("thinking is enabled but
      // reasoning_content is missing"); harmless (ignored) for other models.
      messages.push({
        role: 'assistant',
        content: null,
        reasoning_content: '',
        tool_calls: [
          {
            id: (item.call_id as string) || (item.id as string) || randomUUID(),
            type: 'function',
            function: { name: item.name, arguments: (item.arguments as string) ?? '{}' },
          },
        ],
      });
    } else if (type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: (item.call_id as string) || (item.id as string) || '',
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
      });
    }
    // ignore reasoning items etc.
  }
  return messages;
}

/** Build a Chat Completions request body from a Responses request body. */
export function responsesToChatRequest(body: Json): Json {
  const chat: Json = {
    model: body.model,
    messages: toChatMessages(body),
    stream: body.stream !== false,
  };
  const tools = toChatTools(body.tools);
  if (tools) {
    chat.tools = tools;
    if (body.tool_choice !== undefined) chat.tool_choice = body.tool_choice;
    if (body.parallel_tool_calls !== undefined) chat.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (typeof body.max_output_tokens === 'number') chat.max_tokens = body.max_output_tokens;
  if (typeof body.temperature === 'number') chat.temperature = body.temperature;
  if (typeof body.top_p === 'number') chat.top_p = body.top_p;
  // Intentionally dropped: reasoning, store, include, prompt_cache_key, text,
  // truncation — chat models / non-reasoning upstreams reject these.
  return chat;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response: Chat Completions → Responses (non-streaming)
// ─────────────────────────────────────────────────────────────────────────────

function newRespId() {
  return `resp_${randomUUID().replace(/-/g, '')}`;
}
function newMsgId() {
  return `msg_${randomUUID().replace(/-/g, '')}`;
}
function newFcId() {
  return `fc_${randomUUID().replace(/-/g, '')}`;
}

function mapUsage(u: Json | undefined): Json | undefined {
  if (!u) return undefined;
  const input = (u.prompt_tokens as number) ?? 0;
  const output = (u.completion_tokens as number) ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: (u.total_tokens as number) ?? input + output,
  };
}

/** Translate a non-streaming chat completion JSON into a Responses object. */
export function chatToResponsesObject(chat: Json, model: string): Json {
  const choice = (Array.isArray(chat.choices) ? chat.choices[0] : {}) as Json;
  const msg = (choice?.message ?? {}) as Json;
  const output: Json[] = [];
  const text = typeof msg.content === 'string' ? msg.content : '';
  if (text) {
    output.push({
      type: 'message',
      id: newMsgId(),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls as Json[]) {
      const fn = (tc.function ?? {}) as Json;
      output.push({
        type: 'function_call',
        id: newFcId(),
        call_id: (tc.id as string) || newFcId(),
        name: fn.name,
        arguments: (fn.arguments as string) ?? '{}',
        status: 'completed',
      });
    }
  }
  return {
    id: (chat.id as string) ? `resp_${chat.id}` : newRespId(),
    object: 'response',
    created_at: (chat.created as number) ?? Math.floor(Date.now() / 1000),
    status: 'completed',
    model: (chat.model as string) || model,
    output,
    usage: mapUsage(chat.usage as Json | undefined),
    parallel_tool_calls: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Response: Chat Completions SSE → Responses SSE (streaming)
// ─────────────────────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

function sse(event: string, data: Json): Uint8Array {
  return enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Transform an upstream chat-completions SSE stream into a Codex-correct
 * Responses SSE stream. Handles the text path and function_call path.
 */
export function chatStreamToResponsesStream(
  upstream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const respId = newRespId();
  const msgId = newMsgId();
  let seq = 0;
  const next = () => seq++;

  const baseResponse = (status: string, extra?: Json): Json => ({
    id: respId,
    object: 'response',
    status,
    model,
    output: [],
    ...extra,
  });

  let started = false; // response.created emitted
  let textItemOpen = false; // message output_item + content_part opened
  let textBuf = '';
  let outputIndex = 0;
  // function call accumulation: index → {callId, name, argsBuf, itemId, opened}
  const fcs = new Map<number, { callId: string; name: string; args: string; itemId: string; outputIndex: number }>();
  let usage: Json | undefined;
  let upstreamModel = model;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      let buf = '';

      const ensureStarted = () => {
        if (started) return;
        started = true;
        controller.enqueue(sse('response.created', { type: 'response.created', sequence_number: next(), response: baseResponse('in_progress') }));
        controller.enqueue(sse('response.in_progress', { type: 'response.in_progress', sequence_number: next(), response: baseResponse('in_progress') }));
      };

      const openTextItem = () => {
        if (textItemOpen) return;
        textItemOpen = true;
        outputIndex = fcs.size; // text item after any function items? keep simple: 0 if no fc yet
        controller.enqueue(sse('response.output_item.added', {
          type: 'response.output_item.added', sequence_number: next(), output_index: outputIndex,
          item: { type: 'message', id: msgId, status: 'in_progress', role: 'assistant', content: [] },
        }));
        controller.enqueue(sse('response.content_part.added', {
          type: 'response.content_part.added', sequence_number: next(), item_id: msgId,
          output_index: outputIndex, content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        }));
      };

      const handleChatChunk = (json: Json) => {
        if (typeof json.model === 'string') upstreamModel = json.model;
        if (json.usage) usage = mapUsage(json.usage as Json);
        const choice = (Array.isArray(json.choices) ? json.choices[0] : undefined) as Json | undefined;
        if (!choice) return;
        const delta = (choice.delta ?? {}) as Json;
        ensureStarted();

        if (typeof delta.content === 'string' && delta.content.length) {
          openTextItem();
          textBuf += delta.content;
          controller.enqueue(sse('response.output_text.delta', {
            type: 'response.output_text.delta', sequence_number: next(), item_id: msgId,
            output_index: outputIndex, content_index: 0, delta: delta.content,
          }));
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tcRaw of delta.tool_calls as Json[]) {
            const idx = (tcRaw.index as number) ?? 0;
            const fn = (tcRaw.function ?? {}) as Json;
            let fc = fcs.get(idx);
            if (!fc) {
              const itemId = newFcId();
              fc = { callId: (tcRaw.id as string) || itemId, name: (fn.name as string) || '', args: '', itemId, outputIndex: 100 + idx };
              fcs.set(idx, fc);
              controller.enqueue(sse('response.output_item.added', {
                type: 'response.output_item.added', sequence_number: next(), output_index: fc.outputIndex,
                item: { type: 'function_call', id: fc.itemId, call_id: fc.callId, name: fc.name, arguments: '', status: 'in_progress' },
              }));
            }
            if (typeof fn.name === 'string' && fn.name && !fc.name) fc.name = fn.name;
            if (typeof fn.arguments === 'string' && fn.arguments) {
              fc.args += fn.arguments;
              controller.enqueue(sse('response.function_call_arguments.delta', {
                type: 'response.function_call_arguments.delta', sequence_number: next(),
                item_id: fc.itemId, output_index: fc.outputIndex, delta: fn.arguments,
              }));
            }
          }
        }
      };

      const finish = () => {
        // close text item
        if (textItemOpen) {
          controller.enqueue(sse('response.output_text.done', {
            type: 'response.output_text.done', sequence_number: next(), item_id: msgId,
            output_index: outputIndex, content_index: 0, text: textBuf,
          }));
          controller.enqueue(sse('response.content_part.done', {
            type: 'response.content_part.done', sequence_number: next(), item_id: msgId,
            output_index: outputIndex, content_index: 0,
            part: { type: 'output_text', text: textBuf, annotations: [] },
          }));
          controller.enqueue(sse('response.output_item.done', {
            type: 'response.output_item.done', sequence_number: next(), output_index: outputIndex,
            item: { type: 'message', id: msgId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: textBuf, annotations: [] }] },
          }));
        }
        // close function items
        const output: Json[] = [];
        if (textItemOpen) output.push({ type: 'message', id: msgId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: textBuf, annotations: [] }] });
        for (const fc of fcs.values()) {
          controller.enqueue(sse('response.function_call_arguments.done', {
            type: 'response.function_call_arguments.done', sequence_number: next(),
            item_id: fc.itemId, output_index: fc.outputIndex, arguments: fc.args,
          }));
          controller.enqueue(sse('response.output_item.done', {
            type: 'response.output_item.done', sequence_number: next(), output_index: fc.outputIndex,
            item: { type: 'function_call', id: fc.itemId, call_id: fc.callId, name: fc.name, arguments: fc.args, status: 'completed' },
          }));
          output.push({ type: 'function_call', id: fc.itemId, call_id: fc.callId, name: fc.name, arguments: fc.args, status: 'completed' });
        }
        if (!started) {
          // empty completion — still emit a minimal valid response
          ensureStarted();
        }
        controller.enqueue(sse('response.completed', {
          type: 'response.completed', sequence_number: next(),
          response: { id: respId, object: 'response', status: 'completed', model: upstreamModel, output, usage, parallel_tool_calls: true },
        }));
        controller.close();
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const payload = t.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              handleChatChunk(JSON.parse(payload));
            } catch {
              // ignore unparseable keep-alive lines
            }
          }
        }
        finish();
      } catch (err) {
        try {
          controller.enqueue(sse('response.failed', {
            type: 'response.failed', sequence_number: next(),
            response: { id: respId, object: 'response', status: 'failed', model: upstreamModel, error: { message: String(err) } },
          }));
        } catch {
          /* controller may be closed */
        }
        controller.close();
      }
    },
  });
}
