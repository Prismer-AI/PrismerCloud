import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getLlmProxyStreamBodyTimeoutMs,
  getLlmProxyTimeoutMs,
  withLlmProxyStreamingDispatcher,
} from '@/lib/llm-proxy-upstream';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('llm-proxy upstream dispatcher config', () => {
  it('keeps streaming body timeout disabled by default', () => {
    expect(getLlmProxyTimeoutMs()).toBe(120_000);
    expect(getLlmProxyStreamBodyTimeoutMs()).toBe(0);
  });

  it('honours explicit timeout env overrides', () => {
    vi.stubEnv('LLM_PROXY_TIMEOUT_MS', '180000');
    vi.stubEnv('LLM_PROXY_STREAM_BODY_TIMEOUT_MS', '900000');

    expect(getLlmProxyTimeoutMs()).toBe(180_000);
    expect(getLlmProxyStreamBodyTimeoutMs()).toBe(900_000);
  });

  it('only attaches an undici dispatcher for streaming requests', () => {
    const nonStreaming = withLlmProxyStreamingDispatcher({ method: 'POST' }, false) as RequestInit & {
      dispatcher?: unknown;
    };
    const streaming = withLlmProxyStreamingDispatcher({ method: 'POST' }, true) as RequestInit & {
      dispatcher?: unknown;
    };

    expect(nonStreaming.dispatcher).toBeUndefined();
    expect(streaming.dispatcher).toBeTruthy();
  });
});
