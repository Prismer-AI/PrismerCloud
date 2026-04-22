import { describe, it, expect } from 'vitest';
import { normalizeCallId, normalizeTimestamp, normalizeSessionId, normalizeRiskTag, isUuidV4 } from '../src/normalize.js';

describe('normalizeCallId', () => {
  it('passes through a non-empty string unchanged', () => {
    expect(normalizeCallId('my-call-id')).toBe('my-call-id');
  });

  it('trims whitespace from strings', () => {
    expect(normalizeCallId('  abc  ')).toBe('abc');
  });

  it('generates a UUID-like string for undefined', () => {
    const id = normalizeCallId(undefined);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('generates a UUID-like string for null', () => {
    const id = normalizeCallId(null);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('generates a new ID for empty string', () => {
    const id = normalizeCallId('');
    expect(id.length).toBeGreaterThan(0);
  });

  it('generates unique IDs on successive calls', () => {
    const a = normalizeCallId(undefined);
    const b = normalizeCallId(undefined);
    expect(a).not.toBe(b);
  });
});

describe('normalizeTimestamp', () => {
  it('passes through a valid ms number', () => {
    const ms = 1_700_000_000_000;
    expect(normalizeTimestamp(ms)).toBe(ms);
  });

  it('converts a Date to ms', () => {
    const d = new Date('2024-01-15T00:00:00Z');
    expect(normalizeTimestamp(d)).toBe(d.getTime());
  });

  it('parses an ISO 8601 string', () => {
    const iso = '2024-01-15T12:00:00.000Z';
    expect(normalizeTimestamp(iso)).toBe(Date.parse(iso));
  });

  it('falls back to Date.now() for undefined', () => {
    const before = Date.now();
    const result = normalizeTimestamp(undefined);
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });

  it('falls back to Date.now() for invalid string', () => {
    const before = Date.now();
    const result = normalizeTimestamp('not-a-date');
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });

  it('falls back to Date.now() for NaN', () => {
    const result = normalizeTimestamp(NaN);
    expect(typeof result).toBe('number');
    expect(isFinite(result)).toBe(true);
  });
});

describe('normalizeSessionId', () => {
  it('passes through a non-empty string', () => {
    expect(normalizeSessionId('sess-abc')).toBe('sess-abc');
  });

  it('trims whitespace', () => {
    expect(normalizeSessionId('  sess  ')).toBe('sess');
  });

  it('uses fallback when raw is empty', () => {
    expect(normalizeSessionId('', 'fallback-id')).toBe('fallback-id');
  });

  it('uses fallback when raw is undefined', () => {
    expect(normalizeSessionId(undefined, 'fallback-id')).toBe('fallback-id');
  });

  it('generates a new ID when both raw and fallback are absent', () => {
    const id = normalizeSessionId(undefined);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('generates a new ID when both raw and fallback are empty', () => {
    const id = normalizeSessionId('', '');
    expect(id.length).toBeGreaterThan(0);
  });
});

describe('normalizeRiskTag', () => {
  it('Read → low', () => expect(normalizeRiskTag('Read', 'file.ts')).toBe('low'));
  it('Glob → low', () => expect(normalizeRiskTag('Glob', '**/*.ts')).toBe('low'));
  it('Grep → low', () => expect(normalizeRiskTag('Grep', 'pattern')).toBe('low'));
  it('LS → low', () => expect(normalizeRiskTag('ls', '')).toBe('low'));

  it('Edit → mid', () => expect(normalizeRiskTag('Edit', 'file.ts')).toBe('mid'));
  it('Write → mid', () => expect(normalizeRiskTag('Write', 'file.ts')).toBe('mid'));

  it('Bash with rm → high', () => expect(normalizeRiskTag('Bash', 'rm -rf /tmp')).toBe('high'));
  it('Bash with curl → high', () => expect(normalizeRiskTag('Bash', 'curl https://example.com')).toBe('high'));
  it('Bash with sudo → high', () => expect(normalizeRiskTag('Bash', 'sudo npm install')).toBe('high'));
  it('Bash with wget → high', () => expect(normalizeRiskTag('Bash', 'wget https://x.com/file')).toBe('high'));

  it('Bash with non-destructive cmd → mid', () => {
    expect(normalizeRiskTag('Bash', 'npm run build')).toBe('mid');
  });

  it('unknown tool → mid', () => expect(normalizeRiskTag('UnknownTool', {})).toBe('mid'));
});

describe('isUuidV4', () => {
  it('accepts valid UUIDv4 strings', () => {
    // 4th group starts with '4', variant bits in 5th group start with [89ab]
    expect(isUuidV4('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(true);
    expect(isUuidV4('550e8400-e29b-4000-a716-446655440000')).toBe(true);
    expect(isUuidV4('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('rejects non-UUID strings', () => {
    expect(isUuidV4('not-a-uuid')).toBe(false);
    expect(isUuidV4('')).toBe(false);
    // version 1 (third group starts with 1)
    expect(isUuidV4('550e8400-e29b-11d4-a716-446655440000')).toBe(false);
  });
});
