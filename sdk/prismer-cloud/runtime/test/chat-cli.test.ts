import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChatCommand } from '../src/cli/commands/chat.js';
import { saveConfig, resolvePaths, type Config } from '../src/config.js';

interface CapturedRequest {
  url: string;
  method?: string;
  headers?: HeadersInit;
  body?: string;
}

const cleanup: string[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.PRISMER_HOME;
  delete process.env.PRISMER_API_KEY;
  delete process.env.PRISMER_BASE_URL;
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('buildChatCommand', () => {
  it('exposes the chat command tree', () => {
    const cmd = buildChatCommand();

    expect(cmd.name()).toBe('chat');
    expect(cmd.commands.map((c) => c.name())).toEqual(['me', 'direct', 'group', 'messages']);

    const group = cmd.commands.find((c) => c.name() === 'group');
    expect(group?.commands.map((c) => c.name())).toEqual([
      'create',
      'messages',
      'send',
      'remove-member',
    ]);
  });

  it('constructs the direct message POST path and body', async () => {
    const requests = installFetchStub({ ok: true, data: { message: { id: 'msg-1', conversationId: 'conv-1' } } });
    installConfig();

    await buildChatCommand().parseAsync(['direct', 'target/user', '--message', 'hello', '--json'], { from: 'user' });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(new URL(requests[0]!.url).pathname).toBe('/api/im/direct/target%2Fuser/messages');
    expect(JSON.parse(requests[0]!.body ?? '{}')).toEqual({ type: 'text', content: 'hello' });
    expect(String((requests[0]?.headers as Record<string, string>).Authorization)).toBe('Bearer sk-prismer-test');
  });

  it('constructs the group create POST path and members body', async () => {
    const requests = installFetchStub({ ok: true, data: { groupId: 'group-1', title: 'Team', members: [] } });
    installConfig();

    await buildChatCommand().parseAsync(
      ['group', 'create', '--name', 'Team', '--members', 'u1, u2,,agent-1', '--json'],
      { from: 'user' },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(new URL(requests[0]!.url).pathname).toBe('/api/im/groups');
    expect(JSON.parse(requests[0]!.body ?? '{}')).toEqual({
      title: 'Team',
      members: ['u1', 'u2', 'agent-1'],
    });
  });

  it('constructs message history query paths', async () => {
    const requests = installFetchStub({ ok: true, data: [] });
    installConfig();

    await buildChatCommand().parseAsync(['messages', 'conv 1', '--limit', '25', '--before', 'msg-0', '--json'], {
      from: 'user',
    });

    const url = new URL(requests[0]!.url);
    expect(requests[0]?.method).toBe('GET');
    expect(url.pathname).toBe('/api/im/messages/conv%201');
    expect(url.searchParams.get('limit')).toBe('25');
    expect(url.searchParams.get('before')).toBe('msg-0');
  });

  it('constructs the real group remove-member DELETE endpoint', async () => {
    const requests = installFetchStub({ ok: true });
    installConfig();

    await buildChatCommand().parseAsync(['group', 'remove-member', 'group/1', 'member/2', '--json'], { from: 'user' });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('DELETE');
    expect(new URL(requests[0]!.url).pathname).toBe('/api/im/groups/group%2F1/members/member%2F2');
  });
});

function installConfig(): void {
  const home = mkdtempSync(join(tmpdir(), 'prismer-chat-cli-'));
  cleanup.push(home);
  mkdirSync(home, { recursive: true });
  process.env.PRISMER_HOME = home;
  const cfg: Config = {
    api_key: 'sk-prismer-test',
    cloud_api_base: 'https://cloud.test',
    daemon_id: 'daemon-test',
  };
  saveConfig(cfg, resolvePaths(home));
}

function installFetchStub(payload: unknown): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: input.toString(),
      method: init?.method,
      headers: init?.headers,
      body: init?.body?.toString(),
    });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return requests;
}
