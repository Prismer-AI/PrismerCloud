/**
 * Unit tests for PrismerClient error handling and edge cases.
 *
 * Mocks fetch via vi.fn() to test _request() error paths, constructor
 * validation, setToken(), and destroy().
 *
 * Usage:
 *   npx vitest run tests/unit/error-handling.test.ts --reporter=verbose
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrismerClient } from '../../src/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock Response-like object */
function mockResponse(
  status: number,
  body: unknown,
  options?: { ok?: boolean; headers?: Record<string, string> },
): Response {
  const ok = options?.ok ?? (status >= 200 && status < 300);
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok,
    status,
    statusText: `Status ${status}`,
    headers: new Headers(options?.headers),
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body),
    text: () => Promise.resolve(bodyStr),
    clone: () => mockResponse(status, body, options),
  } as unknown as Response;
}

/** Create a fetch mock that returns the given response */
function createFetchMock(response: Response): typeof fetch {
  return vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

/** Create a fetch mock that rejects with an error */
function createFetchErrorMock(error: Error): typeof fetch {
  return vi.fn().mockRejectedValue(error) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe('PrismerClient constructor', () => {
  it('emits a warning for invalid API key format', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const _client = new PrismerClient({
      apiKey: 'bad-key-format-12345',
      fetch: createFetchMock(mockResponse(200, { ok: true })),
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('sk-prismer-'),
    );
    warnSpy.mockRestore();
  });

  it('does not emit warning for valid sk-prismer- key', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const _client = new PrismerClient({
      apiKey: 'sk-prismer-live-abc123',
      fetch: createFetchMock(mockResponse(200, { ok: true })),
    });
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('sk-prismer-'),
    );
    warnSpy.mockRestore();
  });

  it('does not emit warning for JWT token (eyJ prefix)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const _client = new PrismerClient({
      apiKey: 'eyJhbGciOiJIUzI1NiJ9.test.signature',
      fetch: createFetchMock(mockResponse(200, { ok: true })),
    });
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('sk-prismer-'),
    );
    warnSpy.mockRestore();
  });

  it('accepts empty API key without warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const _client = new PrismerClient({
      apiKey: '',
      fetch: createFetchMock(mockResponse(200, { ok: true })),
    });
    // Empty string is falsy so the warning condition is skipped
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('sk-prismer-'),
    );
    warnSpy.mockRestore();
  });

  it('accepts no apiKey at all (anonymous mode)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const _client = new PrismerClient({
      fetch: createFetchMock(mockResponse(200, { ok: true })),
    });
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('sk-prismer-'),
    );
    warnSpy.mockRestore();
  });

  it('defaults to production base URL', () => {
    const fetchMock = createFetchMock(
      mockResponse(200, { success: true, mode: 'single_url' }),
    );
    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      fetch: fetchMock,
    });
    // Trigger a request so we can inspect the URL
    client.load('https://example.com');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('https://prismer.cloud'),
      expect.anything(),
    );
  });

  it('uses custom baseUrl over environment', () => {
    const fetchMock = createFetchMock(
      mockResponse(200, { success: true }),
    );
    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      baseUrl: 'https://custom.example.com',
      fetch: fetchMock,
    });
    client.load('https://example.com');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('https://custom.example.com'),
      expect.anything(),
    );
  });

  it('strips trailing slash from baseUrl', () => {
    const fetchMock = createFetchMock(
      mockResponse(200, { success: true }),
    );
    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      baseUrl: 'https://custom.example.com/',
      fetch: fetchMock,
    });
    client.load('https://example.com');
    const calledUrl = (fetchMock as any).mock.calls[0][0] as string;
    expect(calledUrl).not.toMatch(/\/\/api/);
    expect(calledUrl).toContain('https://custom.example.com/api');
  });
});

// ---------------------------------------------------------------------------
// _request() error paths
// ---------------------------------------------------------------------------

describe('_request() error handling', () => {
  it('timeout - AbortError returns code TIMEOUT', async () => {
    // Create a fetch that never resolves, simulating a timeout
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          // Listen for abort signal and reject with AbortError
          if (init.signal) {
            init.signal.addEventListener('abort', () => {
              const err = new DOMException('The operation was aborted.', 'AbortError');
              reject(err);
            });
          }
        });
      },
    ) as unknown as typeof fetch;

    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      timeout: 50, // Very short timeout
      fetch: fetchMock,
    });

    const result = await client.load('https://example.com');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('TIMEOUT');
    expect(result.error!.message).toContain('timed out');
  });

  it('network error returns code NETWORK_ERROR', async () => {
    const fetchMock = createFetchErrorMock(
      new TypeError('Failed to fetch'),
    );

    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      fetch: fetchMock,
    });

    const result = await client.load('https://example.com');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('NETWORK_ERROR');
    expect(result.error!.message).toContain('Failed to fetch');
  });

  it('401 response returns error from response body', async () => {
    const fetchMock = createFetchMock(
      mockResponse(401, {
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Invalid API key' },
      }),
    );

    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      fetch: fetchMock,
    });

    const result = await client.load('https://example.com');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('UNAUTHORIZED');
    expect(result.error!.message).toBe('Invalid API key');
  });

  it('401 with JWT token attempts token refresh', async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      callCount++;
      if (callCount === 1) {
        // First call: 401
        return Promise.resolve(
          mockResponse(401, { ok: false, error: { code: 'TOKEN_EXPIRED', message: 'Token expired' } }),
        );
      }
      if ((url as string).includes('/token/refresh')) {
        // Refresh call: return new token
        return Promise.resolve(
          mockResponse(200, { ok: true, data: { token: 'eyJnew-refreshed-token' } }),
        );
      }
      // Retry with new token: success
      return Promise.resolve(
        mockResponse(200, { success: true, ok: true, mode: 'single_url' }),
      );
    }) as unknown as typeof fetch;

    const client = new PrismerClient({
      apiKey: 'eyJhbGciOiJIUzI1NiJ9.original.token',
      fetch: fetchMock,
    });

    const result = await client.load('https://example.com');
    // The refresh + retry should succeed
    expect(result.success).toBe(true);
    // Should have made 3 calls: original, refresh, retry
    expect(callCount).toBe(3);
  });

  it('403 response returns error from response body', async () => {
    const fetchMock = createFetchMock(
      mockResponse(403, {
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
      }),
    );

    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      fetch: fetchMock,
    });

    const result = await client.load('https://example.com');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('FORBIDDEN');
    expect(result.error!.message).toBe('Insufficient permissions');
  });

  it('404 response returns meaningful error', async () => {
    const fetchMock = createFetchMock(
      mockResponse(404, {
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Resource not found' },
      }),
    );

    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      fetch: fetchMock,
    });

    const result = await client.load('https://example.com');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('NOT_FOUND');
    expect(result.error!.message).toBe('Resource not found');
  });

  it('404 without error body falls back to HTTP_ERROR', async () => {
    const fetchMock = createFetchMock(
      mockResponse(404, { ok: false }),
    );

    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      fetch: fetchMock,
    });

    const result = await client.load('https://example.com');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('HTTP_ERROR');
    expect(result.error!.message).toContain('404');
  });

  it('500 response returns server error', async () => {
    const fetchMock = createFetchMock(
      mockResponse(500, {
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      }),
    );

    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      fetch: fetchMock,
    });

    const result = await client.load('https://example.com');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('INTERNAL_ERROR');
  });

  it('non-JSON response body is handled gracefully', async () => {
    // response.json() will throw if body is not valid JSON
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      headers: new Headers(),
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
      text: () => Promise.resolve('<html>Bad Gateway</html>'),
    }) as unknown as typeof fetch;

    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      fetch: fetchMock,
    });

    const result = await client.load('https://example.com');
    // Should catch the SyntaxError and return NETWORK_ERROR
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('NETWORK_ERROR');
  });

  it('malformed JSON response body is handled gracefully', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
      text: () => Promise.resolve('{broken'),
    }) as unknown as typeof fetch;

    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      fetch: fetchMock,
    });

    const result = await client.load('https://example.com');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('NETWORK_ERROR');
  });

  it('sends Authorization header when apiKey is set', async () => {
    const fetchMock = createFetchMock(
      mockResponse(200, { success: true }),
    );

    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-mykey',
      fetch: fetchMock,
    });

    await client.load('https://example.com');
    const callArgs = (fetchMock as any).mock.calls[0];
    const init = callArgs[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer sk-prismer-live-mykey',
    );
  });

  it('sends X-IM-Agent header when imAgent is configured', async () => {
    const fetchMock = createFetchMock(
      mockResponse(200, { ok: true, data: {} }),
    );

    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      imAgent: 'my-agent-id',
      fetch: fetchMock,
    });

    await client.im.account.me();
    const callArgs = (fetchMock as any).mock.calls[0];
    const init = callArgs[1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-IM-Agent']).toBe(
      'my-agent-id',
    );
  });

  it('does not send Authorization header when apiKey is empty', async () => {
    const fetchMock = createFetchMock(
      mockResponse(200, { success: true }),
    );

    const client = new PrismerClient({
      apiKey: '',
      fetch: fetchMock,
    });

    await client.load('https://example.com');
    const callArgs = (fetchMock as any).mock.calls[0];
    const init = callArgs[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('appends query parameters to URL', async () => {
    const fetchMock = createFetchMock(
      mockResponse(200, { ok: true, data: [] }),
    );

    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      fetch: fetchMock,
    });

    await client.im.contacts.discover({ type: 'assistant', capability: 'testing' });
    const calledUrl = (fetchMock as any).mock.calls[0][0] as string;
    expect(calledUrl).toContain('type=assistant');
    expect(calledUrl).toContain('capability=testing');
  });

  it('sends JSON body with Content-Type header for POST requests', async () => {
    const fetchMock = createFetchMock(
      mockResponse(200, { ok: true, data: {} }),
    );

    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      fetch: fetchMock,
    });

    await client.im.account.register({
      type: 'agent',
      username: 'test',
      displayName: 'Test',
    });
    const callArgs = (fetchMock as any).mock.calls[0];
    const init = callArgs[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    const parsed = JSON.parse(init.body as string);
    expect(parsed.username).toBe('test');
  });
});

// ---------------------------------------------------------------------------
// setToken()
// ---------------------------------------------------------------------------

describe('setToken()', () => {
  it('updates the authorization header for subsequent requests', async () => {
    const fetchMock = createFetchMock(
      mockResponse(200, { success: true }),
    );

    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-original',
      fetch: fetchMock,
    });

    // First request with original key
    await client.load('https://example.com');
    let headers = ((fetchMock as any).mock.calls[0][1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-prismer-live-original');

    // Update token
    client.setToken('eyJnew-jwt-token');

    // Second request should use new token
    await client.load('https://example.com');
    headers = ((fetchMock as any).mock.calls[1][1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer eyJnew-jwt-token');
  });

  it('can switch from empty key to a valid key', async () => {
    const fetchMock = createFetchMock(
      mockResponse(200, { success: true }),
    );

    // Explicitly pass empty key to avoid picking up env var in test env
    const client = new PrismerClient({
      apiKey: '',
      fetch: fetchMock,
    });

    // First request without key
    await client.load('https://example.com');
    let headers = ((fetchMock as any).mock.calls[0][1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();

    // Set token
    client.setToken('sk-prismer-live-newkey');

    // Second request should have the key
    await client.load('https://example.com');
    headers = ((fetchMock as any).mock.calls[1][1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-prismer-live-newkey');
  });
});

// ---------------------------------------------------------------------------
// destroy()
// ---------------------------------------------------------------------------

describe('destroy()', () => {
  it('completes without error when no offline manager', async () => {
    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      fetch: createFetchMock(mockResponse(200, { ok: true })),
    });

    // Should resolve without throwing
    await expect(client.destroy()).resolves.toBeUndefined();
  });

  it('can be called multiple times safely', async () => {
    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      fetch: createFetchMock(mockResponse(200, { ok: true })),
    });

    await expect(client.destroy()).resolves.toBeUndefined();
    await expect(client.destroy()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// IM sub-client error propagation
// ---------------------------------------------------------------------------

describe('IM sub-client error propagation', () => {
  it('direct.send() propagates network error correctly', async () => {
    const fetchMock = createFetchErrorMock(new TypeError('DNS resolution failed'));

    const client = new PrismerClient({
      apiKey: 'eyJhbGciOiJIUzI1NiJ9.test.sig',
      fetch: fetchMock,
    });

    const result = await client.im.direct.send('user-123', 'Hello');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('NETWORK_ERROR');
    expect(result.error!.message).toContain('DNS resolution failed');
  });

  it('groups.create() propagates 500 error correctly', async () => {
    const fetchMock = createFetchMock(
      mockResponse(500, {
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Database connection failed' },
      }),
    );

    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      fetch: fetchMock,
    });

    const result = await client.im.groups.create({ title: 'Test Group' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('INTERNAL_ERROR');
  });

  it('credits.get() propagates timeout correctly', async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          if (init.signal) {
            init.signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }
        });
      },
    ) as unknown as typeof fetch;

    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      timeout: 50,
      fetch: fetchMock,
    });

    const result = await client.im.credits.get();
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('TIMEOUT');
  });

  it('conversations.list() propagates 401 error', async () => {
    const fetchMock = createFetchMock(
      mockResponse(401, {
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Invalid token' },
      }),
    );

    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-bad-key',
      fetch: fetchMock,
    });

    const result = await client.im.conversations.list();
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('UNAUTHORIZED');
  });

  it('messages.edit() on non-existent message returns error', async () => {
    const fetchMock = createFetchMock(
      mockResponse(404, {
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Message not found' },
      }),
    );

    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      fetch: fetchMock,
    });

    const result = await client.im.messages.edit(
      'conv-fake',
      'msg-does-not-exist',
      'new content',
    );
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Context API error paths
// ---------------------------------------------------------------------------

describe('Context API error paths', () => {
  it('save() with 400 returns validation error', async () => {
    const fetchMock = createFetchMock(
      mockResponse(400, {
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'url is required' },
      }),
    );

    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      fetch: fetchMock,
    });

    const result = await client.save({ url: '', hqcc: '' });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('VALIDATION_ERROR');
  });

  it('search() with 429 rate limit returns error', async () => {
    const fetchMock = createFetchMock(
      mockResponse(429, {
        success: false,
        error: { code: 'RATE_LIMIT', message: 'Too many requests' },
      }),
    );

    const client = new PrismerClient({
      apiKey: 'sk-prismer-live-test',
      fetch: fetchMock,
    });

    const result = await client.search('test query');
    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('RATE_LIMIT');
  });
});
