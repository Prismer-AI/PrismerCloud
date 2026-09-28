// product209/19 WP3 — PKF report directive injection (complex-question final
// reports → PKF pages), across all four adapter families.
//
// Oracle discipline: only injected TEXT is asserted (never chat content).
// Three layers:
//   1. Trigger matrix — the directive text itself carries the three key
//      semantics (表格/table, PKF, markdown 投影/projection); missing any one
//      → red.
//   2. Dispatch seam — composeCoreDirectives() hands the SAME verbatim text to
//      hermes / claude-code / codex / opencode (and nothing to anyone else).
//   3. Per-adapter assembly fixtures — each adapter's own prompt assembly
//      preserves both directive texts verbatim:
//        claude-code  composeClaudeCodeSystemPrompt (--system-prompt)
//        codex        buildCodexPrompt (prompt prefix)
//        opencode     composeSystemPromptParts (system slot, opencode-agent.ts)
//        hermes       real dispatch with stubbed fetch → SOUL.md on disk

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProfile, TaskInput } from '../src/adapters/contract.js';
import {
  MEMORY_CORE_DIRECTIVE,
  PKF_REPORT_DIRECTIVE,
  composeCoreDirectives,
} from '../src/daemon/dispatch.js';
import { composeClaudeCodeSystemPrompt } from '../src/adapters/coding/claude-code/index.js';
import { buildCodexPrompt } from '../src/adapters/coding/codex/index.js';
import { composeSystemPromptParts } from '../src/adapters/coding/shared/system-prompt.js';
import { getHermesProfileDir } from '../src/adapters/persistence/hermes/index.js';

const DIRECTIVE_BLOCK = [MEMORY_CORE_DIRECTIVE, PKF_REPORT_DIRECTIVE].join('\n\n');
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// ─── 1. Trigger matrix (pure text eval) ─────────────────────────────

describe('PKF_REPORT_DIRECTIVE — trigger matrix (text-level)', () => {
  it('names the 表格/table trigger (complex structured report)', () => {
    expect(PKF_REPORT_DIRECTIVE).toMatch(/表格|table/i);
  });
  it('names PKF as the delivery format', () => {
    expect(PKF_REPORT_DIRECTIVE).toContain('PKF');
  });
  it('names the markdown 投影/projection channel', () => {
    expect(PKF_REPORT_DIRECTIVE).toMatch(/markdown 投影|markdown projection/i);
  });
  it('auto-selects PKF without asking and reserves plain markdown for genuinely short replies', () => {
    expect(PKF_REPORT_DIRECTIVE).toMatch(/auto-select/i);
    expect(PKF_REPORT_DIRECTIVE).toMatch(/do not ask/i);
    expect(PKF_REPORT_DIRECTIVE).toMatch(/only.*short.*(?:markdown|message)/i);
  });
  it('carries the fallback rule (markdown, never block the answer)', () => {
    expect(PKF_REPORT_DIRECTIVE).toMatch(/markdown/i);
    expect(PKF_REPORT_DIRECTIVE).toMatch(/NEVER block/i);
  });
  it('references the pkf-writing skill and pkf_validate', () => {
    expect(PKF_REPORT_DIRECTIVE).toContain('`pkf-writing`');
    expect(PKF_REPORT_DIRECTIVE).toContain('`pkf_validate`');
  });
  it('routes dependency-bearing PKF through the atomic bundle tool instead of individual uploads', () => {
    expect(PKF_REPORT_DIRECTIVE).toContain('`pkf_bundle_commit`');
    expect(PKF_REPORT_DIRECTIVE).toMatch(/dependenc|JS|CSS|media|CSV/i);
    expect(PKF_REPORT_DIRECTIVE).toMatch(/never.*(?:separate|individual).*upload/i);
  });
  it('sinks hash/SRI/manifest computation to the Runtime (pkf209/07 §4a)', () => {
    expect(PKF_REPORT_DIRECTIVE).toMatch(/Runtime responsibilities/i);
    expect(PKF_REPORT_DIRECTIVE).toMatch(/never compute sha256\/SRI yourself/i);
    expect(PKF_REPORT_DIRECTIVE).toMatch(/bytesBase64 or text/i);
  });
  it('teaches the pkf_reply_inline mechanical delivery and never the sentinel grammar (pkf209)', () => {
    // 2026-08-20 matrix fix: the sentinel grammar demanded byte-exact
    // pasting from the model — weak models failed exactly that last step.
    // The directive now teaches the native tool path only; the sentinel wire
    // mechanism (inline-pkf.ts) stays as legacy compatibility for old agents.
    expect(PKF_REPORT_DIRECTIVE).toContain('`pkf_reply_inline`');
    expect(PKF_REPORT_DIRECTIVE).toMatch(/never paste sentinel comments/i);
    expect(PKF_REPORT_DIRECTIVE).toMatch(/never attach the \.pkf as a file/i);
    expect(PKF_REPORT_DIRECTIVE).not.toContain('<!-- prismer-pkf:inline:start -->');
    expect(PKF_REPORT_DIRECTIVE).not.toContain('<!-- prismer-pkf:inline:end -->');
  });
  it('selects inline as the only default authority instead of inventing Memory or attachments', () => {
    expect(PKF_REPORT_DIRECTIVE).toMatch(/inline ContentBlock/i);
    expect(PKF_REPORT_DIRECTIVE).toMatch(/unless the user explicitly requests/i);
    expect(PKF_REPORT_DIRECTIVE).not.toContain('`memory_write`');
    expect(PKF_REPORT_DIRECTIVE).not.toMatch(/declare the attachment path/i);
  });
  it('carries the report-quality floor before mechanical delivery', () => {
    expect(PKF_REPORT_DIRECTIVE).toMatch(/valid PKF.*unacceptable/i);
    expect(PKF_REPORT_DIRECTIVE).toMatch(/5\+ sections/i);
    expect(PKF_REPORT_DIRECTIVE).toMatch(/at least two/i);
    expect(PKF_REPORT_DIRECTIVE).toMatch(/table|diagram|data chart|widget|controlled SVG/i);
    expect(PKF_REPORT_DIRECTIVE).toMatch(/captions?\/alt text/i);
  });
});

describe('all role and task surfaces obey the single carrier directive', () => {
  it('contains no historical role-local Memory or Markdown-Asset carrier policy', () => {
    const roleDirs = [
      join(REPO_ROOT, 'sdk/cloud/catalog/roles'),
      join(REPO_ROOT, 'sdk/prismer/src/templates/roles'),
    ];
    for (const roleDir of roleDirs) {
      const roleFiles = readdirSync(roleDir).filter((name) => name.endsWith('.json'));
      expect(roleFiles.length).toBeGreaterThan(0);
      for (const roleFile of roleFiles) {
        const source = readFileSync(join(roleDir, roleFile), 'utf8');
        const label = `${roleDir}/${roleFile}`;
        expect(source, label).not.toMatch(/PKF memory page plus a parallel markdown projection/i);
        expect(source, label).not.toMatch(/complex structured reports[\s\S]*Memory Page/i);
        expect(source, label).not.toMatch(/documentation-type deliverables\s*=\s*markdown files/i);
        expect(source, label).not.toMatch(/文档型交付物\s*=\s*markdown 文件/i);
        expect(source, label).not.toMatch(/MUST be (?:a )?markdown files?/i);
        expect(source, label).not.toMatch(/必须写成 markdown 文件/i);
        expect(source, label).not.toMatch(/task-bound markdown artifacts?/i);
        expect(source, label).not.toMatch(/artifacts-watcher 自动注册/i);
        expect(source, label).not.toMatch(/artifacts-watcher receipt is the authoritative delivery receipt/i);
        expect(source, label).not.toMatch(/\(as markdown\)/i);
        expect(source, label).not.toMatch(/（以 markdown 呈现）/i);
        expect(source, label).not.toMatch(/写成 markdown 落到/i);
        expect(source, label).not.toMatch(/markdown 验收记录走 artifacts\/ 自动归档/i);
      }
    }
  });

  it('keeps the tasks skill carrier-neutral and mirrors it byte-for-byte into Runtime', () => {
    const catalog = readFileSync(join(REPO_ROOT, 'sdk/cloud/catalog/skills/tasks/SKILL.md'), 'utf8');
    const runtime = readFileSync(join(REPO_ROOT, 'sdk/prismer/built-in-skills/tasks/SKILL.md'), 'utf8');
    expect(runtime).toBe(catalog);
    expect(catalog).toMatch(/inline PKF/i);
    expect(catalog).toMatch(/Runtime carrier directive/i);
    expect(catalog).not.toMatch(/适用于一切「文档型」交付物/i);
    expect(catalog).not.toMatch(/文档型最终产物\*\*必须写成 markdown 文件/i);
    expect(catalog).not.toMatch(/artifacts-watcher 会自动/i);
    expect(catalog).toMatch(/auto-scan 是 OFF/i);
    expect(catalog).toMatch(/不并行产出 `\.md` \/ `\.html` \/ `\.css` \/ `\.js`/i);
  });
});

// ─── 2. Dispatch seam — identical text for all four adapters ────────

describe('dispatch seam — composeCoreDirectives (all four adapter families, verbatim)', () => {
  const ALL = ['hermes', 'pi-core', 'claude-code', 'codex', 'opencode'];
  for (const adapterName of ALL) {
    it(`injects MEMORY + PKF directives for ${adapterName}`, () => {
      expect(composeCoreDirectives(adapterName)).toEqual([MEMORY_CORE_DIRECTIVE, PKF_REPORT_DIRECTIVE]);
    });
  }
  it('injects nothing for non-target adapters', () => {
    expect(composeCoreDirectives('openclaw')).toEqual([]);
    expect(composeCoreDirectives('unknown-adapter')).toEqual([]);
  });
});

// ─── 3. Per-adapter prompt assembly fixtures ────────────────────────

describe('adapter prompt assemblies carry both directives verbatim', () => {
  it('claude-code — composeClaudeCodeSystemPrompt (--system-prompt slot)', () => {
    const out = composeClaudeCodeSystemPrompt(
      { prompt: 'x', metadata: { systemPrompt: DIRECTIVE_BLOCK } } as TaskInput,
      undefined,
    );
    expect(out).toContain(MEMORY_CORE_DIRECTIVE);
    expect(out).toContain(PKF_REPORT_DIRECTIVE);
  });

  it('codex — buildCodexPrompt (systemPrompt prefix)', () => {
    const out = buildCodexPrompt(
      {
        cwd: '/tmp',
        model: 'codex-mini-latest',
        sandbox: 'workspace-write' as const,
        apiKeyEnv: 'OPENAI_API_KEY',
        systemPrompt: DIRECTIVE_BLOCK,
      },
      'task X',
    );
    expect(out).toContain(MEMORY_CORE_DIRECTIVE);
    expect(out).toContain(PKF_REPORT_DIRECTIVE);
  });

  it('opencode — composeSystemPromptParts (promptAsync system slot)', () => {
    // This is the exact assembly opencode-agent.ts runs for the `system` slot:
    // composeSystemPromptParts(this.config.systemPrompt, this.config.daemonAppendSystemPrompt),
    // where config.systemPrompt carries the dispatch-composed metadata.systemPrompt.
    const out = composeSystemPromptParts(DIRECTIVE_BLOCK, undefined);
    expect(out).toContain(MEMORY_CORE_DIRECTIVE);
    expect(out).toContain(PKF_REPORT_DIRECTIVE);
  });
});

// ─── hermes — SOUL.md via real dispatch (fetch stubbed) ─────────────

/**
 * The hermes assembly writes `task.metadata.systemPrompt` verbatim to
 * `<HERMES_HOME>/profiles/<profileName>/SOUL.md` (hermes/index.ts dispatch).
 * We run the real dispatch with a stubbed fetch (the adapter-multimodal
 * harness shape: /health/detailed + /v1/capabilities + sessions API), then
 * read the SOUL.md file off disk — the file IS the hermes prompt output.
 */
function makeStubFetch(captured: Array<{ url: string; method?: string; body?: unknown }>): typeof fetch {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/health/detailed')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          gateway_state: 'running',
          platforms: { api_server: { state: 'connected' } },
        }),
      } as Response;
    }
    if (url.endsWith('/v1/capabilities')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          features: { session_chat_streaming: true, run_approval_response: true },
        }),
      } as Response;
    }
    captured.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (url.endsWith('/api/sessions')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null } as unknown as Headers,
        json: async () => ({ session: { id: 'sess-conv-1' } }),
      } as Response;
    }
    if (url.includes('/api/sessions/') && url.endsWith('/chat/stream')) {
      const encoder = new TextEncoder();
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('event: run.started\ndata: {"run_id":"run-1"}\n\n'));
            controller.enqueue(encoder.encode('event: assistant.delta\ndata: {"delta":"ack"}\n\n'));
            controller.enqueue(
              encoder.encode('event: run.completed\ndata: {"usage":{"input_tokens":10,"output_tokens":3}}\n\n'),
            );
            controller.close();
          },
        }),
      } as Response;
    }
    return { ok: false, status: 404, text: async () => 'unexpected url' } as Response;
  }) as unknown as typeof fetch;
}

function makeStubSessionMapper() {
  let cached: { conversationId: string; agentImUserId: string; hermesSessionId: string; hermesSessionKey: string | null } | null = null;
  return {
    get(conversationId: string, agentImUserId: string) {
      if (!cached) return null;
      return cached.conversationId === conversationId && cached.agentImUserId === agentImUserId ? cached : null;
    },
    async createForConversation(
      _baseUrl: string,
      _apiKey: string,
      conversationId: string,
      agentImUserId: string,
      _profileName: string,
      _workspaceId?: string,
      _runtimeSelection?: { model: string },
    ) {
      cached = { conversationId, agentImUserId, hermesSessionId: `sess-${conversationId}`, hermesSessionKey: null };
      return cached;
    },
  };
}

describe('hermes — SOUL.md carries both directives verbatim (real dispatch, fetch stubbed)', () => {
  let home: string;
  let oldHermesHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'prismer-pkf-directive-'));
    oldHermesHome = process.env.HERMES_HOME;
    process.env.HERMES_HOME = join(home, 'hermes');
  });
  afterEach(async () => {
    if (oldHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = oldHermesHome;
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
    const { setHermesSessionMapper } = await import('../src/adapters/persistence/hermes/sessions-mapper.js');
    setHermesSessionMapper(null);
  });

  it('writes the dispatch-composed directive text into SOUL.md', async () => {
    const { hermesAdapter } = await import('../src/adapters/persistence/hermes/index.js');
    const { setHermesSessionMapper } = await import('../src/adapters/persistence/hermes/sessions-mapper.js');
    setHermesSessionMapper(makeStubSessionMapper() as never);

    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', makeStubFetch(requests));

    const profile: AgentProfile = {
      id: 'profile-test',
      workspaceId: 'ws-1',
      agentImUserId: 'agent-test',
      agentUsername: 'test-agent',
      adapterName: 'hermes',
      name: 'default',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      config: { apiKey: 'sk-test', prismerMcpServerPath: '/tmp/mcp.js' },
    };
    const service = await hermesAdapter.ensureService!(profile);
    const result = await service.dispatch({
      taskId: 't-pkf',
      prompt: 'report please',
      metadata: {
        conversationId: 'conv-1',
        agentImUserId: 'agent-test',
        workspaceId: 'ws-1',
        systemPrompt: DIRECTIVE_BLOCK,
      },
    } as TaskInput);

    expect(result.ok).toBe(true);
    const soul = readFileSync(join(getHermesProfileDir('test-agent'), 'SOUL.md'), 'utf8');
    expect(soul).toContain(MEMORY_CORE_DIRECTIVE);
    expect(soul).toContain(PKF_REPORT_DIRECTIVE);
  });
});
