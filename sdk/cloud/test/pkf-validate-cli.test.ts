/**
 * product209/15 PKF-D3 — `cloud pkf validate|inspect|project` exit-code
 * contract (structure 0/1, resolved 0/1/2) + section-op whole-page semantics
 * are covered at the policy-gate layer; here the CLI surface itself.
 */
import { describe, expect, it, vi } from 'vitest';
import { runPkfInspect, runPkfProject, runPkfValidate } from '../src/commands/pkf';

const VALID_V11 = `<script type="application/prismer+json">{"type":"note","title":"t","pkfVersion":"1.1"}</script><h2 id="a">A</h2><p>ok</p>`;
const INVALID_V11 = `<script type="application/prismer+json">{"type":"note","pkfVersion":"1.1"}</script><p><img src="prismer://asset/abc"></p>`;
const RESOURCE_V11 = `<script type="application/prismer+json">{"type":"note","pkfVersion":"1.1"}</script><p><img src="prismer://workspace/w/asset/${'a'.repeat(64)}"></p>`;

describe('pkf validate exit codes', () => {
  it('structure: valid v1.1 → 0', () => {
    expect(runPkfValidate({ source: VALID_V11, level: 'structure', json: false })).toBe(0);
  });

  it('structure: invalid v1.1 → 1 (business result, not transport)', () => {
    expect(runPkfValidate({ source: INVALID_V11, level: 'structure', json: false })).toBe(1);
  });

  it('resolved: resource doc without a resolver → 2 (unverified)', () => {
    expect(runPkfValidate({ source: RESOURCE_V11, level: 'resolved', json: false })).toBe(2);
  });

  it('resolved: structure failure → 1', () => {
    expect(runPkfValidate({ source: INVALID_V11, level: 'resolved', json: false })).toBe(1);
  });

  it('json payload carries the frozen wire fields', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = runPkfValidate({ source: RESOURCE_V11, level: 'resolved', json: true });
    expect(code).toBe(2);
    const payload = JSON.parse(write.mock.calls[0][0] as string);
    expect(payload).toMatchObject({
      structureStatus: 'pass',
      resourceStatus: 'unverified',
      strictOk: false,
    });
    expect(payload.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.schemaVersion).toBe('1.1');
    write.mockRestore();
  });
});

describe('pkf inspect / project', () => {
  it('inspect exits 0 and prints the structural summary', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(runPkfInspect(VALID_V11, false)).toBe(0);
    expect(String(write.mock.calls[0][0])).toContain('structure=pass');
    write.mockRestore();
  });

  it('inspect JSON receipt hashes the exact UTF-8 source bytes', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(runPkfInspect(VALID_V11, true)).toBe(0);
    const payload = JSON.parse(write.mock.calls[0][0] as string) as {
      sourceHash: string;
      counts: { sections: number };
    };
    expect(payload.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.counts.sections).toBe(1);
    write.mockRestore();
  });

  it('project emits markdown without executable content', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(runPkfProject(VALID_V11)).toBe(0);
    const md = String(write.mock.calls[0][0]);
    expect(md).toContain('# t');
    expect(md).toContain('## A');
    expect(md).not.toContain('<script');
    write.mockRestore();
  });
});
