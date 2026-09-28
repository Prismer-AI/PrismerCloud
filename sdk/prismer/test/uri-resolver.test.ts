import { describe, expect, it } from 'vitest';
import { parseUris } from '../src/uri-resolver.js';

describe('parseUris', () => {
  it('returns empty for plain text', () => {
    expect(parseUris('hello world')).toEqual([]);
  });

  it('extracts a single asset URI', () => {
    const out = parseUris('see prismer://tom/asset/sha256-abc123 thanks');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      raw: 'prismer://tom/asset/sha256-abc123',
      owner: 'tom',
      type: 'asset',
      rest: 'sha256-abc123',
    });
  });

  it('extracts a file URI with workspace + path', () => {
    const out = parseUris('PRD at prismer://pm/file/ws-1/docs/prd.md ok');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: 'file',
      owner: 'pm',
      workspaceId: 'ws-1',
      filePath: 'docs/prd.md',
    });
  });

  it('extracts multiple URIs', () => {
    const text = '[a](prismer://x/asset/h1) and [b](prismer://y/file/ws/path.md) end.';
    const out = parseUris(text);
    expect(out.map((u) => u.type)).toEqual(['asset', 'file']);
  });

  it('does not match other prismer:// types (memory/conversation/...)', () => {
    expect(parseUris('see prismer://x/memory/note')).toEqual([]);
    expect(parseUris('see prismer://x/conversation/abc')).toEqual([]);
  });

  it('stops at delimiters (whitespace, paren, bracket)', () => {
    const out = parseUris('look at (prismer://o/asset/h1) here');
    expect(out[0]!.raw).toBe('prismer://o/asset/h1');
  });

  // Wave-54 B5: workspace-form URIs from doc 26.
  it('extracts workspace-form asset URI with explicit wsId', () => {
    const out = parseUris('check prismer://workspace/ws-A/asset/h1 please');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      raw: 'prismer://workspace/ws-A/asset/h1',
      owner: 'workspace',
      type: 'asset',
      rest: 'h1',
      workspaceId: 'ws-A',
    });
  });

  it('extracts workspace-form file URI with path', () => {
    const out = parseUris('see prismer://workspace/ws-A/file/docs/prd.md ok');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: 'file',
      owner: 'workspace',
      workspaceId: 'ws-A',
      filePath: 'docs/prd.md',
    });
  });

  it('mixes workspace-form and legacy-form in one string', () => {
    const out = parseUris(
      'new prismer://workspace/ws-1/asset/h1 and old prismer://tom/file/ws-2/p.md end',
    );
    expect(out).toHaveLength(2);
    const ws = out.find((u) => u.owner === 'workspace');
    const legacy = out.find((u) => u.owner === 'tom');
    expect(ws?.workspaceId).toBe('ws-1');
    expect(legacy?.workspaceId).toBe('ws-2');
    expect(legacy?.filePath).toBe('p.md');
  });

  it('returns a workspace-form URI only once even if it appears twice', () => {
    const text = 'a prismer://workspace/ws/asset/h then b prismer://workspace/ws/asset/h end';
    const out = parseUris(text);
    expect(out).toHaveLength(1);
  });
});
