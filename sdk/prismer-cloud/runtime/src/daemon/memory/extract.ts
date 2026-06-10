// v2.1 §9.6 — daemon-as-hook-intake memory extraction.
//
// The `post_llm_call` hook delivers a single completed turn (user message +
// assistant response + conversation_history). This module:
//
//   1. Runs cheap heuristic filters (skip greetings / tiny turns) so most
//      conversational noise never reaches the LLM extractor.
//   2. For the small remainder, calls cloud `POST /api/im/memory/extract`
//      with a journal (concatenated turn) and gets back 0-3 ExtractedMemory
//      candidates already classified (user / feedback / project / reference).
//   3. Stamps each candidate with the §4 MemorySourceStamp (agent /
//      workspace / conversation / runId / role-template-slug) and writes
//      to the daemon ScopedMemoryStore synchronously so the next turn's
//      pre_llm_call recall sees them.
//
// The cloud endpoint already persists rows to im_memory_pages via
// MemoryService — daemon writes a local mirror copy purely so the
// recall path can resolve immediately without round-tripping cloud.
//
// Out of scope for MVP:
//   - daemon-local LLM extraction (P1; spec §9.11 P1.2)
//   - role-shared / task-scoped scope routing (P1; only workspace + agent here)

import { randomUUID } from 'node:crypto';
import type { CloudClient } from '../../auth.js';
import type { ScopedMemoryStore, MemoryScope } from './scoped-store.js';

const LOG = '[memory-extract]';

const MIN_USER_MSG_CHARS = 80;
const MIN_ASSISTANT_RESP_CHARS = 200;
const GREETING_RE = /^(hi|hello|hey|你好|嗨|谢谢|thanks|thank you|ok|好的|done)[\s.!?。！？]*$/i;

export interface ExtractInput {
  userMessage: string;
  assistantResponse: string;
  conversationHistory: Array<{ role: string; content: string }>;
  agentImUserId: string;
  workspaceId: string;
  roleSlug: string | null;
  conversationId: string | null;
  runId: string;
  sessionMetadata: { model: string; platform: string };
}

export interface SourceStamp {
  sourceAgentImUserId: string;
  sourceRoleTemplateSlug: string | null;
  sourceWorkspaceId: string;
  sourceConversationId: string | null;
  sourceRunId: string;
  sourceTaskId: string | null;
  extractedAt: string;
}

export interface ExtractedPage {
  title: string;
  content: string;
  /** MVP: 'workspace' (workspace-shared bucket) or 'agent:self' (per-agent bucket). */
  visibility: 'workspace' | 'agent:self';
  path: string;
  description: string;
  memoryType: 'user' | 'feedback' | 'project' | 'reference';
  sourceStamp: SourceStamp;
}

export interface HeuristicSkipResult {
  skipped: true;
  reason: 'too_short_user' | 'too_short_assistant' | 'greeting' | 'empty';
}

export interface ExtractDependencies {
  cloud: CloudClient;
  scopedStore: ScopedMemoryStore;
}

/**
 * Run heuristic filters against the turn. Returns `{ skipped: true, reason }`
 * when the turn should not be extracted; `null` when extraction should proceed.
 */
export function shouldSkipExtraction(input: ExtractInput): HeuristicSkipResult | null {
  const userMsg = input.userMessage?.trim() ?? '';
  const asstMsg = input.assistantResponse?.trim() ?? '';
  if (!userMsg && !asstMsg) {
    return { skipped: true, reason: 'empty' };
  }
  if (userMsg.length < MIN_USER_MSG_CHARS) {
    return { skipped: true, reason: 'too_short_user' };
  }
  if (asstMsg.length < MIN_ASSISTANT_RESP_CHARS) {
    return { skipped: true, reason: 'too_short_assistant' };
  }
  if (GREETING_RE.test(userMsg)) {
    return { skipped: true, reason: 'greeting' };
  }
  return null;
}

/**
 * Build a session-journal style text from a turn that the cloud
 * `/api/im/memory/extract` endpoint can consume. The endpoint extracts
 * via LLM and returns candidates; we then mirror them to the daemon's
 * local store.
 */
function buildJournal(input: ExtractInput): string {
  const lines: string[] = [];
  // Include a couple of prior turns for context if available.
  const history = input.conversationHistory?.slice(-6) ?? [];
  for (const turn of history) {
    if (!turn || typeof turn.content !== 'string') continue;
    const role = turn.role ?? 'user';
    lines.push(`[${role}] ${turn.content}`);
  }
  // Trailing user/assistant (may already be in history; dedupe by
  // checking last entry to avoid double-emit).
  const last = history[history.length - 1];
  const userAlreadyIn =
    last && last.role === 'user' && last.content === input.userMessage;
  const asstAlreadyIn =
    last && last.role === 'assistant' && last.content === input.assistantResponse;
  if (!userAlreadyIn && input.userMessage) {
    lines.push(`[user] ${input.userMessage}`);
  }
  if (!asstAlreadyIn && input.assistantResponse) {
    lines.push(`[assistant] ${input.assistantResponse}`);
  }
  return lines.join('\n\n');
}

interface CloudExtractedMemory {
  path: string;
  memoryType: 'user' | 'feedback' | 'project' | 'reference';
  description: string;
  content: string;
  action?: 'create' | 'update';
}

interface CloudExtractEnvelope {
  ok?: boolean;
  data?: {
    extracted?: CloudExtractedMemory[];
    saved?: number;
    skipped?: number;
  };
}

/**
 * Call cloud `/api/im/memory/extract` with a journal built from the turn.
 * Returns `[]` on heuristic skip, cloud failure, or empty extraction.
 */
export async function extractFromTurn(
  input: ExtractInput,
  deps: ExtractDependencies,
): Promise<ExtractedPage[]> {
  const skip = shouldSkipExtraction(input);
  if (skip) {
    process.stdout.write(`${LOG} skip: ${skip.reason}\n`);
    return [];
  }

  const journal = buildJournal(input);
  if (journal.length < 50) {
    process.stdout.write(`${LOG} skip: journal too short (${journal.length} chars)\n`);
    return [];
  }

  // Cloud extraction. Cloud-side route persists rows itself (see
  // src/im/services/memory-extract.ts); we mirror locally below so
  // pre_llm_call on the *next* turn can recall without waiting for
  // periodic cloud→local sync.
  let extracted: CloudExtractedMemory[] = [];
  try {
    const res = await deps.cloud.request<CloudExtractEnvelope>(
      'POST',
      `/api/im/memory/extract?workspaceId=${encodeURIComponent(input.workspaceId)}`,
      {
        body: { workspaceId: input.workspaceId, journal, scope: 'global' },
        timeoutMs: 25_000,
      },
    );
    if (!res.ok) {
      process.stderr.write(
        `${LOG} cloud /memory/extract failed status=${res.status} code=${res.error?.code} msg=${res.error?.message}\n`,
      );
      return [];
    }
    extracted = res.data?.data?.extracted ?? [];
  } catch (err) {
    process.stderr.write(`${LOG} cloud /memory/extract threw: ${(err as Error).message}\n`);
    return [];
  }

  if (extracted.length === 0) {
    process.stdout.write(`${LOG} cloud returned 0 candidates\n`);
    return [];
  }

  const stamp: SourceStamp = {
    sourceAgentImUserId: input.agentImUserId,
    sourceRoleTemplateSlug: input.roleSlug,
    sourceWorkspaceId: input.workspaceId,
    sourceConversationId: input.conversationId,
    sourceRunId: input.runId,
    sourceTaskId: null,
    extractedAt: new Date().toISOString(),
  };

  const pages: ExtractedPage[] = [];
  for (const candidate of extracted) {
    // Visibility routing: 'user' / 'feedback' (personal preferences,
    // explicit feedback) → agent's private bucket. 'project' / 'reference'
    // (project facts, reusable knowledge) → workspace-shared bucket.
    const visibility: 'workspace' | 'agent:self' =
      candidate.memoryType === 'user' || candidate.memoryType === 'feedback'
        ? 'agent:self'
        : 'workspace';
    const memoryScope: MemoryScope =
      visibility === 'agent:self' ? 'agent-private' : 'workspace-shared';

    // Mirror to local ScopedMemoryStore — synchronous so the very
    // next turn's pre_llm_call recall can see it. Failures are logged
    // but do not propagate (cloud already has the canonical row).
    try {
      deps.scopedStore.write({
        scope: memoryScope,
        ...(memoryScope === 'agent-private' ? { agentImUserId: input.agentImUserId } : {}),
        path: candidate.path,
        content: candidate.content,
        title: candidate.path,
        description: candidate.description,
        pageType: 'leaf',
        sourceRefs: [
          `run:${input.runId}`,
          ...(input.conversationId ? [`conv:${input.conversationId}`] : []),
        ],
        actorImUserId: input.agentImUserId,
        actorKind: 'agent',
      });
    } catch (err) {
      process.stderr.write(
        `${LOG} local mirror write failed path=${candidate.path}: ${(err as Error).message}\n`,
      );
    }

    pages.push({
      title: candidate.path,
      content: candidate.content,
      visibility,
      path: candidate.path,
      description: candidate.description,
      memoryType: candidate.memoryType,
      sourceStamp: stamp,
    });
  }

  process.stdout.write(`${LOG} extracted ${pages.length} page(s) for run=${input.runId}\n`);
  return pages;
}

/** Unused stable export — keeps tooling happy when the file is checked in isolation. */
export const __EXTRACT_NONCE__ = randomUUID();
