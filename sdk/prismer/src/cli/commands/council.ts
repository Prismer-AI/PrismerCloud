// `prismer council (plan|convene|run|finalize|report)` — expert-council execution surface.
//
// product204/03 · 04. WHY THIS EXISTS
// -----------------------------------------------------------------------------
// The council backend (cloud `council.service.ts` + `/api/im/councils/*`) and the
// two built-in skills (persona-generator / council-creator) all shipped, but the
// skills were written as a RAW-HTTP playbook — "Phase B convene → POST
// /api/im/councils" — with no base URL, no auth, no CLI, and no MCP tool. Every
// other skill has an execution surface (`tasks` → `cloud task` CLI; `memory` →
// native memory_* tools). council-creator was the only one naming endpoints the
// agent had no means to call.
//
// The observable consequence (dev, 2026-07-15, real chat path): the orchestrator
// loaded council-creator, narrated Phase A→D faithfully, wrote a markdown
// "roundtable report" — and produced ZERO council side effects (0 plan drafts,
// 0 council conversations, 0 materialized personas, 0 requests to /councils/*).
// It role-played the protocol because that was the only thing it could do. A
// chat message claiming "圆桌讨论全部完成" while the DB holds nothing is exactly
// the failure the acceptance discipline exists to catch.
//
// This command is that missing surface. Shape mirrors `cloud task`: CloudClient
// (api_key auth, base URL from daemon config), JSON in / JSON out, nonzero exit
// on failure.
//
// Nested bodies (Brief facts, persona cast, structured report) arrive as a JSON
// FILE rather than a thicket of flags — the agent already writes files, and the
// wire shape then matches the endpoint contract 1:1 with no CLI-side reshaping
// to drift out of sync.

import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { CloudClient } from '../../auth.js';
import { loadConfig, resolvePaths } from '../../config.js';
import { exitWithError, fail, printJson, runAction, warn } from '../util.js';

const ENV_WS = process.env.PRISMER_WORKSPACE_ID?.trim() || undefined;

function mkCloud(): CloudClient {
  const cfg = loadConfig(resolvePaths());
  return new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
}

/**
 * Every council op must act AS the workspace orchestrator agent, not as the
 * daemon's api-key owner. The daemon's api_key resolves (api-key proxy) to the
 * HUMAN owner by default; the cloud only re-resolves to a specific agent when
 * the request carries `X-IM-Agent: <agent username>` (auth/middleware.ts:460,
 * same header the daemon's asset-deliver already stamps). Without it, `council
 * say` (personaSenderId path) is rejected with PERSONA_SENDER_FORBIDDEN because
 * the requester isn't the persona's backing orchestrator — even though the
 * agent IS that orchestrator. `PRISMER_AGENT_USERNAME` is injected into the
 * agent's env by dispatch. (`plan` works without it — it only needs workspace
 * membership, which the owner also has; `propose` uses it so the proposal
 * bubble is attributed to the orchestrator rather than the human owner.)
 */
function agentHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  const agent = process.env.PRISMER_AGENT_USERNAME?.trim();
  if (agent) h['X-IM-Agent'] = agent;
  const ws = process.env.PRISMER_WORKSPACE_ID?.trim();
  if (ws) h['X-IM-Workspace'] = ws;
  return h;
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    exitWithError(`cannot read --file ${path}: ${(err as Error).message}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      exitWithError(`--file ${path} must contain a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    exitWithError(`--file ${path} is not valid JSON: ${(err as Error).message}`);
  }
}

function resolveWorkspace(opt?: string): string {
  const ws = opt ?? ENV_WS;
  if (!ws) exitWithError('workspace required: pass --workspace-id or set $PRISMER_WORKSPACE_ID');
  return ws;
}

/**
 * POST a council endpoint and surface the failure the way the caller must act on.
 *
 * The Brief hard gate (422 BRIEF_INSUFFICIENT) is the one error an agent MUST NOT
 * paper over: it means the council was never created, and the correct move is to
 * go get the missing material — NOT to write a report anyway. So we print the
 * `gaps[]` explicitly and exit nonzero, rather than letting a generic "HTTP 422"
 * slide past as something the model can rationalize.
 */
async function post(cloud: CloudClient, path: string, body: unknown): Promise<unknown> {
  const res = await cloud.request<{ ok: boolean; data?: unknown; error?: unknown }>('POST', path, {
    body,
    headers: agentHeaders(),
  });
  if (!res.ok) {
    const err = res.error as { code?: string; message?: string; gaps?: string[] } | undefined;
    if (res.status === 422 && err?.code === 'BRIEF_INSUFFICIENT') {
      const gaps = Array.isArray(err.gaps) ? err.gaps : [];
      exitWithError(
        `BRIEF_INSUFFICIENT — the council was NOT created. Missing: ${gaps.join(', ') || '(unspecified)'}\n` +
          `The Brief must stand on BOTH legs: at least one readable material (assetIds → real im_assets rows) ` +
          `AND at least one grounded fact (brief.facts[].text). Go get the missing material and re-run ` +
          `\`prismer council plan\`. Do NOT write a report instead — a council that never convened has no findings.`,
      );
    }
    exitWithError(`${path} failed: ${err?.code ?? res.status} ${err?.message ?? ''}`.trim());
  }
  const env = res.data as { ok?: boolean; data?: unknown } | undefined;
  return env && typeof env === 'object' && 'ok' in env ? env.data : res.data;
}

export function buildCouncilCommand(): Command {
  const cmd = new Command('council').description('Convene and drive an expert council (product204/03)');

  // ── Phase A — plan (Brief hard gate + cast) ────────────────────────────────
  cmd
    .command('plan')
    .description('Create the council plan draft. Enforces the Brief hard gate (422 → gaps).')
    .requiredOption(
      '--file <path>',
      'JSON: { question, brief:{summary?,facts:[{text,sourceUrl?}],gaps?}, cast:[PersonaDef], agenda?:[], assetIds:[], memoryRefs?:[] }',
    )
    .option('--workspace-id <id>', 'Workspace (default: $PRISMER_WORKSPACE_ID)')
    .action(
      runAction<[{ file: string; workspaceId?: string }]>(async (opts) => {
        const body = await readJsonFile(opts.file);
        body.workspaceId = resolveWorkspace(opts.workspaceId);
        printJson(await post(mkCloud(), '/api/im/councils/plan', body));
      }),
    );

  // ── Phase A (end) — propose to the Team Manager, then STOP ─────────────────
  //
  // There is deliberately NO `council convene` command. product204/03 §4.0 gives
  // the Team Manager exactly one decision in this whole flow — "好，开吧" / "先不用" — and
  // convening is what that click does. An agent that could convene on its own
  // would take the decision away from the human, which is the precise failure
  // §4.0 was written to prevent (it deleted the review card for the same reason:
  // "Team Manager 什么都没要求时不该给他一张卡审阅，拿走主导权"). So the orchestrator's last
  // act in Phase A is to PROPOSE and stop; the group is created by the Team Manager's
  // click on the proposal bubble, not by anything the agent can call.
  //
  // Brief did not stand? `--gap` — say what material is missing and never propose
  // a meeting. The Team Manager must never see "here's a plan… actually it failed".
  cmd
    .command('propose <conversationId>')
    .description('Post the proposal bubble to the Team Manager and STOP. The Team Manager’s click is what convenes.')
    .requiredOption('--text <sentence>', 'One human sentence — why these people, in your own words')
    .option('--plan <planId>', 'planId from `council plan` (required unless --gap)')
    .option('--gap', 'Brief did NOT stand: propose nothing, just say what is missing')
    .option('--gap-item <text...>', 'A missing piece of material (repeatable; use with --gap)')
    .action(
      runAction<
        [
          string,
          {
            text: string;
            plan?: string;
            gap?: boolean;
            gapItem?: string[];
          },
        ]
      >(async (conversationId, opts) => {
        if (!opts.gap && !opts.plan) {
          exitWithError('propose needs --plan <planId> (or --gap when the Brief did not stand)');
        }
        // The cast preview is filled by the CLOUD from the plan draft (28 §L1) —
        // the agent no longer hands a --cast-file. It only names the plan + one
        // human sentence; cloud reads `councilPlan.cast` and projects the
        // display-safe subset (never `voice`) onto the proposal bubble itself.
        const body: Record<string, unknown> = {
          text: opts.text,
          variant: opts.gap ? 'gap' : 'propose',
          ...(opts.plan ? { planId: opts.plan } : {}),
          ...(opts.gap ? { gaps: opts.gapItem ?? [] } : {}),
        };
        printJson(await post(mkCloud(), `/api/im/councils/${encodeURIComponent(conversationId)}/propose`, body));
      }),
    );

  // ── Phase C — drive rounds ─────────────────────────────────────────────────
  cmd
    .command('run <conversationId>')
    .description('Drive discussion rounds — ONE serial task inside this council (never @-mention personas to relay).')
    .option('--rounds <n>', 'Number of rounds', (v) => Number.parseInt(v, 10))
    .option('--persona <personaId>', 'Drive a single persona instead of the full table')
    .action(
      runAction<[string, { rounds?: number; persona?: string }]>(async (conversationId, opts) => {
        const body: Record<string, unknown> = {};
        if (opts.rounds !== undefined) body.rounds = opts.rounds;
        if (opts.persona) body.personaId = opts.persona;
        printJson(await post(mkCloud(), `/api/im/councils/${encodeURIComponent(conversationId)}/run`, body));
      }),
    );

  // ── Phase C — drive ONE round atomically (L6=B, product204/28 §4.1) ────────
  //
  // The primary drive surface. The agent produces ONLY the text of this one
  // round — one entry per persona, `[{ personaId, content }]` where personaId is
  // the PersonaDef slug from the roster — writes it to a file, and hands the
  // WHOLE round to the cloud in a SINGLE call. The cloud lands each turn
  // SERIALLY under that persona's own identity (zero LLM: it already holds
  // backingAgentId / voice / session). This replaces the old "agent hand-crafts
  // a 6-flag `council say` per persona" loop, which the real e2e proved
  // unreliable — on any friction the agent bailed to normal messages and faked
  // the roundtable (28 §L2/L6). Here the agent emits content (LLM), the cloud
  // lands turns (data): the exact 03 §0 split.
  //
  // A non-empty `rejected[]` is surfaced LOUDLY and exits nonzero — the round is
  // incomplete and the agent must fix the slugs/content, never paper over it
  // with a normal message.
  cmd
    .command('turns <conversationId>')
    .description('Land ONE full round of persona turns — agent supplies text, cloud speaks as each persona.')
    .requiredOption('--round <n>', 'The round number this file drives', (v) => Number.parseInt(v, 10))
    .requiredOption('--file <path>', 'JSON array: [{ personaId, content }] — personaId is the PersonaDef slug')
    .action(
      runAction<[string, { round: number; file: string }]>(async (conversationId, opts) => {
        if (!Number.isFinite(opts.round)) exitWithError('turns needs --round <n> (an integer)');
        let raw: string;
        try {
          raw = await readFile(opts.file, 'utf8');
        } catch (err) {
          exitWithError(`cannot read --file ${opts.file}: ${(err as Error).message}`);
        }
        let turns: unknown;
        try {
          turns = JSON.parse(raw);
        } catch (err) {
          exitWithError(`--file ${opts.file} is not valid JSON: ${(err as Error).message}`);
        }
        if (!Array.isArray(turns)) {
          exitWithError(
            `--file ${opts.file} must be a JSON ARRAY of { personaId, content } — one entry per persona this round`,
          );
        }
        const result = (await post(mkCloud(), `/api/im/councils/${encodeURIComponent(conversationId)}/turns`, {
          round: opts.round,
          turns,
        })) as { posted?: number; rejected?: Array<{ personaId?: string; reason?: string }> };
        printJson(result);
        const rejected = Array.isArray(result?.rejected) ? result.rejected : [];
        if (rejected.length > 0) {
          fail(`${rejected.length} persona turn(s) were REJECTED and did NOT land in the council:`);
          for (const r of rejected) {
            warn(`  ✗ ${r.personaId ?? '(unknown persona)'}`, r.reason ?? '(no reason)');
          }
          exitWithError(
            `Round ${opts.round} is INCOMPLETE — ${rejected.length} turn(s) never spoke. Do NOT paper over this ` +
              `with a normal message pretending to be a persona. Fix the personaId slugs / content and re-run ` +
              `\`prismer council turns\`, or say plainly which personas could not speak and stop.`,
          );
        }
      }),
    );

  // ── Team Manager follow-up only — one persona speaks (post-settle @-mention) ─
  //
  // ⚠️ NOT a drive surface. Round driving goes through `council turns` (above).
  // This posts ONE persona turn directly and exists only for the resident-state
  // case: after settle the Team Manager @-mentions a single persona and the cloud
  // redirects that dispatch to you with a personaId hint — you answer AS that
  // persona via this path. It posts to /api/im/messages/:convId with
  // `personaSenderId`, which the cloud rewrites into the message's senderId (403
  // PERSONA_SENDER_FORBIDDEN if you are not that persona's backing orchestrator).
  cmd
    .command('say <conversationId>')
    .description('Team Manager follow-up only: post ONE persona turn AS that persona (not for driving rounds — use `turns`).')
    .requiredOption('--persona-user <imUserId>', "The persona's im_users id (from convene's personas[])")
    .requiredOption('--persona-id <slug>', 'PersonaDef.id (slug)')
    .requiredOption('--session <councilSessionId>', 'councilSessionId (from the council marker)')
    .requiredOption('--round <n>', 'Round number', (v) => Number.parseInt(v, 10))
    .requiredOption('--turn <n>', 'Turn index within the round', (v) => Number.parseInt(v, 10))
    .option('--text <content>', 'Turn content')
    .option('--text-file <path>', 'Read turn content from a file')
    .action(
      runAction<
        [
          string,
          {
            personaUser: string;
            personaId: string;
            session: string;
            round: number;
            turn: number;
            text?: string;
            textFile?: string;
          },
        ]
      >(async (conversationId, opts) => {
        let content = opts.text;
        if (opts.textFile) {
          try {
            content = await readFile(opts.textFile, 'utf8');
          } catch (err) {
            exitWithError(`cannot read --text-file ${opts.textFile}: ${(err as Error).message}`);
          }
        }
        if (!content?.trim()) exitWithError('say needs --text or --text-file');
        const body = {
          type: 'text',
          content,
          personaSenderId: opts.personaUser,
          metadata: {
            kind: 'council_turn',
            councilTurn: {
              kind: 'council_turn',
              councilSessionId: opts.session,
              round: opts.round,
              turnIndex: opts.turn,
              personaId: opts.personaId,
            },
          },
        };
        printJson(await post(mkCloud(), `/api/im/messages/${encodeURIComponent(conversationId)}`, body));
      }),
    );

  // ── Phase D — settle ───────────────────────────────────────────────────────
  cmd
    .command('finalize <conversationId>')
    .description('Settle: disagreement map + report + memory writeback + task drafts. The group stays resident.')
    .option(
      '--file <path>',
      'JSON: { report?, reportAssetId?, claims?, gaps?, disagreements?, memoryRefs?, taskDrafts? }',
    )
    .option('--report-file <path>', 'Markdown report file (shorthand for {report:<contents>})')
    .action(
      runAction<[string, { file?: string; reportFile?: string }]>(async (conversationId, opts) => {
        if (!opts.file && !opts.reportFile) {
          exitWithError('finalize needs --file <json> or --report-file <md>');
        }
        const body: Record<string, unknown> = opts.file ? await readJsonFile(opts.file) : {};
        if (opts.reportFile) {
          try {
            body.report = await readFile(opts.reportFile, 'utf8');
          } catch (err) {
            exitWithError(`cannot read --report-file ${opts.reportFile}: ${(err as Error).message}`);
          }
        }
        printJson(await post(mkCloud(), `/api/im/councils/${encodeURIComponent(conversationId)}/finalize`, body));
      }),
    );

  // ── report read-back ───────────────────────────────────────────────────────
  cmd
    .command('report <conversationId>')
    .description('Read back the settled report + claims / gaps / disagreements.')
    .action(
      runAction<[string]>(async (conversationId) => {
        const cloud = mkCloud();
        const res = await cloud.request<{ ok: boolean; data?: unknown; error?: unknown }>(
          'GET',
          `/api/im/councils/${encodeURIComponent(conversationId)}/report`,
          { headers: agentHeaders() },
        );
        if (!res.ok) exitWithError(`report failed: ${(res.error as any)?.message ?? res.status}`);
        const env = res.data as { ok?: boolean; data?: unknown } | undefined;
        printJson(env && typeof env === 'object' && 'ok' in env ? env.data : res.data);
      }),
    );

  return cmd;
}
