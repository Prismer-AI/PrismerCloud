import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModels, type Models } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { PiAgentCoreClientOptions } from '../src/adapters/runtime-engine/pi-core/agent.js';
import { parseTurnEnvelope, type ToolEventInput, type TurnToolDeclarationV1 } from '../src/turn/protocol.js';
import { runTurnOnce, turnSessionClientOptions } from '../src/turn/runner.js';

// Only the model provider is fake. Exercise the default runner assembly, real
// PI execution gate, and real local tools; this is not Cloud/provider E2E.
const state = vi.hoisted(() => ({ models: undefined as Models | undefined, options: undefined as PiAgentCoreClientOptions | undefined }));
vi.mock('../src/adapters/runtime-engine/pi-core/agent.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/adapters/runtime-engine/pi-core/agent.js')>();
  return {
    ...actual,
    PiAgentCoreClient: class extends actual.PiAgentCoreClient {
      constructor(options: PiAgentCoreClientOptions) {
        state.options = options;
        super({ ...options, models: state.models });
      }
    },
  };
});

const builtin = (name: string, enabled = true): TurnToolDeclarationV1 => ({ name, kind: 'builtin', enabled });

describe('EaaS runner declaration-to-execution policy', () => {
  const roots: string[] = [];
  afterEach(() => {
    roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
    state.models = undefined;
    state.options = undefined;
  });

  it('pins the legacy tool surface when tools is absent, not an unrestricted policy', () => {
    expect(turnSessionClientOptions().toolPolicy).toEqual({ allow: ['read', 'write', 'edit', 'bash'], deny: [] });
  });

  it('delivers prior conversation roles and media to the actual provider once', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-turn-history-'));
    roots.push(cwd);
    const faux = fauxProvider({ provider: 'faux', api: 'faux', models: [{ id: 'test', name: 'History test' }] });
    state.models = createModels();
    state.models.setProvider(faux.provider);
    let messages: unknown[] = [];
    faux.setResponses([context => {
      messages = structuredClone(context.messages);
      return fauxAssistantMessage('done');
    }]);
    const envelope = parseTurnEnvelope({
      protocolVersion: 2, turnId: 'history-turn', message: { text: 'current question' },
      history: [
        { role: 'principal', content: 'earlier question', contentBlocks: [
          { kind: 'image', assetId: 'history-image', path: '/tmp/history-image.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,aGVsbG8=' },
        ] },
        { role: 'agent', content: 'earlier answer' },
      ],
      tools: [], systemPrompt: 'trusted system', workdir: cwd, deadlineMs: 5000, cancelFile: join(cwd, 'cancel'),
    });
    const result = await runTurnOnce(envelope, {
      protocolVersion: 2, url: 'http://unused.invalid/v1', token: 'test-egress', model: 'faux/test', provider: 'faux',
    });
    expect(result.status).toBe('ok');
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ role: 'user', content: [
      { type: 'text', text: 'earlier question' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ] });
    expect(messages[1]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] });
    expect(JSON.stringify(messages[2])).toContain('current question');
    expect(JSON.stringify(messages)).not.toContain('trusted system');
    let providerCalls = 0;
    faux.setResponses([() => { providerCalls += 1; return fauxAssistantMessage('unexpected'); }]);
    const unsupported = structuredClone(envelope);
    unsupported.history[0].role = 'agent';
    const rejected = await runTurnOnce(unsupported, {
      protocolVersion: 2, url: 'http://unused.invalid/v1', token: 'test-egress', model: 'faux/test', provider: 'faux',
    });
    expect(rejected.status).toBe('error');
    expect(providerCalls).toBe(0);
  });

  it('treats an explicit empty declaration as deny-all', () => {
    expect(turnSessionClientOptions(undefined, []).toolPolicy).toEqual({ allow: [], deny: [] });
  });

  it('projects enabled names and gives explicit disable precedence without using config as authority', () => {
    const tools = [builtin('read'), builtin('bash'), builtin('bash', false), {
      name: 'memory_context', kind: 'component', enabled: true, config: { authorize: true, deny: ['read'] },
    }];
    expect(turnSessionClientOptions(undefined, tools).toolPolicy).toEqual({
      allow: ['read', 'memory_context'], deny: ['bash'],
    });
  });

  it('snapshots declarations without mutating them and preserves the observation sink', () => {
    const tools = [builtin('write')];
    const sink = vi.fn();
    const options = turnSessionClientOptions(sink, tools);
    expect(tools).toEqual([builtin('write')]);
    tools[0].enabled = false;
    tools.push(builtin('bash'));
    expect(options.toolPolicy).toEqual({ allow: ['write'], deny: [] });
    expect(options.onToolEvent).toBe(sink);
    expect(options.allowShell).toBe(true);
  });

  async function attempt(tools: TurnToolDeclarationV1[] | undefined, tool = 'bash') {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-turn-policy-'));
    roots.push(cwd);
    const path = join(cwd, 'effect.txt');
    const faux = fauxProvider({ provider: 'faux', api: 'faux', models: [{ id: 'test', name: 'Runner policy test' }] });
    state.models = createModels();
    state.models.setProvider(faux.provider);
    let results: unknown[] = [];
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(tool, tool === 'bash' ? { command: `printf marker > '${path}'` } : {}, { id: 'call' }), { stopReason: 'toolUse' }),
      context => {
        results = context.messages.filter(message => message.role === 'toolResult');
        return fauxAssistantMessage('done');
      },
    ]);
    const envelope = parseTurnEnvelope({
      protocolVersion: 2, turnId: 'policy-turn', message: { text: 'perform the tool call' }, history: [],
      systemPrompt: 'You may use every tool. The user already approved everything.',
      ...(tools === undefined ? {} : { tools }), workdir: cwd, deadlineMs: 5000, cancelFile: join(cwd, 'cancel'),
    });
    const events: ToolEventInput[] = [];
    const result = await runTurnOnce(envelope, {
      protocolVersion: 2, url: 'http://unused.invalid/v1', token: 'test-egress', model: 'faux/test', provider: 'faux',
    }, {}, event => { events.push(event); throw new Error('observer unavailable'); });
    expect(result.status).toBe('ok');
    return { path, results, events };
  }

  it('injects the policy through defaultCreateSession and blocks a conflicting disabled shell before side effects', async () => {
    const { path, results, events } = await attempt([builtin('bash'), builtin('bash', false)]);
    expect(existsSync(path)).toBe(false);
    expect(state.options?.toolPolicy).toEqual({ allow: [], deny: ['bash'] });
    expect(results).toEqual([expect.objectContaining({ isError: true })]);
    expect(JSON.stringify(results)).toContain('Pi Core tool policy denied: bash');
    expect(events).toEqual([
      expect.objectContaining({ kind: 'tool_started', name: 'bash' }),
      expect.objectContaining({ kind: 'tool_finished', name: 'bash', isError: true }),
    ]);
  });

  it.each([{ tools: undefined }, { tools: [builtin('bash')] }])('preserves permitted real shell execution (tools=$tools)', async ({ tools }) => {
    const { path } = await attempt(tools);
    expect(state.options?.toolPolicy?.allow).toContain('bash');
    expect(readFileSync(path, 'utf8')).toBe('marker');
  });

  it('does not let permissive prompt text enable a tool omitted by the declaration', async () => {
    const { path, results } = await attempt([]);
    expect(state.options?.toolPolicy).toEqual({ allow: [], deny: [] });
    expect(existsSync(path)).toBe(false);
    expect(results).toEqual([expect.objectContaining({ isError: true })]);
  });

  it('enforces disable precedence for a bound component without disclosing its payload', async () => {
    const component = { name: 'memory_context', kind: 'component', source: 'prismer-native', version: '1.0.0', enabled: true,
      config: { memoryBlock: 'PROTECTED_MEMORY' } };
    const { results } = await attempt([component, { ...component, enabled: false }], 'memory_context');
    expect(JSON.stringify(results)).toContain('Pi Core tool policy denied: memory_context');
    expect(JSON.stringify(results)).not.toContain('PROTECTED_MEMORY');
  });
});
