/**
 * apc/11 §0.28 gap ② — `cloud skill test` must score on REAL run side effects,
 * not on "the DM has an agent message newer than a timestamp". The old harness
 * returned taskStatus:completed / ok:true off a STALE cross-run reply even when
 * ZERO runs were created for THIS dispatch — a self-lying acceptance tool.
 *
 * Fix under test (src/commands/skill.ts):
 *   1. dispatchSampleTask gates `completed` on a run existing for THIS prompt
 *      (im_task_runs.triggerMessageId === the sent message id, via
 *      GET /tasks/runs). No run ⇒ status `dispatch_not_created`, never completed.
 *   2. The reply must be BOUND to this dispatch (metadata.replyToMessageId ===
 *      the sent message id). A cross-run stale reply carries a different id and
 *      is refused even when its createdAt is newer.
 *
 * Strategy: drive the REAL PrismerClient over a scripted `fetch` (real endpoint
 * JSON shapes). The load-bearing judgment (run gate + reply bind + scoring) runs
 * for real — only the network is faked. This mirrors the acp-* "real side effect"
 *范式: the oracle is the returned status / CLI exit code, never chat text.
 */

import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismerClient } from '../src/index';
import {
  register as registerSkill,
  dispatchSampleTask,
  findRunForTrigger,
  extractAgentReply,
} from '../src/commands/skill';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const AGENT = 'agent-uume';
const CONV = 'conv-1';
const OUR_MSG = 'msg-B'; // the message id our POST prompt returns
const OTHER_MSG = 'msg-A'; // a DIFFERENT run's trigger message id
const PROMPT_TS = '2026-07-24T09:18:00.000Z';
const NEWER_TS = '2026-07-24T09:18:09.000Z'; // strictly newer than the prompt

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Script {
  runs: unknown[]; // GET /tasks/runs → data
  messages: unknown[]; // GET /messages/:conv → data.messages
}

function makeFetchMock(script: Script): { fetchFn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push(`${method} ${url}`);

    if (method === 'POST' && url.includes('/api/im/conversations/direct')) {
      return jsonResponse({ ok: true, data: { id: CONV } });
    }
    if (method === 'POST' && url.includes(`/api/im/messages/${CONV}`)) {
      return jsonResponse({ ok: true, data: { message: { id: OUR_MSG, createdAt: PROMPT_TS } } });
    }
    if (method === 'GET' && url.includes('/api/im/tasks/runs')) {
      return jsonResponse({ ok: true, data: script.runs });
    }
    if (method === 'GET' && url.includes(`/api/im/messages/${CONV}`)) {
      return jsonResponse({ ok: true, data: { messages: script.messages } });
    }
    return jsonResponse({ ok: false, error: { code: 'x', message: url } }, 500);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function makeClient(fetchFn: typeof fetch): PrismerClient {
  return new PrismerClient({
    apiKey: 'sk-prismer-live-testkey00000000000000000000000000000000000000000000000000',
    baseUrl: 'https://api.test',
    fetch: fetchFn,
  });
}

// A stale reply belonging to a DIFFERENT run (OTHER_MSG). createdAt is NEWER than
// the prompt on purpose — the exact adversarial case that fooled the anchor-only
// harness (apc/11 §0.28: "createdAt 甚至比 afterIso 新，但属别的 run").
const STALE_CROSS_RUN_REPLY = {
  senderId: AGENT,
  type: 'text',
  content: 'design-review passed: RED then GREEN, exit code 0 — pass16/fail5',
  createdAt: NEWER_TS,
  metadata: { kind: 'agent_reply', replyToMessageId: OTHER_MSG, triggerMessageId: OTHER_MSG },
};

// The genuine reply to OUR dispatch (OUR_MSG).
const OUR_REPLY = {
  senderId: AGENT,
  type: 'text',
  content: 'env doctor JSON: pass16/fail5/skip1/total22',
  createdAt: NEWER_TS,
  metadata: { kind: 'agent_reply', replyToMessageId: OUR_MSG, triggerMessageId: OUR_MSG },
};

const DISPATCH_OPTS = { timeoutMs: 300 } as const; // single immediate poll, no sleep

// ---------------------------------------------------------------------------
// 命根子 negative control — zero run + stale cross-run reply → MUST reject
// ---------------------------------------------------------------------------

describe('dispatchSampleTask — run-side-effect gate (apc/11 §0.28 gap ②)', () => {
  it('命根子: ZERO run created + a stale cross-run reply (newer ts) → dispatch_not_created, NOT completed', async () => {
    const { fetchFn, calls } = makeFetchMock({
      runs: [], // no im_task_runs row for OUR_MSG (agent unroutable / never dispatched)
      messages: [STALE_CROSS_RUN_REPLY], // a good-looking stale reply is present
    });
    const out = await dispatchSampleTask(makeClient(fetchFn), AGENT, 'run env doctor', DISPATCH_OPTS);
    expect(out.status).toBe('dispatch_not_created');
    expect(out.runId).toBeNull();
    expect(out.text).toBe('');
    // Proof the gate actually consulted the runs side effect (not just chat).
    expect(calls.some((c) => c.includes('/api/im/tasks/runs'))).toBe(true);
  });

  it('命根子 variant: run row exists but for a DIFFERENT trigger message → still dispatch_not_created', async () => {
    const { fetchFn } = makeFetchMock({
      runs: [{ id: 'run-A', triggerMessageId: OTHER_MSG, status: 'completed' }],
      messages: [STALE_CROSS_RUN_REPLY],
    });
    const out = await dispatchSampleTask(makeClient(fetchFn), AGENT, 'run env doctor', DISPATCH_OPTS);
    expect(out.status).toBe('dispatch_not_created');
    expect(out.runId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Positive control — a run for OUR prompt + a reply bound to it → completed
  // -------------------------------------------------------------------------

  it('positive: run created for OUR prompt + a reply bound to it → completed with the real text', async () => {
    const { fetchFn } = makeFetchMock({
      runs: [{ id: 'run-B', triggerMessageId: OUR_MSG, status: 'running' }],
      // Adversarial: the stale cross-run reply sits BEFORE the real one, both
      // newer than the prompt. Only the bound one may be picked.
      messages: [STALE_CROSS_RUN_REPLY, OUR_REPLY],
    });
    const out = await dispatchSampleTask(makeClient(fetchFn), AGENT, 'run env doctor', DISPATCH_OPTS);
    expect(out.status).toBe('completed');
    expect(out.runId).toBe('run-B');
    expect(out.text).toBe('env doctor JSON: pass16/fail5/skip1/total22');
  });

  // -------------------------------------------------------------------------
  // Cross-run isolation — run B exists but only run A's reply is present
  // -------------------------------------------------------------------------

  it('cross-run isolation: run B exists, only run A reply present → no_reply, run A reply NOT adopted', async () => {
    const { fetchFn } = makeFetchMock({
      runs: [
        { id: 'run-A', triggerMessageId: OTHER_MSG, status: 'completed' },
        { id: 'run-B', triggerMessageId: OUR_MSG, status: 'running' },
      ],
      messages: [STALE_CROSS_RUN_REPLY], // only run A's reply exists
    });
    const out = await dispatchSampleTask(makeClient(fetchFn), AGENT, 'run env doctor', DISPATCH_OPTS);
    expect(out.status).toBe('no_reply');
    expect(out.runId).toBe('run-B'); // we DID find our run
    expect(out.text).toBe(''); // but never adopted run A's reply
  });

  it('reply metadata delivered as a JSON string is still bound correctly', async () => {
    const { fetchFn } = makeFetchMock({
      runs: [{ id: 'run-B', triggerMessageId: OUR_MSG, status: 'running' }],
      messages: [
        {
          senderId: AGENT,
          type: 'text',
          content: 'stringified-meta reply: pass16',
          createdAt: NEWER_TS,
          metadata: JSON.stringify({ replyToMessageId: OUR_MSG }),
        },
      ],
    });
    const out = await dispatchSampleTask(makeClient(fetchFn), AGENT, 'run env doctor', DISPATCH_OPTS);
    expect(out.status).toBe('completed');
    expect(out.text).toBe('stringified-meta reply: pass16');
  });
});

// ---------------------------------------------------------------------------
// Pure judgment units (the load-bearing logic, tested against real shapes)
// ---------------------------------------------------------------------------

describe('findRunForTrigger', () => {
  it('returns the run whose triggerMessageId matches; null otherwise', () => {
    const runs = { data: [{ id: 'run-B', triggerMessageId: OUR_MSG, status: 'running' }] };
    expect(findRunForTrigger(runs, OUR_MSG)).toEqual({ id: 'run-B', status: 'running' });
    expect(findRunForTrigger(runs, OTHER_MSG)).toBeNull();
    expect(findRunForTrigger({ data: [] }, OUR_MSG)).toBeNull();
    expect(findRunForTrigger(undefined, OUR_MSG)).toBeNull();
  });
});

describe('extractAgentReply — strong trigger-message bind', () => {
  it('rejects a stale cross-run reply even when newer than the anchor', () => {
    const messages = { messages: [STALE_CROSS_RUN_REPLY] };
    // anchor-only (no expected id) would ACCEPT it — that was the bug.
    expect(extractAgentReply(messages, AGENT, PROMPT_TS)).toBe(STALE_CROSS_RUN_REPLY.content);
    // with the expected trigger id, the cross-run reply is refused.
    expect(extractAgentReply(messages, AGENT, PROMPT_TS, OUR_MSG)).toBeNull();
  });

  it('accepts only the reply bound to the expected trigger message', () => {
    const messages = { messages: [STALE_CROSS_RUN_REPLY, OUR_REPLY] };
    expect(extractAgentReply(messages, AGENT, PROMPT_TS, OUR_MSG)).toBe(OUR_REPLY.content);
  });
});

// ---------------------------------------------------------------------------
// CLI-level oracle — `cloud skill test --json` exit code + envelope
// ---------------------------------------------------------------------------

function writeBundle(): string {
  const dir = mkdtempSync(join(tmpdir(), 'apc-skill-test-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'skill.json'),
    JSON.stringify({
      sampleTasks: [
        { prompt: 'run env doctor', acceptanceCriteria: [{ substring: 'pass', label: 'reports pass count' }] },
      ],
    }),
  );
  return dir;
}

async function runSkillTestCli(client: PrismerClient, dir: string) {
  const program = new Command();
  program.exitOverride();
  registerSkill(program, () => client, () => client);

  const out: string[] = [];
  const err: string[] = [];
  const oO = process.stdout.write;
  const oE = process.stderr.write;
  process.stdout.write = ((s: string | Uint8Array) => {
    out.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => {
    err.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;

  let exitCode = 0;
  const oExit = process.exit;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit_${exitCode}`);
  }) as typeof process.exit;

  try {
    await program.parseAsync(['node', 'cloud', 'skill', 'test', dir, '--agent', AGENT, '--json', '--timeout-ms', '300']);
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith('__exit_'))) throw e;
  } finally {
    process.stdout.write = oO;
    process.stderr.write = oE;
    process.exit = oExit;
  }
  return { exitCode, stdout: out.join(''), stderr: err.join('') };
}

describe('cloud skill test — end-to-end scoring oracle', () => {
  it('命根子: zero run + stale reply that WOULD match the criterion → exit 1, ok:false, dispatch_not_created', async () => {
    // The stale reply contains "pass" — so if the harness scored it, it would be
    // FALSELY green. The run gate must reject before scoring.
    const { fetchFn } = makeFetchMock({ runs: [], messages: [STALE_CROSS_RUN_REPLY] });
    const { exitCode, stdout } = await runSkillTestCli(makeClient(fetchFn), writeBundle());
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout) as { ok: boolean; tasks: Array<{ taskStatus: string; ok: boolean }> };
    expect(parsed.ok).toBe(false);
    expect(parsed.tasks[0].taskStatus).toBe('dispatch_not_created');
    expect(parsed.tasks[0].ok).toBe(false);
  });

  it('positive: run for our prompt + bound reply matching the criterion → exit 0, ok:true', async () => {
    const { fetchFn } = makeFetchMock({
      runs: [{ id: 'run-B', triggerMessageId: OUR_MSG, status: 'running' }],
      messages: [OUR_REPLY],
    });
    const { exitCode, stdout } = await runSkillTestCli(makeClient(fetchFn), writeBundle());
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { ok: boolean; tasks: Array<{ taskStatus: string; ok: boolean }> };
    expect(parsed.ok).toBe(true);
    expect(parsed.tasks[0].taskStatus).toBe('completed');
    expect(parsed.tasks[0].ok).toBe(true);
  });
});
