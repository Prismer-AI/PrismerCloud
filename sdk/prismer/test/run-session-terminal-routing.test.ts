import { describe, expect, it } from 'vitest';

import { RunSessionRegistry } from '../src/daemon/memory/run-session-map.js';
import { openLocalDb } from '../src/sync/store.js';

describe('RunSessionRegistry terminal routing evidence', () => {
  it('keeps configured intent untrusted until the adapter records terminal served routing', () => {
    const db = openLocalDb(':memory:');
    const registry = new RunSessionRegistry(db);
    registry.register({
      runId: 'run_terminal_routing',
      conversationId: 'conv_1',
      taskId: 'task_1',
      agentImUserId: 'agent_1',
      workspaceId: 'ws_1',
      profileName: 'profile_1',
      roleTemplateSlug: null,
      adapterName: 'hermes',
      model: 'configured-model',
      proxyProvider: 'configured-chain',
    });

    expect(registry.lookup('run_terminal_routing')).toMatchObject({
      model: 'configured-model',
      proxyProvider: 'configured-chain',
      servedModel: null,
      servedProvider: null,
      routingEvidenceSource: null,
    });

    registry.recordTerminalRouting('run_terminal_routing', {
      servedModel: null,
      servedProvider: null,
      routingEvidenceSource: 'adapter',
    });
    expect(registry.lookup('run_terminal_routing')).toMatchObject({
      servedModel: null,
      servedProvider: null,
      routingEvidenceSource: null,
    });

    registry.recordTerminalRouting('run_terminal_routing', {
      servedModel: 'served-model',
      servedProvider: 'served-provider',
      routingEvidenceSource: 'adapter',
    });
    // The sessions SSE completion currently carries no routing fields. Its
    // defensive terminal stamp must not erase earlier post_api_request evidence.
    registry.recordTerminalRouting('run_terminal_routing', {
      servedModel: null,
      servedProvider: null,
      routingEvidenceSource: 'adapter',
    });
    expect(registry.lookup('run_terminal_routing')).toMatchObject({
      servedModel: 'served-model',
      servedProvider: 'served-provider',
      routingEvidenceSource: 'adapter',
    });

    expect(registry.lookup('run_terminal_routing')).toMatchObject({
      model: 'configured-model',
      proxyProvider: 'configured-chain',
      servedModel: 'served-model',
      servedProvider: 'served-provider',
      routingEvidenceSource: 'adapter',
    });
    db.close();
  });

  it('binds terminal evidence to the exact Hermes provider session and ignores synthetic session rows', () => {
    const db = openLocalDb(':memory:');
    const registry = new RunSessionRegistry(db);
    db.prepare(
      `INSERT INTO local_run_sessions
         (run_id, conversation_id, task_id, agent_im_user_id, workspace_id,
          profile_name, role_template_slug, adapter_name, created_at, hermes_session_id)
       VALUES (?, ?, NULL, ?, ?, ?, NULL, 'hermes', ?, ?)`,
    ).run('session:api_exact', 'conv_1', 'agent_1', 'ws_1', 'profile_1', Date.now() - 1, 'api_exact');
    registry.register({
      runId: 'run_exact',
      conversationId: 'conv_1',
      taskId: 'task_exact',
      messageId: 'msg_exact',
      agentImUserId: 'agent_1',
      workspaceId: 'ws_1',
      profileName: 'profile_1',
      roleTemplateSlug: null,
      adapterName: 'hermes',
      providerSessionId: 'api_exact',
      model: 'configured-model',
      proxyProvider: 'configured-chain',
    });

    expect(registry.recordTerminalRoutingByProviderSession('api_exact', {
      servedModel: 'served-model',
      servedProvider: 'served-provider',
      routingEvidenceSource: 'adapter',
    })).toBe(true);
    expect(registry.lookupByProviderSession('api_exact')).toMatchObject({
      runId: 'run_exact',
      taskId: 'task_exact',
      conversationId: 'conv_1',
      messageId: 'msg_exact',
      servedModel: 'served-model',
      servedProvider: 'served-provider',
      routingEvidenceSource: 'adapter',
    });
    expect(registry.lookup('session:api_exact')).toMatchObject({
      servedModel: null,
      servedProvider: null,
      routingEvidenceSource: null,
    });
    expect(registry.recordTerminalRoutingByProviderSession('api_unknown', {
      servedModel: 'tampered-model',
      servedProvider: 'tampered-provider',
      routingEvidenceSource: 'adapter',
    })).toBe(false);
    db.close();
  });

  it('excludes only provider-cache synthetic rows without breaking task-less artifact run lookup', () => {
    const db = openLocalDb(':memory:');
    const registry = new RunSessionRegistry(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO local_run_sessions
         (run_id, conversation_id, task_id, agent_im_user_id, workspace_id,
          profile_name, role_template_slug, adapter_name, created_at, hermes_session_id)
       VALUES ('session:api_cache', 'conv_1', NULL, 'agent_1', 'ws_1',
               'profile_1', NULL, 'hermes', ?, 'api_cache')`,
    ).run(now - 1);

    expect(registry.lookupActiveByAgent('agent_1', { adapterName: 'hermes' })).toMatchObject({
      runId: 'session:api_cache',
      taskId: null,
    });
    expect(
      registry.lookupActiveByAgent('agent_1', {
        adapterName: 'hermes',
        excludeProviderCacheRows: true,
      }),
    ).toBeNull();

    db.prepare(
      `INSERT INTO local_run_sessions
         (run_id, conversation_id, task_id, agent_im_user_id, workspace_id,
          profile_name, role_template_slug, adapter_name, created_at)
       VALUES ('artifact:taskless', 'conv_1', NULL, 'agent_1', 'ws_1',
               'profile_1', NULL, 'hermes', ?)`,
    ).run(now);
    expect(
      registry.lookupActiveByAgent('agent_1', {
        adapterName: 'hermes',
        excludeProviderCacheRows: true,
      }),
    ).toMatchObject({ runId: 'artifact:taskless', taskId: null });
    db.close();
  });

  it('resolves real provider-session runs even when synthetic cache rows have task ids', () => {
    const db = openLocalDb(':memory:');
    const registry = new RunSessionRegistry(db);
    registry.register({
      runId: 'run_taskless_exact',
      conversationId: 'conv_1',
      taskId: null,
      messageId: 'msg_exact',
      agentImUserId: 'agent_1',
      workspaceId: 'ws_1',
      profileName: 'profile_1',
      roleTemplateSlug: null,
      adapterName: 'hermes',
      providerSessionId: 'api_taskless',
      model: 'configured-model',
      proxyProvider: 'configured-chain',
    });
    db.prepare(
      `INSERT INTO local_run_sessions
         (run_id, conversation_id, task_id, agent_im_user_id, workspace_id,
          profile_name, role_template_slug, adapter_name, created_at,
          provider_session_id)
       VALUES ('psession:hermes:api_taskless', 'conv_1', 'cached_task',
               'agent_1', 'ws_1', 'profile_1', NULL, 'hermes', ?,
               'api_taskless')`,
    ).run(Date.now() + 1);

    expect(registry.lookupByProviderSession('api_taskless')).toMatchObject({
      runId: 'run_taskless_exact',
      taskId: null,
      conversationId: 'conv_1',
      messageId: 'msg_exact',
    });
    expect(registry.recordTerminalRoutingByProviderSession('api_taskless', {
      servedModel: 'served-model',
      servedProvider: 'served-provider',
      routingEvidenceSource: 'adapter',
    })).toBe(true);
    expect(registry.lookup('run_taskless_exact')).toMatchObject({
      servedModel: 'served-model',
      servedProvider: 'served-provider',
      routingEvidenceSource: 'adapter',
    });
    expect(registry.lookup('psession:hermes:api_taskless')).toMatchObject({
      servedModel: null,
      servedProvider: null,
      routingEvidenceSource: null,
    });
    db.close();
  });
});
