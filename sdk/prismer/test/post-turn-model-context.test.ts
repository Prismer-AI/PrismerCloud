import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudClient } from '../src/auth.js';
import type { PostTurnJob } from '../src/adapters/coding/shared/lifecycle/post-turn-store.js';
import { extractDurablePostTurn } from '../src/daemon/memory/hook-server.js';
import { MemoryRuntime } from '../src/daemon/memory/runtime.js';

describe('durable post-turn model context', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    cleanup.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  it('uses the persisted profile model and attached assets after worker handoff', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'post-turn-model-context-'));
    cleanup.push(dir);
    const runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'device_1' });
    let requestBody: Record<string, unknown> | null = null;
    const cloud = new CloudClient({
      baseUrl: 'http://cloud.test',
      apiKey: 'test-key',
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '{"pages":[]}' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 2 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await extractDurablePostTurn(JOB, { cloud, memoryRuntime: runtime });

    expect(requestBody?.model).toBe('deepseek-v4-flash');
    const messages = requestBody?.messages as Array<{ content?: string }>;
    expect(messages[0]?.content).toContain('prismer://asset/asset_1');
    runtime.closeAll();
  });

  it('threads the bounded barrier abort signal into the gateway request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'post-turn-model-abort-'));
    cleanup.push(dir);
    const runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'device_1' });
    let requestSignal: AbortSignal | undefined;
    const cloud = new CloudClient({
      baseUrl: 'http://cloud.test',
      apiKey: 'test-key',
      fetchImpl: async (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        await new Promise<void>((resolve, reject) => {
          const fallback = setTimeout(resolve, 40);
          requestSignal?.addEventListener('abort', () => {
            clearTimeout(fallback);
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
        return new Response(
          JSON.stringify({ content: [{ type: 'text', text: '{"pages":[]}' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    const controller = new AbortController();

    const pending = extractDurablePostTurn(JOB, {
      cloud,
      memoryRuntime: runtime,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error('memory_barrier_timeout')), 0);

    await expect(pending).rejects.toThrow(/gateway .*failed|aborted|timeout/i);
    expect(requestSignal?.aborted).toBe(true);
    runtime.closeAll();
  });

  it('fails traceably when the completed turn has no execution model instead of using a fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'post-turn-model-missing-'));
    cleanup.push(dir);
    const runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'device_1' });
    let cloudCalls = 0;
    const cloud = new CloudClient({
      baseUrl: 'http://cloud.test',
      apiKey: 'test-key',
      fetchImpl: async () => {
        cloudCalls += 1;
        return new Response('{}', { status: 200 });
      },
    });
    const missingModel: PostTurnJob = {
      ...JOB,
      payload: {
        ...JOB.payload,
        executionContext: { ...JOB.payload.executionContext, model: undefined },
      },
    };

    await expect(extractDurablePostTurn(missingModel, { cloud, memoryRuntime: runtime }))
      .rejects.toThrow('non_extractable:no_execution_model');
    expect(cloudCalls).toBe(0);
    runtime.closeAll();
  });

  it('fails traceably before the gateway when terminal provider evidence is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'post-turn-provider-missing-'));
    cleanup.push(dir);
    const runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'device_1' });
    let cloudCalls = 0;
    const cloud = new CloudClient({
      baseUrl: 'http://cloud.test',
      apiKey: 'test-key',
      fetchImpl: async () => {
        cloudCalls += 1;
        return new Response('{}', { status: 200 });
      },
    });
    const missingProvider: PostTurnJob = {
      ...JOB,
      payload: {
        ...JOB.payload,
        executionContext: { ...JOB.payload.executionContext, provider: undefined },
      },
    };

    await expect(extractDurablePostTurn(missingProvider, { cloud, memoryRuntime: runtime }))
      .rejects.toThrow('non_extractable:no_terminal_provider');
    expect(cloudCalls).toBe(0);
    runtime.closeAll();
  });
});

const JOB: PostTurnJob = {
  idempotencyKey: 'post-turn:ws_test:agent_1:turn_1',
  workspaceId: 'ws_test',
  agentImUserId: 'agent_1',
  conversationId: 'conv_1',
  turnId: 'turn_1',
  terminalState: 'completed',
  payload: {
    userMessage:
      'Please retain this detailed architecture decision and the complete runtime ownership boundary for future work.',
    assistantResponse:
      'The runtime owns durable post-turn extraction, restart recovery, exactly-once application, and the routing snapshot used for the completed turn. This response is intentionally long enough to pass the memory extraction heuristic and prove the actual gateway request model.',
    toolFailures: [],
    executionContext: {
      adapterName: 'hermes',
      roleSlug: 'team-manager',
      model: 'deepseek-v4-flash',
      provider: 'prismer-gateway',
      routingEvidenceSource: 'adapter',
      proxyProvider: 'default',
      attachedAssetIds: ['asset_1'],
    },
    contentMeta: {
      userMessage: { sha256: 'u', originalBytes: 100, storedBytes: 100, truncated: false },
      assistantResponse: { sha256: 'a', originalBytes: 250, storedBytes: 250, truncated: false },
    },
  },
  result: null,
  resultHash: null,
  extractedAt: null,
  status: 'pending',
  attemptCount: 0,
  nextAttemptAt: 0,
  lastError: null,
  createdAt: 0,
  completedAt: null,
  payloadCompactedAt: null,
};
