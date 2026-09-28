import { describe, expect, it } from 'vitest';
import { inferAgentOutputMime, validateAgentOutputAsset } from '../src/daemon/asset/agent-output-policy.js';

const MB = 1024 * 1024;

describe('Runtime agent-output PKF policy', () => {
  it('infers the canonical PKF MIME and enforces the 5 MiB source budget', () => {
    expect(inferAgentOutputMime('redis-principles.pkf')).toBe('application/vnd.prismer.pkf+html');
    expect(validateAgentOutputAsset({ filename: 'redis-principles.pkf', sizeBytes: 5 * MB })).toMatchObject({
      ok: true,
      mime: 'application/vnd.prismer.pkf+html',
      maxBytes: 5 * MB,
    });
    expect(validateAgentOutputAsset({ filename: 'redis-principles.pkf', sizeBytes: 5 * MB + 1 })).toMatchObject({
      ok: false,
    });
  });
});
