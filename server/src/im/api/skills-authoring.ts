/**
 * Prismer IM — Skill Authoring Request API (release201/24 §UX).
 *
 * `POST /api/im/skills/authoring-requests` is the honest replacement for the
 * old client-side manifest stuffer. Instead of the browser templating a hollow
 * SKILL.md, this dispatches a real `skill-authoring` IMTask to a workspace
 * agent. The agent (daemon runtime) FETCHES the source, distills it, writes
 * SKILL.md + scripts + testCases derived from the material, and submits via
 * `cloud skill draft create`. Creating the task with an `assigneeId` triggers
 * `TaskService.emitDaemonDispatchRequest`, so an online agent picks it up
 * immediately; an offline agent runs it on next connect (task stays assigned).
 *
 * Auth: authenticated workspace member (TaskService enforces membership).
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import prisma from '../db';
import type { ApiResponse } from '../types/index';
import type { TaskService } from '../services/task.service';
import { type AuthoringSpec, runAuthoringChat } from '../services/skill-authoring-chat.service';

type SourceKind = 'inline-spec' | 'doc-url' | 'code-source' | 'service-endpoint';

const SOURCE_KINDS: SourceKind[] = ['inline-spec', 'doc-url', 'code-source', 'service-endpoint'];

/**
 * The instruction the authoring agent receives. It MUST really fetch + distill
 * the source and derive acceptanceCriteria from it (release201/24 §2.1), not
 * record a URL into a placeholder.
 */
export function buildAuthoringPrompt(input: {
  intent: string;
  sourceKind: SourceKind;
  sourceRefs: string[];
  sampleTask?: string | null;
  /** release201/24 §Phase1a — the converged spec from the conversational wizard. */
  spec?: AuthoringSpec | null;
}): string {
  const { intent, sourceKind, sourceRefs, sampleTask, spec } = input;
  const refsBlock = sourceRefs.length
    ? sourceRefs.map((r) => `  - ${r}`).join('\n')
    : '  - (none — work from the inline goal)';
  // When the wizard converged a structured spec, hand it to the agent verbatim
  // so it builds to the agreed slug / triggers / IO / acceptance instead of
  // re-deriving them. This is Path B: clarification happened up-front.
  const specBlock = spec && Object.keys(spec).length > 0 ? `\nAgreed spec (from intake conversation):\n${formatSpec(spec)}` : '';
  return [
    'Use your `skill-authoring` skill to create a Prismer skill draft from the request below, then submit it.',
    '',
    `Goal: ${intent}`,
    `Source kind: ${sourceKind}`,
    'Sources:',
    refsBlock,
    sampleTask ? `\nSample task / expected output:\n  ${sampleTask}` : '',
    specBlock,
    '',
    'Requirements (release201/24 §2.1) — do NOT skip:',
    '1. ACTUALLY fetch/read the sources: `cloud load <url>` for docs/URLs, `cloud code grep` for code, `cloud service introspect <url>` for API/MCP. Never just record the URL as a reference.',
    '2. Write SKILL.md + skill.json. If the skill calls an API or runs a script, write a runnable `scripts/call-*.*`.',
    '3. Derive concrete `skill.json.sampleTasks[]` with `acceptanceCriteria[]` FROM the fetched material — these become the eval tests. Never leave a generic placeholder criterion.',
    '4. Submit via `cloud skill draft create --slug <slug> --manifest <path>`. Report the draft id. Do NOT auto-promote or publish — the workspace owner reviews it.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Render the converged wizard spec as a compact instruction block. */
function formatSpec(spec: AuthoringSpec): string {
  const lines: string[] = [];
  if (spec.slug) lines.push(`  slug: ${spec.slug}`);
  if (spec.name) lines.push(`  name: ${spec.name}`);
  if (spec.triggers?.length) lines.push(`  triggers: ${spec.triggers.join(', ')}`);
  if (spec.inputs) lines.push(`  inputs: ${spec.inputs}`);
  if (spec.outputs) lines.push(`  outputs: ${spec.outputs}`);
  if (spec.scope) lines.push(`  scope: ${spec.scope}`);
  if (spec.acceptanceCriteria?.length) {
    lines.push('  acceptanceCriteria:');
    for (const c of spec.acceptanceCriteria) lines.push(`    - ${c}`);
  }
  if (spec.sampleTasks?.length) {
    lines.push('  sampleTasks:');
    for (const t of spec.sampleTasks) {
      lines.push(`    - input: ${t.input}`);
      for (const c of t.acceptanceCriteria) lines.push(`      criterion: ${c}`);
    }
  }
  return lines.join('\n');
}

function coerceSpec(raw: unknown): AuthoringSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  // Trust the client-supplied spec shape loosely; buildAuthoringPrompt only
  // reads known string/array fields, so any extra keys are harmless.
  return raw as AuthoringSpec;
}

export function createSkillAuthoringRouter(deps: { taskService: TaskService }): Hono {
  const router = new Hono();

  router.post('/authoring-requests', authMiddleware, async (c) => {
    const user = c.get('user');
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const intent = typeof body.intent === 'string' ? body.intent.trim() : '';
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
    const sourceKind: SourceKind = SOURCE_KINDS.includes(body.sourceKind) ? body.sourceKind : 'inline-spec';
    const sourceRefs: string[] = Array.isArray(body.sourceRefs)
      ? body.sourceRefs.filter((x: unknown): x is string => typeof x === 'string' && x.trim().length > 0)
      : [];
    const sampleTask = typeof body.sampleTask === 'string' && body.sampleTask.trim() ? body.sampleTask.trim() : null;
    const spec = coerceSpec(body.spec);

    if (intent.length < 8) {
      return c.json(
        { ok: false, error: 'intent_required', message: 'Describe what the skill should do (≥ 8 chars).' },
        400,
      );
    }
    if (!workspaceId) {
      return c.json<ApiResponse>({ ok: false, error: 'workspace_required' }, 400);
    }

    // Resolve target agent: caller-provided → first online workspace agent →
    // any workspace agent (task waits 'assigned' until it reconnects).
    let agentId: string | undefined = typeof body.agentId === 'string' && body.agentId ? body.agentId : undefined;
    let agentOnline = false;
    if (!agentId) {
      const online = await prisma.iMAgentCard.findFirst({
        where: { workspaceId, status: { not: 'offline' } },
        orderBy: { lastHeartbeat: 'desc' },
        select: { imUserId: true },
      });
      if (online) {
        agentId = online.imUserId;
        agentOnline = true;
      } else {
        const any = await prisma.iMAgentCard.findFirst({ where: { workspaceId }, select: { imUserId: true } });
        agentId = any?.imUserId;
      }
    } else {
      const card = await prisma.iMAgentCard
        .findUnique({ where: { imUserId: agentId }, select: { status: true } })
        .catch(() => null);
      agentOnline = !!card && card.status !== 'offline';
    }

    if (!agentId) {
      return c.json(
        {
          ok: false,
          error: 'no_authoring_agent',
          message: 'No agent in this workspace can author skills yet. Pair an agent first.',
        },
        409,
      );
    }

    const prompt = buildAuthoringPrompt({ intent, sourceKind, sourceRefs, sampleTask, spec });
    try {
      const task = await deps.taskService.createTask(user.imUserId, {
        title: `Author skill: ${intent.slice(0, 60)}`,
        description: prompt,
        capability: 'skill-authoring',
        assigneeId: agentId,
        workspaceId,
        metadata: {
          authoringRequest: { intent, sourceKind, sourceRefs, sampleTask, spec, requestedBy: user.imUserId },
        } as any,
      });
      console.log(
        `[skills-authoring] dispatched task=${task.id} agent=${agentId.slice(-6)} online=${agentOnline} kind=${sourceKind}`,
      );
      return c.json<ApiResponse>({
        ok: true,
        data: { requestId: task.id, taskId: task.id, agentId, agentOnline },
      });
    } catch (err) {
      return c.json<ApiResponse>({ ok: false, error: (err as Error).message }, 400);
    }
  });

  // release201/24 §Phase1a (Path B) — conversational intake. The wizard replays
  // the message history each turn; we converge an AuthoringSpec and tell the
  // client when it's `ready` to dispatch via /authoring-requests above.
  router.post('/authoring-chat', authMiddleware, async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    // Bound the replayed history (cost / prompt-bloat / 30s-timeout DoS guard):
    // keep the last MAX_TURNS messages and clamp each to MAX_MSG_CHARS.
    const MAX_TURNS = 40;
    const MAX_MSG_CHARS = 8000;
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string')
      .slice(-MAX_TURNS)
      .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: (m.content as string).slice(0, MAX_MSG_CHARS) }));
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
    if (messages.length === 0) {
      return c.json<ApiResponse>({ ok: false, error: 'messages_required' }, 400);
    }
    if (!workspaceId) {
      return c.json<ApiResponse>({ ok: false, error: 'workspace_required' }, 400);
    }
    try {
      const turn = await runAuthoringChat({
        messages,
        workspaceId,
        specSoFar: coerceSpec(body.specSoFar) ?? undefined,
      });
      return c.json<ApiResponse>({ ok: true, data: turn });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'no_llm_api_key') {
        return c.json(
          { ok: false, error: 'llm_unavailable', message: 'Authoring chat needs an LLM API key configured.' },
          503,
        );
      }
      return c.json<ApiResponse>({ ok: false, error: msg }, 502);
    }
  });

  return router;
}
