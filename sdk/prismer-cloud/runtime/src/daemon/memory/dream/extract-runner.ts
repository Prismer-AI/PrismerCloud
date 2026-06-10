// Session-end extract runner — M-C (doc 25 §3 支柱 3).
//
// Hermes / CC / OpenClaw / Codex finish a session by handing the
// transcript to this runner. We don't write memory pages directly —
// agent-authored extraction is too fast/loose to skip review. Instead
// we fork an LLM via the host's fork_query to summarize the session
// into 0..N candidate memory updates, then enqueue each as an
// `IMMemoryProposal` for the user to confirm in the Library Memory
// view (see `memory-proposal.service.ts`).
//
// The runner is intentionally synchronous-feeling per session (the
// host calls it after on_session_end and awaits) but emits proposals
// via the daemon outbox so the cloud-side proposal table fills via
// the standard sync channel rather than a separate POST. Mirrors the
// recall_pull / recall_inject observability path.

import { randomUUID } from 'node:crypto';
import type { MemoryRuntime } from '../runtime.js';
import type { ForkLLMResult } from '../fork/runner.js';
import { createLogger } from '../../../lib/logger.js';

const log = createLogger('memory.dream.extract');

const EXTRACT_SYSTEM_PROMPT = [
  'You are reviewing a finished agent session and proposing 0–3 short memory entries that would be useful to surface in future sessions.',
  '',
  'Be conservative. Most sessions do NOT warrant a memory write — only propose memories when:',
  '  - the user expressed a clear preference (style, tooling, naming convention)',
  '  - the user shared a project-level fact that future sessions will keep needing (deadlines, ownership, tracker references)',
  '  - the agent encountered a workaround or gotcha that would save time next time',
  '',
  'For each memory you propose, return a JSON object with:',
  '  - path: workspace-relative path under "memory/" (e.g. "memory/feedback/sdk-naming.md")',
  '  - title: short imperative title (≤80 chars)',
  '  - summary: 1–3 sentence body in markdown',
  '  - rationale: why future sessions benefit (1 sentence)',
  '  - confidence: float in [0,1] — your subjective certainty this is worth keeping',
  '',
  'Respond with a single JSON object: { "proposals": [...] }. Empty proposals[] is fine and preferred when nothing strong stands out. Do NOT wrap the JSON in code fences.',
].join('\n');

export interface ExtractInput {
  workspaceId: string;
  sessionId: string;
  agentImUserId: string;
  /** Compressed conversation transcript — pre-truncated by caller to a
   *  reasonable token budget. The runner does NOT re-summarize. */
  transcript: string;
}

export interface ExtractedProposal {
  path: string;
  title: string;
  summary: string;
  rationale: string;
  confidence: number;
}

export interface ExtractRunnerOptions {
  runtime: MemoryRuntime;
  deviceId: string;
  /** Host-supplied LLM call. Same shape as the fork-recall runner. */
  forkLLM: (input: { system: string; user: string; max_tokens: number }) => Promise<ForkLLMResult>;
}

export class SessionExtractRunner {
  constructor(private readonly opts: ExtractRunnerOptions) {}

  /**
   * Walk the session transcript, propose 0–N memory updates via fork
   * LLM, enqueue each one as a `memory.proposal` outbox event. Returns
   * the list of proposals that were successfully enqueued (so callers
   * can echo a count to the user).
   *
   * Failure modes — all return `[]` quietly:
   *   - empty transcript
   *   - host LLM unreachable / no key
   *   - LLM returns malformed JSON
   */
  async extract(input: ExtractInput): Promise<ExtractedProposal[]> {
    if (!input.transcript || !input.transcript.trim()) return [];
    const slot = this.opts.runtime.peek(input.workspaceId);
    if (!slot) return [];

    let llmResult: ForkLLMResult;
    try {
      llmResult = await this.opts.forkLLM({
        system: EXTRACT_SYSTEM_PROMPT,
        user: `Session id: ${input.sessionId}\n\n${input.transcript}`,
        max_tokens: 1024,
      });
    } catch (err) {
      log.warn(`forkLLM failed: ${(err as Error).message}`);
      return [];
    }

    const parsed = parseExtractOutput(llmResult.text);
    if (parsed.length === 0) return [];

    // Enqueue each proposal as a `memory.proposal` outbox event. The
    // cloud-side MemoryWriteService.ingestSyncInbox routes to the
    // proposal table when it sees this eventType (added in M-C cloud
    // side once the routing entry is added).
    for (const p of parsed) {
      const eventId = randomUUID();
      const createdAt = new Date().toISOString();
      slot.outbox.enqueue({
        eventId,
        schemaVersion: 1,
        eventType: 'memory.proposal',
        workspaceId: input.workspaceId,
        actorImUserId: input.agentImUserId,
        actorKind: 'agent',
        deviceId: this.opts.deviceId,
        createdAt,
        idempotencyKey: `proposal:${input.sessionId}:${p.path}:${eventId.slice(0, 8)}`,
        metadataJson: {
          sessionId: input.sessionId,
          source: 'session_extract',
        },
        // The proposal payload travels under `query` for now — when
        // the cloud-side event router accepts `memory.proposal`, the
        // shape will be a typed payload. Until then, treat this as a
        // forward-compat enqueue: the daemon owns this for v0.
        query: JSON.stringify(p),
      });
    }
    return parsed;
  }
}

/**
 * Parse the extract LLM output into ExtractedProposal[]. Tolerant of
 * code-fence wrappers + missing fields (drops malformed entries
 * instead of throwing).
 */
export function parseExtractOutput(rawText: string): ExtractedProposal[] {
  const trimmed = rawText.trim();
  if (!trimmed) return [];
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const arr = (parsed as { proposals?: unknown }).proposals;
  if (!Array.isArray(arr)) return [];
  const out: ExtractedProposal[] = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const p = e as Partial<ExtractedProposal>;
    if (typeof p.path !== 'string' || !p.path.startsWith('memory/')) continue;
    if (typeof p.title !== 'string' || !p.title.trim()) continue;
    if (typeof p.summary !== 'string' || !p.summary.trim()) continue;
    if (typeof p.rationale !== 'string') continue;
    const conf = typeof p.confidence === 'number' ? Math.max(0, Math.min(1, p.confidence)) : 0.5;
    out.push({
      path: p.path,
      title: p.title.slice(0, 80),
      summary: p.summary.slice(0, 4000),
      rationale: p.rationale.slice(0, 500),
      confidence: conf,
    });
  }
  // Cap at 3 to match the prompt's "0–3" budget.
  return out.slice(0, 3);
}

export { EXTRACT_SYSTEM_PROMPT };
