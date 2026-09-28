import { describe, expect, it, vi } from 'vitest';
import { parseTurnEnvelope, parseTurnResult } from '../src/turn/protocol.js';
import { runTurnOnce } from '../src/turn/runner.js';

const binding = {
  kind: 'asset-ingest', version: 1, taskId: 'task-1', runId: 'run-1', generation: 1,
  workspaceId: 'ws', assetId: 'asset', contentHash: 'a'.repeat(64), ingestVersion: 1,
  environmentId: 'env', environmentEpoch: 2,
  segments: [{ path: 'sources/asset.md', text: 'The annual rainfall is 740mm.' }],
};
function input(maintenance: unknown = binding) {
  return { protocolVersion: 2, turnId: 'run-1', message: { text: '' }, history: [], systemPrompt: '',
    tools: [], workdir: '/tmp', deadlineMs: 1000, cancelFile: '/tmp/cancel', maintenance };
}
const egress = { protocolVersion: 2 as const, url: 'http://127.0.0.1:1/v1', token: 'synthetic-token', model: 'test', provider: 'cloud-egress' };
function session(finalText: string) {
  return { run: vi.fn(async (_prompt: string, _options: unknown) => ({ finalText })), subscribe: vi.fn(() => () => {}),
    interrupt: vi.fn(async () => {}), close: vi.fn(async () => {}) };
}

describe('maintenance protocol and runner (synthetic engine, not provider acceptance)', () => {
  it('retains a validated real task/run owner without a principal message', () => {
    expect(parseTurnEnvelope(input())).toHaveProperty('maintenance', binding);
  });
  it.each([
    { ...binding, runId: 'other' }, { ...binding, contentHash: 'invalid' },
    { ...binding, generation: 0 }, { ...binding, environmentEpoch: -1 }, { ...binding, environmentEpoch: 0 },
    { ...binding, segments: [{ path: '../escape', text: 'source' }] },
    { ...binding, segments: [{ path: '/absolute', text: 'source' }] },
    { ...binding, segments: [] }, { ...binding, kind: 'arbitrary-task' },
  ])('rejects invalid maintenance owner or destination %# before execution', (maintenance) => {
    expect(() => parseTurnEnvelope(input(maintenance))).toThrow();
  });
  it('rejects chat history and tool grants on the narrow ingest lane', () => {
    expect(() => parseTurnEnvelope({ ...input(), history: [{ role: 'principal', content: 'not an ingest source' }] })).toThrow();
    expect(() => parseTurnEnvelope({ ...input(), tools: [{ name: 'bash', kind: 'builtin', enabled: true }] })).toThrow();
  });
  it('returns bound semantic products from the actual runner path', async () => {
    const fake = session(JSON.stringify({ pages: [{ path: 'sources/asset.md', content: '# Rainfall\nAnnual rainfall is 740mm.' }] }));
    const createSession = vi.fn(async () => fake);
    const result = await runTurnOnce(parseTurnEnvelope(input()), egress, { createSession });
    expect(result.status).toBe('ok');
    expect(result).not.toHaveProperty('replyText');
    expect(result).toHaveProperty('maintenanceResult.runId', 'run-1');
    expect(result).toHaveProperty('maintenanceResult.pages.0.sourceRef', `asset:asset#${binding.contentHash}`);
    expect(parseTurnResult(result)).toHaveProperty('maintenanceResult', result.maintenanceResult);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ tools: [], history: [] }));
    expect(fake.run.mock.calls[0]?.[0]).toContain('740mm');
  });
  it('rejects forged product digests on result readback', () => {
    expect(() => parseTurnResult({ protocolVersion: 2, turnId: 'run-1', status: 'ok', maintenanceResult: {
      ...binding, pages: [{ path: 'sources/asset.md', content: 'body', contentHash: 'b'.repeat(64), sourceRef: `asset:asset#${binding.contentHash}` }],
    } })).toThrow();
  });
  it.each(['RECEIVED', '{"pages":[]}', '{"pages":[{"path":"other.md","content":"invented"}]}'])('does not mark invalid semantic output successful: %s', async (reply) => {
    const result = await runTurnOnce(parseTurnEnvelope(input()), egress, { createSession: async () => session(reply) });
    expect(result.status).toBe('error');
    expect(result).not.toHaveProperty('maintenanceResult');
  });
});
