/**
 * 2026-05-31 release201/30 §7 Phase 3 — `/api/admin/client-log` smoke test.
 *
 * Exercises body validation + payload shaping. Mocks `apiGuard` (no real auth)
 * and `logger` (capture structured fields). Real route module is under test
 * (not mocked) so the validation chain and pino dispatch wiring are both
 * verified.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const guardOk = vi.fn();
const loggerWarn = vi.fn();
const loggerError = vi.fn();

vi.mock('@/lib/api-guard', () => ({
  apiGuard: vi.fn(async () => guardOk()),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => loggerWarn(...args),
    error: (...args: unknown[]) => loggerError(...args),
  },
  createModuleLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { POST } from '@/app/api/admin/client-log/route';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/client-log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/admin/client-log', () => {
  beforeEach(() => {
    guardOk.mockReturnValue({
      ok: true,
      auth: {
        userId: 'user-42',
        email: 'tester@example.com',
        authType: 'jwt',
        authHeader: 'Bearer fake',
      },
    });
    loggerWarn.mockReset();
    loggerError.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('400s on missing msg', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- NextRequest accepts standard Request shape in route handlers
    const res = await POST(makeRequest({}) as any);
    expect(res.status).toBe(400);
    expect(loggerWarn).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('400s on invalid JSON', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    const res = await POST(makeRequest('{not json') as any);
    expect(res.status).toBe(400);
  });

  it('logs warn with traceId echoed back', async () => {
    const res = await POST(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      makeRequest({
        level: 'warn',
        msg: 'AssetCard fallback',
        traceId: 'trace_abc123',
        meta: { assetId: 'a1' },
      }) as any,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.traceId).toBe('trace_abc123');

    expect(loggerWarn).toHaveBeenCalledTimes(1);
    const [args, msg] = loggerWarn.mock.calls[0];
    expect((args as Record<string, unknown>).component).toBe('[client-log]');
    expect((args as Record<string, unknown>).traceId).toBe('trace_abc123');
    expect((args as Record<string, unknown>).userId).toBe('user-42');
    expect(msg).toBe('AssetCard fallback');
  });

  it('uses error logger for level=error', async () => {
    const res = await POST(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      makeRequest({
        level: 'error',
        msg: 'ConsistencyError type=file no attachments + no fileUrl',
        traceId: 'trace_def456',
      }) as any,
    );
    expect(res.status).toBe(200);
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it('drops malformed traceId before logging', async () => {
    const res = await POST(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      makeRequest({
        level: 'warn',
        msg: 'upload retry exhausted',
        traceId: 'bad/value with spaces',
      }) as any,
    );
    expect(res.status).toBe(200);
    const [args] = loggerWarn.mock.calls[0];
    expect((args as Record<string, unknown>).traceId).toBeUndefined();
    // response should also not echo malformed id
    const body = await res.json();
    expect(body.traceId).toBeUndefined();
  });

  it('rejects oversize body', async () => {
    const huge = 'x'.repeat(5 * 1024);
    const res = await POST(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      makeRequest({ level: 'warn', msg: 'big', meta: { blob: huge } }) as any,
    );
    expect(res.status).toBe(413);
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it('passes through guard 401 response', async () => {
    guardOk.mockReturnValue({
      ok: false,
      response: new Response(JSON.stringify({ ok: false }), { status: 401 }),
    });
    const res = await POST(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      makeRequest({ level: 'warn', msg: 'whatever' }) as any,
    );
    expect(res.status).toBe(401);
    expect(loggerWarn).not.toHaveBeenCalled();
  });
});
