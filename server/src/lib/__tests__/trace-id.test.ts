import { describe, expect, it } from 'vitest';
import {
  generateServerTraceId,
  getOrGenerateTraceId,
  isValidTraceId,
  TRACE_HEADER,
} from '@/lib/trace-id';

describe('trace-id (server)', () => {
  it('generateServerTraceId emits the expected shape', () => {
    const id = generateServerTraceId();
    expect(id.startsWith('trace_s_')).toBe(true);
    expect(isValidTraceId(id)).toBe(true);
  });

  it('generateServerTraceId honors custom prefix', () => {
    const id = generateServerTraceId('boot');
    expect(id.startsWith('boot_')).toBe(true);
    expect(isValidTraceId(id)).toBe(true);
  });

  it('isValidTraceId rejects clearly malformed values', () => {
    expect(isValidTraceId('')).toBe(false);
    // too short
    expect(isValidTraceId('abc')).toBe(false);
    // disallowed punctuation
    expect(isValidTraceId('hello world')).toBe(false);
    expect(isValidTraceId('hello/path')).toBe(false);
    // too long (>40 chars)
    expect(isValidTraceId('a'.repeat(41))).toBe(false);
  });

  it('isValidTraceId accepts ordinary frontend-mint shape', () => {
    expect(isValidTraceId('trace_abc123')).toBe(true);
    expect(isValidTraceId('trace_s_zz09zz09')).toBe(true);
  });

  it('generateServerTraceId returns reasonably unique ids', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateServerTraceId());
    // Collision in 200 draws of a 36^8 space is astronomically unlikely.
    expect(seen.size).toBe(200);
  });

  it('getOrGenerateTraceId preserves a valid incoming header', () => {
    const c = {
      req: {
        header: (name: string) => (name === TRACE_HEADER ? 'trace_user12' : undefined),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal Context stub
    const out = getOrGenerateTraceId(c as any);
    expect(out).toBe('trace_user12');
  });

  it('getOrGenerateTraceId mints a fresh id when header is missing', () => {
    const c = {
      req: { header: () => undefined },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal Context stub
    const out = getOrGenerateTraceId(c as any);
    expect(isValidTraceId(out)).toBe(true);
    expect(out.startsWith('trace_s_')).toBe(true);
  });

  it('getOrGenerateTraceId rejects malformed incoming header and mints fresh', () => {
    const c = {
      req: { header: () => 'bad/value-with/slashes' },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal Context stub
    const out = getOrGenerateTraceId(c as any);
    expect(out).not.toBe('bad/value-with/slashes');
    expect(isValidTraceId(out)).toBe(true);
  });
});
