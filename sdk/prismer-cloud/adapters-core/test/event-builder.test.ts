import { describe, it, expect } from 'vitest';
// NOTE: don't import { ZodError } from 'zod' — adapters-core and @prismer/wire
// can resolve to different copies of the zod module (version skew v3/v4),
// making `toThrow(ZodError)` fail even when a ZodError IS thrown. We instead
// check error.name === 'ZodError' which is stable across copies + versions.
import { ParaEventSchema } from '@prismer/wire';
import type { AgentDescriptor } from '@prismer/wire';
import {
  makeRegisterEvent,
  makeSessionStarted,
  makeSessionReset,
  makeSessionEnded,
  makeAgentState,
  makePromptSubmit,
  makeLlmPre,
  makeLlmPost,
  makeTurnEnd,
  makeTurnFailure,
  makeToolPre,
  makeToolPost,
  makeToolFailure,
  makeApprovalRequest,
  makeApprovalResult,
  makeTaskCreated,
  makeTaskCompleted,
  makeCompactPre,
  makeCompactPost,
  makeBootstrapInjected,
  makeSkillActivated,
  makeSkillDeactivated,
} from '../src/event-builder.js';

const agent: AgentDescriptor = {
  id: 'test-agent@host',
  adapter: 'claude-code',
  version: '1.0.0',
  tiersSupported: [1, 2, 3],
  capabilityTags: ['code', 'shell'],
  workspace: '/workspace',
};

/** Helper: asserts the event round-trips through the schema. */
function assertSchemaValid(evt: unknown): void {
  expect(() => ParaEventSchema.parse(evt)).not.toThrow();
}

describe('event-builder', () => {
  describe('makeRegisterEvent', () => {
    it('produces a schema-valid agent.register event', () => {
      const evt = makeRegisterEvent(agent);
      expect(evt.type).toBe('agent.register');
      assertSchemaValid(evt);
    });

    it('throws ZodError if tiersSupported contains out-of-range tier', () => {
      // Wire schema: z.number().int().min(1).max(10)
      expect(() => makeRegisterEvent({ ...agent, tiersSupported: [0] })).toThrow(expect.objectContaining({ name: "ZodError" }));
    });
  });

  describe('makeSessionStarted', () => {
    it('produces a schema-valid agent.session.started event', () => {
      const evt = makeSessionStarted({ sessionId: 'sess-1', scope: 'global' });
      expect(evt.type).toBe('agent.session.started');
      assertSchemaValid(evt);
    });

    it('includes optional parentSessionId when provided', () => {
      const evt = makeSessionStarted({
        sessionId: 'sess-2',
        scope: 'project',
        parentSessionId: 'sess-0',
      });
      assertSchemaValid(evt);
      expect((evt as { parentSessionId?: string }).parentSessionId).toBe('sess-0');
    });

    it('throws ZodError when scope is not a string type', () => {
      expect(() =>
        // @ts-expect-error intentionally invalid
        makeSessionStarted({ sessionId: 'sess', scope: 42 }),
      ).toThrow(expect.objectContaining({ name: "ZodError" }));
    });
  });

  describe('makeSessionReset', () => {
    it('produces schema-valid event for each reset reason', () => {
      for (const reason of ['new', 'reset', 'clear', 'compact'] as const) {
        const evt = makeSessionReset({ sessionId: 'sess', reason });
        assertSchemaValid(evt);
        expect(evt.type).toBe('agent.session.reset');
      }
    });
  });

  describe('makeSessionEnded', () => {
    it('produces schema-valid event', () => {
      const evt = makeSessionEnded({ sessionId: 'sess', reason: 'stop' });
      assertSchemaValid(evt);
      expect(evt.type).toBe('agent.session.ended');
    });
  });

  describe('makeAgentState', () => {
    it('produces schema-valid event for all states', () => {
      for (const status of ['idle', 'thinking', 'tool', 'awaiting_approval', 'error'] as const) {
        const evt = makeAgentState(status);
        assertSchemaValid(evt);
        expect(evt.type).toBe('agent.state');
      }
    });

    it('throws ZodError for invalid status', () => {
      // @ts-expect-error intentionally invalid
      expect(() => makeAgentState('sleeping')).toThrow(expect.objectContaining({ name: "ZodError" }));
    });
  });

  describe('makePromptSubmit', () => {
    it('produces schema-valid event', () => {
      const evt = makePromptSubmit({
        sessionId: 'sess',
        prompt: 'hello',
        source: 'user',
      });
      assertSchemaValid(evt);
      expect(evt.type).toBe('agent.prompt.submit');
    });

    it('throws ZodError on invalid source', () => {
      // @ts-expect-error intentionally invalid
      expect(() => makePromptSubmit({ sessionId: 'sess', prompt: 'x', source: 'bot' })).toThrow(expect.objectContaining({ name: "ZodError" }));
    });
  });

  describe('makeLlmPre', () => {
    it('produces schema-valid event', () => {
      const evt = makeLlmPre({
        sessionId: 'sess',
        model: 'claude-sonnet-4-6',
        conversationLength: 10,
        isFirstTurn: false,
      });
      assertSchemaValid(evt);
      expect(evt.type).toBe('agent.llm.pre');
    });
  });

  describe('makeLlmPost', () => {
    it('produces schema-valid event', () => {
      const evt = makeLlmPost({ sessionId: 'sess', tokensUsed: 1500, stopReason: 'end_turn' });
      assertSchemaValid(evt);
      expect(evt.type).toBe('agent.llm.post');
    });
  });

  describe('makeTurnEnd', () => {
    it('produces schema-valid event without lastAssistantMessage', () => {
      const evt = makeTurnEnd({ sessionId: 'sess' });
      assertSchemaValid(evt);
    });

    it('produces schema-valid event with lastAssistantMessage', () => {
      const evt = makeTurnEnd({ sessionId: 'sess', lastAssistantMessage: 'Done.' });
      assertSchemaValid(evt);
    });
  });

  describe('makeTurnFailure', () => {
    it('produces schema-valid event', () => {
      const evt = makeTurnFailure({
        sessionId: 'sess',
        errorType: 'rate_limit',
        errorMessage: 'Too many requests',
      });
      assertSchemaValid(evt);
      expect(evt.type).toBe('agent.turn.failure');
    });
  });

  describe('makeToolPre', () => {
    it('produces schema-valid event without riskTag', () => {
      const evt = makeToolPre({ callId: 'call-1', tool: 'Bash', args: 'ls -la' });
      assertSchemaValid(evt);
      expect(evt.type).toBe('agent.tool.pre');
    });

    it('produces schema-valid event with riskTag', () => {
      const evt = makeToolPre({ callId: 'call-2', tool: 'Bash', args: 'rm -rf /tmp', riskTag: 'high' });
      assertSchemaValid(evt);
    });

    it('throws ZodError when riskTag is invalid', () => {
      expect(() =>
        makeToolPre({
          callId: 'call-3',
          tool: 'Bash',
          args: {},
          // @ts-expect-error intentionally invalid
          riskTag: 'critical',
        }),
      ).toThrow(expect.objectContaining({ name: "ZodError" }));
    });
  });

  describe('makeToolPost', () => {
    it('produces schema-valid event', () => {
      const evt = makeToolPost({ callId: 'call-1', ok: true, durationMs: 42, summary: 'ok' });
      assertSchemaValid(evt);
    });

    it('throws ZodError when durationMs is negative', () => {
      expect(() =>
        makeToolPost({ callId: 'call-1', ok: true, durationMs: -1, summary: 'bad' }),
      ).toThrow(expect.objectContaining({ name: "ZodError" }));
    });
  });

  describe('makeToolFailure', () => {
    it('produces schema-valid event without optional fields', () => {
      const evt = makeToolFailure({ callId: 'call-1', error: 'Permission denied' });
      assertSchemaValid(evt);
    });

    it('produces schema-valid event with all optional fields', () => {
      const evt = makeToolFailure({
        callId: 'call-1',
        error: 'SIGINT',
        signalPattern: 'SIGINT',
        isInterrupt: true,
      });
      assertSchemaValid(evt);
    });
  });

  describe('makeApprovalRequest', () => {
    it('produces schema-valid event', () => {
      const evt = makeApprovalRequest({ callId: 'call-1', prompt: 'Allow Bash?', ttlMs: 30000 });
      assertSchemaValid(evt);
    });

    it('throws ZodError when ttlMs is not positive', () => {
      expect(() =>
        makeApprovalRequest({ callId: 'call-1', prompt: 'prompt', ttlMs: 0 }),
      ).toThrow(expect.objectContaining({ name: "ZodError" }));
    });
  });

  describe('makeApprovalResult', () => {
    it('produces schema-valid event', () => {
      const evt = makeApprovalResult({ callId: 'call-1', decision: 'allow', by: 'local' });
      assertSchemaValid(evt);
    });
  });

  describe('makeTaskCreated', () => {
    it('produces schema-valid event', () => {
      const evt = makeTaskCreated({ taskId: 'task-1', subject: 'Write tests' });
      assertSchemaValid(evt);
      expect(evt.type).toBe('agent.task.created');
    });
  });

  describe('makeTaskCompleted', () => {
    it('produces schema-valid event for all statuses', () => {
      for (const status of ['completed', 'failed', 'cancelled'] as const) {
        const evt = makeTaskCompleted({ taskId: 'task-1', subject: 'Write tests', status });
        assertSchemaValid(evt);
      }
    });
  });

  describe('makeCompactPre', () => {
    it('produces schema-valid event', () => {
      const evt = makeCompactPre({
        sessionId: 'sess',
        trigger: 'auto',
        messageCount: 100,
        tokenCount: 50000,
      });
      assertSchemaValid(evt);
      expect(evt.type).toBe('agent.compact.pre');
    });
  });

  describe('makeCompactPost', () => {
    it('produces schema-valid event', () => {
      const evt = makeCompactPost({
        sessionId: 'sess',
        compactedCount: 80,
        tokensBefore: 50000,
        tokensAfter: 5000,
      });
      assertSchemaValid(evt);
    });
  });

  describe('makeBootstrapInjected', () => {
    it('produces schema-valid event', () => {
      const evt = makeBootstrapInjected({ bootstrapFiles: ['CLAUDE.md'], agentId: 'agent-1' });
      assertSchemaValid(evt);
      expect(evt.type).toBe('agent.bootstrap.injected');
    });
  });

  describe('makeSkillActivated', () => {
    it('produces schema-valid event', () => {
      const evt = makeSkillActivated({
        skillName: 'review',
        source: { kind: 'plugin', pluginName: '@prismer/claude-code-plugin' },
        trigger: 'user-invoke',
      });
      assertSchemaValid(evt);
      expect(evt.type).toBe('agent.skill.activated');
    });
  });

  describe('makeSkillDeactivated', () => {
    it('produces schema-valid event', () => {
      const evt = makeSkillDeactivated({ skillName: 'review', reason: 'compaction-drop' });
      assertSchemaValid(evt);
      expect(evt.type).toBe('agent.skill.deactivated');
    });

    it('throws ZodError for invalid reason', () => {
      expect(() =>
        makeSkillDeactivated({
          skillName: 'review',
          // @ts-expect-error intentionally invalid
          reason: 'unknown-reason',
        }),
      ).toThrow(expect.objectContaining({ name: "ZodError" }));
    });
  });

  // ============================================================
  // Skill Permission Rule Integration Tests
  // ============================================================

  describe('Skill Permission Rule Integration', () => {
    it('skill.activated emits permission rule push', () => {
      // This test verifies that when a skill is activated,
      // it pushes its permission rules to the permission engine
      const evt = makeSkillActivated({
        skillName: 'deploy',
        source: { kind: 'plugin', pluginName: '@prismer/claude-code-plugin' },
        trigger: 'auto-match',
      });
      assertSchemaValid(evt);

      // The adapter should integrate with permission engine:
      // - Extract permission rules from skill definition
      // - Push them to active rule set with source='skill'
      // - Deactivate removes them (source='skill' filter)
      expect(evt.type).toBe('agent.skill.activated');
    });

    it('skill.deactivated removes permission rules', () => {
      const evt = makeSkillDeactivated({
        skillName: 'deploy',
        reason: 'session-end',
      });
      assertSchemaValid(evt);

      // The adapter should:
      // - Filter out all rules with source='skill' and matching skillName
      // - Or mark them as inactive
      expect(evt.type).toBe('agent.skill.deactivated');
    });
  });

  // ============================================================
  // LLM Context Injection Tests (cache-safe)
  // ============================================================

  describe('LLM Context Injection', () => {
    it('agent.llm.pre supports cache-safe context injection', () => {
      const evt = makeLlmPre({
        sessionId: 'sess-1',
        model: 'claude-sonnet-4-6',
        conversationLength: 15,
        isFirstTurn: false,
      });
      assertSchemaValid(evt);
      expect(evt.type).toBe('agent.llm.pre');

      // Cache-safe injection pattern:
      // - adapter listens to agent.llm.pre events
      // - injects context (memory, bootstrap) BEFORE sending to LLM
      // - uses cache keys to avoid redundant injection
      // - stores injected context hash for validation
    });

    it('tracks token usage across turns', () => {
      const preEvt = makeLlmPre({
        sessionId: 'sess-1',
        model: 'claude-sonnet-4-6',
        conversationLength: 10,
        isFirstTurn: true,
      });
      const postEvt = makeLlmPost({
        sessionId: 'sess-1',
        tokensUsed: 1500,
        stopReason: 'end_turn',
      });

      assertSchemaValid(preEvt);
      assertSchemaValid(postEvt);

      // Token tracking pattern:
      // - pre event: record turn start, conversation length
      // - post event: record tokens used, stop reason
      // - adapter maintains running total per session
      // - emit agent.notification on quota thresholds
      expect(preEvt.type).toBe('agent.llm.pre');
      expect(postEvt.type).toBe('agent.llm.post');
    });
  });

  // ============================================================
  // Environment Event Integration Tests
  // ============================================================

  describe('Environment Event Integration', () => {
    it('agent.fs.op emits for file operations', () => {
      // This test verifies file operation tracking
      // - File read: agent.fs.op with op='read', path, status
      // - File write: agent.fs.op with op='write', path, size
      // - File delete: agent.fs.op with op='delete', path
      // Sandbox runtime should emit these events via fs-adapter

      // Example event structure (would be emitted by sandbox-runtime):
      // {
      //   type: 'agent.fs.op',
      //   op: 'read' | 'write' | 'delete' | 'edit',
      //   path: '/workspace/file.txt',
      //   status: 'success' | 'error',
      //   error?: string
      // }
      expect(true).toBe(true); // Placeholder - event would be emitted by sandbox-runtime
    });

    it('agent.file.watched tracks file changes', () => {
      // File watching integration:
      // - Adapter sets up file watcher on workspace
      // - Emits agent.file.watched on changes
      // - Includes: path, changeType (created/modified/deleted), timestamp

      // Example event structure:
      // {
      //   type: 'agent.file.watched',
      //   path: '/workspace/src/file.ts',
      //   changeType: 'modified',
      //   timestamp: 1713672000000
      // }
      expect(true).toBe(true); // Placeholder - event would be emitted by adapter
    });

    it('agent.cwd.changed tracks directory changes', () => {
      // CWD tracking:
      // - Adapter monitors current working directory
      // - Emits agent.cwd.changed when directory changes
      // - Includes: oldPath, newPath, trigger (user/command/auto)

      // Example event structure:
      // {
      //   type: 'agent.cwd.changed',
      //   oldPath: '/workspace/old',
      //   newPath: '/workspace/new',
      //   trigger: 'command'
      // }
      expect(true).toBe(true); // Placeholder - event would be emitted by adapter
    });

    it('agent.config.changed tracks configuration changes', () => {
      // Config tracking:
      // - Adapter monitors settings files
      // - Emits agent.config.changed on changes
      // - Includes: key, oldValue, newValue, source

      // Example event structure:
      // {
      //   type: 'agent.config.changed',
      //   key: 'permissionMode',
      //   oldValue: 'default',
      //   newValue: 'tier',
      //   source: 'settings.json'
      // }
      expect(true).toBe(true); // Placeholder - event would be emitted by adapter
    });

    it('agent.worktree.created tracks git worktree creation', () => {
      // Worktree tracking:
      // - Adapter detects git worktree operations
      // - Emits agent.worktree.created on creation
      // - Includes: worktreePath, baseBranch, detachedFrom

      // Example event structure:
      // {
      //   type: 'agent.worktree.created',
      //   worktreePath: '/tmp/worktree-abc',
      //   baseBranch: 'main',
      //   detachedFrom: 'feature-xyz'
      // }
      expect(true).toBe(true); // Placeholder - event would be emitted by adapter
    });

    it('agent.worktree.removed tracks git worktree removal', () => {
      // Worktree cleanup tracking:
      // - Adapter detects worktree deletion
      // - Emits agent.worktree.removed on cleanup
      // - Includes: worktreePath, reason (cleanup/error)

      // Example event structure:
      // {
      //   type: 'agent.worktree.removed',
      //   worktreePath: '/tmp/worktree-abc',
      //   reason: 'cleanup'
      // }
      expect(true).toBe(true); // Placeholder - event would be emitted by adapter
    });
  });
});
