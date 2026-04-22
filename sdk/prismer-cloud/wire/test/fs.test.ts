/**
 * @prismer/wire — fs.ts test suite
 *
 * Covers FsRequest union (all 6 ops), FsResponse ok + error branches,
 * and the specialised FsPermissionDenied shape.
 */

import { describe, it, expect } from 'vitest';
import {
  FsRequestSchema,
  FsResponseSchema,
  FsPermissionDeniedSchema,
  FsErrorCodeSchema,
} from '../src/fs.js';

function mustParse<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  return schema.parse(value);
}

function mustFail(schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown): void {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
}

describe('FsRequest', () => {
  it('read', () => {
    mustParse(FsRequestSchema, { op: 'read', path: '/w/a.txt' });
  });

  it('read with offset+limit', () => {
    mustParse(FsRequestSchema, { op: 'read', path: '/w/a.txt', offset: 100, limit: 1024 });
  });

  it('write with utf8', () => {
    mustParse(FsRequestSchema, { op: 'write', path: '/w/b.txt', content: 'hello' });
  });

  it('write with base64', () => {
    mustParse(FsRequestSchema, {
      op: 'write',
      path: '/w/bin.dat',
      content: 'aGVsbG8=',
      encoding: 'base64',
    });
  });

  it('delete', () => {
    mustParse(FsRequestSchema, { op: 'delete', path: '/w/stale' });
  });

  it('edit with replaceAll', () => {
    mustParse(FsRequestSchema, {
      op: 'edit',
      path: '/w/b.txt',
      oldString: 'foo',
      newString: 'bar',
      replaceAll: true,
    });
  });

  it('list with maxDepth', () => {
    mustParse(FsRequestSchema, { op: 'list', path: '/w', maxDepth: 3 });
  });

  it('search with glob', () => {
    mustParse(FsRequestSchema, {
      op: 'search',
      query: 'TODO',
      path: '/w/src',
      glob: '**/*.ts',
    });
  });

  it('rejects unknown op', () => {
    mustFail(FsRequestSchema, { op: 'chmod', path: '/w/a' });
  });

  it('rejects empty path on read', () => {
    mustFail(FsRequestSchema, { op: 'read', path: '' });
  });

  it('rejects missing oldString on edit', () => {
    mustFail(FsRequestSchema, { op: 'edit', path: '/w/a', newString: 'x' });
  });
});

describe('FsResponse — success branch', () => {
  it('read ok', () => {
    mustParse(FsResponseSchema, {
      ok: true,
      op: 'read',
      content: 'hi',
      bytes: 2,
      encoding: 'utf8',
    });
  });

  it('write ok', () => {
    mustParse(FsResponseSchema, { ok: true, op: 'write', bytes: 100 });
  });

  it('list ok with entries', () => {
    mustParse(FsResponseSchema, {
      ok: true,
      op: 'list',
      entries: [
        { path: 'a.txt', type: 'file', size: 42 },
        { path: 'sub', type: 'directory' },
      ],
    });
  });

  it('search ok with matches', () => {
    mustParse(FsResponseSchema, {
      ok: true,
      op: 'search',
      matches: [{ path: '/w/a.ts', line: 3, snippet: 'TODO: fix' }],
    });
  });
});

describe('FsResponse — error branch', () => {
  it('permission_denied error', () => {
    mustParse(FsResponseSchema, {
      ok: false,
      code: 'permission_denied',
      error: 'rule deny matched',
      op: 'read',
      path: '/etc/passwd',
    });
  });

  it('outside_sandbox error', () => {
    mustParse(FsResponseSchema, {
      ok: false,
      code: 'outside_sandbox',
      error: 'Path outside sandbox: /tmp/x',
    });
  });

  it('rejects error with unknown code', () => {
    mustFail(FsResponseSchema, { ok: false, code: 'weird', error: 'x' });
  });
});

describe('FsPermissionDenied (approval_required specialisation)', () => {
  it('parses valid approval-required payload', () => {
    mustParse(FsPermissionDeniedSchema, {
      ok: false,
      code: 'approval_required',
      error: 'approval gate not configured',
      toolName: 'Write',
      path: '/w/new.txt',
      reason: 'ask rule matched',
    });
  });

  it('rejects missing toolName', () => {
    mustFail(FsPermissionDeniedSchema, {
      ok: false,
      code: 'approval_required',
      error: 'x',
      path: '/w/a',
      reason: 'r',
    });
  });
});

describe('FsErrorCode enum', () => {
  it('accepts every listed code', () => {
    const codes = [
      'permission_denied',
      'outside_sandbox',
      'approval_required',
      'not_found',
      'io_error',
      'invalid_arg',
      'unc_path',
      'symlink_refused',
      'frozen_path',
    ];
    for (const c of codes) {
      mustParse(FsErrorCodeSchema, c);
    }
  });

  it('rejects unlisted code', () => {
    mustFail(FsErrorCodeSchema, 'made_up');
  });
});
