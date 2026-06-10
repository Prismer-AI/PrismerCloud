// release201/30 §XML-context P0 (2026-05-31) — integration test for
// `dispatchViaSessions` body composition.
//
// Mocks `consumeSessionsSse` (avoids real SSE parsing) and the
// `HermesSessionMapper` (avoids better-sqlite3 dependency) so we can call
// the real `dispatchViaSessions` and inspect the fetch body it would have
// sent to hermes. Goal: lock the wire shape changes
//
//   - prior_message carries <attached_assets><asset .../></attached_assets>
//   - current_message carries <attached_assets> + <inline_content>
//   - asset blocks are NOT prepended above <conversation_context> anymore.

import { describe, expect, it, vi, beforeEach } from 'vitest';

// HermesSessionMapper transitively imports better-sqlite3 via LocalDb. Stub
// the whole module before importing dispatchViaSessions so the file loads
// without the dep.
vi.mock('../src/adapters/hermes/sessions-mapper.js', () => ({
  HermesSessionMapper: class {
    constructor() {}
    get() {
      return null;
    }
    async createForConversation() {
      return null;
    }
  },
}));

// consumeSessionsSse parses real SSE frames — replace with a stub that
// returns a finished result immediately so dispatch falls through to the
// post-fetch path without needing a real stream.
vi.mock('../src/adapters/hermes/sessions-sse.js', () => ({
  consumeSessionsSse: vi.fn(async () => ({
    output: 'ok',
    runId: 'run_test',
    usage: null,
    approvalRequested: false,
  })),
}));

// run-session-map registers the runId post-success — null short-circuits.
vi.mock('../src/daemon/memory/run-session-map.js', () => ({
  getRunSessionRegistry: () => null,
}));

import { dispatchViaSessions } from '../src/adapters/hermes/sessions-dispatcher.js';
import type { TaskInput } from '../src/adapters/contract.js';

describe('dispatchViaSessions XML-context P0 wiring (release201/30, 2026-05-31)', () => {
  let capturedBody: Record<string, unknown> | null = null;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capturedBody = null;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const initObj = init as { body?: string } | undefined;
      if (initObj?.body) capturedBody = JSON.parse(initObj.body);
      // Provide a minimally valid Response with a streaming-ish body so the
      // dispatcher proceeds. consumeSessionsSse is stubbed above, so the
      // actual bytes don't matter — but `res.ok` + non-null `res.body` must hold.
      return new Response(new ReadableStream(), { status: 200 });
    });
  });

  const baseDeps = {
    baseUrl: 'http://127.0.0.1:9000',
    apiKey: 'test-key',
    profileName: 'engineer',
    serviceId: 'svc_test',
    model: 'hermes-test',
    capabilities: {},
    instructions: 'You are a test agent.',
    idempotencyKey: 'idem-1',
    sessionMapper: {
      // We'll inject a pre-resolved session via spy to skip the lookup path.
      get: () => ({
        conversationId: 'cv_1',
        agentImUserId: 'u_engineer',
        hermesSessionId: 'hs_1',
        hermesSessionKey: null,
      }),
      createForConversation: async () => ({
        conversationId: 'cv_1',
        agentImUserId: 'u_engineer',
        hermesSessionId: 'hs_1',
        hermesSessionKey: null,
      }),
    } as unknown as ConstructorParameters<typeof import('../src/adapters/hermes/sessions-mapper.js')['HermesSessionMapper']>[0] extends never
      ? never
      : import('../src/adapters/hermes/sessions-mapper.js').HermesSessionMapper,
  };

  it('embeds <attached_assets> in prior_message and <inline_content>/<attached_assets> in current_message', async () => {
    const task: TaskInput = {
      taskId: 't_xml_p0',
      prompt: 'ignored composed prompt',
      currentPrompt: '@engineer please review the PDF',
      metadata: {
        conversationId: 'cv_1',
        agentImUserId: 'u_engineer',
        workspaceId: 'ws_1',
      },
      contextEntries: [
        {
          role: 'user',
          content: 'Here is the spec you should review.',
          sender: 'ceo',
          senderRole: 'agent',
          createdAt: '2026-05-31T00:00:00.000Z',
          attachedAssetIds: ['ast_spec'],
          attachedAssets: [
            { id: 'ast_spec', mime: 'application/pdf', filename: 'spec.pdf', sizeBytes: 4096 },
          ],
        },
      ],
      assetRefs: [
        {
          assetId: 'ast_current_pdf',
          contentHash: 'sha256:cafe',
          mime: 'application/pdf',
          sizeBytes: 8192,
          kind: 'file',
          workspaceId: 'ws_1',
          role: 'attachment',
          filename: 'review.pdf',
        },
      ],
      assetPromptBlocks: ['[PDF text — extracted body of review.pdf]'],
      conversationType: 'group',
      conversationId: 'cv_1',
      profileAgentUsername: 'engineer',
      profileAgentImUserId: 'u_engineer',
      participants: [
        {
          imUserId: 'u_winshare',
          username: 'winshare',
          displayName: 'Winshare',
          role: 'human',
        },
        {
          imUserId: 'u_ceo',
          username: 'ceo',
          displayName: 'CEO',
          role: 'agent',
          agentType: 'workspace',
        },
        {
          imUserId: 'u_engineer',
          username: 'engineer',
          displayName: 'Engineer',
          role: 'agent',
          agentType: 'workspace',
        },
      ],
      currentMessageSender: 'winshare',
      currentMessageSenderRole: 'human',
    };

    await dispatchViaSessions(task, baseDeps as Parameters<typeof dispatchViaSessions>[1]);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(capturedBody).not.toBeNull();
    const message = (capturedBody as { message: unknown }).message;
    // No image refs → message is a plain string holding the XML
    expect(typeof message).toBe('string');
    const xml = message as string;

    // 1. prior_message has <attached_assets>
    expect(xml).toContain('<prior_message author="ceo"');
    const priorOpen = xml.indexOf('<prior_message author="ceo"');
    const priorClose = xml.indexOf('</prior_message>');
    const priorBlock = xml.slice(priorOpen, priorClose);
    expect(priorBlock).toContain('<attached_assets>');
    expect(priorBlock).toContain(
      '<asset id="ast_spec" mime="application/pdf" filename="spec.pdf" size_bytes="4096"/>',
    );

    // 2. current_message has <attached_assets> derived from assetRefs +
    //    <inline_content asset_id> from assetPromptBlocks
    const curOpen = xml.indexOf('<current_message author="winshare"');
    const curClose = xml.indexOf('</current_message>');
    const curBlock = xml.slice(curOpen, curClose);
    expect(curBlock).toContain(
      '<asset id="ast_current_pdf" mime="application/pdf" filename="review.pdf" size_bytes="8192"/>',
    );
    expect(curBlock).toContain('<inline_content asset_id="ast_current_pdf">');
    expect(curBlock).toContain('[PDF text — extracted body of review.pdf]');

    // 3. assetPromptBlocks must NOT be prepended ABOVE <conversation_context>
    //    anymore (release201/30 P0 — they belong inside <current_message>).
    expect(xml.indexOf('<conversation_context')).toBe(0);
    // The pdf body text appears ONLY inside <inline_content>, not as a
    // free-standing leading block above the envelope.
    const pdfBodyMatches = xml.match(/\[PDF text — extracted body of review\.pdf\]/g) ?? [];
    expect(pdfBodyMatches.length).toBe(1);
  });

  // release202/04 §3.3 P3 — per-trigger <execution_context> subset (§3.3.2).
  describe('execution_context per-trigger subset (release202/04 P3)', () => {
    const depsWithVision = {
      ...baseDeps,
      model: 'us-kimi-k2.6',
      supportsVision: true,
    };

    const sharedMetadata = {
      conversationId: 'cv_1',
      agentImUserId: 'u_engineer',
      prismerWorkspaceId: 'ws_1',
      prismerActiveProjectId: 'pj_1',
      prismerArtifactsDir: '/abs/ws_1/pj_1/tasks/t_p3/artifacts',
      prismerScratchDir: '/abs/ws_1/pj_1/tasks/t_p3/scratch',
      prismerSessionId: 'ses_abc',
      prismerAgentUsername: 'engineer',
      prismerTaskId: 't_p3',
      roleTemplateSlug: 'ENGINEER',
      hopCount: 2,
      prismerGoals: [{ id: 't_p3', title: 'ship export', status: 'in_progress' }],
    };

    const group3Participants = [
      { imUserId: 'u_winshare', username: 'winshare', displayName: 'Winshare', role: 'human' },
      { imUserId: 'u_ceo', username: 'ceo', displayName: 'CEO', role: 'agent', agentType: 'workspace' },
      { imUserId: 'u_engineer', username: 'engineer', displayName: 'Engineer', role: 'agent', agentType: 'workspace' },
    ];

    async function dispatchAndGetXml(task: TaskInput, deps = depsWithVision): Promise<string> {
      await dispatchViaSessions(task, deps as Parameters<typeof dispatchViaSessions>[1]);
      const message = (capturedBody as { message: unknown }).message;
      return typeof message === 'string' ? message : JSON.stringify(message);
    }

    it('(a) group-session emits execution_context with type + agent_username + artifacts_dir + participants', async () => {
      const xml = await dispatchAndGetXml({
        taskId: 't_p3',
        prompt: 'x',
        currentPrompt: '@engineer build it',
        metadata: { ...sharedMetadata },
        conversationType: 'group',
        conversationId: 'cv_1',
        profileAgentUsername: 'engineer',
        profileAgentImUserId: 'u_engineer',
        participants: group3Participants,
        currentMessageSender: 'winshare',
        currentMessageSenderRole: 'human',
      });
      expect(xml).toContain('<execution_context type="group-session">');
      expect(xml).toContain('<agent_username>engineer</agent_username>');
      expect(xml).toContain('<artifacts_dir>/abs/ws_1/pj_1/tasks/t_p3/artifacts</artifacts_dir>');
      // group keeps the <participants> block (mention targets)
      expect(xml).toContain('<participants>');
      expect(xml).toContain('username="ceo"');
      // current_turn_sender + hop + workspace_contacts hint present for group
      expect(xml).toContain('<current_turn_sender role="human">winshare</current_turn_sender>');
      expect(xml).toContain('<hop n="2" budget="5"/>');
      expect(xml).toContain('<workspace_contacts hint="use: cloud team list"/>');
      // model + vision surfaced
      expect(xml).toContain('<model supports_vision="true">us-kimi-k2.6</model>');
    });

    it('(b) task-run emits NO participants and NO current_turn_sender, but keeps hop + linked_task', async () => {
      const xml = await dispatchAndGetXml({
        taskId: 't_p3',
        prompt: 'x',
        currentPrompt: 'do the kanban task',
        // No conversationType → derives task-run. (resolveSession still needs
        // conversationId+agentImUserId in metadata to find a session.)
        metadata: { ...sharedMetadata },
        conversationId: 'cv_1',
        profileAgentUsername: 'engineer',
        profileAgentImUserId: 'u_engineer',
        // Even if participants are passed, task-run execution_context must not
        // surface current_turn_sender/workspace_contacts.
        participants: group3Participants,
        currentMessageSender: 'winshare',
        currentMessageSenderRole: 'human',
      });
      expect(xml).toContain('<execution_context type="task-run">');
      // task-run subset: no current_turn_sender, no workspace_contacts hint
      const ecOpen = xml.indexOf('<execution_context');
      const ecClose = xml.indexOf('</execution_context>');
      const ecBlock = xml.slice(ecOpen, ecClose);
      expect(ecBlock).not.toContain('<current_turn_sender');
      expect(ecBlock).not.toContain('<workspace_contacts');
      // but hop/budget + linked_task still present (agent-to-agent chain)
      expect(ecBlock).toContain('<hop n="2" budget="5"/>');
      expect(ecBlock).toContain('<linked_task status="in_progress">ship export</linked_task>');
    });

    it('(c) dm-session has current_turn_sender but NO hop/budget', async () => {
      const xml = await dispatchAndGetXml({
        taskId: 't_p3',
        prompt: 'x',
        currentPrompt: 'help me',
        metadata: { ...sharedMetadata },
        conversationType: 'direct',
        conversationId: 'cv_1',
        profileAgentUsername: 'engineer',
        profileAgentImUserId: 'u_engineer',
        participants: [
          { imUserId: 'u_winshare', username: 'winshare', displayName: 'Winshare', role: 'human' },
          { imUserId: 'u_engineer', username: 'engineer', displayName: 'Engineer', role: 'agent', agentType: 'workspace' },
        ],
        currentMessageSender: 'winshare',
        currentMessageSenderRole: 'human',
      });
      expect(xml).toContain('<execution_context type="dm-session">');
      const ecOpen = xml.indexOf('<execution_context');
      const ecClose = xml.indexOf('</execution_context>');
      const ecBlock = xml.slice(ecOpen, ecClose);
      // dm keeps current_turn_sender
      expect(ecBlock).toContain('<current_turn_sender role="human">winshare</current_turn_sender>');
      // dm has NO hop/budget (no fan-out) and NO workspace_contacts hint
      expect(ecBlock).not.toContain('<hop ');
      expect(ecBlock).not.toContain('<workspace_contacts');
    });
  });
});
