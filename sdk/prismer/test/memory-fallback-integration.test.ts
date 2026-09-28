import { describe, expect, it } from 'vitest';
import { createFallbackMemoryIntegration, type FallbackAdapter } from '../src/adapters/shared/memory-integration.js';

describe('fallback memory integration', () => {
  it.each(['claude-code', 'codex'] as FallbackAdapter[])('%s exposes recall schema and executors', (adapter) => {
    const integration = createFallbackMemoryIntegration(adapter, {
      workspaceId: 'ws1',
      actorImUserId: 'agent1',
      daemonUrl: 'http://127.0.0.1:3999',
    });

    const tools = integration.recallTools();
    expect(tools.schemas.map((tool) => tool.name)).toEqual(['memory_search', 'memory_load']);
    expect(typeof tools.handlers.search).toBe('function');
    expect(typeof tools.handlers.load).toBe('function');
    const alias = integration.recallToolImpls();
    expect(typeof alias.search).toBe('function');
    expect(typeof alias.load).toBe('function');
  });
});
