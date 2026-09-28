import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachPkfRpc } from '../src/daemon/pkf/rpc.js';
import {
  PKF_INLINE_REPLY_MARKER_FILENAME,
  bindPkfReplyInlineScope,
  resolvePkfReplyInlineBlocks,
  runPkfReplyInlineTool,
  unbindPkfReplyInlineScope,
} from '../src/daemon/pkf/reply-inline.js';
import {
  PKF_REPLY_INLINE_TOOL,
  type PkfReplyInlineToolInput,
} from '../src/adapters/memory-tools.js';
import { HERMES_MEMORY_TOOLS } from '../src/adapters/persistence/hermes/memory-tools.js';
import { handleDispatch, PKF_REPORT_DIRECTIVE } from '../src/daemon/dispatch.js';
import type { AgentProfile } from '../src/adapters/contract.js';

/**
 * pkf209 — the `pkf_reply_inline` native tool (mechanical inline-PKF delivery).
 *
 * 2026-08-20 matrix root cause: weak models complete every correct step but
 * fail the LAST one — pasting the sentinel-wrapped PKF into the final reply
 * text. The tool removes that burden: the agent calls it with the validated
 * file path, the daemon validates + writes a per-task marker, and the dispatch
 * terminal state mechanically constructs the same contentBlock shape the
 * sentinel extraction produces. The sentinel wire path stays untouched
 * (legacy agents); the tool path is additive.
 */

const here = dirname(fileURLToPath(import.meta.url));
const providerPath = join(here, '..', 'plugins', 'memory', 'prismer', '__init__.py');
const havePython = spawnSync('python3', ['--version'], { timeout: 10_000 }).status === 0;

const GOOD_PKF =
  '<script type="application/prismer+json">{"type":"note","title":"Vector search memo","description":"HNSW vs IVF vs brute force.","pkfVersion":"1.1"}</script>' +
  '<section><h2 id="summary" data-sid="sec_01k2f6m8v7q4x9a3b5c6d7e8f9">Summary</h2><p>Recall/cost trade-offs.</p></section>';

const BAD_PKF = '<p>no frontmatter at all</p>';

const AGENT = 'agent-reply-inline';

let scratch: string;
let workRoot: string;
let server: HttpServer;
let port: number;

function writeFileRecursive(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

beforeEach(async () => {
  workRoot = mkdtempSync(join(tmpdir(), 'pkf-reply-inline-'));
  scratch = join(workRoot, 'ws', 'tasks', 'task-1', 'scratch');
  writeFileRecursive(join(scratch, 'memo.pkf'), GOOD_PKF);

  const pkfRpc = attachPkfRpc({});
  server = createHttpServer(async (req, res) => {
    if (!(await pkfRpc(req, res))) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('PKF RPC port unavailable');
  port = address.port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workRoot, { recursive: true, force: true });
  unbindPkfReplyInlineScope(AGENT, 'task-1');
});

describe('pkf_reply_inline tool handler (daemon-side)', () => {
  beforeEach(() => {
    bindPkfReplyInlineScope(AGENT, { taskId: 'task-1', scratchDir: scratch, allowedReadRoots: [] });
  });

  it('happy path: validates the file, writes the marker, returns hash + title', async () => {
    const out = await runPkfReplyInlineTool({ agentImUserId: AGENT, path: 'memo.pkf' });
    expect(out).toMatchObject({ ok: true, emitted: true, title: 'Vector search memo' });
    if (!out.ok) throw new Error('unreachable');
    expect(out.sourceHash).toMatch(/^[0-9a-f]{64}$/);

    const markerPath = join(scratch, PKF_INLINE_REPLY_MARKER_FILENAME);
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    expect(marker.taskId).toBe('task-1');
    expect(marker.sourceHash).toBe(out.sourceHash);
    expect(marker.path).toBe(join(scratch, 'memo.pkf'));
  });

  it('rejects an invalid PKF without writing any marker', async () => {
    writeFileRecursive(join(scratch, 'bad.pkf'), BAD_PKF);
    const out = await runPkfReplyInlineTool({ agentImUserId: AGENT, path: 'bad.pkf' });
    expect(out).toMatchObject({ ok: false, error: 'pkf_reply_inline_invalid' });
    expect(existsSync(join(scratch, PKF_INLINE_REPLY_MARKER_FILENAME))).toBe(false);
  });

  it('rejects a source over the 32 KiB inline block budget', async () => {
    const padded = GOOD_PKF.replace('Recall/cost trade-offs.', 'x'.repeat(33_000));
    writeFileRecursive(join(scratch, 'huge.pkf'), padded);
    const out = await runPkfReplyInlineTool({ agentImUserId: AGENT, path: 'huge.pkf' });
    expect(out).toMatchObject({ ok: false, error: 'pkf_reply_inline_too_large' });
    expect(existsSync(join(scratch, PKF_INLINE_REPLY_MARKER_FILENAME))).toBe(false);
  });

  it('rejects path escape outside the task scratch/workdir roots', async () => {
    const outside = join(workRoot, 'outside.pkf');
    writeFileSync(outside, GOOD_PKF);
    const relativeEscape = await runPkfReplyInlineTool({
      agentImUserId: AGENT,
      path: '../../outside.pkf',
    });
    expect(relativeEscape).toMatchObject({ ok: false, error: 'pkf_reply_inline_path_outside' });

    const absoluteEscape = await runPkfReplyInlineTool({ agentImUserId: AGENT, path: outside });
    expect(absoluteEscape).toMatchObject({ ok: false, error: 'pkf_reply_inline_path_outside' });
    expect(existsSync(join(scratch, PKF_INLINE_REPLY_MARKER_FILENAME))).toBe(false);
  });

  it('accepts a file inside an explicit extra read root (repo workdir)', async () => {
    const repo = join(workRoot, 'repo');
    writeFileRecursive(join(repo, 'research.pkf'), GOOD_PKF);
    unbindPkfReplyInlineScope(AGENT, 'task-1');
    bindPkfReplyInlineScope(AGENT, { taskId: 'task-1', scratchDir: scratch, allowedReadRoots: [repo] });
    const out = await runPkfReplyInlineTool({ agentImUserId: AGENT, path: join(repo, 'research.pkf') });
    expect(out).toMatchObject({ ok: true, emitted: true });
  });

  it('resolves a RELATIVE path against the agent cwd root when scratch misses (run-2 lesson)', async () => {
    // 2026-08-20 run 2: the hermes agent wrote `memo.pkf` with a relative
    // write_file → landed in its profile cwd, not the task scratch. The tool
    // must resolve the same relative path against every read root, or the
    // model retries until it gives up and attaches the file.
    const profileCwd = join(workRoot, 'profiles', 'marketer');
    writeFileRecursive(join(profileCwd, 'memo.pkf'), GOOD_PKF);
    unbindPkfReplyInlineScope(AGENT, 'task-1');
    bindPkfReplyInlineScope(AGENT, {
      taskId: 'task-1',
      scratchDir: scratch,
      allowedReadRoots: [profileCwd],
    });
    const out = await runPkfReplyInlineTool({ agentImUserId: AGENT, path: 'memo.pkf' });
    expect(out).toMatchObject({ ok: true, emitted: true, title: 'Vector search memo' });
  });

  it('fails closed without an active dispatch scope', async () => {
    unbindPkfReplyInlineScope(AGENT, 'task-1');
    const out = await runPkfReplyInlineTool({ agentImUserId: AGENT, path: 'memo.pkf' });
    expect(out).toMatchObject({ ok: false, error: 'pkf_reply_inline_no_active_task' });
  });
});

describe('terminal marker resolution (dispatch final state)', () => {
  it('builds the same contentBlock shape as the sentinel extraction', async () => {
    bindPkfReplyInlineScope(AGENT, { taskId: 'task-1', scratchDir: scratch, allowedReadRoots: [] });
    await runPkfReplyInlineTool({ agentImUserId: AGENT, path: 'memo.pkf' });

    const outcome = await resolvePkfReplyInlineBlocks(scratch, []);
    expect(outcome).not.toBeNull();
    expect(outcome && 'contentBlocks' in outcome ? outcome.contentBlocks : []).toEqual([
      { kind: 'pkf', source: GOOD_PKF, title: 'Vector search memo' },
    ]);
  });

  it('re-validates: a tampered file (hash drift) emits no block and reports the reason', async () => {
    bindPkfReplyInlineScope(AGENT, { taskId: 'task-1', scratchDir: scratch, allowedReadRoots: [] });
    await runPkfReplyInlineTool({ agentImUserId: AGENT, path: 'memo.pkf' });
    writeFileSync(join(scratch, 'memo.pkf'), GOOD_PKF.replace('Recall/cost', 'TAMPERED'));

    const outcome = await resolvePkfReplyInlineBlocks(scratch, []);
    expect(outcome).toMatchObject({ warn: true, reason: 'pkf_reply_inline_file_changed' });
  });

  it('re-validates: a FORGED marker (correct hash, invalid PKF) still emits no block', async () => {
    // The agent can write files in its own scratch dir — a hand-forged marker
    // whose sourceHash matches the (invalid) file must still fail closed at
    // terminal: the PKF itself is re-validated, never trusted from the hash.
    writeFileSync(join(scratch, 'memo.pkf'), BAD_PKF);
    writeFileSync(
      join(scratch, PKF_INLINE_REPLY_MARKER_FILENAME),
      JSON.stringify({
        taskId: 'task-1',
        path: join(scratch, 'memo.pkf'),
        sourceHash: createHash('sha256').update(BAD_PKF).digest('hex'),
      }),
    );

    const outcome = await resolvePkfReplyInlineBlocks(scratch, []);
    expect(outcome).toMatchObject({ warn: true, reason: 'pkf_reply_inline_invalid' });
  });

  it('returns null when no marker exists (plain replies stay plain)', async () => {
    expect(await resolvePkfReplyInlineBlocks(scratch, [])).toBeNull();
  });
});

// ─── daemon loopback RPC (/local/pkf/reply-inline) ──────────────────────────

async function postReplyInline(
  body: unknown,
  agent = AGENT,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/local/pkf/reply-inline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(agent ? { 'X-Prismer-Agent': agent } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('pkf_reply_inline RPC route', () => {
  it('routes the bound agent to a successful marker write', async () => {
    bindPkfReplyInlineScope(AGENT, { taskId: 'task-1', scratchDir: scratch, allowedReadRoots: [] });
    const r = await postReplyInline({ path: 'memo.pkf' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, emitted: true, title: 'Vector search memo' });
  });

  it('returns 409 when no dispatch scope is bound for the calling agent', async () => {
    const r = await postReplyInline({ path: 'memo.pkf' }, 'agent-nobody');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('pkf_reply_inline_no_active_task');
  });

  it('returns 403 on path escape and does not write the marker', async () => {
    bindPkfReplyInlineScope(AGENT, { taskId: 'task-1', scratchDir: scratch, allowedReadRoots: [] });
    const r = await postReplyInline({ path: join(workRoot, 'outside.pkf') });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('pkf_reply_inline_path_outside');
    expect(existsSync(join(scratch, PKF_INLINE_REPLY_MARKER_FILENAME))).toBe(false);
  });

  it('returns 400 on a missing path', async () => {
    bindPkfReplyInlineScope(AGENT, { taskId: 'task-1', scratchDir: scratch, allowedReadRoots: [] });
    const r = await postReplyInline({});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('pkf_reply_inline_path_required');
  });
});

// ─── dispatch terminal wiring ────────────────────────────────────────────────

function buildDeps(profile: AgentProfile, dispatch: ReturnType<typeof vi.fn>, tempRoot: string) {
  const sent: unknown[] = [];
  const adapter = {
    name: profile.adapterName,
    kind: 'long-running',
    capabilities: [],
    workspaceSchema: {},
    validate: () => ({ ok: true }),
    health: async () => ({ available: true }),
  } as never;
  const cloud = {
    get: vi.fn(async (path: string) => {
      if (path === '/api/im/agent_profiles/profile-1') return profile;
      if (path.startsWith('/api/im/tasks?')) return [];
      if (path.startsWith('/api/im/memory/digest?')) {
        return { digest: '', filesSummarized: 0, filesTotal: 0, totalBytes: 0 };
      }
      if (path === '/api/im/tasks/task-1') return { task: { id: 'task-1', metadata: {} } };
      throw new Error(`unexpected GET ${path}`);
    }),
    request: vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, data: {} } })),
  };
  return {
    sent,
    deps: {
      registry: { get: () => adapter },
      cloud,
      uriResolver: {
        rewrite: async (text: string) => ({ text, resolvedHashes: [] }),
        rewriteAll: async (texts: string[]) => ({ texts, resolvedHashes: [] }),
      },
      assetCache: { unpin: vi.fn() },
      ws: { send: (msg: unknown) => sent.push(msg) },
      ensureService: async () => ({ id: 'svc', healthy: async () => true, dispatch }),
      paths: {
        root: tempRoot,
        configFile: join(tempRoot, 'config.toml'),
        localDb: join(tempRoot, 'local.db'),
        cacheDir: join(tempRoot, 'cache'),
        logsDir: join(tempRoot, 'logs'),
        runsDir: join(tempRoot, 'runs'),
        workspacesDir: join(tempRoot, 'workspaces'),
        devicesDir: join(tempRoot, 'devices'),
      },
    } as never,
  };
}

function hermesProfile(): AgentProfile {
  return {
    id: 'profile-1',
    workspaceId: 'ws-1',
    agentImUserId: AGENT,
    adapterName: 'hermes',
    name: 'Hermes',
    config: { systemPrompt: 'You are Hermes.' },
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function taskScratchOf(tempRoot: string): string {
  return join(tempRoot, 'workspaces', 'ws-1', 'projects', '_unscoped', 'tasks', 'task-1', 'scratch');
}

function writeMarker(taskScratch: string, source: string): void {
  mkdirSync(taskScratch, { recursive: true });
  writeFileSync(join(taskScratch, 'memo.pkf'), source);
  writeFileSync(
    join(taskScratch, PKF_INLINE_REPLY_MARKER_FILENAME),
    JSON.stringify({
      taskId: 'task-1',
      path: join(taskScratch, 'memo.pkf'),
      sourceHash: createHash('sha256').update(source).digest('hex'),
      title: 'Vector search memo',
    }),
  );
}

describe('handleDispatch terminal wiring (marker path)', () => {
  it('emits the contentBlock from the marker when the reply text carries no sentinel', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'pkf-reply-dispatch-'));
    try {
      const profile = hermesProfile();
      const dispatch = vi.fn(async () => ({ ok: true, output: 'Done — memo delivered inline.' }));
      const { deps } = buildDeps(profile, dispatch, tempRoot);

      // First dispatch proves the scratch dir is provisioned under deps.paths.
      await handleDispatch(
        {
          taskId: 'task-1',
          agentImUserId: AGENT,
          profileId: 'profile-1',
          capability: 'chat',
          prompt: 'research it',
        },
        'req-marker-1',
        deps,
      );
      const taskScratch = taskScratchOf(tempRoot);
      expect(existsSync(taskScratch)).toBe(true);

      // The agent's tool call leaves this marker; the second dispatch's
      // terminal state must turn it into the inline contentBlock.
      writeMarker(taskScratch, GOOD_PKF);
      const dispatch2 = vi.fn(async () => ({ ok: true, output: 'Done — memo delivered inline.' }));
      const { deps: deps2, sent } = buildDeps(profile, dispatch2, tempRoot);
      deps2.preReplyDurabilityBarrier = vi.fn(async (input: { assistantResponse: string }) => {
        expect(input.assistantResponse).toContain('Done — memo delivered inline.');
        expect(input.assistantResponse).toContain(GOOD_PKF);
        return {
          commitKey: 'durability:pkf-marker',
          postTurnKey: 'post-turn:pkf-marker',
          canonicalTurnId: 'task-1',
          state: 'skipped_not_durable' as const,
          receipts: [],
          timeoutMs: 30_000,
          replyCommittedAt: 1,
        };
      });
      const reply2 = await handleDispatch(
        {
          taskId: 'task-1',
          agentImUserId: AGENT,
          profileId: 'profile-1',
          capability: 'chat',
          prompt: 'research it again',
        },
        'req-marker-2',
        deps2,
      );

      expect(reply2.ok).toBe(true);
      expect(reply2.contentBlocks).toEqual([{ kind: 'pkf', source: GOOD_PKF, title: 'Vector search memo' }]);
      expect(reply2.output).toBe('Done — memo delivered inline.');
      expect(deps2.preReplyDurabilityBarrier).toHaveBeenCalledOnce();
      const terminalFrame = sent.find(
        (frame: never) => (frame as { type?: string })?.type === 'task.dispatch.reply',
      ) as { payload?: { contentBlocks?: unknown } };
      expect(terminalFrame?.payload?.contentBlocks).toEqual(reply2.contentBlocks);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      unbindPkfReplyInlineScope(AGENT, 'task-1');
    }
  });

  it('keeps the sentinel carrier authoritative when both paths fired', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'pkf-reply-dispatch-'));
    try {
      const profile = hermesProfile();
      const sentinelSource = GOOD_PKF.replace('Vector search memo', 'Sentinel carrier');
      const output = [
        'Readable projection.',
        '<!-- prismer-pkf:inline:start -->',
        sentinelSource,
        '<!-- prismer-pkf:inline:end -->',
      ].join('\n\n');
      const dispatch = vi.fn(async () => ({ ok: true, output }));
      const { deps } = buildDeps(profile, dispatch, tempRoot);

      writeMarker(taskScratchOf(tempRoot), GOOD_PKF);

      const reply = await handleDispatch(
        {
          taskId: 'task-1',
          agentImUserId: AGENT,
          profileId: 'profile-1',
          capability: 'chat',
          prompt: 'report',
        },
        'req-sentinel-wins',
        deps,
      );

      expect(reply.contentBlocks).toEqual([{ kind: 'pkf', source: sentinelSource, title: 'Sentinel carrier' }]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      unbindPkfReplyInlineScope(AGENT, 'task-1');
    }
  });

  it('a tampered marker file emits NO block and warns on stderr', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'pkf-reply-dispatch-'));
    const stderrWrite = process.stderr.write.bind(process.stderr);
    const warnings: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      if (typeof chunk === 'string' && chunk.includes('pkf-reply-inline')) warnings.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const profile = hermesProfile();
      const dispatch = vi.fn(async () => ({ ok: true, output: 'Delivered inline.' }));
      const { deps } = buildDeps(profile, dispatch, tempRoot);

      const taskScratch = taskScratchOf(tempRoot);
      mkdirSync(taskScratch, { recursive: true });
      writeFileSync(join(taskScratch, 'memo.pkf'), GOOD_PKF.replace('Recall/cost', 'DRIFTED'));
      writeFileSync(
        join(taskScratch, PKF_INLINE_REPLY_MARKER_FILENAME),
        JSON.stringify({
          taskId: 'task-1',
          path: join(taskScratch, 'memo.pkf'),
          sourceHash: createHash('sha256').update(GOOD_PKF).digest('hex'),
          title: 'Vector search memo',
        }),
      );

      const reply = await handleDispatch(
        {
          taskId: 'task-1',
          agentImUserId: AGENT,
          profileId: 'profile-1',
          capability: 'chat',
          prompt: 'report',
        },
        'req-tamper',
        deps,
      );

      expect(reply.ok).toBe(true);
      expect(reply.contentBlocks).toBeUndefined();
      expect(reply.output).toBe('Delivered inline.');
      expect(warnings.some((line) => line.includes('pkf_reply_inline_file_changed'))).toBe(true);
    } finally {
      process.stderr.write = stderrWrite;
      rmSync(tempRoot, { recursive: true, force: true });
      unbindPkfReplyInlineScope(AGENT, 'task-1');
    }
  });
});

// ─── cross-turn session read roots (memory211) ───────────────────────────────
//
// Owner live run (2026-09): a hermes LONG session keeps its task dirs under
// `sessions/<sid>/tasks/<tid>/` across turns, and the agent naturally
// re-delivers a .pkf it authored in a PREVIOUS turn's scratch. The dispatch
// scope's read roots must therefore include the SESSION dir (directory-prefix
// containment covers every historical tasks/*/scratch under it) — not just the
// current run's scratch.

describe('handleDispatch cross-turn session read roots (memory211)', () => {
  const SID = 'conv-session-1';

  function sessionTaskScratchOf(tempRoot: string, taskId: string): string {
    return join(
      tempRoot,
      'workspaces',
      'ws-1',
      'projects',
      '_unscoped',
      'sessions',
      SID,
      'tasks',
      taskId,
      'scratch',
    );
  }

  it('delivers a .pkf the agent authored in a PREVIOUS run scratch of the same session', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'pkf-reply-session-'));
    let toolOutcome: Awaited<ReturnType<typeof runPkfReplyInlineTool>> | null = null;
    try {
      // Previous run's scratch: the file lives under the SAME session, OLD task.
      const oldScratch = sessionTaskScratchOf(tempRoot, 'task-0');
      writeFileRecursive(join(oldScratch, 'skill-selfcheck.pkf'), GOOD_PKF);

      const profile = hermesProfile();
      // The mocked adapter dispatch runs while dispatch.ts has already bound
      // this turn's scope — exactly where the agent's tool call lands.
      const dispatch = vi.fn(async () => {
        toolOutcome = await runPkfReplyInlineTool({
          agentImUserId: AGENT,
          path: join(oldScratch, 'skill-selfcheck.pkf'),
        });
        return { ok: true, output: 'Delivered from the previous turn scratch.' };
      });
      const { deps, sent } = buildDeps(profile, dispatch, tempRoot);

      const reply = await handleDispatch(
        {
          taskId: 'task-1',
          agentImUserId: AGENT,
          profileId: 'profile-1',
          capability: 'chat',
          prompt: 're-deliver the self-check',
          conversationId: SID,
        },
        'req-session-cross-turn',
        deps,
      );

      expect(toolOutcome).toMatchObject({ ok: true, emitted: true, title: 'Vector search memo' });
      expect(reply.ok).toBe(true);
      expect(reply.contentBlocks).toEqual([{ kind: 'pkf', source: GOOD_PKF, title: 'Vector search memo' }]);
      // The marker is still written into THIS run's scratch (never the old one).
      expect(existsSync(join(sessionTaskScratchOf(tempRoot, 'task-1'), PKF_INLINE_REPLY_MARKER_FILENAME))).toBe(
        true,
      );
      const terminalFrame = sent.find(
        (frame: never) => (frame as { type?: string })?.type === 'task.dispatch.reply',
      ) as { payload?: { contentBlocks?: unknown } };
      expect(terminalFrame?.payload?.contentBlocks).toEqual(reply.contentBlocks);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      unbindPkfReplyInlineScope(AGENT, 'task-1');
    }
  });

  it('still rejects a .pkf outside the session (another session / foreign path)', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'pkf-reply-session-'));
    let toolOutcome: Awaited<ReturnType<typeof runPkfReplyInlineTool>> | null = null;
    try {
      const otherSessionScratch = join(
        tempRoot,
        'workspaces',
        'ws-1',
        'projects',
        '_unscoped',
        'sessions',
        'conv-other-session',
        'tasks',
        'task-x',
        'scratch',
      );
      writeFileRecursive(join(otherSessionScratch, 'leak.pkf'), GOOD_PKF);

      const profile = hermesProfile();
      const dispatch = vi.fn(async () => {
        toolOutcome = await runPkfReplyInlineTool({
          agentImUserId: AGENT,
          path: join(otherSessionScratch, 'leak.pkf'),
        });
        return { ok: true, output: 'Delivered.' };
      });
      const { deps } = buildDeps(profile, dispatch, tempRoot);

      const reply = await handleDispatch(
        {
          taskId: 'task-1',
          agentImUserId: AGENT,
          profileId: 'profile-1',
          capability: 'chat',
          prompt: 'try to leak another session file',
          conversationId: SID,
        },
        'req-session-escape',
        deps,
      );

      expect(toolOutcome).toMatchObject({ ok: false, error: 'pkf_reply_inline_path_outside' });
      expect(reply.ok).toBe(true);
      expect(reply.contentBlocks).toBeUndefined();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      unbindPkfReplyInlineScope(AGENT, 'task-1');
    }
  });
});

// ─── tool surface + directive teaching ───────────────────────────────────────

describe('pkf_reply_inline tool surface', () => {
  it('freezes the path-only input schema', () => {
    expect(PKF_REPLY_INLINE_TOOL.name).toBe('pkf_reply_inline');
    expect(PKF_REPLY_INLINE_TOOL.inputSchema).toEqual({
      type: 'object',
      properties: {
        path: expect.objectContaining({ type: 'string' }),
      },
      required: ['path'],
      additionalProperties: false,
    });
  });

  it('joins the Hermes function-tool surface', () => {
    expect(HERMES_MEMORY_TOOLS.map((tool) => tool.function.name)).toContain('pkf_reply_inline');
  });

  it('is NOT required for PKF runtime capability (old runtimes stay available)', async () => {
    const { REQUIRED_PKF_NATIVE_TOOLS } = await import('../src/daemon/pkf-runtime-capability.js');
    expect(REQUIRED_PKF_NATIVE_TOOLS).not.toContain('pkf_reply_inline');
  });

  it('the dispatch directive teaches the tool path, never the sentinel comments', () => {
    expect(PKF_REPORT_DIRECTIVE).toContain('`pkf_reply_inline`');
    expect(PKF_REPORT_DIRECTIVE).toMatch(/never paste sentinel comments/i);
    expect(PKF_REPORT_DIRECTIVE).toMatch(/never attach the \.pkf as a file/i);
    expect(PKF_REPORT_DIRECTIVE).not.toContain('<!-- prismer-pkf:inline:start -->');
    expect(PKF_REPORT_DIRECTIVE).not.toContain('<!-- prismer-pkf:inline:end -->');
  });
});

// ─── python parity (schema 1:1 + forwarding) ─────────────────────────────────

function runProvider(
  script: string,
  port: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('python3', ['-c', script], {
      env: {
        ...process.env,
        PRISMER_DAEMON_PORT: String(port),
        PRISMER_WORKSPACE_ID: 'ws-reply-inline',
        PRISMER_AGENT_IM_USER_ID: AGENT,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(!havePython)('pkf_reply_inline python parity', () => {
  it('registers the 1:1 schema and forwards {path} to the loopback', async () => {
    bindPkfReplyInlineScope(AGENT, { taskId: 'task-1', scratchDir: scratch, allowedReadRoots: [] });
    const script = `
import importlib.util, json, sys, types
agent_pkg = types.ModuleType("agent"); agent_pkg.__path__ = []
mp = types.ModuleType("agent.memory_provider")
class MemoryProvider: pass
mp.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = mp
spec = importlib.util.spec_from_file_location("prismer_shell", ${JSON.stringify(providerPath)})
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
p = mod.PrismerMemoryProvider(); p.initialize("sess_reply_inline")
schemas = {s["name"]: s for s in p.get_tool_schemas()}
assert "pkf_reply_inline" in schemas, sorted(schemas)
good = json.loads(p.handle_tool_call("pkf_reply_inline", {"path": "memo.pkf"}))
assert good["ok"] is True and good["emitted"] is True and good["title"] == "Vector search memo", good
escape = json.loads(p.handle_tool_call("pkf_reply_inline", {"path": "../../outside.pkf"}))
assert escape["ok"] is False and escape["error"] == "pkf_reply_inline_path_outside", escape
missing = json.loads(p.handle_tool_call("pkf_reply_inline", {}))
assert missing["ok"] is False, missing
print(json.dumps({"parameters": schemas["pkf_reply_inline"]["parameters"]}))
`;
    const result = await runProvider(script, port);
    expect(result.code, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout.trim().split('\n').pop()!) as { parameters: Record<string, unknown> };
    const tsSchema = PKF_REPLY_INLINE_TOOL.inputSchema as Record<string, unknown>;
    expect(receipt.parameters).toEqual(tsSchema);
  });
});

// The tool input type is part of the exported mirror contract surface.
void (undefined as unknown as PkfReplyInlineToolInput);
