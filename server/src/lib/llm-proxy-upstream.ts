import { Agent as UndiciAgent } from 'undici';

const DEFAULT_LLM_PROXY_TIMEOUT_MS = 120_000;
const DEFAULT_STREAM_BODY_TIMEOUT_MS = 0;

const streamingDispatchers = new Map<string, UndiciAgent>();

function parseNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getLlmProxyTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.LLM_PROXY_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LLM_PROXY_TIMEOUT_MS;
}

export function getLlmProxyStreamBodyTimeoutMs(): number {
  return parseNonNegativeIntEnv('LLM_PROXY_STREAM_BODY_TIMEOUT_MS', DEFAULT_STREAM_BODY_TIMEOUT_MS);
}

function getStreamingDispatcher(headersTimeoutMs: number, bodyTimeoutMs: number): UndiciAgent {
  const key = `${headersTimeoutMs}:${bodyTimeoutMs}`;
  const cached = streamingDispatchers.get(key);
  if (cached) return cached;

  const dispatcher = new UndiciAgent({
    headersTimeout: headersTimeoutMs,
    // Undici defaults bodyTimeout to 300s. LLM streams can legitimately go
    // quiet while a model/tool step is running, so the proxy must not inject
    // its own 5-minute upstream body watchdog unless explicitly configured.
    bodyTimeout: bodyTimeoutMs,
  });
  streamingDispatchers.set(key, dispatcher);
  return dispatcher;
}

export function withLlmProxyStreamingDispatcher(init: RequestInit, isStreaming: boolean): RequestInit {
  if (!isStreaming) return init;
  const headersTimeoutMs = getLlmProxyTimeoutMs();
  const bodyTimeoutMs = getLlmProxyStreamBodyTimeoutMs();
  return {
    ...init,
    dispatcher: getStreamingDispatcher(headersTimeoutMs, bodyTimeoutMs),
  } as RequestInit;
}
