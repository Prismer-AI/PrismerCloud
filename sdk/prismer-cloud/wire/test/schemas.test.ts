/**
 * @prismer/wire — Vitest test suite
 *
 * Tests:
 *   - Positive: valid instance for each of the 47 PARA event types
 *   - Negative: ≥10 malformed payloads all rejected
 *   - Round-trip: JSON.parse(JSON.stringify(x)) === x for representative events
 *   - Frame: encode/decode round-trip with random bytes
 *   - EncryptedEnvelope + Deeplink smoke tests
 */

import { describe, it, expect } from 'vitest';
import {
  ParaEventSchema,
  AgentDescriptorSchema,
  PermissionRuleSchema,
  PermissionModeSchema,
  SkillSourceSchema,
} from '../src/schemas.js';
import { EncryptedEnvelopeSchema } from '../src/envelopes.js';
import { encodeFrame, decodeFrame, chunkFile, reassembleFile, Opcode } from '../src/frame.js';
import { parseDeeplink, serializeDeeplink, PrismerDeeplinkSchema } from '../src/deeplinks.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function mustParse<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  return schema.parse(value);
}

function mustFail(schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown): void {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
}

// ─── Positive: all 47 events ──────────────────────────────────────────────

describe('ParaEvent positive (all 47 event types)', () => {
  // Lifecycle family (8)
  it('agent.register', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.register',
      agent: {
        id: 'claude-code@MacBook-Pro',
        adapter: 'claude-code',
        version: '2.1.105',
        tiersSupported: [1, 2, 3, 4, 5],
        capabilityTags: ['code', 'shell'],
        workspace: '/Users/test/project',
      },
    });
  });

  it('agent.session.started', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.session.started',
      sessionId: 'sess-001',
      scope: 'global',
      parentSessionId: undefined,
    });
  });

  it('agent.session.reset', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.session.reset',
      sessionId: 'sess-001',
      reason: 'compact',
    });
  });

  it('agent.session.ended', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.session.ended',
      sessionId: 'sess-001',
      reason: 'stop',
    });
  });

  it('agent.subagent.started', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.subagent.started',
      agentId: 'sub-001',
      parentAgentId: 'main-001',
      subagentType: 'Explore',
    });
  });

  it('agent.subagent.ended', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.subagent.ended',
      agentId: 'sub-001',
      reason: 'complete',
      transcriptPath: '/tmp/transcript.jsonl',
    });
  });

  it('agent.state', () => {
    for (const status of ['idle', 'thinking', 'tool', 'awaiting_approval', 'error'] as const) {
      mustParse(ParaEventSchema, { type: 'agent.state', status });
    }
  });

  it('agent.tiers.update', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.tiers.update',
      agentId: 'agent-001',
      tiersAdded: [4, 5],
      tiersRemoved: [],
      reason: 'manual upgrade',
    });
  });

  // Turn / LLM family (6)
  it('agent.prompt.submit', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.prompt.submit',
      sessionId: 'sess-001',
      prompt: 'Please review this code',
      source: 'user',
    });
  });

  it('agent.llm.pre', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.llm.pre',
      sessionId: 'sess-001',
      model: 'claude-opus-4-6',
      conversationLength: 5,
      isFirstTurn: false,
    });
  });

  it('agent.llm.post', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.llm.post',
      sessionId: 'sess-001',
      tokensUsed: 1024,
      stopReason: 'end_turn',
    });
  });

  it('agent.turn.step', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.turn.step',
      sessionId: 'sess-001',
      iteration: 2,
      toolNames: ['Bash', 'Read'],
    });
  });

  it('agent.turn.end', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.turn.end',
      sessionId: 'sess-001',
      lastAssistantMessage: 'Done!',
    });
  });

  it('agent.turn.failure', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.turn.failure',
      sessionId: 'sess-001',
      errorType: 'rate_limit',
      errorMessage: 'Too many requests',
    });
  });

  // Message I/O family (5)
  it('agent.message', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.message',
      role: 'user',
      content: 'Hello',
      ts: Date.now(),
    });
  });

  it('agent.channel.inbound', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.channel.inbound',
      from: 'user@telegram',
      content: 'Hi agent',
      channelId: 'telegram-123',
      metadata: { messageId: 42 },
    });
  });

  it('agent.channel.outbound.sent', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.channel.outbound.sent',
      to: 'user@telegram',
      content: 'Hello back',
      channelId: 'telegram-123',
      success: true,
    });
  });

  it('agent.channel.transcribed', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.channel.transcribed',
      transcript: 'Hello from voice',
      from: 'user@discord',
      channelId: 'discord-voice-1',
      mediaPath: '/tmp/audio.ogg',
    });
  });

  it('agent.channel.preprocessed', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.channel.preprocessed',
      bodyForAgent: 'User sent: [image: cat.png, description: A fluffy cat]',
      from: 'user@slack',
      channelId: 'slack-general',
    });
  });

  // Tool family (5)
  it('agent.tool.pre', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.tool.pre',
      callId: 'call-001',
      tool: 'Bash',
      args: { command: 'ls -la' },
      riskTag: 'low',
    });
  });

  it('agent.tool.post', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.tool.post',
      callId: 'call-001',
      ok: true,
      durationMs: 42,
      summary: 'Listed 5 files',
      updatedMCPToolOutput: null,
    });
  });

  it('agent.tool.failure', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.tool.failure',
      callId: 'call-002',
      error: 'Command not found: bun',
      signalPattern: 'ENOENT',
      isInterrupt: false,
    });
  });

  it('agent.elicitation.request', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.elicitation.request',
      serverName: 'stripe-mcp',
      requestId: 'elicit-001',
      formSchema: { type: 'object', properties: { apiKey: { type: 'string' } } },
    });
  });

  it('agent.elicitation.result', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.elicitation.result',
      serverName: 'stripe-mcp',
      requestId: 'elicit-001',
      action: 'accept',
      content: { apiKey: 'sk_test_xxx' },
    });
  });

  // Permission family (3)
  it('agent.approval.request', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.approval.request',
      callId: 'call-003',
      prompt: 'Allow Bash(rm -rf /tmp/test)?',
      ttlMs: 30000,
      permissionSuggestions: [],
    });
  });

  it('agent.approval.result', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.approval.result',
      callId: 'call-003',
      decision: 'allow',
      by: 'remote',
      updatedInput: null,
      updatedPermissions: [],
    });
  });

  it('agent.approval.denied', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.approval.denied',
      callId: 'call-003',
      reason: 'User denied via mobile',
      retry: false,
    });
  });

  // Task / Teammate / Command family (4)
  it('agent.task.created', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.task.created',
      taskId: 'task-001',
      subject: 'Review PR #42',
      description: 'Please review the authentication changes',
      teammateName: 'Reviewer',
      teamName: 'Alpha',
    });
  });

  it('agent.task.completed', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.task.completed',
      taskId: 'task-001',
      subject: 'Review PR #42',
      status: 'completed',
    });
  });

  it('agent.teammate.idle', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.teammate.idle',
      teammateName: 'Reviewer',
      teamName: 'Alpha',
    });
  });

  it('agent.command', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.command',
      command: '/review',
      args: { pr: 42 },
      source: 'user',
      commandKind: 'new',
    });
  });

  // Memory / Context family (4)
  it('agent.compact.pre', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.compact.pre',
      sessionId: 'sess-001',
      trigger: 'auto',
      messageCount: 150,
      tokenCount: 95000,
    });
  });

  it('agent.compact.post', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.compact.post',
      sessionId: 'sess-001',
      compactedCount: 140,
      tokensBefore: 95000,
      tokensAfter: 8000,
    });
  });

  it('agent.instructions.loaded', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.instructions.loaded',
      filePath: '/project/CLAUDE.md',
      memoryType: 'project_instructions',
      loadReason: 'session_start',
    });
  });

  it('agent.bootstrap.injected', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.bootstrap.injected',
      bootstrapFiles: ['~/.prismer/skills/review.md'],
      agentId: 'agent-001',
    });
  });

  // Environment family (6)
  it('agent.fs.op', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.fs.op',
      op: 'write',
      path: '/project/src/main.ts',
      bytes: 4096,
    });
  });

  it('agent.file.watched', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.file.watched',
      filePath: '/project/package.json',
      changeType: 'modify',
    });
  });

  it('agent.cwd.changed', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.cwd.changed',
      oldCwd: '/project',
      newCwd: '/project/src',
    });
  });

  it('agent.config.changed', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.config.changed',
      configSource: 'user_settings',
      changedValues: { theme: 'dark' },
    });
  });

  it('agent.worktree.created', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.worktree.created',
      worktreePath: '/project/.worktrees/feat-auth',
      branch: 'feat/auth',
    });
  });

  it('agent.worktree.removed', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.worktree.removed',
      worktreePath: '/project/.worktrees/feat-auth',
    });
  });

  // Notification family (1)
  it('agent.notification', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.notification',
      notificationType: 'idle_prompt',
      message: 'Agent is waiting for your input',
      title: 'Idle',
    });
  });

  // Skill family (5)
  it('agent.skill.activated', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.skill.activated',
      skillName: 'review',
      source: { kind: 'user' },
      trigger: 'user-invoke',
      args: 'pr:42',
    });
  });

  it('agent.skill.deactivated', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.skill.deactivated',
      skillName: 'review',
      reason: 'compaction-drop',
    });
  });

  it('agent.skill.proposed', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.skill.proposed',
      draftPath: '~/.prismer/skills/drafts/new-skill.md',
      name: 'new-skill',
      description: 'A new skill proposed by the agent',
      author: 'agent',
    });
  });

  it('agent.skill.installed', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.skill.installed',
      skillName: 'deploy-prod',
      source: { kind: 'registry', registry: 'prismer', ref: 'deploy-prod@1.2.0' },
      version: '1.2.0',
      sha256: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc123',
    });
  });

  it('agent.skill.uninstalled', () => {
    mustParse(ParaEventSchema, {
      type: 'agent.skill.uninstalled',
      skillName: 'deploy-prod',
    });
  });
});

// ─── Negative: ≥10 malformed payloads ─────────────────────────────────────

describe('ParaEvent negative (malformed payloads rejected)', () => {
  it('unknown event type', () => mustFail(ParaEventSchema, { type: 'unknown.event', sessionId: 's1' }));
  it('null input', () => mustFail(ParaEventSchema, null));
  it('empty object', () => mustFail(ParaEventSchema, {}));
  it('string input', () => mustFail(ParaEventSchema, 'not-an-event'));
  it('array input', () => mustFail(ParaEventSchema, []));
  it('missing required field: agent.session.started without scope', () =>
    mustFail(ParaEventSchema, { type: 'agent.session.started', sessionId: 'sess-001' }));
  it('invalid enum: agent.session.ended unknown reason', () =>
    mustFail(ParaEventSchema, { type: 'agent.session.ended', sessionId: 's1', reason: 'cancelled' }));
  it('invalid type: agent.llm.pre tokensUsed as string', () =>
    mustFail(ParaEventSchema, {
      type: 'agent.llm.pre',
      sessionId: 's1',
      model: 'claude',
      conversationLength: 'five',
      isFirstTurn: true,
    }));
  it('missing required field: agent.approval.request without ttlMs', () =>
    mustFail(ParaEventSchema, { type: 'agent.approval.request', callId: 'c1', prompt: 'Allow?' }));
  it('invalid enum: agent.turn.failure unknown errorType', () =>
    mustFail(ParaEventSchema, {
      type: 'agent.turn.failure',
      sessionId: 's1',
      errorType: 'network_error',
      errorMessage: 'oops',
    }));
  it('boolean instead of object', () => mustFail(ParaEventSchema, true));
  it('number instead of object', () => mustFail(ParaEventSchema, 42));
  it('agent.approval.result invalid decision', () =>
    mustFail(ParaEventSchema, {
      type: 'agent.approval.result',
      callId: 'c1',
      decision: 'maybe',
      by: 'local',
    }));
});

// ─── Round-trip: JSON.parse(JSON.stringify(x)) === x ─────────────────────

describe('ParaEvent JSON round-trip', () => {
  const representativeEvents = [
    {
      type: 'agent.register',
      agent: {
        id: 'cc@host',
        adapter: 'claude-code',
        version: '2.1.0',
        tiersSupported: [1, 2, 3],
        capabilityTags: ['code'],
        workspace: '/home/user/proj',
      },
    },
    {
      type: 'agent.tool.pre',
      callId: 'x',
      tool: 'Bash',
      args: { command: 'echo hi' },
      riskTag: 'low',
    },
    {
      type: 'agent.notification',
      notificationType: 'other',
      message: 'hello',
    },
    {
      type: 'agent.skill.installed',
      skillName: 'deploy',
      source: { kind: 'registry', registry: 'prismer', ref: 'deploy@1.0.0' },
      sha256: 'deadbeef'.repeat(8),
    },
    {
      type: 'agent.compact.post',
      sessionId: 's1',
      compactedCount: 100,
      tokensBefore: 80000,
      tokensAfter: 5000,
    },
  ];

  for (const event of representativeEvents) {
    it(`round-trip: ${event.type}`, () => {
      const parsed = ParaEventSchema.parse(event);
      const serialized = JSON.stringify(parsed);
      const reparsed = ParaEventSchema.parse(JSON.parse(serialized));
      expect(reparsed).toEqual(parsed);
    });
  }
});

// ─── AgentDescriptor ──────────────────────────────────────────────────────

describe('AgentDescriptor', () => {
  it('valid descriptor', () => {
    mustParse(AgentDescriptorSchema, {
      id: 'claude-code@MacBook-Pro',
      adapter: 'claude-code',
      version: '2.1.105',
      tiersSupported: [1, 2, 3, 4, 5, 6, 7],
      capabilityTags: ['code', 'shell', 'mcp', 'approval'],
      workspace: '/Users/test/project',
      workspaceGroup: 'team-alpha',
    });
  });

  it('rejects non-integer tier', () => {
    mustFail(AgentDescriptorSchema, {
      id: 'a',
      adapter: 'cc',
      version: '1.0',
      tiersSupported: [1.5],
      capabilityTags: [],
      workspace: '/',
    });
  });

  it('rejects tier out of range', () => {
    mustFail(AgentDescriptorSchema, {
      id: 'a',
      adapter: 'cc',
      version: '1.0',
      tiersSupported: [11],
      capabilityTags: [],
      workspace: '/',
    });
  });
});

// ─── SkillSource (6 variants) ─────────────────────────────────────────────

describe('SkillSource', () => {
  it('kind: user', () => mustParse(SkillSourceSchema, { kind: 'user' }));
  it('kind: project', () => mustParse(SkillSourceSchema, { kind: 'project', workspace: '/ws' }));
  it('kind: workspace', () => mustParse(SkillSourceSchema, { kind: 'workspace', workspace: '/ws' }));
  it('kind: plugin', () => mustParse(SkillSourceSchema, { kind: 'plugin', pluginName: 'prismer-cc' }));
  it('kind: bundled', () => mustParse(SkillSourceSchema, { kind: 'bundled', adapter: 'claude-code' }));
  it('kind: registry (prismer)', () =>
    mustParse(SkillSourceSchema, { kind: 'registry', registry: 'prismer', ref: 'review@1.0.0' }));
  it('kind: registry (clawhub)', () =>
    mustParse(SkillSourceSchema, { kind: 'registry', registry: 'clawhub', ref: 'deploy@2.0' }));
  it('rejects unknown kind', () => mustFail(SkillSourceSchema, { kind: 'github', repo: 'foo/bar' }));
  it('rejects missing workspace for project', () => mustFail(SkillSourceSchema, { kind: 'project' }));
});

// ─── PermissionRule ───────────────────────────────────────────────────────

describe('PermissionRule', () => {
  it('valid rule (structured value)', () => {
    mustParse(PermissionRuleSchema, {
      source: 'policySettings',
      behavior: 'deny',
      value: { tool: 'Bash', pattern: 'rm *' },
    });
  });

  it('valid rule with no pattern', () => {
    mustParse(PermissionRuleSchema, {
      source: 'session',
      behavior: 'allow',
      value: { tool: 'Edit' },
    });
  });

  it('all 8 sources accepted', () => {
    const sources = ['policySettings', 'userSettings', 'projectSettings', 'localSettings', 'skill', 'session', 'cliArg', 'command'] as const;
    for (const source of sources) {
      mustParse(PermissionRuleSchema, { source, behavior: 'allow', value: { tool: '*' } });
    }
  });

  it('all 3 behaviors accepted', () => {
    for (const behavior of ['allow', 'deny', 'ask'] as const) {
      mustParse(PermissionRuleSchema, { source: 'session', behavior, value: { tool: 'Edit' } });
    }
  });

  it('rejects unknown source', () => mustFail(PermissionRuleSchema, { source: 'unknown', behavior: 'allow', value: { tool: '*' } }));

  it('rejects string value (old shape)', () => mustFail(PermissionRuleSchema, { source: 'session', behavior: 'allow', value: 'Bash' }));
});

// ─── PermissionMode ───────────────────────────────────────────────────────

describe('PermissionMode', () => {
  it('all 6 modes accepted', () => {
    for (const mode of ['default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'auto'] as const) {
      mustParse(PermissionModeSchema, mode);
    }
  });
  it('rejects unknown mode', () => mustFail(PermissionModeSchema, 'superAdmin'));
});

// ─── EncryptedEnvelope ────────────────────────────────────────────────────

describe('EncryptedEnvelope', () => {
  it('valid envelope', () => {
    mustParse(EncryptedEnvelopeSchema, { t: 'encrypted', c: 'base64ciphertext==', v: 1 });
  });
  it('rejects wrong t', () => mustFail(EncryptedEnvelopeSchema, { t: 'plaintext', c: 'hi', v: 1 }));
  it('rejects wrong version', () => mustFail(EncryptedEnvelopeSchema, { t: 'encrypted', c: 'data', v: 2 }));
  it('rejects empty ciphertext', () => mustFail(EncryptedEnvelopeSchema, { t: 'encrypted', c: '', v: 1 }));
});

// ─── Binary frame encode/decode ───────────────────────────────────────────

describe('Frame encode/decode round-trip', () => {
  it('random bytes round-trip', () => {
    for (let i = 0; i < 20; i++) {
      const size = Math.floor(Math.random() * 512) + 1;
      const payload = new Uint8Array(size);
      for (let j = 0; j < size; j++) payload[j] = Math.floor(Math.random() * 256);
      const opcode = (Math.floor(Math.random() * 5)) as 0 | 1 | 2 | 3 | 4;
      const slot = Math.floor(Math.random() * 256);
      const encoded = encodeFrame({ opcode, slot, payload });
      const decoded = decodeFrame(encoded);
      expect(decoded.opcode).toBe(opcode);
      expect(decoded.slot).toBe(slot);
      expect(decoded.payload).toEqual(payload);
    }
  });

  it('all opcodes round-trip', () => {
    for (const opcode of [Opcode.JSON_CONTROL, Opcode.AGENT_OUTPUT, Opcode.TERMINAL_IO, Opcode.FILE_CHUNK, Opcode.AUDIT_TAP]) {
      const payload = new TextEncoder().encode(`{"type":"test","opcode":${opcode}}`);
      const encoded = encodeFrame({ opcode, slot: 0, payload });
      const decoded = decodeFrame(encoded);
      expect(decoded.opcode).toBe(opcode);
      expect(decoded.payload).toEqual(payload);
    }
  });

  it('2-byte overhead', () => {
    const payload = new Uint8Array(100);
    const encoded = encodeFrame({ opcode: Opcode.JSON_CONTROL, slot: 0, payload });
    expect(encoded.length).toBe(102);
  });

  it('throws on too-short frame', () => {
    expect(() => decodeFrame(new Uint8Array(1))).toThrow('Frame too short');
  });

  it('file chunking round-trip (64KB chunks)', () => {
    const original = new Uint8Array(200 * 1024);
    for (let i = 0; i < original.length; i++) original[i] = i % 256;
    const chunks = chunkFile(original, 64 * 1024, 3);
    expect(chunks.length).toBe(Math.ceil(original.length / (64 * 1024)));
    const reassembled = reassembleFile(chunks);
    expect(reassembled).toEqual(original);
  });
});

// ─── Deeplink ─────────────────────────────────────────────────────────────
// Canonical v1.9.0 semantics (see docs/version190/07-remote-control.md §5.6.2):
//   - user/chat/pair use `kind:` discriminator (new format)
//   - invoke/open retain `action:` discriminator (legacy format)
// Legacy `action: 'pair'` + `token` shape was removed; pairing moved to
// `kind: 'pair'` + `offer`. Golden fixtures in fixtures/deeplinks.golden.json
// are the source of truth — see test/deeplinks.test.ts for golden coverage.

describe('Deeplink', () => {
  it('parse user link (new kind format)', () => {
    const link = parseDeeplink('prismer://u/abc');
    expect((link as { kind: string }).kind).toBe('user');
    expect((link as { userId: string }).userId).toBe('abc');
  });

  it('parse chat link (new kind format)', () => {
    const link = parseDeeplink('prismer://chat/conv123');
    expect((link as { kind: string }).kind).toBe('chat');
    expect((link as { convId: string }).convId).toBe('conv123');
  });

  it('parse pair link (new kind format)', () => {
    const link = parseDeeplink('prismer://pair?offer=xyz');
    expect((link as { kind: string }).kind).toBe('pair');
    expect((link as { offer: string }).offer).toBe('xyz');
  });

  it('parse invoke link (legacy action format)', () => {
    const link = parseDeeplink('prismer://invoke?skill=review&args=pr%3A42');
    expect((link as { action: string }).action).toBe('invoke');
    expect((link as { skill: string }).skill).toBe('review');
  });

  it('parse open link (legacy action format)', () => {
    const link = parseDeeplink('prismer://open?target=/project/src');
    expect((link as { action: string }).action).toBe('open');
    expect((link as { target: string }).target).toBe('/project/src');
  });

  it('serialize user link', () => {
    const link: import('../src/deeplinks.js').PrismerDeeplink = {
      scheme: 'prismer',
      kind: 'user',
      userId: 'user-123',
    };
    expect(serializeDeeplink(link)).toBe('prismer://u/user-123');
  });

  it('serialize chat link', () => {
    const link: import('../src/deeplinks.js').PrismerDeeplink = {
      scheme: 'prismer',
      kind: 'chat',
      convId: 'conv-456',
    };
    expect(serializeDeeplink(link)).toBe('prismer://chat/conv-456');
  });

  it('serialize pair link', () => {
    const link: import('../src/deeplinks.js').PrismerDeeplink = {
      scheme: 'prismer',
      kind: 'pair',
      offer: 'xyz789',
    };
    const uri = serializeDeeplink(link);
    expect(uri).toContain('prismer://pair');
    expect(uri).toContain('offer=xyz789');
  });

  it('round-trip user link', () => {
    const original: import('../src/deeplinks.js').PrismerDeeplink = {
      scheme: 'prismer',
      kind: 'user',
      userId: 'user-rt',
    };
    const uri = serializeDeeplink(original);
    const parsed = parseDeeplink(uri);
    expect(parsed).toEqual(original);
  });

  it('round-trip chat link', () => {
    const original: import('../src/deeplinks.js').PrismerDeeplink = {
      scheme: 'prismer',
      kind: 'chat',
      convId: 'conv-rt',
    };
    const uri = serializeDeeplink(original);
    const parsed = parseDeeplink(uri);
    expect(parsed).toEqual(original);
  });

  it('round-trip pair link', () => {
    const original: import('../src/deeplinks.js').PrismerDeeplink = {
      scheme: 'prismer',
      kind: 'pair',
      offer: 'tok-roundtrip',
      source: 'qr',
    };
    const uri = serializeDeeplink(original);
    const parsed = parseDeeplink(uri);
    expect(parsed).toEqual(original);
  });

  it('rejects non-prismer URI', () => {
    expect(() => parseDeeplink('https://example.com/pair?offer=x')).toThrow();
  });

  it('rejects invalid action', () => {
    expect(() => parseDeeplink('prismer://hack?payload=evil')).toThrow();
  });

  it('rejects URI with no action', () => {
    expect(() => parseDeeplink('prismer://')).toThrow(/Missing action\/kind/);
  });

  it('rejects pair URI with no query params', () => {
    expect(() => parseDeeplink('prismer://pair')).toThrow(/Missing action\/kind/);
  });

  it('validates schema directly', () => {
    mustFail(PrismerDeeplinkSchema, { scheme: 'prismer', kind: 'pair' }); // missing offer
    mustFail(PrismerDeeplinkSchema, { scheme: 'http', kind: 'pair', offer: 'x' }); // wrong scheme
    mustFail(PrismerDeeplinkSchema, { scheme: 'prismer', kind: 'user' }); // missing userId
    mustFail(PrismerDeeplinkSchema, { scheme: 'prismer', action: 'invoke' }); // missing skill
  });
});
