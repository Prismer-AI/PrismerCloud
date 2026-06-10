import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openclawAdapter } from '../src/adapters/openclaw/index.js';

describe('openclaw skill injection', () => {
  // 14b rev.3 §3.0.4 P2 — OpenClaw adapter switched from
  // /v1/chat/completions to /v1/responses; system content is now carried
  // in the top-level `instructions` field instead of a system message.
  it('includes installed SKILL.md content in the /v1/responses instructions field', async () => {
    const home = mkdtempSync(join(tmpdir(), 'prismer-openclaw-skill-'));
    const skillsDir = join(home, 'skills');
    mkdirSync(join(skillsDir, 'memory-curation'), { recursive: true });
    writeFileSync(join(skillsDir, 'memory-curation', 'SKILL.md'), '# Memory Curation\n\nKeep durable facts.', 'utf8');
    const requests: Array<{ url: string; body?: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.endsWith('/health')) return { ok: true };
      requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      return {
        ok: true,
        json: async () => ({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const service = await openclawAdapter.ensureService?.({
        id: 'profile-openclaw',
        workspaceId: 'ws-1',
        agentImUserId: 'agent-openclaw',
        agentUsername: 'agent-user',
        adapterName: 'openclaw',
        name: 'OpenClaw',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        config: {
          apiKey: 'openclaw-api-key',
          skillsDir,
        },
      });

      const result = await service?.dispatch({
        taskId: 'task-1',
        prompt: 'Remember this.',
        metadata: { systemPrompt: 'You are OpenClaw.' },
      });

      expect(result?.ok).toBe(true);
      const body = requests.find((req) => req.url.endsWith('/v1/responses'))?.body as {
        instructions?: string;
        input: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
      };
      expect(body.instructions).toContain('You are OpenClaw.');
      expect(body.instructions).toContain('[Installed Skills]');
      expect(body.instructions).toContain('# Memory Curation');
      expect(body.instructions).toContain('Keep durable facts.');
      // User prompt still rides through as input_text in the first message.
      expect(body.input[0]?.role).toBe('user');
      expect(body.input[0]?.content[0]).toMatchObject({
        type: 'input_text',
        text: 'Remember this.',
      });
    } finally {
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
