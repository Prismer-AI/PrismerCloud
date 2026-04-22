/**
 * Prismer Wire — Deeplink Golden Fixture Tests (v1.9.0)
 *
 * Drives `fixtures/deeplinks.golden.json` through vitest — the JSON file is the
 * canonical specification (see docs/version190/07-remote-control.md §5.6.2).
 * The parser/serializer must satisfy every fixture; do not edit the JSON to
 * make tests pass — fix the code instead.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { parseDeeplink, serializeDeeplink, type PrismerDeeplink } from '../src/deeplinks.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface ValidCase {
  uri: string;
  expected: PrismerDeeplink;
  description: string;
}

interface InvalidCase {
  uri: string;
  expectedError: string;
  description: string;
}

interface EdgeCase {
  uri: string;
  expected?: PrismerDeeplink;
  expectedError?: string;
  description: string;
}

interface Golden {
  valid: ValidCase[];
  invalid: InvalidCase[];
  edgeCases: EdgeCase[];
}

const fixturesPath = join(__dirname, '../fixtures/deeplinks.golden.json');
const golden: Golden = JSON.parse(readFileSync(fixturesPath, 'utf-8'));

/**
 * Match an error against the golden `expectedError` substring. The fixture
 * uses the literal `"ZodError"` to mean "any ZodError", so check the error
 * class name as well as the message text.
 */
function errorMatches(err: unknown, needle: string): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message?.includes(needle)) return true;
  if (err.name === needle) return true;
  if (err.constructor?.name === needle) return true;
  return false;
}

describe('Deeplink golden fixtures — valid', () => {
  for (const testCase of golden.valid) {
    it(`parses: ${testCase.description}`, () => {
      const parsed = parseDeeplink(testCase.uri);
      expect(parsed).toEqual(testCase.expected);
    });

    it(`round-trips: ${testCase.description}`, () => {
      const parsed = parseDeeplink(testCase.uri);
      const serialized = serializeDeeplink(parsed);
      // Re-parse the serialized form — canonical form may reorder/strip query
      // params, so compare at the structural level, not the raw string level.
      const reparsed = parseDeeplink(serialized);
      expect(reparsed).toEqual(testCase.expected);
    });
  }
});

describe('Deeplink golden fixtures — invalid', () => {
  for (const testCase of golden.invalid) {
    it(`rejects: ${testCase.description}`, () => {
      let threw: unknown;
      try {
        parseDeeplink(testCase.uri);
      } catch (e) {
        threw = e;
      }
      expect(threw, `expected ${testCase.uri} to throw`).toBeInstanceOf(Error);
      expect(
        errorMatches(threw, testCase.expectedError),
        `expected error to match "${testCase.expectedError}", got: ${
          (threw as Error)?.name
        }: ${(threw as Error)?.message}`,
      ).toBe(true);
    });
  }
});

describe('Deeplink golden fixtures — edge cases', () => {
  for (const testCase of golden.edgeCases) {
    if (testCase.expectedError) {
      it(`rejects: ${testCase.description}`, () => {
        let threw: unknown;
        try {
          parseDeeplink(testCase.uri);
        } catch (e) {
          threw = e;
        }
        expect(threw, `expected ${testCase.uri} to throw`).toBeInstanceOf(Error);
        expect(
          errorMatches(threw, testCase.expectedError!),
          `expected error to match "${testCase.expectedError}", got: ${
            (threw as Error)?.name
          }: ${(threw as Error)?.message}`,
        ).toBe(true);
      });
    } else if (testCase.expected) {
      it(`parses: ${testCase.description}`, () => {
        const parsed = parseDeeplink(testCase.uri);
        expect(parsed).toEqual(testCase.expected);
      });
    }
  }
});

describe('Deeplink explicit serialize cases', () => {
  it('serializes user link', () => {
    expect(
      serializeDeeplink({ scheme: 'prismer', kind: 'user', userId: 'user-123' }),
    ).toBe('prismer://u/user-123');
  });

  it('serializes chat link', () => {
    expect(
      serializeDeeplink({ scheme: 'prismer', kind: 'chat', convId: 'conv-456' }),
    ).toBe('prismer://chat/conv-456');
  });

  it('serializes pair link with source', () => {
    const uri = serializeDeeplink({
      scheme: 'prismer',
      kind: 'pair',
      offer: 'test-offer',
      source: 'qr',
    });
    expect(uri.startsWith('prismer://pair?')).toBe(true);
    expect(uri).toContain('offer=test-offer');
    expect(uri).toContain('source=qr');
  });

  it('serializes legacy invoke link', () => {
    const uri = serializeDeeplink({
      scheme: 'prismer',
      action: 'invoke',
      skill: 'test-skill',
      args: '{}',
      sessionId: 'session-123',
    });
    expect(uri.startsWith('prismer://invoke?')).toBe(true);
    expect(uri).toContain('skill=test-skill');
    expect(uri).toContain('args=%7B%7D');
    expect(uri).toContain('sessionId=session-123');
  });

  it('serializes legacy open link', () => {
    expect(
      serializeDeeplink({
        scheme: 'prismer',
        action: 'open',
        target: '/path/to/file.ts',
      }),
    ).toBe('prismer://open?target=%2Fpath%2Fto%2Ffile.ts');
  });
});
