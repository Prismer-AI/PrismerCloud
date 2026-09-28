// product209/15 PKF-D3 — runtime native `pkf_validate` tool.
//
// Offline by construction: the tool runs the bundled core in-process — no
// daemon RPC, no shell-out, no cloud. Same golden fixture results as Cloud.

import { describe, expect, it } from 'vitest';
import { PKF_VALIDATE_TOOL, runPkfValidateLocal } from '../src/adapters/memory-tools.js';
import { HERMES_MEMORY_TOOLS } from '../src/adapters/persistence/hermes/memory-tools.js';

const VALID_V11 = `<script type="application/prismer+json">{"type":"note","title":"t","pkfVersion":"1.1"}</script><h2 id="a">A</h2><p>ok</p>`;
const INVALID_V11 = `<script type="application/prismer+json">{"type":"note","pkfVersion":"1.1"}</script><p><img src="prismer://asset/abc"></p>`;

describe('pkf_validate native tool', () => {
  it('is registered in the shared spec and the hermes adapter', () => {
    expect(PKF_VALIDATE_TOOL.name).toBe('pkf_validate');
    expect(PKF_VALIDATE_TOOL.inputSchema).toMatchObject({ type: 'object' });
    expect(HERMES_MEMORY_TOOLS.some((t) => t.function.name === 'pkf_validate')).toBe(true);
  });

  it('validates valid v1.1 in-process (no shell-out, no network)', () => {
    const out = runPkfValidateLocal({ source: VALID_V11 });
    expect(out.structureStatus).toBe('pass');
    expect(out.strictOk).toBe(true);
    expect(out.schemaVersion).toBe('1.1');
    expect(out.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects invalid v1.1 with stable diagnostics — same result as Cloud', () => {
    const out = runPkfValidateLocal({ source: INVALID_V11 });
    expect(out.structureStatus).toBe('fail');
    expect(out.diagnostics.some((d) => d.code === 'bare-asset-uri')).toBe(true);
  });
});
